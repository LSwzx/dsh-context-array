/**
 * Inbox hop tracking: claimed→read, hop propagation with the 3-hop ceiling, and the
 * one-wake-per-source-per-turn budget.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { resolveConfig } from '../src/config.js'
import { ensureDefaultSpace, openStore } from '../src/db.js'
import { MAX_HOP_COUNT, createInboxTracker } from '../src/inbox-tracker.js'
import { sendInbox } from '../src/inbox.js'

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-array-tracker-'))
  const config = resolveConfig({ dataDir })
  const opened = openStore(config)
  ensureDefaultSpace(opened.db, config)
  t.after(() => {
    opened.close()
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  return opened.db
}

const message = (text) => ({ role: 'user', content: [{ type: 'text', text }] })

test('claiming a delivered message marks it read and opens a hop trigger', (t) => {
  const db = fixture(t)
  const tracker = createInboxTracker({ db })
  const row = sendInbox(db, { spaceId: 'space-default', sourceSessionId: 's1', targetSessionId: 's2', content: 'hello' })
  tracker.noteDelivery({ targetSessionId: 's2', inboxId: row.id, hop: 0, content: 'hello' })

  const record = tracker.onClaimed({ agent: { id: 's2' }, message: message('hello'), turn: 1 })
  assert.equal(record.inboxId, row.id)
  assert.equal(db.prepare('SELECT status FROM inbox WHERE id = ?').get(row.id).status, 'read')
  assert.deepEqual(tracker.nextHop('s2'), { hop: 1, triggerMsgId: row.id })
})

test('hop count stops at the ceiling', (t) => {
  const db = fixture(t)
  const tracker = createInboxTracker({ db })
  const first = sendInbox(db, { spaceId: 'space-default', sourceSessionId: 's1', targetSessionId: 's2', content: 'm0' })
  tracker.noteDelivery({ targetSessionId: 's2', inboxId: first.id, hop: 0, content: 'm0' })
  tracker.onClaimed({ agent: { id: 's2' }, message: message('m0'), turn: 1 })

  let hop = 0
  for (let index = 1; index <= MAX_HOP_COUNT; index += 1) {
    const next = tracker.nextHop('s2')
    assert.equal(next.hop, hop + 1)
    hop = next.hop
    const row = sendInbox(db, {
      spaceId: 'space-default',
      sourceSessionId: 's2',
      targetSessionId: 's3',
      content: 'm' + index,
    })
    tracker.noteDelivery({ targetSessionId: 's2', inboxId: row.id, hop, content: 'm' + index })
    tracker.onClaimed({ agent: { id: 's2' }, message: message('m' + index), turn: index + 1 })
  }
  assert.equal(tracker.nextHop('s2'), null, 'hop MAX+1 is refused')
})

test('one wake per source per turn and turn close clears the trigger', (t) => {
  const db = fixture(t)
  const tracker = createInboxTracker({ db })
  const row = sendInbox(db, { spaceId: 'space-default', sourceSessionId: 's1', targetSessionId: 's2', content: 'x' })
  tracker.noteDelivery({ targetSessionId: 's2', inboxId: row.id, hop: 0, content: 'x' })
  tracker.onClaimed({ agent: { id: 's2' }, message: message('x'), turn: 7 })

  assert.equal(tracker.consumeWake('s2'), true)
  assert.equal(tracker.consumeWake('s2'), false)
  tracker.onTurnStopping({ agent: { id: 's2' } })
  assert.equal(tracker.nextHop('s2').hop, 0, 'after the turn the sender is user-originated again')
  assert.equal(tracker.consumeWake('s2'), true)

  // A delivery without a matching claim does not open a trigger.
  tracker.noteDelivery({ targetSessionId: 's9', inboxId: 'x', hop: 0, content: 'noise' })
  assert.equal(tracker.nextHop('s9').hop, 0)
})
