/**
 * Fold planning, durable commit shape, and the foldSession pipeline.
 *
 * The fake session mirrors only the surface of a real `Session` this module
 * touches: `events`, `eventAt`, `append(type, data, options?)`, `surface.nodes`,
 * `deriveEventMessage`, and `requestHeader`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { commitFold, foldSession, inspectEntryState, planFold, summarize } from '../src/compaction-fold.js'

const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-flash'

/** Build a session with three complete turns and a system head. */
function fakeSession({ turnCount = 3, tokensPerNode = 1000, openLastTurn = false, withTurnStarts = true } = {}) {
  const events = []
  const nodes = []
  let seq = 0
  const push = (type, data = {}) => {
    const event = { seq, type, data }
    events.push(event)
    seq += 1
    return event
  }
  push('system/message')
  nodes.push(0)
  for (let turn = 1; turn <= turnCount; turn += 1) {
    if (withTurnStarts) push('turn/start', { turn })
    nodes.push(push('user/message', { turn }).seq)
    nodes.push(push('assistant/message', { turn }).seq)
    if (!(openLastTurn && turn === turnCount)) push('turn/end', { turn })
  }
  return {
    events,
    surface: { nodes },
    get seq() {
      return seq
    },
    eventAt(target) {
      return events.find((event) => event.seq === target)
    },
    deriveEventMessage(event) {
      if (event?.type === 'user/message') return { role: 'user', content: [{ type: 'text', text: 'u' + event.data.turn }] }
      if (event?.type === 'assistant/message') return { role: 'assistant', content: [{ type: 'text', text: 'a' + event.data.turn }] }
      if (event?.type === 'system/message') return { role: 'system', content: [{ type: 'text', text: 'sys' }] }
      return null
    },
    append(type, data, options) {
      const event = push(type, data)
      if (options?.surfaceOp?.op === 'replace') {
        const keep = nodes.filter((node) => node < options.surfaceOp.startSeq || node > options.surfaceOp.endSeq)
        const insertAt = keep.findIndex((node) => node > options.surfaceOp.endSeq)
        keep.splice(insertAt < 0 ? keep.length : insertAt, 0, event.seq)
        nodes.length = 0
        nodes.push(...keep)
      } else if (type === 'user/message') {
        nodes.push(event.seq)
      }
      return event
    },
    requestHeader() {
      return { config: { provider: PROVIDER, model: MODEL }, tools: [] }
    },
    /** Test hook: every counted node costs `tokensPerNode`. */
    measurement() {
      return { nodes: nodes.map((node) => ({ seq: node, heuristicTokens: tokensPerNode })) }
    },
  }
}

function fakeCtx({ session, pressureTokens = 900_000, contextWindow = 1_000_000, text = 'summary text' } = {}) {
  return {
    get(name) {
      if (name !== 'tokenMeter') return undefined
      return {
        measure: () => session.measurement(),
        contextPressure: () => ({ pressureTokens, contextWindow }),
      }
    },
    llm: {
      async *stream(options) {
        assert.equal(options.provider, PROVIDER)
        assert.equal(options.model, MODEL)
        assert.ok(options.messages.length >= 2, 'region messages plus the instruction')
        yield { type: 'text-delta', index: 0, text: 'summary ' }
        yield { type: 'text-delta', index: 0, text: 'text' }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    text,
  }
}

function collectEvents() {
  const records = []
  return { records, append: (record) => records.push(record) }
}

const CONFIG = { foldRatio: 0.85, retainRatio: 0.3, minFoldTokens: 1000, summaryMaxTokens: 600 }

test('plan keeps the surface head, folds the oldest turns, and keeps the ratio tail', () => {
  const session = fakeSession({ turnCount: 3 })
  const plan = planFold({ session, measurement: session.measurement(), config: CONFIG })
  // 7 nodes x 1000 = 7000; keep >= 2100 -> keep the last two turns (4 nodes);
  // node 0 is the system head and must never be part of the replaced span.
  assert.notEqual(plan, null)
  assert.equal(plan.keptSeqs.length, 4)
  assert.deepEqual(plan.shadowedSeqs, [session.surface.nodes[1], session.surface.nodes[2]])
  assert.equal(plan.start, session.surface.nodes[1])
  assert.equal(plan.end, session.surface.nodes[2])
  assert.equal(plan.shadowedTokenCount, 2000)
})

test('plan refuses regions below minFoldTokens', () => {
  const session = fakeSession({ turnCount: 2 })
  const plan = planFold({ session, measurement: session.measurement(), config: { ...CONFIG, minFoldTokens: 10_000 } })
  assert.equal(plan, null)
})

test('plan refuses a surface without turn starts', () => {
  const session = fakeSession({ withTurnStarts: false })
  assert.equal(planFold({ session, measurement: session.measurement(), config: CONFIG }), null)
})

test('inspectEntryState finds the open turn and an unmatched lock', () => {
  const open = fakeSession({ openLastTurn: true })
  assert.deepEqual(inspectEntryState(open), { openTurn: 3, unmatchedStartSeq: null })

  const locked = fakeSession({ openLastTurn: true })
  locked.append('compaction/start', { compactionId: 'c1', turn: 3 })
  const state = inspectEntryState(locked)
  assert.equal(state.openTurn, 3)
  assert.notEqual(state.unmatchedStartSeq, null)

  const closed = fakeSession()
  closed.append('compaction/start', { compactionId: 'c2', turn: 1 })
  closed.append('compaction/end', { compactionId: 'c2', turn: 1 })
  assert.equal(inspectEntryState(closed).unmatchedStartSeq, null)
})

test('summarize concatenates deltas and forwards the signal', async () => {
  const controller = new AbortController()
  const result = await summarize({
    llm: fakeCtx().llm,
    messages: [{ role: 'user', content: [] }, { role: 'assistant', content: [] }],
    target: { provider: PROVIDER, model: MODEL },
    config: { summaryMaxTokens: 600 },
    signal: controller.signal,
  })
  assert.equal(result.text, 'summary text')
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 4 })
})

test('summarize rejects an empty summary and an error finish', async () => {
  const emptyLlm = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  await assert.rejects(
    () => summarize({ llm: emptyLlm, messages: [{ role: 'user', content: [] }], target: { provider: PROVIDER, model: MODEL }, config: {} }),
    /SUMMARY_EMPTY/,
  )

  const failingLlm = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X' } } }
    },
  }
  await assert.rejects(
    () =>
      summarize({ llm: failingLlm, messages: [{ role: 'user', content: [] }], target: { provider: PROVIDER, model: MODEL }, config: {} }),
    /SUMMARY_FAILED: boom/,
  )
})

test('commitFold appends start, summary, replacement message, and end in order', () => {
  const session = fakeSession({ openLastTurn: true })
  const before = session.surface.nodes.length
  const plan = planFold({ session, measurement: session.measurement(), config: CONFIG })
  const result = commitFold({
    session,
    start: plan.start,
    end: plan.end,
    shadowedSeqs: plan.shadowedSeqs,
    shadowedTokenCount: plan.shadowedTokenCount,
    summaryText: 'compressed',
    target: { provider: PROVIDER, model: MODEL },
    maxTokens: 600,
    usage: { inputTokens: 10, outputTokens: 4 },
    turn: 3,
  })

  const appended = session.events.slice(-4).map((event) => event.type)
  assert.deepEqual(appended, ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])
  const summaryEvent = session.events.find((event) => event.type === 'compaction/summary')
  assert.equal(summaryEvent.data.shadowedTokenCount, plan.shadowedTokenCount)
  assert.deepEqual(summaryEvent.data.shadowedRange, { start: plan.start, end: plan.end })
  assert.equal(summaryEvent.data.provider, PROVIDER)

  const replacement = session.events.find((event) => event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint')
  assert.equal(replacement.data.source.compactionId, result.compactionId)
  assert.match(replacement.data.content[0].text, /<compaction-summary>/)
  assert.equal(result.endSeq, session.events.at(-1).seq)

  // Surface shrank by the replaced nodes and gained the checkpoint node.
  assert.equal(session.surface.nodes.length, before - plan.shadowedSeqs.length + 1)
})

test('commitFold closes the lock when the replacement append throws', () => {
  const session = fakeSession({ openLastTurn: true })
  const plan = planFold({ session, measurement: session.measurement(), config: CONFIG })
  const originalAppend = session.append.bind(session)
  let failed = false
  session.append = (type, data, options) => {
    if (type === 'user/message' && !failed) {
      failed = true
      throw new Error('surface rejected')
    }
    return originalAppend(type, data, options)
  }
  assert.throws(
    () =>
      commitFold({
        session,
        start: plan.start,
        end: plan.end,
        shadowedSeqs: plan.shadowedSeqs,
        shadowedTokenCount: plan.shadowedTokenCount,
        summaryText: 'x',
        target: { provider: PROVIDER, model: MODEL },
        turn: 3,
      }),
    /surface rejected/,
  )
  const last = session.events.at(-1)
  assert.equal(last.type, 'compaction/end')
  assert.match(last.data.error.message, /surface rejected/)
})

test('foldSession folds an open turn above the pressure line', async () => {
  const session = fakeSession({ openLastTurn: true })
  const originalNodes = [...session.surface.nodes]
  const events = collectEvents()
  const result = await foldSession({
    ctx: fakeCtx({ session }),
    agent: { id: 's1', session },
    trigger: 'pressure',
    config: CONFIG,
    events,
    warn: () => {},
  })
  assert.notEqual(result, null)
  assert.equal(result.shadowedRange.start, originalNodes[1], 'the system head stays untouched')
  assert.deepEqual(
    events.records.map((record) => record.type),
    ['compaction/fold-plan', 'compaction/folded'],
  )
  assert.equal(events.records[1].sessionId, 's1')
})

test('foldSession stands down below the pressure line, without a turn, or while locked', async () => {
  const lowEvents = collectEvents()
  const low = await foldSession({
    ctx: fakeCtx({ session: fakeSession({ openLastTurn: true }), pressureTokens: 100_000 }),
    agent: { id: 's1', session: fakeSession({ openLastTurn: true }) },
    trigger: 'pressure',
    config: CONFIG,
    events: lowEvents,
    warn: () => {},
  })
  assert.equal(low, null)

  const noTurnSession = fakeSession()
  const noTurnEvents = collectEvents()
  const noTurn = await foldSession({
    ctx: fakeCtx({ session: noTurnSession }),
    agent: { id: 's2', session: noTurnSession },
    trigger: 'pressure',
    config: CONFIG,
    events: noTurnEvents,
    warn: () => {},
  })
  assert.equal(noTurn, null)
  assert.equal(noTurnEvents.records[0].reason, 'NO_OPEN_TURN')

  const lockedSession = fakeSession({ openLastTurn: true })
  lockedSession.append('compaction/start', { compactionId: 'c9', turn: 1 })
  const lockedEvents = collectEvents()
  const locked = await foldSession({
    ctx: fakeCtx({ session: lockedSession }),
    agent: { id: 's3', session: lockedSession },
    trigger: 'pressure',
    config: CONFIG,
    events: lockedEvents,
    warn: () => {},
  })
  assert.equal(locked, null)
  assert.equal(lockedEvents.records[0].reason, 'LOCKED')
})

test('a summary failure records the failure and leaves no open lock', async () => {
  const session = fakeSession({ openLastTurn: true })
  const events = collectEvents()
  const ctx = fakeCtx({ session })
  ctx.llm = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider down', code: 'SERVER' } } }
    },
  }
  const result = await foldSession({
    ctx,
    agent: { id: 's4', session },
    trigger: 'pressure',
    config: CONFIG,
    events,
    warn: () => {},
  })
  assert.equal(result, null)
  assert.deepEqual(
    events.records.map((record) => record.type),
    ['compaction/fold-plan', 'compaction/fold-failed'],
  )
  assert.equal(session.events.some((event) => event.type === 'compaction/start'), false)
})
