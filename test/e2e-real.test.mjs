import assert from 'node:assert/strict'
import { test } from 'node:test'

import { NATURAL_ROUNDS, analyzeUsage, renderReport } from '../tools/e2e-real.mjs'

function row(sessionId, input, cacheRead, output) {
  return {
    sessionId,
    usage: { inputTokens: input, cacheReadTokens: cacheRead, outputTokens: output },
    prefixTokens: 19_000,
    prefixHitTokens: cacheRead > 0 ? 19_000 : 0,
  }
}

test('every scripted round is long, human-sounding Chinese with no tool arguments', () => {
  assert.equal(NATURAL_ROUNDS.length, 5)
  for (const round of NATURAL_ROUNDS) {
    assert.ok(round.text.length >= 100, `R${round.round} prompt too short`)
    assert.ok(!round.text.includes('raw_content'), 'prompt must not be a tool-call argument')
    assert.ok(!round.text.includes('targetSessionId'))
  }
})

test('analyzeUsage computes per-session rates and cost savings', () => {
  const usage = analyzeUsage([row('a', 100, 900, 50), row('a', 50, 950, 20), row('b', 10, 0, 5)])
  assert.equal(usage.totals.requests, 3)
  assert.equal(usage.totals.prompt, 2010)
  assert.equal(usage.totals.miss, 160)
  assert.equal(usage.totals.hit, 1850)
  assert.equal(usage.totals.output, 75)
  assert.ok(Math.abs(usage.totals.hitRate - 1850 / 2010) < 1e-9)
  assert.ok(usage.cost.actual > 0)
  assert.ok(usage.cost.noCache > usage.cost.actual)
  assert.ok(usage.sessions.every((entry) => Number.isFinite(entry.hitRate)))
})

test('renderReport includes full prompts and no NaN hit rates', () => {
  const usage = analyzeUsage([row('aaaaaaaa-1', 100, 900, 50)])
  const report = renderReport({
    runAt: '2026-11-28T00:00:00Z',
    usage,
    toolOnly: null,
    toolOnlyPath: 'x',
    results: [{ round: 1, requests: 2, sent: true }],
  })
  assert.match(report, /完整 Prompt/)
  assert.ok(!report.includes('NaN'))
  assert.match(report, /真实对话/)
  for (const round of NATURAL_ROUNDS) assert.ok(report.includes(round.text.slice(0, 20)))
})
