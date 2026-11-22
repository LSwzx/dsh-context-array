/**
 * Compaction takeover (M0-6) and history-replacement detection (M1-4).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installCompactionTakeover, installHistoryReplacementWatch, createCompactionProvider } from '../src/compaction.js'

function createEvents() {
  const records = []
  return { records, append: (record) => records.push(record) }
}

function createHost({ provideThrows, pressureTokens, pressureThrows, now } = {}) {
  const provided = []
  const listeners = new Map()
  const ctx = {
    provide(name, value) {
      if (provideThrows) throw new Error('INACTIVE_EFFECT: name already provided')
      provided.push({ name, value })
      return () => {}
    },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {}
    },
    get(name) {
      if (name !== 'tokenMeter') return undefined
      return {
        contextPressure: (session) => {
          if (pressureThrows) throw new Error('tokenMeter exploded')
          return pressureTokens === undefined
            ? {}
            : { pressureTokens, contextWindow: 1_048_576 }
        },
      }
    },
  }
  return { ctx, provided, listeners }
}

/** Stand-in for the loop's built-in `agent/pre-step` behaviour. */
const ENTER = { kind: 'enter', messages: [{ id: 'claimed' }] }
const inner = () => ENTER

/** Run one waterfall pre-step, counting how often `next()` reached the inner. */
function runPreStep(preStep, payload) {
  let calls = 0
  const result = preStep(payload, () => {
    calls += 1
    return inner()
  })
  return { calls, result }
}

test('off mode claims nothing', () => {
  const events = createEvents()
  const host = createHost()
  const result = installCompactionTakeover({
    ctx: host.ctx,
    config: { compactionMode: 'off', compactionWarnTokens: 1 },
    events,
  })
  assert.equal(result.installed, false)
  assert.equal(result.reason, 'off')
  assert.equal(host.provided.length, 0)
  assert.equal(events.records.length, 0)
})

test('observe mode provides the compaction seam exactly once', () => {
  const events = createEvents()
  const host = createHost()
  const result = installCompactionTakeover({
    ctx: host.ctx,
    config: { compactionMode: 'observe', compactionWarnTokens: 1 },
    events,
  })
  assert.equal(result.installed, true)
  assert.equal(host.provided.length, 1)
  assert.equal(host.provided[0].name, 'compaction')
  const provider = host.provided[0].value
  assert.equal(typeof provider.compactIfNeeded, 'function')
  assert.equal(typeof provider.compactNow, 'function')
  assert.equal(typeof provider.compactRegion, 'function')
  assert.deepEqual(
    events.records.map((record) => record.type),
    ['compaction/provider-installed'],
  )
})

test('the observe provider never folds and reports what it saw', async () => {
  const events = createEvents()
  const provider = createCompactionProvider({ mode: 'observe', events })
  assert.equal(await provider.compactIfNeeded({ id: 's1' }, 'pressure'), null)
  assert.equal(await provider.compactNow({ id: 's1' }), null)
  await assert.rejects(() => provider.compactRegion(1, 2, { id: 's1' }), /not implemented/)
  assert.deepEqual(
    events.records.map((record) => record.trigger),
    ['pressure', 'manual'],
  )
})

test('a seam owned by someone else is reported, not swallowed', () => {
  const events = createEvents()
  const host = createHost({ provideThrows: true })
  const result = installCompactionTakeover({
    ctx: host.ctx,
    config: { compactionMode: 'observe', compactionWarnTokens: 1 },
    events,
  })
  assert.equal(result.installed, false)
  assert.equal(result.reason, 'conflict')
  assert.equal(events.records[0].type, 'compaction/provider-conflict')
})

test('pressure below the warn threshold is not logged', () => {
  const events = createEvents()
  const host = createHost({ pressureTokens: 100 })
  installCompactionTakeover({
    ctx: host.ctx,
    config: { compactionMode: 'observe', compactionWarnTokens: 1000 },
    events,
  })
  const [preStep] = host.listeners.get('agent/pre-step')
  runPreStep(preStep, { agent: { id: 's1', session: {} } })
  assert.equal(events.records.filter((record) => record.type === 'compaction/pressure').length, 0)
})

test('pressure above the threshold is logged once per session per minute', () => {
  const events = createEvents()
  let clock = 1_000_000
  const host = createHost({ pressureTokens: 500_000 })
  installCompactionTakeover({
    ctx: host.ctx,
    config: { compactionMode: 'observe', compactionWarnTokens: 400_000 },
    events,
    now: () => clock,
  })
  const [preStep] = host.listeners.get('agent/pre-step')
  runPreStep(preStep, { agent: { id: 's1', session: {} } })
  runPreStep(preStep, { agent: { id: 's1', session: {} } })
  clock += 61_000
  runPreStep(preStep, { agent: { id: 's1', session: {} } })

  const samples = events.records.filter((record) => record.type === 'compaction/pressure')
  assert.equal(samples.length, 2)
  assert.equal(samples[0].pressureTokens, 500_000)
  assert.equal(samples[0].contextWindow, 1_048_576)
})

// Regression: `agent/pre-step` is a waterfall. A listener that returns without
// calling `next()` vetoes the chain, so the loop gets `undefined` instead of a
// decision and the whole turn fails on `decision.kind`.
test('the sampler never vetoes the pre-step waterfall', () => {
  const events = createEvents()
  const host = createHost({ pressureTokens: 500_000 })
  installCompactionTakeover({
    ctx: host.ctx,
    config: { compactionMode: 'observe', compactionWarnTokens: 1000 },
    events,
  })
  const [preStep] = host.listeners.get('agent/pre-step')

  for (const payload of [
    undefined,
    {},
    { agent: undefined },
    { agent: { id: 's1', session: {} } },
  ]) {
    const { calls, result } = runPreStep(preStep, payload)
    assert.equal(calls, 1, 'next() must run exactly once')
    assert.equal(result, ENTER, 'the inner decision must reach the loop')
  }
})

test('a sampler that throws still delegates and reports once', () => {
  const events = createEvents()
  const errors = []
  const host = createHost({ pressureThrows: true })
  installCompactionTakeover({
    ctx: host.ctx,
    config: { compactionMode: 'observe', compactionWarnTokens: 1000 },
    events,
    warn: (error) => errors.push(error),
  })
  const [preStep] = host.listeners.get('agent/pre-step')
  const { calls, result } = runPreStep(preStep, { agent: { id: 's1', session: {} } })
  assert.equal(calls, 1)
  assert.equal(result, ENTER)
  assert.equal(errors.length, 1)
})

test('history replacement is recorded from session events', () => {
  const events = createEvents()
  const host = createHost()
  installHistoryReplacementWatch({ ctx: host.ctx, events })
  const [sessionEvent] = host.listeners.get('session/event')

  sessionEvent({ id: 's1' }, { type: 'user/message', seq: 42, surfaceOp: { op: 'replace', startSeq: 10, endSeq: 20 }, sourceEventSeqs: [11, 12] })
  sessionEvent({ id: 's1' }, { type: 'user/message', seq: 43 })
  assert.equal(events.records.length, 1)
  assert.equal(events.records[0].type, 'history/replace')
  assert.equal(events.records[0].startSeq, 10)
  assert.equal(events.records[0].endSeq, 20)
  assert.equal(events.records[0].sourceEvents, 2)
})
