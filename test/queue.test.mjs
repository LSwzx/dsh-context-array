/**
 * Queue mechanics: dedupe, atomic claim, stale requeue, retry budget, settle.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { resolveConfig } from '../src/config.js'
import { openStore } from '../src/db.js'
import { claimNext, enqueueProposal, queueStats, settleClaim } from '../src/queue.js'

function store(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-array-queue-'))
  const opened = openStore(resolveConfig({ dataDir }))
  t.after(() => {
    opened.close()
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  return opened.db
}

const fixedNow = new Date('2026-11-22T08:00:00Z')

test('enqueue dedupes the same session+content inside one hour bucket', (t) => {
  const db = store(t)
  const first = enqueueProposal(db, { sourceSessionId: 's1', rawContent: '用户偏好深色主题', now: fixedNow })
  const second = enqueueProposal(db, { sourceSessionId: 's1', rawContent: '用户偏好深色主题', now: fixedNow })
  const other = enqueueProposal(db, { sourceSessionId: 's2', rawContent: '用户偏好深色主题', now: fixedNow })
  assert.equal(first.deduped, false)
  assert.equal(second.deduped, true)
  assert.equal(second.id, first.id)
  assert.equal(other.deduped, false)
  assert.notEqual(other.id, first.id)
  assert.equal(queueStats(db).pending, 2)
})

test('claimNext is atomic, oldest first, and increments retry_count', (t) => {
  const db = store(t)
  const a = enqueueProposal(db, { sourceSessionId: 's1', rawContent: 'a', now: fixedNow })
  const b = enqueueProposal(db, { sourceSessionId: 's1', rawContent: 'b', now: fixedNow })

  const first = claimNext(db, { staleMinutes: 10, maxRetries: 3 })
  assert.equal(first.id, a.id)
  assert.equal(first.retry_count, 1)
  assert.equal(first.status, undefined)

  const second = claimNext(db, { staleMinutes: 10, maxRetries: 3 })
  assert.equal(second.id, b.id)

  assert.equal(claimNext(db, { staleMinutes: 10, maxRetries: 3 }), null)
  const stats = queueStats(db)
  assert.equal(stats.processing, 2)
  assert.equal(stats.pending, 0)
})

test('a stale claim is returned to pending and can be claimed again', (t) => {
  const db = store(t)
  const item = enqueueProposal(db, { sourceSessionId: 's1', rawContent: 'stale', now: fixedNow })
  claimNext(db, { staleMinutes: 10, maxRetries: 3 })
  // Simulate a manager that died 30 minutes ago.
  db.prepare("UPDATE memory_queue SET claimed_at = datetime('now', '-30 minutes') WHERE id = ?").run(item.id)

  const reclaimed = claimNext(db, { staleMinutes: 10, maxRetries: 3 })
  assert.equal(reclaimed.id, item.id)
  assert.equal(reclaimed.retry_count, 2)
})

test('rows over the retry budget become failed and are not claimable', (t) => {
  const db = store(t)
  const item = enqueueProposal(db, { sourceSessionId: 's1', rawContent: 'poison', now: fixedNow })
  db.prepare('UPDATE memory_queue SET retry_count = 3 WHERE id = ?').run(item.id)

  assert.equal(claimNext(db, { staleMinutes: 10, maxRetries: 3 }), null)
  assert.equal(queueStats(db).failed, 1)
  assert.equal(queueStats(db).pending, 0)
})

test('settleClaim only moves processing rows and records the reason', (t) => {
  const db = store(t)
  const item = enqueueProposal(db, { sourceSessionId: 's1', rawContent: 'x', now: fixedNow })
  assert.equal(settleClaim(db, item.id, 'done'), false, 'pending rows are not settleable')

  claimNext(db, { staleMinutes: 10, maxRetries: 3 })
  assert.equal(settleClaim(db, item.id, 'rejected', { error: 'not worth keeping' }), true)
  const row = db.prepare('SELECT status, error, claimed_at FROM memory_queue WHERE id = ?').get(item.id)
  assert.equal(row.status, 'rejected')
  assert.equal(row.error, 'not worth keeping')
  assert.equal(row.claimed_at, null)

  assert.equal(settleClaim(db, item.id, 'done'), false, 'already terminal')
  assert.throws(() => settleClaim(db, item.id, 'processing'), /unsupported terminal status/)
})

test('queueStats reports every status and a total', (t) => {
  const db = store(t)
  const a = enqueueProposal(db, { sourceSessionId: 's1', rawContent: 'a', now: fixedNow })
  const b = enqueueProposal(db, { sourceSessionId: 's1', rawContent: 'b', now: fixedNow })
  enqueueProposal(db, { sourceSessionId: 's1', rawContent: 'c', now: fixedNow })
  claimNext(db, { staleMinutes: 10, maxRetries: 3 })
  settleClaim(db, a.id, 'done')
  claimNext(db, { staleMinutes: 10, maxRetries: 3 })
  settleClaim(db, b.id, 'rejected')
  const stats = queueStats(db)
  assert.equal(stats.total, 3)
  assert.equal(stats.pending, 1)
  assert.equal(stats.done, 1)
  assert.equal(stats.rejected, 1)
  assert.equal(stats.processing, 0)
})
