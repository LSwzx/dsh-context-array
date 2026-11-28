/**
 * M4 inbox: durable queue, delivery modes, and the wake throttle.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { resolveConfig } from '../src/config.js'
import { ensureDefaultSpace, openStore } from '../src/db.js'
import {
  DEFAULT_WAKE_MAX_PER_HOUR,
  acknowledgeInbox,
  deliverInbox,
  listInbox,
  noteWake,
  sendInbox,
  wakeCountLastHour,
} from '../src/inbox.js'

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-array-inbox-'))
  const config = resolveConfig({ dataDir })
  const opened = openStore(config)
  ensureDefaultSpace(opened.db, config)
  t.after(() => {
    opened.close()
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  return opened.db
}

function agentStub() {
  const calls = { inject: [], followup: [] }
  return {
    calls,
    agent: {
      inject(message) {
        calls.inject.push(message)
      },
      followup(message) {
        calls.followup.push(message)
      },
    },
  }
}

function fakeCtx(agentsById) {
  return { get: (name) => (name === 'agents' ? { get: (id) => agentsById[id] } : undefined) }
}

test('sendInbox dedupes identical (space, source, target, content) rows', (t) => {
  const db = fixture(t)
  const first = sendInbox(db, { spaceId: 'space-default', sourceSessionId: 's1', targetSessionId: 's2', content: 'hello' })
  const second = sendInbox(db, { spaceId: 'space-default', sourceSessionId: 's1', targetSessionId: 's2', content: 'hello' })
  assert.equal(first.deduped, false)
  assert.equal(second.deduped, true)
  assert.equal(second.id, first.id)
  assert.equal(listInbox(db, { targetSessionId: 's2' }).length, 1)
})

test('acknowledgeInbox only moves pending rows', (t) => {
  const db = fixture(t)
  const row = sendInbox(db, { spaceId: 'space-default', sourceSessionId: 's1', targetSessionId: 's2', content: 'read me' })
  assert.deepEqual(acknowledgeInbox(db, row.id), { acknowledged: true })
  assert.deepEqual(acknowledgeInbox(db, row.id), { acknowledged: false })
  assert.equal(listInbox(db, { targetSessionId: 's2', status: 'pending' }).length, 0)
  assert.equal(listInbox(db, { targetSessionId: 's2', status: 'read' }).length, 1)
})

test('deliverInbox is offline without a live agent, queued without wake, woke with wake', (t) => {
  const db = fixture(t)
  const offline = deliverInbox(fakeCtx({}), { db, targetSessionId: 's2', content: 'x' })
  assert.equal(offline.mode, 'offline')

  const { agent, calls } = agentStub()
  const ctx = fakeCtx({ s2: agent })
  const queued = deliverInbox(ctx, { db, targetSessionId: 's2', content: 'queued text' })
  assert.equal(queued.mode, 'queued')
  assert.equal(calls.inject.length, 1)
  assert.equal(calls.followup.length, 0)
  assert.equal(calls.inject[0].content[0].text, 'queued text')
  assert.equal(calls.inject[0].source.kind, 'context-array-inbox')

  const woke = deliverInbox(ctx, { db, targetSessionId: 's2', content: 'wake up', wake: true })
  assert.equal(woke.mode, 'woke')
  assert.equal(calls.followup.length, 1)
  assert.equal(wakeCountLastHour(db, 's2'), 1)
})

test('the wake throttle queues instead of waking after the hourly limit', (t) => {
  const db = fixture(t)
  const { agent, calls } = agentStub()
  const ctx = fakeCtx({ s2: agent })
  for (let index = 0; index < DEFAULT_WAKE_MAX_PER_HOUR; index += 1) {
    noteWake(db, { targetSessionId: 's2', sourceSessionId: 's1', inboxId: null, throttled: false })
  }
  assert.equal(wakeCountLastHour(db, 's2'), DEFAULT_WAKE_MAX_PER_HOUR)

  const result = deliverInbox(ctx, { db, targetSessionId: 's2', content: 'too many', wake: true })
  assert.equal(result.mode, 'throttled')
  assert.equal(calls.followup.length, 0)
  assert.equal(calls.inject.length, 1, 'still queued, just not woken')
  const throttled = db.prepare('SELECT COUNT(*) AS n FROM inbox_wake_log WHERE throttled = 1').get().n
  assert.equal(throttled, 1)
})

test('throttled wakes do not count against the hourly budget', (t) => {
  const db = fixture(t)
  const { agent } = agentStub()
  const ctx = fakeCtx({ s2: agent })
  noteWake(db, { targetSessionId: 's2', inboxId: null, throttled: true })
  noteWake(db, { targetSessionId: 's2', inboxId: null, throttled: false })
  // Age the successful wake past the cooldown so this test isolates the hourly budget.
  db.prepare("UPDATE inbox_wake_log SET at = datetime('now', '-30 minutes') WHERE throttled = 0").run()
  assert.equal(wakeCountLastHour(db, 's2'), 1)
  assert.equal(deliverInbox(ctx, { db, targetSessionId: 's2', content: 'ok', wake: true }).mode, 'woke')
})

test('a second wake inside the cooldown window is throttled to a queue', (t) => {
  const db = fixture(t)
  const { agent, calls } = agentStub()
  const ctx = fakeCtx({ s2: agent })
  assert.equal(deliverInbox(ctx, { db, targetSessionId: 's2', content: 'first', wake: true }).mode, 'woke')
  const second = deliverInbox(ctx, { db, targetSessionId: 's2', content: 'second', wake: true, cooldownMinutes: 10 })
  assert.equal(second.mode, 'throttled')
  assert.equal(second.reason, 'cooldown')
  assert.equal(calls.followup.length, 1, 'only the first wake started a turn')
  assert.equal(calls.inject.length, 1, 'the throttled message is still queued')
})

test('the global hourly wake budget throttles even a first wake for a target', (t) => {
  const db = fixture(t)
  const { agent, calls } = agentStub()
  const ctx = fakeCtx({ s3: agent })
  for (let index = 0; index < 2; index += 1) {
    noteWake(db, { targetSessionId: 'other-' + index, inboxId: null, throttled: false })
    db.prepare("UPDATE inbox_wake_log SET at = datetime('now', '-5 minutes')").run()
  }
  const result = deliverInbox(ctx, { db, targetSessionId: 's3', content: 'hi', wake: true, globalMaxPerHour: 2 })
  assert.equal(result.mode, 'throttled')
  assert.equal(result.reason, 'global')
  assert.equal(calls.followup.length, 0)
  assert.equal(calls.inject.length, 1)
})

test('inbox dedupe allows resending the same text in a later hour', (t) => {
  const db = fixture(t)
  const early = new Date('2026-11-28T01:05:00Z')
  const later = new Date('2026-11-28T02:05:00Z')
  const first = sendInbox(db, { spaceId: 'space-default', sourceSessionId: 's1', targetSessionId: 's2', content: 'ping', now: early })
  const sameHour = sendInbox(db, { spaceId: 'space-default', sourceSessionId: 's1', targetSessionId: 's2', content: 'ping', now: early })
  const nextHour = sendInbox(db, { spaceId: 'space-default', sourceSessionId: 's1', targetSessionId: 's2', content: 'ping', now: later })
  assert.equal(first.deduped, false)
  assert.equal(sameHour.deduped, true)
  assert.equal(nextHour.deduped, false)
  assert.notEqual(nextHour.id, first.id)
})

test('listInbox exposes hop_count and the throttled wake marker', (t) => {
  const db = fixture(t)
  const row = sendInbox(db, { spaceId: 'space-default', sourceSessionId: 's1', targetSessionId: 's2', content: 'hop' })
  db.prepare('UPDATE inbox SET hop_count = 2 WHERE id = ?').run(row.id)
  noteWake(db, { targetSessionId: 's2', sourceSessionId: 's1', inboxId: row.id, throttled: true })

  const [pending] = listInbox(db, { targetSessionId: 's2' })
  assert.equal(pending.hop_count, 2)
  assert.equal(pending.last_wake_throttled, 1)
  assert.equal(pending.space_name, 'Default space')

  assert.equal(listInbox(db, { status: 'all' }).length, 1, 'status=all must not filter')
  assert.equal(listInbox(db, { status: 'read' }).length, 0)
})

