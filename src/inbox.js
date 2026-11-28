/**
 * Inbox (M4): durable queued messages between sessions, with an optional wake.
 *
 * Two delivery modes, exactly as the design doc requires:
 * - queue only → `agent.inject()`: cheap, model-facing context that lands in the next
 *   admitted step without starting one (no token spend on its own);
 * - wake → `agent.followup()`: starts a real turn, therefore billed, therefore
 *   throttled by a sliding-hour limit and recorded in `inbox_wake_log`.
 *
 * The durable row is written first: a failed wake leaves the message visible in the
 * inbox rather than losing it.
 */

import crypto from 'node:crypto'

/** Source kind recorded on the injected user-role message. */
export const INBOX_SOURCE_KIND = 'context-array-inbox'

/** Default sliding-hour wake limit per target session. */
export const DEFAULT_WAKE_MAX_PER_HOUR = 10
/** Default sliding-hour wake limit across all targets (anti wake-storm). */
export const DEFAULT_WAKE_GLOBAL_MAX_PER_HOUR = 30
/** Default minimum gap between two wakes of the same target. */
export const DEFAULT_WAKE_COOLDOWN_MINUTES = 10

/** Stable dedupe key for one (content, UTC hour) tuple: resend after the hour. */
export function inboxDedupeKey(content, now = new Date()) {
  const hourBucket = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCHours()).padStart(2, '0')}`
  return crypto
    .createHash('sha256')
    .update(`${String(content)}\u0000${hourBucket}`)
    .digest('hex')
    .slice(0, 32)
}

/**
 * Store one inbox message.
 *
 * @returns {{ id: string, deduped: boolean }}
 */
export function sendInbox(db, { spaceId, sourceSessionId, targetSessionId, content, now = new Date() }) {
  const id = crypto.randomUUID()
  const dedupe = inboxDedupeKey(content, now)
  const existing = db
    .prepare(
      `SELECT id FROM inbox
        WHERE space_id = ? AND source_session_id IS ? AND target_session_id IS ? AND dedupe_key = ?`,
    )
    .get(spaceId, sourceSessionId, targetSessionId, dedupe)
  if (existing) return { id: existing.id, deduped: true }

  db.prepare(
    `INSERT INTO inbox (id, space_id, source_session_id, target_session_id, content, dedupe_key, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(id, spaceId, sourceSessionId, targetSessionId, String(content), dedupe)
  return { id, deduped: false }
}

/** Inbox rows for one target (or all targets when omitted), newest first. */
export function listInbox(db, { targetSessionId, status = 'pending', limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200)
  const conditions = []
  const params = []
  if (targetSessionId) {
    conditions.push('i.target_session_id = ?')
    params.push(targetSessionId)
  }
  if (status && status !== 'all') {
    conditions.push('i.status = ?')
    params.push(status)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return db
    .prepare(
      `SELECT i.id, i.space_id, s.name AS space_name, i.source_session_id, i.target_session_id,
              i.content, i.status, i.hop_count, i.created_at,
              (SELECT w.throttled FROM inbox_wake_log AS w
                WHERE w.inbox_id = i.id ORDER BY w.at DESC, w.id DESC LIMIT 1) AS last_wake_throttled
         FROM inbox AS i
         LEFT JOIN memory_spaces AS s ON s.id = i.space_id
         ${where}
        ORDER BY i.created_at DESC
        LIMIT ?`,
    )
    .all(...params, safeLimit)
}

/** Mark one message read. */
export function acknowledgeInbox(db, id) {
  const result = db.prepare("UPDATE inbox SET status = 'read' WHERE id = ? AND status = 'pending'").run(id)
  return { acknowledged: result.changes === 1 }
}

/** How many wakes this target already consumed in the trailing hour. */
export function wakeCountLastHour(db, targetSessionId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM inbox_wake_log
        WHERE target_session_id = ? AND throttled = 0 AND at >= datetime('now', '-1 hour')`,
    )
    .get(targetSessionId).n
}

/** Wakes delivered (not throttled) to any target in the trailing hour. */
export function globalWakeCountLastHour(db) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM inbox_wake_log WHERE throttled = 0 AND at >= datetime('now', '-1 hour')")
    .get().n
}

/** Timestamp of the last delivered wake for one target, or null. */
export function lastWakeAt(db, targetSessionId) {
  const row = db
    .prepare(
      "SELECT at FROM inbox_wake_log WHERE target_session_id = ? AND throttled = 0 ORDER BY at DESC, id DESC LIMIT 1",
    )
    .get(targetSessionId)
  return row?.at ?? null
}

/** Parse SQLite UTC timestamps (`YYYY-MM-DD HH:MM:SS`, no zone) into epoch ms. */
function sqliteTimeMs(value) {
  if (!value) return null
  const parsed = Date.parse(String(value).replace(' ', 'T') + 'Z')
  return Number.isNaN(parsed) ? null : parsed
}

/** Record one wake attempt (delivered or throttled). */
export function noteWake(db, { targetSessionId, sourceSessionId, inboxId, throttled }) {
  db.prepare(
    'INSERT INTO inbox_wake_log (target_session_id, source_session_id, inbox_id, throttled) VALUES (?, ?, ?, ?)',
  ).run(targetSessionId, sourceSessionId ?? null, inboxId ?? null, throttled ? 1 : 0)
}

/** Wrap text as the user-role message the agent inbox accepts. */
function inboxMessage(content) {
  return {
    content: [{ type: 'text', text: String(content) }],
    source: { kind: INBOX_SOURCE_KIND },
  }
}

/**
 * Deliver one message to a live agent.
 *
 * @param {any} ctx plugin context (uses `ctx.get('agents')`)
 * @param {{ targetSessionId: string, content: string, wake?: boolean, maxPerHour?: number,
 *           sourceSessionId?: string, inboxId?: string }} request
 * @returns {{ mode: 'woke'|'queued'|'throttled'|'offline', targetSessionId: string, wakeCount?: number }}
 */
export function deliverInbox(ctx, request) {
  const {
    targetSessionId,
    content,
    wake = false,
    maxPerHour = DEFAULT_WAKE_MAX_PER_HOUR,
    globalMaxPerHour = DEFAULT_WAKE_GLOBAL_MAX_PER_HOUR,
    cooldownMinutes = DEFAULT_WAKE_COOLDOWN_MINUTES,
    now = () => Date.now(),
  } = request
  const db = request.db
  const agents = ctx?.get?.('agents')
  const agent = agents?.get?.(targetSessionId)
  if (!agent) return { mode: 'offline', targetSessionId }

  const message = inboxMessage(content)
  const canInject = typeof agent.inject === 'function'
  const canWake = typeof agent.followup === 'function'

  if (!wake) {
    if (!canInject) return { mode: 'offline', targetSessionId }
    agent.inject(message)
    return { mode: 'queued', targetSessionId }
  }

  const throttle = (reason) => {
    if (db) {
      noteWake(db, {
        targetSessionId,
        sourceSessionId: request.sourceSessionId,
        inboxId: request.inboxId,
        throttled: true,
      })
    }
    if (canInject) agent.inject(message)
    return { mode: 'throttled', reason, targetSessionId }
  }

  if (db) {
    const globalUsed = globalWakeCountLastHour(db)
    if (globalUsed >= globalMaxPerHour) return throttle('global')

    const lastAt = sqliteTimeMs(lastWakeAt(db, targetSessionId))
    if (lastAt !== null && now() - lastAt < cooldownMinutes * 60_000) return throttle('cooldown')

    const used = wakeCountLastHour(db, targetSessionId)
    if (used >= maxPerHour) return throttle('hourly')
  }

  if (!canWake) {
    if (canInject) agent.inject(message)
    return { mode: 'queued', targetSessionId }
  }
  agent.followup(message)
  if (db) {
    noteWake(db, {
      targetSessionId,
      sourceSessionId: request.sourceSessionId,
      inboxId: request.inboxId,
      throttled: false,
    })
  }
  return { mode: 'woke', targetSessionId }
}
