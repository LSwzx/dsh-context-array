/**
 * Prefix estimation and the dual cache metrics (M1-4).
 *
 * The estimator must stay identical to DSH's fixed heuristic (4 chars per token,
 * +4 role framing for a system message, +4 structural for the tool block), so
 * these tests pin the exact numbers rather than ranges.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { computePrefixMetrics, estimateSystemMessage, estimateToolsTokens } from '../src/prefix.js'

const systemMessage = (text) => ({ role: 'system', content: [{ type: 'text', text }] })

test('estimateSystemMessage prices text density plus role framing', () => {
  // An empty text block still carries role framing, exactly like DSH's estimator.
  assert.equal(estimateSystemMessage(systemMessage('')), 4)
  assert.equal(estimateSystemMessage({ role: 'system', content: [] }), 0)
  // 8 chars / 4 = 2 tokens + 4 framing
  assert.equal(estimateSystemMessage(systemMessage('abcdefgh')), 6)
  // 9 chars -> ceil(9/4)=3 + 4
  assert.equal(estimateSystemMessage(systemMessage('abcdefghi')), 7)
  assert.equal(estimateSystemMessage(undefined), 0)
})

test('estimateToolsTokens prices the canonical tool array plus structural overhead', () => {
  assert.equal(estimateToolsTokens([]), 0)
  assert.equal(estimateToolsTokens(undefined), 0)
  const tools = [{ name: 'read', description: 'd', parameters: { type: 'object' } }]
  const expected = Math.ceil(JSON.stringify(tools).length / 4) + 4
  assert.equal(estimateToolsTokens(tools), expected)
})

test('a fully cached prefix reports prefixHit 1 and a full wholeHit', () => {
  const metrics = computePrefixMetrics({
    messages: [systemMessage('abcdefgh')],
    tools: [{ name: 'read' }],
    usage: { inputTokens: 10, cacheReadTokens: 10_000, cacheWriteTokens: 0 },
  })
  assert.ok(metrics.prefixTokens > 0)
  assert.equal(metrics.prefixHit, 1)
  assert.equal(metrics.wholeHit, Math.round((10_000 / 10_010) * 1e6) / 1e6)
})

test('a partially cached prefix reports the cached fraction', () => {
  // system text of 400 chars -> 100 + 4 = 104 tokens; no tools.
  const text = 'x'.repeat(400)
  const metrics = computePrefixMetrics({
    messages: [systemMessage(text)],
    tools: [],
    usage: { inputTokens: 2000, cacheReadTokens: 52, cacheWriteTokens: 0 },
  })
  assert.equal(metrics.prefixTokens, 104)
  assert.equal(metrics.prefixHitTokens, 52)
  assert.equal(metrics.prefixHit, 0.5)
})

test('an uncached prefix reports 0 without dividing by zero', () => {
  const metrics = computePrefixMetrics({
    messages: [systemMessage('abcdefgh')],
    tools: [],
    usage: { inputTokens: 500, cacheReadTokens: 0 },
  })
  assert.equal(metrics.prefixHit, 0)
  assert.equal(metrics.wholeHit, 0)
})

test('a request without a system message prices tools only', () => {
  const tools = [{ name: 'read', description: 'd', parameters: { type: 'object' } }]
  const metrics = computePrefixMetrics({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools,
    usage: { inputTokens: 5, cacheReadTokens: 1000 },
  })
  assert.equal(metrics.systemTokens, 0)
  assert.equal(metrics.prefixTokens, metrics.toolTokens)
  assert.equal(metrics.prefixHit, 1)
})

test('only system node 0 counts as prefix', () => {
  // A prompt DSH appended in history is history, not prefix: it must not inflate
  // the denominator and make prefixHit look artificially low.
  const metrics = computePrefixMetrics({
    messages: [systemMessage('abcdefgh'), { role: 'user', content: [{ type: 'text', text: 'x' }] }, systemMessage('y'.repeat(400))],
    tools: [],
    usage: { inputTokens: 10, cacheReadTokens: 1000 },
  })
  assert.equal(metrics.prefixTokens, 6)
  assert.equal(metrics.prefixHit, 1)
})
