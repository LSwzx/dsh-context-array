// Estimate how much cache-miss this architecture avoids, from the real usage log.
//
// Definitions:
//   promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens   (what the model read)
//   billedMiss   = inputTokens + cacheWriteTokens + r * cacheReadTokens
//                  (r = cache-hit price / miss price; DeepSeek prices hits far below misses)
//   noCache      = promptTokens  (every request billed as a full miss)
//   saved%       = 1 - billedMiss / noCache
//
// r is a PARAMETER: this script does not know your contract price, so it prints a
// table for several ratios. Token counts themselves need no price assumption.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const logPath = path.join(os.homedir(), '.dsh', 'context-array', 'usage.jsonl')
const RATIOS = [0.25, 0.1, 0.05, 0]

const round = (value, digits = 2) => Number(value.toFixed(digits))
const pct = (value) => `${round(value * 100)}%`

const records = fs
  .readFileSync(logPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))

const sessions = new Map()
const totals = { requests: 0, prompt: 0, cacheRead: 0, uncached: 0, cacheWrite: 0 }

for (const record of records) {
  const usage = record.usage ?? {}
  const input = usage.inputTokens ?? 0
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const prompt = input + cacheRead + cacheWrite
  if (prompt === 0) continue

  const key = record.sessionId ?? '(none)'
  if (!sessions.has(key)) sessions.set(key, { requests: 0, prompt: 0, cacheRead: 0, uncached: 0, cacheWrite: 0 })
  const bucket = sessions.get(key)
  bucket.requests += 1
  bucket.prompt += prompt
  bucket.cacheRead += cacheRead
  bucket.uncached += input
  bucket.cacheWrite += cacheWrite

  totals.requests += 1
  totals.prompt += prompt
  totals.cacheRead += cacheRead
  totals.uncached += input
  totals.cacheWrite += cacheWrite
}

function summarize(bucket) {
  const row = {
    requests: bucket.requests,
    promptTokens: bucket.prompt,
    cacheReadTokens: bucket.cacheRead,
    uncachedTokens: bucket.uncached,
    cacheWriteTokens: bucket.cacheWrite,
    avgPromptTokens: Math.round(bucket.prompt / Math.max(1, bucket.requests)),
    measuredHitShare: bucket.prompt ? round(bucket.cacheRead / bucket.prompt, 4) : 0,
  }
  for (const ratio of RATIOS) {
    const billed = bucket.uncached + bucket.cacheWrite + ratio * bucket.cacheRead
    row[`billedAtHitPrice_${ratio}`] = Math.round(billed)
    row[`savedPct_${ratio}`] = pct(1 - billed / Math.max(1, bucket.prompt))
  }
  return row
}

const out = {
  logPath,
  ratiosInterpreted: 'cache-hit price / miss price',
  overall: summarize(totals),
  sessions: [...sessions.entries()].map(([sessionId, bucket]) => ({ sessionId, ...summarize(bucket) })),
  notes: [
    'promptTokens is the whole prompt the model read; cached tokens are billed at the hit price, not free.',
    'savedPct_1 would be 0%, so only hit-price ratios below 1 matter.',
    'Without cache protection the usual failure is not "prefix re-billed" but "whole history re-billed each step".',
    'L1-L4 prefix (system node 0 + tools) is ~18k tokens; protecting it protects the chain that follows it.',
  ],
}

console.log(JSON.stringify(out, null, 2))
