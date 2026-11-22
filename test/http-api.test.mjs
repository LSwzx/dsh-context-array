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

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-array-api-'))
  const config = resolveConfig({ dataDir })
  const opened = openStore(config)
  ensureDefaultSpace(opened.db, config)

  let route = null
  const ctx = {
    get: (name) => (name === 'webServer' ? { register: (registered) => ((route = registered), () => {}) } : undefined),
  }
  registerContextArrayApi({ ctx, db: opened.db, config, warn: () => {} })
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
  assert.equal(missingMemory.status, 404)
  assert.equal(missingMemory.json.error, 'MEMORY_NOT_FOUND')
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
