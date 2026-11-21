import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { createUsageObserver } from '../src/observer.js'

const tempDirs = []

/** Fresh temp dir per test; removed in `after`. */
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-context-array-observer-'))
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Freeze every nested object/array, mirroring the frozen request payload. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/** Fake downstream stream: an async generator over fixed chunks. */
function makeSource(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

async function collect(iterable) {
  const received = []
  for await (const chunk of iterable) received.push(chunk)
  return received
}

const SYSTEM_TEXT = 'You are the dsh observer. Stay append-only.'
const TOOL_CANONICAL = '[{"description":"read a file","name":"read","parameters":{"properties":{"path":{"type":"string"}},"required":["path"],"type":"object"}}]'

/** Frozen request envelope + a usage chunk, as the real waterfall sees them. */
function makeFixture() {
  const systemMessage = {
    role: 'system',
    content: [
      { type: 'text', text: 'You are the dsh observer. ' },
      { type: 'tool-addition', toolName: 'read' },
      { type: 'text', text: 'Stay append-only.' },
    ],
  }
  const userMessage = { role: 'user', content: [{ type: 'text', text: 'hello' }] }
  const tool = {
    name: 'read',
    description: 'read a file',
    parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
  }
  const options = deepFreeze({
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    sessionId: 'sess-1',
    messages: [systemMessage, userMessage],
    tools: [tool],
  })
  const usage = deepFreeze({
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 104,
    cacheReadTokens: 30,
    cacheWriteTokens: 60,
  })
  const chunks = deepFreeze([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'he' },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  return { options, chunks, usage }
}

test('wrapStream yields the same chunk objects in the same order', async () => {
  const { options, chunks } = makeFixture()
  const observer = createUsageObserver({ logPath: path.join(makeTempDir(), 'usage.jsonl') })

  const received = await collect(observer.wrapStream(options, () => makeSource(chunks)))

  assert.equal(received.length, chunks.length)
  received.forEach((chunk, index) => assert.equal(chunk, chunks[index]))
})

test('a usage chunk appends one contract-shaped JSONL record', async () => {
  const { options, chunks, usage } = makeFixture()
  const dir = makeTempDir()
  const logPath = path.join(dir, 'usage.jsonl')
  const observer = createUsageObserver({ logPath, now: () => Date.parse('2026-11-21T13:00:00.000Z') })

  await collect(observer.wrapStream(options, () => makeSource(chunks)))

  const rawLines = fs.readFileSync(logPath, 'utf8').trimEnd().split('\n')
  assert.equal(rawLines.length, 1)
  const [record] = observer.readLog()

  assert.equal(record.schema, 1)
  assert.equal(record.at, '2026-11-21T13:00:00.000Z')
  assert.equal(record.sessionId, 'sess-1')
  assert.equal(record.provider, 'deepseek-official')
  assert.equal(record.model, 'deepseek-flash')
  assert.equal(record.purpose, null)
  assert.equal(record.messageCount, 2)
  assert.equal(record.toolCount, 1)
  assert.equal(record.systemDigest, sha256(SYSTEM_TEXT))
  assert.equal(record.toolsDigest, sha256(TOOL_CANONICAL))
  assert.equal(record.prefixDigest, sha256(`${sha256(SYSTEM_TEXT)}:${sha256(TOOL_CANONICAL)}`))
  // usage is stored verbatim; only its source is annotated.
  assert.deepEqual(record.usage, usage)
  assert.equal(record.usageSource, 'normalized-usage-chunk')
  assert.equal(record.hitRate, 0.3)
  assert.equal(record.inputTokens, 10)
  assert.equal(record.cacheReadTokens, 30)
  assert.equal(record.cacheWriteTokens, 60)
})

test('hitRate treats a zero denominator as 0 and rounds to six decimals', async () => {
  const observer = createUsageObserver({ logPath: path.join(makeTempDir(), 'usage.jsonl') })
  const options = deepFreeze({ provider: 'deepseek-official', model: 'deepseek-flash', messages: [], tools: [] })

  const noDenominator = deepFreeze({ type: 'usage', usage: { inputTokens: 0, outputTokens: 3 } })
  const oneThird = deepFreeze({ type: 'usage', usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 1 } })

  await collect(observer.wrapStream(options, () => makeSource([noDenominator, oneThird])))

  const records = observer.readLog()
  assert.equal(records.length, 2)
  assert.equal(records[0].hitRate, 0)
  assert.deepEqual(records[0].usage, { inputTokens: 0, outputTokens: 3 })
  assert.equal(records[1].hitRate, 0.333333)
})

test('empty tools digest the canonical empty array and no system message digests the empty string', async () => {
  const { usage } = makeFixture()
  const observer = createUsageObserver({ logPath: path.join(makeTempDir(), 'usage.jsonl') })
  const options = deepFreeze({
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'no system here' }] }],
  })

  await collect(observer.wrapStream(options, () => makeSource([{ type: 'usage', usage }])))

  const [record] = observer.readLog()
  assert.equal(record.toolCount, 0)
  assert.equal(record.systemDigest, sha256(''))
  assert.equal(record.toolsDigest, sha256('[]'))
  assert.equal(record.prefixDigest, sha256(`${sha256('')}:${sha256('[]')}`))
  assert.equal(record.sessionId, null)
  assert.equal(record.purpose, null)
})

test('the frozen request envelope is never mutated', async () => {
  const { options, chunks } = makeFixture()
  const snapshot = JSON.stringify(options)
  const observer = createUsageObserver({ logPath: path.join(makeTempDir(), 'usage.jsonl') })

  await collect(observer.wrapStream(options, () => makeSource(chunks)))

  assert.equal(JSON.stringify(options), snapshot)
  assert.ok(Object.isFrozen(options))
  assert.ok(Object.isFrozen(options.messages[0].content))
  assert.ok(Object.isFrozen(options.tools[0].parameters))
  assert.deepEqual(options.messages.map(message => message.role), ['system', 'user'])
})

test('readLog tolerates a truncated last line', () => {
  const dir = makeTempDir()
  const logPath = path.join(dir, 'usage.jsonl')
  const complete = JSON.stringify({ schema: 1, at: '2026-11-21T13:00:00.000Z', hitRate: 0.5 })
  fs.writeFileSync(logPath, `${complete}\n{"schema":1,"at":"2026-11-21T13:00:0`, 'utf8')
  const observer = createUsageObserver({ logPath })

  const records = observer.readLog()
  assert.equal(records.length, 1)
  assert.equal(records[0].hitRate, 0.5)
  assert.deepEqual(observer.stats(), {
    requests: 1,
    meanHitRate: 0.5,
    lastAt: '2026-11-21T13:00:00.000Z',
  })
})

test('a missing log file reads as empty', () => {
  const observer = createUsageObserver({ logPath: path.join(makeTempDir(), 'missing', 'usage.jsonl') })
  assert.deepEqual(observer.readLog(), [])
  assert.deepEqual(observer.stats(), { requests: 0, meanHitRate: 0, lastAt: null })
})

test('stats aggregate the log', async () => {
  const { options, chunks } = makeFixture()
  const observer = createUsageObserver({ logPath: path.join(makeTempDir(), 'usage.jsonl'), now: () => 1_764_000_000_000 })

  await collect(observer.wrapStream(options, () => makeSource(chunks)))
  await collect(observer.wrapStream(options, () => makeSource([{ type: 'usage', usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 90 } }])))

  const stats = observer.stats()
  assert.equal(stats.requests, 2)
  assert.equal(stats.meanHitRate, 0.6)
  assert.equal(stats.lastAt, '2025-11-24T16:00:00.000Z')
})

test('a write failure only reaches onError, never the stream', async () => {
  const dir = makeTempDir()
  const blockedParent = path.join(dir, 'not-a-directory')
  fs.writeFileSync(blockedParent, 'x', 'utf8')
  const errors = []
  const { options, chunks } = makeFixture()
  const observer = createUsageObserver({
    logPath: path.join(blockedParent, 'usage.jsonl'),
    onError: error => errors.push(error),
  })

  const received = await collect(observer.wrapStream(options, () => makeSource(chunks)))

  assert.equal(received.length, chunks.length)
  received.forEach((chunk, index) => assert.equal(chunk, chunks[index]))
  assert.equal(errors.length, 1)
  assert.ok(errors[0] instanceof Error)
  assert.deepEqual(observer.readLog(), [])
})

test('an onError sink that throws still cannot break the stream', async () => {
  const dir = makeTempDir()
  const blockedParent = path.join(dir, 'blocked')
  fs.writeFileSync(blockedParent, 'x', 'utf8')
  const { options, chunks } = makeFixture()
  const observer = createUsageObserver({
    logPath: path.join(blockedParent, 'usage.jsonl'),
    onError: () => {
      throw new Error('error sink exploded')
    },
  })

  const received = await collect(observer.wrapStream(options, () => makeSource(chunks)))
  assert.equal(received.length, chunks.length)
})

test('downstream stream errors still propagate to the consumer', async () => {
  const observer = createUsageObserver({ logPath: path.join(makeTempDir(), 'usage.jsonl') })
  const failure = new Error('adapter failed')
  const errors = []
  const source = {
    async *[Symbol.asyncIterator]() {
      yield { type: 'text-delta', index: 0, text: 'a' }
      throw failure
    },
  }
  const observed = createUsageObserver({
    logPath: path.join(makeTempDir(), 'usage.jsonl'),
    onError: error => errors.push(error),
  })

  await assert.rejects(collect(observer.wrapStream({ messages: [] }, () => source)), failure)
  await assert.rejects(collect(observed.wrapStream({ messages: [] }, () => source)), failure)
  assert.equal(errors.length, 0)
})

test('usage chunks are the only chunks that write a record', async () => {
  const observer = createUsageObserver({ logPath: path.join(makeTempDir(), 'usage.jsonl') })
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hi' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]

  await collect(observer.wrapStream({ messages: [], tools: [] }, () => makeSource(chunks)))
  assert.equal(observer.readLog().length, 0)
})
