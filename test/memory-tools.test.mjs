/**
 * M3 permission model and write path.
 *
 * The tools are plain definitions, so the tests call `execute(args, exec)` directly
 * with the host-injected identity — exactly what the runtime passes.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { resolveConfig } from '../src/config.js'
import { bindSessionSpaces, ensureDefaultSpace, openStore } from '../src/db.js'
import { createInboxTracker } from '../src/inbox-tracker.js'
import { sendInbox } from '../src/inbox.js'
import { createMemoryTools, sessionBinding } from '../src/memory-tools.js'

const MAIN = 'session-main'
const ADMIN = 'session-admin'
const SPACE = 'space-default'
const OTHER_SPACE = 'space-other'

function fixture(t, config = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-array-tools-'))
  const resolved = resolveConfig({ dataDir, spaceId: SPACE, ...config })
  const opened = openStore(resolved)
  ensureDefaultSpace(opened.db, resolved)
  opened.db.prepare('INSERT OR IGNORE INTO memory_spaces (id, name, description) VALUES (?, ?, ?)').run(OTHER_SPACE, 'Other', '')

  bindSessionSpaces(opened.db, MAIN, [SPACE], 'main')
  bindSessionSpaces(opened.db, ADMIN, [SPACE], 'admin')

  const tools = createMemoryTools({
    db: opened.db,
    embedPassage: async (text) => {
      const vec = new Float32Array(384)
      vec[0] = text.length % 7
      vec[1] = 1
      return vec
    },
    config: { queueStaleMinutes: 10, queueMaxRetries: 3, ...config },
  })
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))

  t.after(() => {
    opened.close()
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  return { db: opened.db, byName, config: resolved }
}

const asMain = { agent: { id: MAIN } }
const asAdmin = { agent: { id: ADMIN } }
const asStranger = { agent: { id: 'session-nobody' } }

test('sessionBinding reports the frozen spaces and role', (t) => {
  const { db } = fixture(t)
  assert.deepEqual(sessionBinding(db, MAIN), { spaceIds: [SPACE], role: 'main' })
  assert.deepEqual(sessionBinding(db, ADMIN), { spaceIds: [SPACE], role: 'admin' })
  assert.deepEqual(sessionBinding(db, 'missing'), { spaceIds: [], role: null })
})

test('a normal session can only propose; it cannot claim or archive', async (t) => {
  const { db, byName } = fixture(t)
  const queued = await byName.memory_propose.execute(
    { raw_content: '用户偏好深色主题', note: 'from chat' },
    asMain,
  )
  assert.equal(queued.deduped, false)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0, 'propose never writes the store')

  const claim = await byName.memory_queue_claim.execute({}, asMain)
  assert.equal(claim.claimed, false)
  assert.equal(claim.reason, 'NOT_ADMIN')

  const archive = await byName.memory_archive.execute(
    { content: 'x', dimension: 'fact', spaceId: SPACE },
    asMain,
  )
  assert.equal(archive.error, 'NOT_ADMIN')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0)

  const settle = await byName.memory_queue_settle.execute({ queueId: queued.proposalId, status: 'rejected' }, asMain)
  assert.equal(settle.reason, 'NOT_ADMIN')
})

test('the admin claims, archives with a local embedding, and settles the queue', async (t) => {
  const { db, byName } = fixture(t)
  const queued = await byName.memory_propose.execute({ raw_content: '生产库禁止直接 DDL' }, asMain)

  const claim = await byName.memory_queue_claim.execute({}, asAdmin)
  assert.equal(claim.claimed, true)
  assert.equal(claim.item.queueId, queued.proposalId)
  assert.equal(claim.item.sourceSessionId, MAIN)

  const archived = await byName.memory_archive.execute(
    {
      content: '生产库禁止直接 DDL；变更走迁移脚本。',
      dimension: 'fact',
      spaceId: SPACE,
      queueId: claim.item.queueId,
    },
    asAdmin,
  )
  assert.equal(archived.error, undefined)
  assert.equal(archived.embedded, true)
  assert.equal(archived.queueSettled, true)

  const row = db.prepare('SELECT space_id, dimension, content, embedding, source_session_id FROM memories WHERE id = ?').get(archived.memoryId)
  assert.equal(row.space_id, SPACE)
  assert.equal(row.dimension, 'fact')
  assert.equal(row.source_session_id, ADMIN)
  assert.notEqual(row.embedding, null)

  const queueRow = db.prepare('SELECT status FROM memory_queue WHERE id = ?').get(claim.item.queueId)
  assert.equal(queueRow.status, 'done')
})

test('archive refuses a space the manager is not bound to', async (t) => {
  const { db, byName } = fixture(t)
  const archived = await byName.memory_archive.execute(
    { content: 'x', dimension: 'fact', spaceId: OTHER_SPACE },
    asAdmin,
  )
  assert.equal(archived.error, 'SPACE_NOT_BOUND')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0)
})

test('supersede points at the old memory and rolls back a failed one', async (t) => {
  const { db, byName } = fixture(t)
  const old = await byName.memory_archive.execute(
    { content: '接口超时设置为 30s', dimension: 'fact', spaceId: SPACE },
    asAdmin,
  )
  const replaced = await byName.memory_archive.execute(
    { content: '接口超时设置为 60s（旧值 30s 已过时）', dimension: 'fact', spaceId: SPACE, supersedesId: old.memoryId },
    asAdmin,
  )
  assert.equal(replaced.supersededId, old.memoryId)
  const oldRow = db.prepare('SELECT superseded_by FROM memories WHERE id = ?').get(old.memoryId)
  assert.equal(oldRow.superseded_by, replaced.memoryId)

  // Superseding an already-superseded id must fail and roll the new row back.
  const before = db.prepare('SELECT COUNT(*) AS n FROM memories').get().n
  const failed = await byName.memory_archive.execute(
    { content: '再改一次', dimension: 'fact', spaceId: SPACE, supersedesId: old.memoryId },
    asAdmin,
  )
  assert.match(String(failed.error), /cannot supersede/)
  assert.equal(failed.memoryId, '')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, before, 'rolled back')
})

test('an embedder failure still archives, reporting embedded:false', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-array-tools-'))
  const resolved = resolveConfig({ dataDir, spaceId: SPACE })
  const opened = openStore(resolved)
  ensureDefaultSpace(opened.db, resolved)
  bindSessionSpaces(opened.db, ADMIN, [SPACE], 'admin')
  t.after(() => {
    opened.close()
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const [archive] = createMemoryTools({
    db: opened.db,
    embedPassage: async () => {
      throw new Error('EMBEDDER_UNAVAILABLE')
    },
    config: {},
  }).filter((tool) => tool.name === 'memory_archive')

  const result = await archive.execute({ content: 'still stored', dimension: 'fact', spaceId: SPACE }, asAdmin)
  assert.equal(result.embedded, false)
  assert.notEqual(result.memoryId, '')
})

test('adminSessionIds grants the write path without a bound admin role', async (t) => {
  const { db, byName } = fixture(t, { adminSessionIds: [MAIN] })
  const queued = await byName.memory_propose.execute({ raw_content: '配置驱动的管理员' }, asMain)
  const claim = await byName.memory_queue_claim.execute({}, asMain)
  assert.equal(claim.claimed, true)
  const archived = await byName.memory_archive.execute(
    { content: '配置驱动的管理员也可以入库', dimension: 'working', spaceId: SPACE, queueId: queued.proposalId },
    asMain,
  )
  assert.equal(archived.error, undefined)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 1)
})

test('memory_queue_stats is admin-only and counts each status', async (t) => {
  const { byName } = fixture(t)
  await byName.memory_propose.execute({ raw_content: 'a' }, asMain)
  await byName.memory_propose.execute({ raw_content: 'b' }, asMain)

  const denied = await byName.memory_queue_stats.execute({}, asStranger)
  assert.equal(denied.error, 'NOT_ADMIN')

  const stats = await byName.memory_queue_stats.execute({}, asAdmin)
  assert.equal(stats.pending, 2)
  assert.equal(stats.total, 2)
})

test('memory_bind binds the caller and refuses an admin role to a non-admin', async (t) => {
  const { db, byName } = fixture(t)
  const space = await byName.memory_archive.execute({ content: 'x', dimension: 'fact', spaceId: OTHER_SPACE }, asAdmin)
  assert.equal(space.error, 'SPACE_NOT_BOUND')

  // The admin is bound only to SPACE; OTHER_SPACE is bindable by the admin itself.
  const bound = await byName.memory_bind.execute({ spaceId: OTHER_SPACE }, asAdmin)
  assert.equal(bound.bound, true)
  assert.equal(bound.role, 'main')
  assert.equal(sessionBinding(db, ADMIN).spaceIds.includes(OTHER_SPACE), true)

  const escalate = await byName.memory_bind.execute({ spaceId: SPACE, role: 'admin' }, asMain)
  assert.equal(escalate.error, 'ADMIN_REQUIRES_ADMIN')

  const unbound = await byName.memory_unbind.execute({ spaceId: OTHER_SPACE }, asAdmin)
  assert.equal(unbound.unbound, true)
})

test('inbox tools queue for another session and read own messages', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-array-tools-'))
  const resolved = resolveConfig({ dataDir, spaceId: SPACE })
  const opened = openStore(resolved)
  ensureDefaultSpace(opened.db, resolved)
  bindSessionSpaces(opened.db, MAIN, [SPACE], 'main')
  bindSessionSpaces(opened.db, ADMIN, [SPACE], 'admin')
  t.after(() => {
    opened.close()
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const calls = { inject: 0, followup: 0 }
  const targetAgent = {
    inject() {
      calls.inject += 1
    },
    followup() {
      calls.followup += 1
    },
  }
  const ctx = { get: (name) => (name === 'agents' ? { get: (id) => (id === ADMIN ? targetAgent : undefined) } : undefined) }
  const tools = createMemoryTools({ db: opened.db, embedPassage: null, config: {}, ctx })
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))

  const sent = await byName.inbox_send.execute(
    { targetSessionId: ADMIN, content: 'remember the deploy window', wake: true },
    asMain,
  )
  assert.equal(sent.delivery, 'woke')
  assert.equal(calls.followup, 1)

  const listed = await byName.inbox_list.execute({}, asAdmin)
  assert.equal(listed.messages.length, 1)
  assert.equal(listed.messages[0].source_session_id, MAIN)

  const acked = await byName.inbox_ack.execute({ inboxId: listed.messages[0].id }, asAdmin)
  assert.equal(acked.acknowledged, true)
  assert.equal((await byName.inbox_list.execute({}, asAdmin)).messages.length, 0)
})

test('hop ceiling, per-turn wake budget and inbox visibility follow the design', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-array-tools-'))
  const resolved = resolveConfig({ dataDir, spaceId: SPACE })
  const opened = openStore(resolved)
  ensureDefaultSpace(opened.db, resolved)
  bindSessionSpaces(opened.db, MAIN, [SPACE], 'main')
  bindSessionSpaces(opened.db, ADMIN, [SPACE], 'admin')
  bindSessionSpaces(opened.db, 'session-sub', [SPACE], 'sub')
  t.after(() => {
    opened.close()
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const calls = { inject: 0, followup: 0 }
  const targetAgent = {
    id: 'target',
    inject() {
      calls.inject += 1
    },
    followup() {
      calls.followup += 1
    },
  }
  const ctx = { get: (name) => (name === 'agents' ? { get: (id) => (id === 'target' ? targetAgent : undefined) } : undefined) }
  const tracker = createInboxTracker({ db: opened.db })
  const tools = createMemoryTools({ db: opened.db, embedPassage: null, config: {}, ctx, inboxTracker: tracker })
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))

  // --- hop ceiling: a sender already at hop 3 cannot forward -------------
  const seed = sendInbox(opened.db, { spaceId: SPACE, sourceSessionId: 's0', targetSessionId: MAIN, content: 'seed' })
  tracker.noteDelivery({ targetSessionId: MAIN, inboxId: seed.id, hop: 3, content: 'seed' })
  tracker.onClaimed({ agent: { id: MAIN }, message: { role: 'user', content: [{ type: 'text', text: 'seed' }] }, turn: 1 })
  const refused = await byName.inbox_send.execute({ targetSessionId: 'target', content: 'forward' }, asMain)
  assert.equal(refused.error, 'HOP_LIMIT')

  // A sender inside an inbox-triggered turn forwards with hop 1 and gets a wake; a
  // second wake in the same turn is downgraded to a queued inject.
  tracker.onTurnStopping({ agent: { id: MAIN } })
  const trigger = sendInbox(opened.db, { spaceId: SPACE, sourceSessionId: 's0', targetSessionId: MAIN, content: 'trigger' })
  tracker.noteDelivery({ targetSessionId: MAIN, inboxId: trigger.id, hop: 0, content: 'trigger' })
  tracker.onClaimed({ agent: { id: MAIN }, message: { role: 'user', content: [{ type: 'text', text: 'trigger' }] }, turn: 2 })
  const first = await byName.inbox_send.execute({ targetSessionId: 'target', content: 'one', wake: true }, asMain)
  assert.equal(first.delivery, 'woke')
  assert.equal(first.hop, 1)
  const second = await byName.inbox_send.execute({ targetSessionId: 'target', content: 'two', wake: true }, asMain)
  assert.equal(second.delivery, 'throttled')
  assert.equal(second.reason, 'per-source-turn')
  assert.equal(calls.followup, 1, 'only one wake for the source in this turn')

  // --- visibility: main reads messages in bound spaces, sub only its own --
  sendInbox(opened.db, { spaceId: SPACE, sourceSessionId: 'other', targetSessionId: 'someone-else', content: 'broadcast' })
  const mainMessages = await byName.inbox_list.execute({ status: 'all' }, asMain)
  assert.ok(mainMessages.messages.some((row) => row.content === 'broadcast'), 'main reads its space messages')

  const subMessages = await byName.inbox_list.execute({ status: 'all' }, { agent: { id: 'session-sub' } })
  assert.equal(subMessages.messages.some((row) => row.content === 'broadcast'), false, 'sub does not read other targets')
})

test('rejections must use the prompt reason enum', async (t) => {
  const { byName } = fixture(t)
  const queued = await byName.memory_propose.execute({ raw_content: '你好呀' }, { agent: { id: MAIN } })
  const claim = await byName.memory_queue_claim.execute({}, { agent: { id: ADMIN } })
  assert.equal(claim.item.queueId, queued.proposalId)

  const invalid = await byName.memory_queue_settle.execute(
    { queueId: claim.item.queueId, status: 'rejected', reason: '随便写的' },
    { agent: { id: ADMIN } },
  )
  assert.equal(invalid.settled, false)
  assert.equal(invalid.reason, 'INVALID_REASON')
  assert.ok(invalid.acceptedReasons.includes('LOW_VALUE'))

  const valid = await byName.memory_queue_settle.execute(
    { queueId: claim.item.queueId, status: 'rejected', reason: 'LOW_VALUE' },
    { agent: { id: ADMIN } },
  )
  assert.equal(valid.settled, true)
})
