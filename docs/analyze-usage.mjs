// Summarize the live usage log into the numbers quoted by docs/M1-RESULTS.md.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const logPath = path.join(os.homedir(), '.dsh', 'context-array', 'usage.jsonl')
const records = fs
  .readFileSync(logPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))

const groups = new Map()
for (const record of records) {
  const key = record.sessionId ?? '(none)'
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(record)
}

const round = (value, digits = 4) => Number(value.toFixed(digits))
const summary = []
for (const [sessionId, list] of groups) {
  const rates = list.map((record) => record.hitRate)
  const digests = new Set(list.map((record) => record.prefixDigest))
  const sysCounts = list.map((record) => record.systemMessageCount).filter((value) => typeof value === 'number')
  const cacheRead = list.reduce((sum, record) => sum + (record.cacheReadTokens ?? 0), 0)
  const input = list.reduce((sum, record) => sum + (record.inputTokens ?? 0), 0)
  const write = list.reduce((sum, record) => sum + (record.cacheWriteTokens ?? 0), 0)
  summary.push({
    sessionId,
    requests: list.length,
    prefixDigests: digests.size,
    minHit: round(Math.min(...rates)),
    maxHit: round(Math.max(...rates)),
    meanHit: round(rates.reduce((a, b) => a + b, 0) / rates.length),
    aggregateHit: round(cacheRead / Math.max(1, input + cacheRead + write)),
    cacheReadTokens: cacheRead,
    uncachedInputTokens: input,
    cacheWriteTokens: write,
    systemMessageCounts: [...new Set(sysCounts)].sort((a, b) => a - b),
    provider: list[0].provider,
    model: list[0].model,
  })
}

const steady = records.filter((record) => record.hitRate >= 0.5)
console.log(
  JSON.stringify(
    {
      logPath,
      totalRecords: records.length,
      sessions: summary,
      steadyState: {
        requests: steady.length,
        meanHit: round(steady.reduce((sum, r) => sum + r.hitRate, 0) / steady.length),
        minHit: round(Math.min(...steady.map((r) => r.hitRate))),
        maxHit: round(Math.max(...steady.map((r) => r.hitRate))),
      },
    },
    null,
    2,
  ),
)
