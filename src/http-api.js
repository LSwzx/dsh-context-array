/**
 * Host HTTP API for the M4 sidebar panel.
 *
 * One prefix route (`/api/context-array`) owned by the plugin. Reads answer local
 * store state; writes are refused unless the request is loopback **and** carries
 * `x-context-array-ui: 1`, the same guard the shipped plugins use, so another page
 * cannot drive the actions.
 */

import {
  acknowledgeInbox,
  deliverInbox,
  listInbox,
  sendInbox,
} from './inbox.js'
import { getQueueItem, listQueueItems, queueStats, QUEUE_STATUSES } from './queue.js'
import {
  bindSessionToSpace,
  countActiveMemories,
  createSpace,
  deleteSpace,
  listBindings,
  listKnownSessions,
  listMemories,
  listSpacesDetailed,
  unbindSessionFromSpace,
  updateSpace,
} from './spaces.js'

/** The five allowed dimensions; also the only accepted `dimension` filter values. */
const MEMORY_DIMENSIONS = ['working', 'recent', 'fact', 'reflection', 'personality']

export const API_PREFIX = '/api/context-array'

/** Send one JSON response. */
function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Loopback-only, and writes additionally require the UI header. */
function localRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Read and parse a bounded JSON body. */
async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 256 * 1024) throw new Error('BODY_TOO_LARGE')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Register one route on whatever web server this fiber eventually gets.
 *
 * `ctx.get('webServer')` can legitimately be empty while the plugin activates (the web
 * carrier may mount later), so the old silent-noop path could leave the panel without a
 * route forever. `ctx.inject` runs now when the service exists and later when it
 * appears; the outcome is always recorded as an `http-api/*` event.
 *
 * @param {any} ctx
 * @param {object} route
 * @param {{ events?: { append: (record: object) => void } | null, warn?: (error: unknown) => void }} [options]
 * @returns {() => void}
 */
export function registerRoute(ctx, route, { events = null, warn = () => {} } = {}) {
  const announce = (status, extra = {}) => {
    try {
      events?.append({ type: `http-api/${status}`, at: new Date().toISOString(), ...extra })
    } catch {
      // Observability must never block registration.
    }
  }
  const attach = (web) => {
    if (!web || typeof web.register !== 'function') {
      announce('unavailable')
      return () => {}
    }
    try {
      const dispose = web.register(route)
      announce('registered')
      return typeof dispose === 'function' ? dispose : () => {}
    } catch (error) {
      warn(error)
      announce('failed', { message: String(error?.message ?? error) })
      return () => {}
    }
  }

  if (typeof ctx?.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const dispose = attach(webCtx?.webServer)
      if (typeof webCtx?.effect === 'function') webCtx.effect(() => dispose, 'context-array:http-api-route')
    })
    return () => {}
  }

  const web = ctx?.get?.('webServer')
  if (!web) {
    announce('unavailable')
    return () => {}
  }
  return attach(web)
}

/**
 * Register the API route.
 *
 * @param {{ ctx: any, db: any, config: object, warn: (error: unknown) => void,
 *           events?: object | null, persona?: object | null }} input
 * @returns {() => void} disposer
 */
export function registerContextArrayApi({ ctx, db, config, warn, events = null, persona = null, inboxTracker = null }) {
  const route = {
    kind: 'prefix',
    path: API_PREFIX,
    async handler(req, res) {
      try {
        if (!localRequest(req)) return json(res, 403, { error: 'LOCAL_ONLY' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname.replace(/^\/api\/context-array/, '').replace(/\/+$/, '') || '/'
        const method = (req.method ?? 'GET').toUpperCase()
        const write = method !== 'GET' && method !== 'HEAD'
        if (write && req.headers['x-context-array-ui'] !== '1') {
          return json(res, 403, { error: 'UI_HEADER_REQUIRED' })
        }
        const body = write ? await readJson(req) : {}

        if (method === 'GET' && path === '/persona') {
          const memories = db
            .prepare(
              `SELECT m.id, m.content, m.space_id, s.name AS space_name, m.timestamp
                 FROM memories AS m
                 LEFT JOIN memory_spaces AS s ON s.id = m.space_id
                WHERE m.dimension = 'personality' AND m.superseded_by IS NULL
                ORDER BY m.seq DESC
                LIMIT 50`,
            )
            .all()
          return json(res, 200, {
            mode: persona?.mode ?? 'off',
            tools: persona?.tools ?? [],
            traits: persona?.traits ?? [],
            memories,
            alerts: persona?.alerts ?? [],
          })
        }
        if (method === 'GET' && path === '/health') {
          return json(res, 200, { ok: true, spaces: listSpacesDetailed(db).length, queue: queueStats(db) })
        }
        if (method === 'GET' && path === '/overview') {
          return json(res, 200, {
            spaces: listSpacesDetailed(db),
            bindings: listBindings(db),
            sessions: listKnownSessions(db),
            queue: queueStats(db),
            wakeMaxPerHour: config.wakeMaxPerHour,
            defaultSpaceId: config.spaceId,
          })
        }
        if (method === 'POST' && path === '/spaces/create') {
          const name = String(body.name ?? '').trim()
          if (name === '') return json(res, 400, { error: 'SPACE_NAME_REQUIRED' })
          return json(res, 200, { space: createSpace(db, { ...body, name }) })
        }
        if (method === 'POST' && path === '/spaces/update') {
          const space = updateSpace(db, body)
          return space ? json(res, 200, { space }) : json(res, 404, { space: null, error: 'SPACE_NOT_FOUND' })
        }
        if (method === 'POST' && path === '/spaces/delete') {
          const result = deleteSpace(db, String(body.id ?? ''), { defaultSpaceId: config.spaceId })
          return json(res, result.deleted ? 200 : 409, result.deleted ? result : { ...result, error: result.reason })
        }
        if (method === 'GET' && path === '/memories') {
          const spaceId = url.searchParams.get('spaceId') ?? ''
          if (spaceId === '') return json(res, 400, { error: 'SPACE_ID_REQUIRED', memories: [], total: 0 })
          const dimension = url.searchParams.get('dimension') || undefined
          if (dimension !== undefined && !MEMORY_DIMENSIONS.includes(dimension)) {
            return json(res, 400, { error: 'INVALID_DIMENSION', memories: [], total: 0 })
          }
          const limit = Number(url.searchParams.get('limit') ?? 100)
          const offset = Number(url.searchParams.get('offset') ?? 0)
          const memories = listMemories(db, { spaceId, dimension, limit, offset })
          return json(res, 200, {
            memories,
            total: countActiveMemories(db, spaceId, dimension),
            limit: Math.min(Math.max(Number(limit) || 100, 1), 200),
            offset: Math.max(Number(offset) || 0, 0),
            dimension: dimension ?? null,
          })
        }
        if (method === 'POST' && path === '/memories/delete') {
          // Human callers may never modify memory: writes are the central memory
          // manager's job and go through the admin tools only.
          return json(res, 403, { deleted: false, error: 'MEMORY_READ_ONLY' })
        }
        if (method === 'POST' && path === '/bind') {
          const role = String(body.role ?? 'main')
          // Admin identity is deployment config (adminSessionIds) or an existing bound
          // role. The unauthenticated loopback UI must not be able to mint an admin.
          if (role === 'admin') return json(res, 403, { bound: false, error: 'ADMIN_ROLE_IS_CONFIG_ONLY' })
          if (!['main', 'sub'].includes(role)) return json(res, 400, { bound: false, error: 'INVALID_ROLE' })
          const result = bindSessionToSpace(db, { sessionId: body.sessionId, spaceId: body.spaceId, role })
          return json(res, result.bound ? 200 : 404, result.bound ? result : { ...result, error: result.reason })
        }
        if (method === 'POST' && path === '/unbind') {
          const result = unbindSessionFromSpace(db, body)
          return json(res, result.unbound ? 200 : 404, result.unbound ? result : { ...result, error: 'BINDING_NOT_FOUND' })
        }
        if (method === 'GET' && path === '/queue') {
          const status = url.searchParams.get('status') || undefined
          if (status !== undefined && status !== '' && !QUEUE_STATUSES.includes(status)) {
            return json(res, 400, { error: 'INVALID_STATUS', stats: queueStats(db), items: [] })
          }
          const sourceSessionId = url.searchParams.get('sourceSessionId') || undefined
          const limit = Number(url.searchParams.get('limit') ?? 50)
          const offset = Number(url.searchParams.get('offset') ?? 0)
          const listing = listQueueItems(db, {
            status: status || undefined,
            sourceSessionId,
            limit,
            offset,
            staleMinutes: config.queueStaleMinutes,
            maxRetries: config.queueMaxRetries,
          })
          return json(res, 200, {
            stats: queueStats(db),
            ...listing,
            limit: Math.min(Math.max(Number(limit) || 50, 1), 200),
            offset: Math.max(Number(offset) || 0, 0),
          })
        }
        if (method === 'GET' && path.startsWith('/queue/')) {
          const item = getQueueItem(db, decodeURIComponent(path.slice('/queue/'.length)))
          return item === null ? json(res, 404, { error: 'QUEUE_ITEM_NOT_FOUND' }) : json(res, 200, { item })
        }
        if (method === 'GET' && path === '/inbox') {
          const targetSessionId = url.searchParams.get('targetSessionId') ?? undefined
          const status = url.searchParams.get('status') || 'pending'
          if (!['pending', 'read', 'failed', 'all'].includes(status)) {
            return json(res, 400, { error: 'INVALID_STATUS', messages: [] })
          }
          return json(res, 200, { messages: listInbox(db, { targetSessionId, status }) })
        }
        if (method === 'POST' && path === '/inbox/send') {
          const targetSessionId = String(body.targetSessionId ?? '').trim()
          const content = String(body.content ?? '').trim()
          if (targetSessionId === '' || content === '') return json(res, 400, { error: 'TARGET_AND_CONTENT_REQUIRED' })
          const known = listKnownSessions(db).find((row) => row.sessionId === body.sourceSessionId)
          const inbox = sendInbox(db, {
            spaceId: String(body.spaceId || known?.links[0]?.spaceId || config.spaceId),
            sourceSessionId: body.sourceSessionId ?? null,
            targetSessionId,
            content,
          })
          // A duplicate row must not be delivered twice: the first send already took
          // effect, so report it instead of injecting the same text again.
          if (inbox.deduped) {
            return json(res, 200, {
              inboxId: inbox.id,
              deduped: true,
              delivery: { mode: 'duplicate', targetSessionId },
            })
          }
          const delivery = deliverInbox(ctx, {
            db,
            targetSessionId,
            content,
            wake: body.wake === true,
            maxPerHour: config.wakeMaxPerHour,
            globalMaxPerHour: config.wakeGlobalMaxPerHour,
            cooldownMinutes: config.wakeCooldownMinutes,
            inboxId: inbox.id,
            sourceSessionId: body.sourceSessionId ?? null,
            tracker: inboxTracker,
            hop: 0,
          })
          return json(res, 200, { inboxId: inbox.id, deduped: false, delivery })
        }
        if (method === 'POST' && path === '/inbox/ack') {
          const result = acknowledgeInbox(db, String(body.id ?? ''))
          return json(res, result.acknowledged ? 200 : 409, result.acknowledged ? result : { ...result, error: 'NOT_PENDING' })
        }
        return json(res, 404, { error: 'UNKNOWN_ROUTE', method, path })
      } catch (error) {
        warn(error)
        return json(res, 500, { error: String(error?.message ?? error) })
      }
    },
  }
  return registerRoute(ctx, route, { events, warn })
}
