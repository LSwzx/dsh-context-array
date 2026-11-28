/**
 * Inbox hop tracking (design §3.4): hop_count enforcement and the "one wake per source
 * per turn" rule.
 *
 * Attribution uses the host's own events rather than guessing: a delivery remembers
 * what it put in the agent's inbox, `agent/inbox/claimed` tells us the message was
 * consumed by a turn, and `agent/turn-stopping` closes that turn. While a session is
 * inside a turn started by an inbox message, anything it sends inherits hop+1, and its
 * first wake consumes the per-turn wake budget.
 *
 * State is process-local and pruned by age; the durable facts (inbox hops, status,
 * trigger_msg_id) live in SQLite.
 */

/** Maximum hop count a message may reach before the send is refused. */
export const MAX_HOP_COUNT = 3
/** Pending deliveries older than this are dropped from the tracker. */
const DELIVERY_TTL_MS = 60 * 60 * 1000

/** Stable digest of the text a delivered message carries. */
function textHash(text) {
  return String(text ?? '').slice(0, 500)
}

/** Collect the text of a message's content blocks. */
function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/**
 * @param {{ db: any, now?: () => number, warn?: (error: unknown) => void }} input
 */
export function createInboxTracker({ db, now = () => Date.now(), warn = () => {} }) {
  /** @type {Map<string, { inboxId: string, hop: number, hash: string, at: number }[]>} */
  const pendingByTarget = new Map()
  /** @type {Map<string, { inboxId: string, hop: number, turn: number|null, wakeCount: number, at: number }>} */
  const activeBySender = new Map()

  function prune() {
    const cutoff = now() - DELIVERY_TTL_MS
    for (const [sessionId, list] of pendingByTarget) {
      const kept = list.filter((entry) => entry.at >= cutoff)
      if (kept.length === 0) pendingByTarget.delete(sessionId)
      else pendingByTarget.set(sessionId, kept)
    }
    for (const [sessionId, entry] of activeBySender) {
      if (entry.at < cutoff) activeBySender.delete(sessionId)
    }
  }

  return {
    /** Remember one inject/followup so a later `agent/inbox/claimed` can be matched. */
    noteDelivery({ targetSessionId, inboxId, hop, content }) {
      prune()
      if (!targetSessionId || !inboxId) return
      const list = pendingByTarget.get(targetSessionId) ?? []
      list.push({ inboxId, hop, hash: textHash(content), at: now() })
      pendingByTarget.set(targetSessionId, list)
    },

    /** `agent/inbox/claimed` → mark the row read and make it the sender's active trigger. */
    onClaimed({ agent, message, turn }) {
      try {
        const sessionId = agent?.id
        if (!sessionId) return null
        const list = pendingByTarget.get(sessionId) ?? []
        const hash = textHash(messageText(message))
        const index = list.findIndex((entry) => entry.hash === hash)
        if (index < 0) return null
        const [entry] = list.splice(index, 1)
        if (list.length === 0) pendingByTarget.delete(sessionId)
        else pendingByTarget.set(sessionId, list)
        db.prepare("UPDATE inbox SET status = 'read' WHERE id = ? AND status = 'pending'").run(entry.inboxId)
        const record = { inboxId: entry.inboxId, hop: entry.hop, turn: turn ?? null, wakeCount: 0, at: now() }
        activeBySender.set(sessionId, record)
        return record
      } catch (error) {
        warn(error)
        return null
      }
    },

    /** `agent/turn-stopping` → the trigger no longer applies to new sends. */
    onTurnStopping({ agent }) {
      const sessionId = agent?.id
      if (sessionId) activeBySender.delete(sessionId)
    },

    /** Current trigger for a session, or null. */
    triggerOf(sessionId) {
      return activeBySender.get(sessionId) ?? null
    },

    /** Hop for a message this session is about to send; null means the limit is reached. */
    nextHop(sessionId) {
      const trigger = activeBySender.get(sessionId)
      if (!trigger) return { hop: 0, triggerMsgId: null }
      const hop = trigger.hop + 1
      if (hop > MAX_HOP_COUNT) return null
      return { hop, triggerMsgId: trigger.inboxId }
    },

    /** Reserve the per-turn wake budget for the sender (false when already used). */
    consumeWake(sessionId) {
      const trigger = activeBySender.get(sessionId)
      if (!trigger) return true
      if (trigger.wakeCount >= 1) return false
      trigger.wakeCount += 1
      return true
    },
  }
}
