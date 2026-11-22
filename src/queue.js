/**
 * Memory proposal queue (M3).
 *
 * Ordinary sessions cannot write the formal store: they enqueue a candidate, and the
 * central memory manager claims it atomically, decides, and archives it through the
 * archive path (which computes the embedding locally and rolls back on a failed
 * supersede).
 *
 * Claim is one `BEGIN IMMEDIATE` transaction so two managers can never take the same
 * row. A claim older than `staleMinutes` is returned to `pending` first (a crashed
 * manager must not wedge the queue), and a row that exhausted `maxRetries` becomes
 * `failed` instead of looping forever.
 */

import crypto from 'node:crypto'

/** Queue statuses, matching the schema CHECK constraint. */
export const QUEUE_STATUSES = Object.freeze(['pending', 'processing', 'done', 'rejected', 'failed'])

/** Hash used to avoid enqueueing the exact same candidate twice in one hour. */
export function proposalDedupeKey(sourceSessionId, rawContent, now = new Date()) {
  const hourBucket = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCHours()).padStart(2, '0')}`
  return crypto
    .createHash('sha256')
    .update(`${sourceSessionId}\u0000${rawContent}\u0000${hourBucket}`)
    .digest('hex')
}

/**
 * Enqueue one candidate memory.
 *
 * @param {{ prepare: Function, exec: Function }} db
 * @param {{ sourceSessionId: string, rawContent: string, now?: Date }} input
 * @returns {{ id: string, deduped: boolean }}
 */
export function enqueueProposal(db, { sourceSessionId, rawContent, now = new Date() }) {
  const id = crypto.randomUUID()
  const dedupe = proposalDedupeKey(sourceSessionId, rawContent, now)
  const existing = db
    .prepare('SELECT id FROM memory_queue WHERE dedupe_key = ? AND status IN (?, ?, ?) LIMIT 1')
    .get(dedupe, 'pending', 'processing', 'done')
  if (existing) return { id: existing.id, deduped: true }

  db.prepare(
    `INSERT INTO memory_queue (id, source_session_id, raw_content, dedupe_key, status, retry_count)
     VALUES (?, ?, ?, ?, 'pending', 0)`,
  ).run(id, sourceSessionId, rawContent, dedupe)
  return { id, deduped: false }
}

/**
 * Claim the oldest pending candidate atomically.
 *
 * @param {any} db
 * @param {{ staleMinutes?: number, maxRetries?: number, now?: () => Date }} [options]
 * @returns {object|null} the claimed row, or null when the queue is empty
 */
export function claimNext(db, { staleMinutes = 10, maxRetries = 3 } = {}) {
  db.exec('BEGIN IMMEDIATE')
  try {
    // Requeue claims abandoned by a crashed manager.
    db.prepare(
      `UPDATE memory_queue
          SET status = 'pending', claimed_at = NULL
        WHERE status = 'processing'
          AND claimed_at IS NOT NULL
          AND claimed_at <= datetime('now', ?)`,
    ).run(`-${staleMinutes} minutes`)

    // Stop retrying rows that already burned their budget.
    db.prepare(
      `UPDATE memory_queue
          SET status = 'failed', claimed_at = NULL
        WHERE status = 'pending' AND retry_count >= ?`,
    ).run(maxRetries)

    const row = db
      .prepare(
        `UPDATE memory_queue
            SET status = 'processing',
                claimed_at = CURRENT_TIMESTAMP,
                retry_count = retry_count + 1
          WHERE id = (
            SELECT id FROM memory_queue
             WHERE status = 'pending'
             ORDER BY created_at ASC, rowid ASC
             LIMIT 1
          )
         RETURNING id, source_session_id, raw_content, retry_count, created_at, claimed_at`,
      )
      .get()
    db.exec('COMMIT')
    return row ?? null
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The original failure is the useful one.
    }
    throw error
  }
}

/** Finish one claimed row with a terminal status. */
export function settleClaim(db, id, status, { error } = {}) {
  if (!['done', 'rejected', 'failed'].includes(status)) {
    throw new TypeError(`settleClaim: unsupported terminal status "${status}"`)
  }
  const result = db
    .prepare('UPDATE memory_queue SET status = ?, claimed_at = NULL, error = ? WHERE id = ? AND status = ?')
    .run(status, error === undefined ? null : String(error), id, 'processing')
  return result.changes === 1
}

/** Queue counters for the admin surface. */
export function queueStats(db) {
  const rows = db.prepare('SELECT status, COUNT(*) AS count FROM memory_queue GROUP BY status').all()
  const stats = { pending: 0, processing: 0, done: 0, rejected: 0, failed: 0 }
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(stats, row.status)) stats[row.status] = row.count
  }
  stats.total = Object.values(stats).reduce((sum, value) => sum + value, 0)
  return stats
}

/** Columns shared by the list and the single-item read, plus derived age. */
const QUEUE_ITEM_COLUMNS = `
  id, status, retry_count, created_at, claimed_at, error, source_session_id,
  substr(raw_content, 1, 200) AS content_preview,
  length(raw_content) AS content_length,
  CASE WHEN claimed_at IS NULL THEN NULL
       ELSE CAST((julianday('now') - julianday(claimed_at)) * 86400 AS INTEGER) END AS claimed_ago_seconds`

/**
 * Read-only queue listing for the UI (M4 follow-up).
 *
 * The panel never writes here: claiming, archiving and settling stay in the admin
 * tools, the single write path.
 *
 * @param {any} db
 * @param {{ status?: string, sourceSessionId?: string, limit?: number, offset?: number,
 *           staleMinutes?: number, maxRetries?: number }} [options]
 * @returns {{ items: object[], total: number, hasMore: boolean, stuckCount: number,
 *             stuckAfterSeconds: number, maxRetries: number }}
 */
export function listQueueItems(db, { status, sourceSessionId, limit = 50, offset = 0, staleMinutes = 10, maxRetries = 3 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200)
  const safeOffset = Math.max(Number(offset) || 0, 0)
  const conditions = []
  const params = []
  if (status && QUEUE_STATUSES.includes(status)) {
    conditions.push('status = ?')
    params.push(status)
  }
  if (sourceSessionId) {
    conditions.push('source_session_id = ?')
    params.push(sourceSessionId)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const items = db
    .prepare(
      `SELECT ${QUEUE_ITEM_COLUMNS} FROM memory_queue ${where}
        ORDER BY created_at ASC, rowid ASC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, safeLimit, safeOffset)
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM memory_queue ${where}`).get(...params)?.n ?? 0)
  const stuckAfterSeconds = staleMinutes * 60
  const stuckCount = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_queue
          WHERE status = 'processing' AND claimed_at IS NOT NULL
            AND claimed_at <= datetime('now', ?)`,
      )
      .get(`-${staleMinutes} minutes`)?.n ?? 0,
  )
  return {
    items,
    total,
    hasMore: safeOffset + items.length < total,
    stuckCount,
    stuckAfterSeconds,
    maxRetries,
  }
}

/** One queue item with the full raw content, or null. */
export function getQueueItem(db, id) {
  const row = db
    .prepare(
      `SELECT ${QUEUE_ITEM_COLUMNS}, raw_content FROM memory_queue WHERE id = ?`,
    )
    .get(id)
  return row ?? null
}
