/**
 * M4 HTTP API: routing, JSON shapes and the loopback + UI-header guard.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { resolveConfig } from '../src/config.js'
import { ensureDefaultSpace, openStore } from '../src/db.js'
import { registerContextArrayApi } from '../src/http-api.js'

function fixture(t, services = {}, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-array-api-'))
  const config = resolveConfig({ dataDir })
  const opened = openStore(config)
  ensureDefaultSpace(opened.db, config)

  let route = null
  const ctx = {
    get: (name) =>
      name === 'webServer'
        ? { register: (registered) => ((route = registered), () => {}) }
        : services[name],
  }
  registerContextArrayApi({
    ctx,
    db: opened.db,
    config,
    warn: () => {},
    updateChecker: extra.updateChecker,
    persona: {
      mode: 'observe',
      tools: ['web_search', 'web_fetch'],
      traits: ['Call yourself 肥鱼'],
      alerts: [{ at: '2026-11-28T00:00:00.000Z', tool: 'web_fetch', patterns: ['zh-ignore'] }],
    },
  })
  t.after(() => {
    opened.close()
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  return { route, db: opened.db }
}

/** One fake request/response pair; body is JSON for non-GET methods. */
function request(route, { method = 'GET', path: urlPath, body, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url: urlPath,
    headers,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  return new Promise((resolve) => {
    const res = {
      statusCode: 0,
      headers: undefined,
      body: '',
      writeHead(status, responseHeaders) {
        this.statusCode = status
        this.headers = responseHeaders
      },
      end(text) {
        this.body = text ?? ''
        resolve({ status: this.statusCode, json: this.body ? JSON.parse(this.body) : null })
      },
    }
    route.handler(req, res)
  })
}

test('the route is registered as a prefix and answers health', async (t) => {
  const { route } = fixture(t)
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/api/context-array')
  const response = await request(route, { path: '/api/context-array/health' })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
})

test('overview, spaces and memories round-trip through the API', async (t) => {
  const { route, db } = fixture(t)
  const created = await request(route, {
    method: 'POST',
    path: '/api/context-array/spaces/create',
    headers: { 'x-context-array-ui': '1' },
    body: { name: 'Work', description: 'facts' },
  })
  assert.equal(created.status, 200)
  const spaceId = created.json.space.id

  db.prepare('INSERT INTO memories (id, space_id, dimension, content, source_session_id) VALUES (?, ?, ?, ?, ?)').run(
    'mem-1',
    spaceId,
    'fact',
    'API memory',
    's1',
  )
  db.prepare('INSERT INTO session_space_links (session_id, space_id, role) VALUES (?, ?, ?)').run('s1', spaceId, 'main')

  const overview = await request(route, { path: '/api/context-array/overview' })
  assert.equal(overview.status, 200)
  assert.equal(overview.json.defaultSpaceId, 'space-default')
  assert.equal(overview.json.spaces.length, 2)
  assert.equal(overview.json.sessions[0].sessionId, 's1')

  const memories = await request(route, { path: `/api/context-array/memories?spaceId=${spaceId}` })
  assert.equal(memories.status, 200)
  assert.equal(memories.json.memories[0].content, 'API memory')

  const bound = await request(route, {
    method: 'POST',
    path: '/api/context-array/bind',
    headers: { 'x-context-array-ui': '1' },
    body: { sessionId: 's2', spaceId, role: 'main' },
  })
  assert.equal(bound.json.bound, true)

  const unbound = await request(route, {
    method: 'POST',
    path: '/api/context-array/unbind',
    headers: { 'x-context-array-ui': '1' },
    body: { sessionId: 's2', spaceId },
  })
  assert.equal(unbound.json.unbound, true)
})

test('writes require the UI header and loopback peers', async (t) => {
  const { route } = fixture(t)
  const missingHeader = await request(route, {
    method: 'POST',
    path: '/api/context-array/spaces/create',
    body: { name: 'Nope' },
  })
  assert.equal(missingHeader.status, 403)
  assert.equal(missingHeader.json.error, 'UI_HEADER_REQUIRED')

  const remote = await request(route, {
    method: 'POST',
    path: '/api/context-array/spaces/create',
    headers: { 'x-context-array-ui': '1' },
    body: { name: 'Nope' },
    remoteAddress: '10.0.0.5',
  })
  assert.equal(remote.status, 403)
  assert.equal(remote.json.error, 'LOCAL_ONLY')
})

test('inbox send and ack go through the API, and unknown routes are 404', async (t) => {
  const { route } = fixture(t)
  const sent = await request(route, {
    method: 'POST',
    path: '/api/context-array/inbox/send',
    headers: { 'x-context-array-ui': '1' },
    body: { targetSessionId: 'target-1', content: 'hi' },
  })
  assert.equal(sent.status, 200)
  assert.equal(sent.json.delivery.mode, 'offline')

  const inbox = await request(route, { path: '/api/context-array/inbox?status=pending' })
  assert.equal(inbox.json.messages.length, 1)
  assert.equal(inbox.json.messages[0].target_session_id, 'target-1')

  const acked = await request(route, {
    method: 'POST',
    path: '/api/context-array/inbox/ack',
    headers: { 'x-context-array-ui': '1' },
    body: { id: sent.json.inboxId },
  })
  assert.equal(acked.json.acknowledged, true)

  const unknown = await request(route, { path: '/api/context-array/nope' })
  assert.equal(unknown.status, 404)
})

test('delete refuses a non-empty space with 409', async (t) => {
  const { route, db } = fixture(t)
  const created = await request(route, {
    method: 'POST',
    path: '/api/context-array/spaces/create',
    headers: { 'x-context-array-ui': '1' },
    body: { name: 'Busy' },
  })
  const spaceId = created.json.space.id
  db.prepare('INSERT INTO memories (id, space_id, dimension, content, source_session_id) VALUES (?, ?, ?, ?, ?)').run(
    'mem-2',
    spaceId,
    'fact',
    'x',
    's1',
  )
  const refused = await request(route, {
    method: 'POST',
    path: '/api/context-array/spaces/delete',
    headers: { 'x-context-array-ui': '1' },
    body: { id: spaceId },
  })
  assert.equal(refused.status, 409)
  assert.equal(refused.json.reason, 'SPACE_NOT_EMPTY')
  assert.equal(refused.json.error, 'SPACE_NOT_EMPTY', 'client can render the failure without guessing')
})

test('business failures carry a readable error field instead of a silent 200', async (t) => {
  const { route } = fixture(t)
  const emptyName = await request(route, {
    method: 'POST',
    path: '/api/context-array/spaces/create',
    headers: { 'x-context-array-ui': '1' },
    body: { name: '   ' },
  })
  assert.equal(emptyName.status, 400)
  assert.equal(emptyName.json.error, 'SPACE_NAME_REQUIRED')

  const unknownSpace = await request(route, {
    method: 'POST',
    path: '/api/context-array/bind',
    headers: { 'x-context-array-ui': '1' },
    body: { sessionId: 's1', spaceId: 'space-missing', role: 'main' },
  })
  assert.equal(unknownSpace.status, 404)
  assert.equal(unknownSpace.json.bound, false)
  assert.equal(unknownSpace.json.error, 'SPACE_NOT_FOUND')

  const unknownBinding = await request(route, {
    method: 'POST',
    path: '/api/context-array/unbind',
    headers: { 'x-context-array-ui': '1' },
    body: { sessionId: 's1', spaceId: 'space-default' },
  })
  assert.equal(unknownBinding.status, 404)
  assert.equal(unknownBinding.json.error, 'BINDING_NOT_FOUND')

  const missingMemory = await request(route, {
    method: 'POST',
    path: '/api/context-array/memories/delete',
    headers: { 'x-context-array-ui': '1' },
    body: { id: 'mem-missing' },
  })
  assert.equal(missingMemory.status, 403)
  assert.equal(missingMemory.json.error, 'MEMORY_READ_ONLY', 'humans never delete memory through the UI API')
})

test('the UI cannot mint an admin binding', async (t) => {
  const { route } = fixture(t)
  const escalated = await request(route, {
    method: 'POST',
    path: '/api/context-array/bind',
    headers: { 'x-context-array-ui': '1' },
    body: { sessionId: 's1', spaceId: 'space-default', role: 'admin' },
  })
  assert.equal(escalated.status, 403)
  assert.equal(escalated.json.error, 'ADMIN_ROLE_IS_CONFIG_ONLY')
  assert.equal(escalated.json.bound, false)
})

test('a duplicate inbox send reports duplicate instead of delivering twice', async (t) => {
  const { route, db } = fixture(t)
  const body = { targetSessionId: 'target-2', content: 'same text' }
  const first = await request(route, {
    method: 'POST',
    path: '/api/context-array/inbox/send',
    headers: { 'x-context-array-ui': '1' },
    body,
  })
  const second = await request(route, {
    method: 'POST',
    path: '/api/context-array/inbox/send',
    headers: { 'x-context-array-ui': '1' },
    body,
  })
  assert.equal(first.json.deduped, false)
  assert.equal(second.json.deduped, true)
  assert.equal(second.json.delivery.mode, 'duplicate')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 1)
})

test('the picker lists persisted sessions (not only bound/live) with folded titles', async (t) => {
  const { route } = fixture(t, {
    sessionQuery: {
      listSessions: async () => [
        { header: { id: 'persisted-1', createdAt: 100 }, live: false, persisted: true },
        { header: { id: 'live-2', createdAt: 200 }, live: true, persisted: true },
        { header: { id: 'sub-1', createdAt: 300, origin: 'subagent' }, live: false, persisted: true },
        { header: { id: 'child-1', createdAt: 400, parentSession: 'persisted-1' }, live: false, persisted: true },
      ],
      readTitleSnapshots: async (ids) =>
        ids.map((id) => ({
          sessionId: id,
          status: 'fulfilled',
          value: { title: { title: id === 'persisted-1' ? '很久以前的会话' : '当前会话', source: { kind: 'provider' } } },
        })),
    },
  })
  const overview = await request(route, { path: '/api/context-array/overview' })
  assert.equal(overview.status, 200)
  const persisted = overview.json.sessions.find((row) => row.sessionId === 'persisted-1')
  assert.equal(persisted.title, '很久以前的会话')
  assert.equal(persisted.titleSource, 'provider')
  assert.equal(persisted.live, false)
  const live = overview.json.sessions.find((row) => row.sessionId === 'live-2')
  assert.equal(live.live, true)
  assert.equal(live.title, '当前会话')
  assert.equal(
    overview.json.sessions.some((row) => row.sessionId === 'sub-1' || row.sessionId === 'child-1'),
    false,
    'subagent sessions are not user sessions and stay out of the picker',
  )
})

test('overview sessions include live agents and host titles for the picker', async (t) => {
  const liveAgent = { id: 'live-1', session: {} }
  const { route } = fixture(t, {
    agents: { list: () => [liveAgent] },
    sessionTitle: { get: () => ({ title: '缓存实验' }) },
  })
  const overview = await request(route, { path: '/api/context-array/overview' })
  assert.equal(overview.status, 200)
  const live = overview.json.sessions.find((row) => row.sessionId === 'live-1')
  assert.equal(live.live, true)
  assert.equal(live.title, '缓存实验')
})

test('the persona endpoint exposes guard mode, traits and personality memories', async (t) => {
  const { route, db } = fixture(t)
  db.prepare('INSERT INTO memories (id, space_id, dimension, content, source_session_id) VALUES (?, ?, ?, ?, ?)').run(
    'persona-1',
    'space-default',
    'personality',
    'Prefers Chinese, calls the agent 肥鱼',
    's1',
  )
  const response = await request(route, { path: '/api/context-array/persona' })
  assert.equal(response.status, 200)
  assert.equal(response.json.mode, 'observe')
  assert.deepEqual(response.json.tools, ['web_search', 'web_fetch'])
  assert.deepEqual(response.json.traits, ['Call yourself 肥鱼'])
  assert.equal(response.json.alerts.length, 1)
  assert.equal(response.json.memories.length, 1)
  assert.match(response.json.memories[0].content, /肥鱼/)
  assert.deepEqual(response.json.profile, { text: '', updatedBy: null, updatedAt: null, scope: 'global' })
})

test('a human can edit persona for one chosen conversation', async (t) => {
  const { route } = fixture(t)
  const saved = await request(route, {
    method: 'POST',
    path: '/api/context-array/persona',
    headers: { 'x-context-array-ui': '1' },
    body: { sessionId: 'session-picked', text: '这个对话里我叫鱼鱼。' },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.profile.scope, 'session')
  assert.equal(saved.json.profile.text, '这个对话里我叫鱼鱼。')

  const read = await request(route, { path: '/api/context-array/persona?sessionId=session-picked' })
  assert.equal(read.json.profile.scope, 'session')
  assert.equal(read.json.profile.text, '这个对话里我叫鱼鱼。')
  assert.equal(read.json.own.text, '这个对话里我叫鱼鱼。')

  const other = await request(route, { path: '/api/context-array/persona?sessionId=session-other' })
  assert.equal(other.json.profile.scope, 'global')
  assert.equal(other.json.own, null)
})

test('a human can edit the global persona through the API', async (t) => {
  const { route } = fixture(t)
  const saved = await request(route, {
    method: 'POST',
    path: '/api/context-array/persona',
    headers: { 'x-context-array-ui': '1' },
    body: { text: '我叫肥鱼，称呼用户为老板。' },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.profile.text, '我叫肥鱼，称呼用户为老板。')
  assert.equal(saved.json.profile.updatedBy, 'human')

  const read = await request(route, { path: '/api/context-array/persona' })
  assert.equal(read.json.profile.text, '我叫肥鱼，称呼用户为老板。')

  const tooLong = await request(route, {
    method: 'POST',
    path: '/api/context-array/persona',
    headers: { 'x-context-array-ui': '1' },
    body: { text: 'x'.repeat(4001) },
  })
  assert.equal(tooLong.status, 400)
  assert.equal(tooLong.json.error, 'PERSONA_TOO_LONG')
})

test('the update endpoint reports status and installs the requested version', async (t) => {
  const installed = []
  const checker = {
    status: () => ({ current: '1.0.0', latest: '2.0.0', available: true, source: 'registry' }),
    check: async () => ({ current: '1.0.0', latest: '2.0.0', available: true, source: 'registry' }),
    install: async (version) => {
      installed.push(version)
      return { current: '1.0.0', latest: version, available: false, lastResult: { application: 'applied' } }
    },
  }
  const { route } = fixture(t, {}, { updateChecker: checker })
  const status = await request(route, { path: '/api/context-array/update' })
  assert.equal(status.status, 200)
  assert.equal(status.json.available, true)

  const installed2 = await request(route, {
    method: 'POST',
    path: '/api/context-array/update',
    headers: { 'x-context-array-ui': '1' },
    body: { version: '2.0.0' },
  })
  assert.equal(installed2.status, 200)
  assert.deepEqual(installed, ['2.0.0'])
  assert.equal(installed2.json.available, false)
})

test('memories support dimension filtering, paging and a total', async (t) => {
  const { route, db } = fixture(t)
  const insert = (id, dimension) =>
    db
      .prepare('INSERT INTO memories (id, space_id, dimension, content, source_session_id) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'space-default', dimension, id, 's1')
  insert('m-fact-1', 'fact')
  insert('m-fact-2', 'fact')
  insert('m-reflection', 'reflection')

  const all = await request(route, { path: '/api/context-array/memories?spaceId=space-default' })
  assert.equal(all.json.total, 3)
  assert.equal(all.json.memories.length, 3)
  assert.equal(all.json.dimension, null)

  const facts = await request(route, {
    path: '/api/context-array/memories?spaceId=space-default&dimension=fact&limit=1&offset=1',
  })
  assert.equal(facts.json.total, 2)
  assert.equal(facts.json.memories.length, 1)
  assert.equal(facts.json.dimension, 'fact')
  assert.equal(facts.json.limit, 1)
  assert.equal(facts.json.offset, 1)

  const missingSpace = await request(route, { path: '/api/context-array/memories' })
  assert.equal(missingSpace.status, 400)
  assert.equal(missingSpace.json.error, 'SPACE_ID_REQUIRED')

  const badDimension = await request(route, { path: '/api/context-array/memories?spaceId=space-default&dimension=nope' })
  assert.equal(badDimension.status, 400)
  assert.equal(badDimension.json.error, 'INVALID_DIMENSION')
})

test('the queue endpoint lists items, flags stuck claims, and serves full content', async (t) => {
  const { route, db } = fixture(t)
  const insert = (id, status, retryCount, claimedAt) =>
    db
      .prepare('INSERT INTO memory_queue (id, source_session_id, raw_content, status, retry_count, claimed_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 's1', 'x'.repeat(300), status, retryCount, claimedAt)
  insert('q-pending', 'pending', 0, null)
  insert('q-stuck', 'processing', 1, '2020-01-01 00:00:00')
  insert('q-failed', 'failed', 3, null)
  db.prepare('UPDATE memory_queue SET error = ? WHERE id = ?').run('SUPERSEDE_FAILED: nope', 'q-failed')

  const listing = await request(route, { path: '/api/context-array/queue' })
  assert.equal(listing.status, 200)
  assert.equal(listing.json.stats.total, 3)
  assert.equal(listing.json.items.length, 3)
  assert.equal(listing.json.stuckCount, 1)
  assert.equal(listing.json.stuckAfterSeconds, 600)
  assert.equal(listing.json.maxRetries, 3)
  assert.equal(listing.json.hasMore, false)

  const stuckItem = listing.json.items.find((item) => item.id === 'q-stuck')
  assert.equal(stuckItem.content_preview.length, 200)
  assert.equal(stuckItem.content_length, 300)
  assert.equal(stuckItem.claimed_ago_seconds > 600, true)

  const failedOnly = await request(route, { path: '/api/context-array/queue?status=failed' })
  assert.deepEqual(
    failedOnly.json.items.map((item) => item.id),
    ['q-failed'],
  )
  assert.match(failedOnly.json.items[0].error, /SUPERSEDE_FAILED/)

  const detail = await request(route, { path: '/api/context-array/queue/q-pending' })
  assert.equal(detail.status, 200)
  assert.equal(detail.json.item.raw_content.length, 300)
  const missing = await request(route, { path: '/api/context-array/queue/nope' })
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error, 'QUEUE_ITEM_NOT_FOUND')

  const badStatus = await request(route, { path: '/api/context-array/queue?status=weird' })
  assert.equal(badStatus.status, 400)
  assert.equal(badStatus.json.error, 'INVALID_STATUS')
})
