/**
 * M3 tools: the proposal queue and the central memory manager's write path.
 *
 * Permission model (design doc §3.2, §0.2-12):
 * - Any session may **propose**: `memory_propose` only appends to `memory_queue`;
 *   it can never write `memories`.
 * - Only an **admin** session may claim, archive or settle. Admin identity is
 *   resolved server-side (bound role `admin`, or the deployment's `adminSessionIds`),
 *   never from tool arguments.
 * - `memory_archive` re-checks that the target space is one the caller is actually
 *   bound to, computes the embedding locally, and rolls back a failed supersede.
 */

import { insertMemory } from './db-memories.js'
import { acknowledgeInbox, deliverInbox, listInbox, sendInbox } from './inbox.js'
import { claimNext, enqueueProposal, queueStats, settleClaim } from './queue.js'
import { bindSessionToSpace, unbindSessionFromSpace } from './spaces.js'

/** JSON schema for the archive return value. */
const ARCHIVE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['memoryId', 'embedded'],
  properties: {
    memoryId: { type: 'string' },
    embedded: { type: 'boolean' },
    supersededId: { type: 'string' },
    queueSettled: { type: 'boolean' },
    error: { type: 'string' },
  },
}

const PROPOSE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['proposalId', 'deduped'],
  properties: {
    proposalId: { type: 'string' },
    deduped: { type: 'boolean' },
  },
}

const CLAIM_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['claimed'],
  properties: {
    claimed: { type: 'boolean' },
    item: { type: 'object' },
    reason: { type: 'string' },
  },
}

const STATS_OUTPUT = { type: 'object' }

const SETTLE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['settled'],
  properties: {
    settled: { type: 'boolean' },
    reason: { type: 'string' },
  },
}

const BIND_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bound: { type: 'boolean' },
    unbound: { type: 'boolean' },
    spaceId: { type: 'string' },
    role: { type: 'string' },
    error: { type: 'string' },
  },
}

const INBOX_SEND_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    inboxId: { type: 'string' },
    deduped: { type: 'boolean' },
    targetSessionId: { type: 'string' },
    delivery: { type: 'string' },
    error: { type: 'string' },
  },
}

const INBOX_LIST_OUTPUT = { type: 'object', properties: { messages: { type: 'array' } } }

const INBOX_ACK_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['acknowledged'],
  properties: { acknowledged: { type: 'boolean' } },
}

/**
 * Resolve one session's bound spaces and role.
 *
 * @param {any} db
 * @param {string} sessionId
 * @returns {{ spaceIds: string[], role: string|null }}
 */
export function sessionBinding(db, sessionId) {
  try {
    const rows = db
      .prepare(
        `SELECT l.space_id, l.role
           FROM session_space_links AS l
           JOIN memory_spaces AS s ON s.id = l.space_id
          WHERE l.session_id = ?
          ORDER BY l.space_id ASC`,
      )
      .all(sessionId)
    return {
      spaceIds: rows.map((row) => row.space_id),
      role: rows.find((row) => typeof row.role === 'string')?.role ?? null,
    }
  } catch {
    return { spaceIds: [], role: null }
  }
}

/**
 * Build the M3 tool definitions.
 *
 * @param {object} input
 * @param {any} input.db
 * @param {((text: string) => Promise<Float32Array|null>) | null} input.embedPassage
 * @param {{ adminSessionIds?: readonly string[], queueStaleMinutes?: number, queueMaxRetries?: number }} input.config
 * @param {(error: unknown) => void} [input.warn]
 * @returns {object[]} tool definitions
 */
export function createMemoryTools({ db, embedPassage = null, config = {}, warn = () => {}, ctx = null }) {
  const adminIds = new Set(Array.isArray(config.adminSessionIds) ? config.adminSessionIds : [])
  const staleMinutes = config.queueStaleMinutes ?? 10
  const maxRetries = config.queueMaxRetries ?? 3
  const wakeMaxPerHour = config.wakeMaxPerHour ?? 10

  /** Server-side admin check: bound role or deployment allow-list. Never tool args. */
  function isAdmin(sessionId) {
    if (!sessionId) return false
    if (adminIds.has(sessionId)) return true
    return sessionBinding(db, sessionId).role === 'admin'
  }

  function denied(reason) {
    return { ok: false, reason }
  }

  /** Bound-spaces lookup reused by bind/unbind/inbox. */
  function spacesOf(sessionId) {
    return sessionBinding(db, sessionId).spaceIds
  }

  return [
    {
      name: 'memory_propose',
      description:
        'Propose a durable memory candidate for the central memory manager to review. ' +
        'This only queues the text; it never writes the memory store. ' +
        'Use it for stable facts, preferences, decisions or lessons worth remembering.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['raw_content'],
        properties: {
          raw_content: { type: 'string', description: 'The candidate memory, in plain text.' },
          note: { type: 'string', description: 'Optional context for the manager (why it matters).' },
        },
      },
      output: {
        schema: PROPOSE_OUTPUT,
        render(args, value) {
          return [
            {
              type: 'text',
              text: value.deduped
                ? `memory_propose: identical candidate already queued (${value.proposalId}).`
                : `memory_propose: queued ${value.proposalId} for review.`,
            },
          ]
        },
      },
      async execute(args, exec) {
        const sessionId = exec?.agent?.id
        if (!sessionId) return { proposalId: '', deduped: false }
        const rawContent = String(args?.raw_content ?? '').trim()
        if (rawContent.length === 0) return { proposalId: '', deduped: false }
        const text = args?.note ? `${rawContent}\n\n[note] ${String(args.note).trim()}` : rawContent
        const queued = enqueueProposal(db, { sourceSessionId: sessionId, rawContent: text })
        return { proposalId: queued.id, deduped: queued.deduped }
      },
    },

    {
      name: 'memory_queue_claim',
      description:
        'Claim the oldest pending memory proposal for review (atomic; central memory manager only). ' +
        'Returns the candidate text and its queue id, or nothing when the queue is empty.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: CLAIM_OUTPUT,
        render(args, value) {
          if (!value.claimed) {
            return [
              {
                type: 'text',
                text: value.reason
                  ? `memory_queue_claim: denied (${value.reason}).`
                  : 'memory_queue_claim: queue is empty.',
              },
            ]
          }
          const item = value.item ?? {}
          return [
            {
              type: 'text',
              text: `memory_queue_claim: ${item.queueId} (retry ${item.retryCount}) from ${item.sourceSessionId}\n${item.rawContent}`,
            },
          ]
        },
      },
      async execute(args, exec) {
        if (!isAdmin(exec?.agent?.id)) return { claimed: false, reason: 'NOT_ADMIN' }
        try {
          const row = claimNext(db, { staleMinutes, maxRetries })
          if (!row) return { claimed: false }
          return {
            claimed: true,
            item: {
              queueId: row.id,
              rawContent: row.raw_content,
              sourceSessionId: row.source_session_id,
              retryCount: row.retry_count,
            },
          }
        } catch (error) {
          warn(error)
          return { claimed: false }
        }
      },
    },

    {
      name: 'memory_archive',
      description:
        'Archive one reviewed candidate into the memory store (central memory manager only). ' +
        'Classify it into one dimension, pick ONE space the manager is bound to, and pass ' +
        'supersedesId when it replaces an older memory. The embedding is computed locally.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['content', 'dimension', 'spaceId'],
        properties: {
          content: { type: 'string', description: 'Final memory text to store.' },
          dimension: {
            type: 'string',
            enum: ['working', 'recent', 'fact', 'reflection', 'personality'],
            description: 'Five-dimension classification.',
          },
          spaceId: { type: 'string', description: 'One space this manager is bound to.' },
          supersedesId: { type: 'string', description: 'Memory id this one replaces, if any.' },
          queueId: { type: 'string', description: 'Queue item to mark done after archiving.' },
        },
      },
      output: {
        schema: ARCHIVE_OUTPUT,
        render(args, value) {
          if (value.error) return [{ type: 'text', text: `memory_archive failed: ${value.error}` }]
          return [
            {
              type: 'text',
              text:
                `memory_archive: stored ${value.memoryId} (embedded=${value.embedded})` +
                (value.supersededId ? ` superseding ${value.supersededId}` : '') +
                (value.queueSettled ? ', queue item settled.' : '.'),
            },
          ]
        },
      },
      async execute(args, exec) {
        const sessionId = exec?.agent?.id
        if (!isAdmin(sessionId)) return { memoryId: '', embedded: false, error: 'NOT_ADMIN' }
        const content = String(args?.content ?? '').trim()
        const dimension = String(args?.dimension ?? '')
        const spaceId = String(args?.spaceId ?? '')
        const allowed = sessionBinding(db, sessionId).spaceIds
        if (content.length === 0) return { memoryId: '', embedded: false, error: 'EMPTY_CONTENT' }
        if (!allowed.includes(spaceId)) return { memoryId: '', embedded: false, error: 'SPACE_NOT_BOUND' }

        let embedding = null
        let embedded = false
        if (typeof embedPassage === 'function') {
          try {
            embedding = await embedPassage(content)
            embedded = embedding instanceof Float32Array && embedding.length > 0
          } catch (error) {
            // Keyword retrieval still works without a vector; report the degradation.
            warn(error)
            embedded = false
          }
        }

        try {
          const memoryId = insertMemory(db, {
            spaceId,
            dimension,
            content,
            embedding,
            sourceSessionId: sessionId,
            supersedesId: typeof args?.supersedesId === 'string' && args.supersedesId.trim() !== '' ? args.supersedesId.trim() : null,
          })
          let queueSettled = false
          const queueId = typeof args?.queueId === 'string' ? args.queueId.trim() : ''
          if (queueId !== '') queueSettled = settleClaim(db, queueId, 'done')
          return {
            memoryId,
            embedded,
            ...(typeof args?.supersedesId === 'string' && args.supersedesId.trim() !== ''
              ? { supersededId: args.supersedesId.trim() }
              : {}),
            queueSettled,
          }
        } catch (error) {
          warn(error)
          return { memoryId: '', embedded, error: String(error?.message ?? error) }
        }
      },
    },

    {
      name: 'memory_queue_settle',
      description:
        'Reject or fail one claimed proposal without archiving it (central memory manager only). ' +
        'Rejection is a normal decision; failure means it could not be processed.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['queueId', 'status'],
        properties: {
          queueId: { type: 'string', description: 'Claimed queue item id.' },
          status: { type: 'string', enum: ['rejected', 'failed'], description: 'Terminal status to record.' },
          reason: { type: 'string', description: 'Why it was rejected or failed.' },
        },
      },
      output: {
        schema: SETTLE_OUTPUT,
        render(args, value) {
          return [
            {
              type: 'text',
              text: value.settled
                ? `memory_queue_settle: ${args?.queueId} → ${args?.status}.`
                : `memory_queue_settle: ${args?.queueId} was not processing (${value.reason ?? 'NO_CHANGE'}).`,
            },
          ]
        },
      },
      async execute(args, exec) {
        if (!isAdmin(exec?.agent?.id)) return { settled: false, reason: 'NOT_ADMIN' }
        const queueId = typeof args?.queueId === 'string' ? args.queueId.trim() : ''
        const status = String(args?.status ?? '')
        if (queueId === '') return { settled: false, reason: 'MISSING_QUEUE_ID' }
        try {
          const settled = settleClaim(db, queueId, status, { error: args?.reason })
          return { settled, ...(settled ? {} : { reason: 'NOT_PROCESSING' }) }
        } catch (error) {
          warn(error)
          return { settled: false, reason: String(error?.message ?? error) }
        }
      },
    },

    {
      name: 'memory_queue_stats',
      description: 'Queue counters for the central memory manager (admin only).',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: STATS_OUTPUT,
        render(args, value) {
          return [
            {
              type: 'text',
              text: `memory_queue_stats: pending=${value.pending} processing=${value.processing} done=${value.done} rejected=${value.rejected} failed=${value.failed} total=${value.total}`,
            },
          ]
        },
      },
      async execute(args, exec) {
        if (!isAdmin(exec?.agent?.id)) return { pending: 0, processing: 0, done: 0, rejected: 0, failed: 0, total: 0, error: 'NOT_ADMIN' }
        try {
          return queueStats(db)
        } catch (error) {
          warn(error)
          return { pending: 0, processing: 0, done: 0, rejected: 0, failed: 0, total: 0, error: String(error?.message ?? error) }
        }
      },
    },
    {
      name: 'memory_bind',
      description:
        'Bind THIS session to one space (M4). `role: admin` is only accepted from a current ' +
        'central memory manager; a main session may bind additional readable spaces.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['spaceId'],
        properties: {
          spaceId: { type: 'string', description: 'Space id, e.g. space-default.' },
          role: { type: 'string', enum: ['main', 'admin', 'sub'], description: 'Role for this binding (default main).' },
        },
      },
      output: {
        schema: BIND_OUTPUT,
        render(args, value) {
          if (value.error) return [{ type: 'text', text: `memory_bind failed: ${value.error}` }]
          return [{ type: 'text', text: `memory_bind: ${value.spaceId} → ${value.role}.` }]
        },
      },
      async execute(args, exec) {
        const sessionId = exec?.agent?.id
        if (!sessionId) return { bound: false, error: 'NO_SESSION_IDENTITY' }
        const spaceId = String(args?.spaceId ?? '').trim()
        const role = String(args?.role ?? 'main')
        if (role === 'admin' && !isAdmin(sessionId)) return { bound: false, error: 'ADMIN_REQUIRES_ADMIN' }
        const result = bindSessionToSpace(db, { sessionId, spaceId, role })
        return result.bound ? { bound: true, spaceId, role } : { bound: false, error: result.reason }
      },
    },

    {
      name: 'memory_unbind',
      description: 'Remove THIS session\'s binding to one space.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['spaceId'],
        properties: { spaceId: { type: 'string' } },
      },
      output: {
        schema: BIND_OUTPUT,
        render(args, value) {
          return [{ type: 'text', text: value.unbound ? `memory_unbind: ${value.spaceId} removed.` : `memory_unbind: no binding for ${args?.spaceId}.` }]
        },
      },
      async execute(args, exec) {
        const sessionId = exec?.agent?.id
        if (!sessionId) return { unbound: false, error: 'NO_SESSION_IDENTITY' }
        const spaceId = String(args?.spaceId ?? '').trim()
        return { ...unbindSessionFromSpace(db, { sessionId, spaceId }), spaceId }
      },
    },

    {
      name: 'inbox_send',
      description:
        'Queue a message for another session (M4). Queue-only is cheap: it lands in the target ' +
        'next step without starting a turn. `wake: true` starts a real turn and is rate-limited.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['targetSessionId', 'content'],
        properties: {
          targetSessionId: { type: 'string', description: 'Exact target session id.' },
          content: { type: 'string', description: 'Message text.' },
          wake: { type: 'boolean', description: 'Start a turn on the target (throttled).' },
        },
      },
      output: {
        schema: INBOX_SEND_OUTPUT,
        render(args, value) {
          if (value.error) return [{ type: 'text', text: `inbox_send failed: ${value.error}` }]
          return [
            {
              type: 'text',
              text: `inbox_send: ${value.inboxId} → ${value.targetSessionId} (${value.delivery}${value.deduped ? ', deduped' : ''}).`,
            },
          ]
        },
      },
      async execute(args, exec) {
        const sessionId = exec?.agent?.id
        const targetSessionId = String(args?.targetSessionId ?? '').trim()
        const content = String(args?.content ?? '').trim()
        if (!sessionId || targetSessionId === '' || content === '') return { error: 'TARGET_AND_CONTENT_REQUIRED' }
        const spaceId = spacesOf(sessionId)[0] ?? config.spaceId
        const inbox = sendInbox(db, { spaceId, sourceSessionId: sessionId, targetSessionId, content })
        const delivery = deliverInbox(ctx, {
          db,
          targetSessionId,
          content,
          wake: args?.wake === true,
          maxPerHour: wakeMaxPerHour,
          inboxId: inbox.id,
          sourceSessionId: sessionId,
        })
        return { inboxId: inbox.id, deduped: inbox.deduped, targetSessionId, delivery: delivery.mode }
      },
    },

    {
      name: 'inbox_list',
      description: 'List inbox messages addressed to THIS session (pending by default).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['pending', 'read', 'all'] },
          limit: { type: 'integer' },
        },
      },
      output: {
        schema: INBOX_LIST_OUTPUT,
        render(args, value) {
          if (!value.messages?.length) return [{ type: 'text', text: 'inbox_list: empty.' }]
          return [
            {
              type: 'text',
              text: value.messages
                .map((row) => `${row.id} [${row.status}] from ${row.source_session_id ?? 'unknown'}: ${String(row.content).slice(0, 200)}`)
                .join('\n'),
            },
          ]
        },
      },
      async execute(args, exec) {
        const sessionId = exec?.agent?.id
        if (!sessionId) return { messages: [] }
        const status = String(args?.status ?? 'pending')
        return {
          messages: listInbox(db, {
            targetSessionId: sessionId,
            status: status === 'all' ? undefined : status,
            limit: args?.limit,
          }),
        }
      },
    },

    {
      name: 'inbox_ack',
      description: 'Mark one inbox message read.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['inboxId'],
        properties: { inboxId: { type: 'string' } },
      },
      output: {
        schema: INBOX_ACK_OUTPUT,
        render(args, value) {
          return [{ type: 'text', text: value.acknowledged ? `inbox_ack: ${args?.inboxId} read.` : `inbox_ack: ${args?.inboxId} was not pending.` }]
        },
      },
      async execute(args) {
        return acknowledgeInbox(db, String(args?.inboxId ?? '').trim())
      },
    },
  ]
}
