// Summarize the live usage + event logs into the numbers quoted by docs/M1-RESULTS.md.
//
// Reports the M1-4 dual metrics:
//   prefixHit — share of the L1–L4 prefix served from cache (the architecture metric)
//   wholeHit  — provider-reported share of billed input (cost reference only)
// and the TTL probe: the first request after a long idle gap, per session.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataDir = path.join(os.homedir(), '.dsh', 'context-array')
const usageLogPath = path.join(dataDir, 'usage.jsonl')
const eventsLogPath = path.join(dataDir, 'events.jsonl')
const GAP_MINUTES = 60

const round = (value, digits = 4) => Number(value.toFixed(digits))
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0)

function readJsonl(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const records = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      // tolerate a truncated trailing line
    }
  }
  return records
}

const usage = readJsonl(usageLogPath)
const events = readJsonl(eventsLogPath)
if (usage.length === 0) {
  console.log(JSON.stringify({ usageLogPath, records: 0, hint: 'no usage recorded yet' }, null, 2))
  process.exit(0)
}

const sessions = new Map()
for (const record of usage) {
  const key = record.sessionId ?? '(none)'
  if (!sessions.has(key)) sessions.set(key, [])
  sessions.get(key).push(record)
}

const report = []
for (const [sessionId, list] of sessions) {
  const prefixHits = list.map((r) => (typeof r.prefixHit === 'number' ? r.prefixHit : null)).filter((v) => v !== null)
  const wholeHits = list
    .map((r) => (typeof r.wholeHit === 'number' ? r.wholeHit : typeof r.hitRate === 'number' ? r.hitRate : null))
    .filter((v) => v !== null)

  const gaps = []
  for (let i = 1; i < list.length; i += 1) {
    const previous = Date.parse(list[i - 1].at)
    const current = Date.parse(list[i].at)
    if (!Number.isFinite(previous) || !Number.isFinite(current)) continue
    const minutes = (current - previous) / 60_000
    if (minutes >= GAP_MINUTES) {
      gaps.push({
        afterMinutes: round(minutes, 1),
        requestAt: list[i].at,
        prefixHit: list[i].prefixHit ?? null,
        wholeHit: list[i].wholeHit ?? list[i].hitRate ?? null,
        cacheReadTokens: list[i].cacheReadTokens ?? null,
        inputTokens: list[i].inputTokens ?? null,
      })
    }
  }

  const replacements = events.filter(
    (event) => event.type === 'history/replace' && (event.sessionId === sessionId || event.sessionId === null),
  ).length

  report.push({
    sessionId,
    requests: list.length,
    distinctPrefixDigests: new Set(list.map((r) => r.prefixDigest).filter(Boolean)).size,
    prefixHit: prefixHits.length
      ? { min: round(Math.min(...prefixHits)), mean: round(mean(prefixHits)), max: round(Math.max(...prefixHits)) }
      : null,
    requestsWithPartialPrefix: prefixHits.filter((value) => value < 0.999999).length,
    wholeHit: wholeHits.length ? { min: round(Math.min(...wholeHits)), mean: round(mean(wholeHits)), max: round(Math.max(...wholeHits)) } : null,
    systemMessageCounts: [...new Set(list.map((r) => r.systemMessageCount).filter((v) => typeof v === 'number'))].sort((a, b) => a - b),
    historyReplacements: replacements,
    ttlProbe: gaps,
  })
}

const allPrefix = usage.map((r) => r.prefixHit).filter((v) => typeof v === 'number')
console.log(
  JSON.stringify(
    {
      usageLogPath,
      eventsLogPath,
      totalUsageRecords: usage.length,
      totalEventRecords: events.length,
      sessions: report,
      overall: {
        prefixHitMean: allPrefix.length ? round(mean(allPrefix)) : null,
        prefixHitMin: allPrefix.length ? round(Math.min(...allPrefix)) : null,
        requestsWithPartialPrefix: allPrefix.filter((value) => value < 0.999999).length,
      },
      compactionEvents: events
        .filter((event) => String(event.type ?? '').startsWith('compaction/'))
        .slice(-5),
    },
    null,
    2,
  ),
)
