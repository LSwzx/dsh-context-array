/**
 * Usage observation layer for the `llm/stream` waterfall (M1).
 *
 * The hook only observes: it never rewrites the frozen request. Each
 * `{ type: 'usage' }` chunk becomes one JSONL record so the cache-hit rate
 * required by CONTRACT.md §0.1-② and v4.1 §2 rule 3 can be measured per
 * request, keyed by the L1/L2 prefix digests that explain the rate.
 *
 * @module dsh-context-array/observer
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** Record shape version; bump together with CONTRACT.md. */
const SCHEMA = 1
/** DeepSeek's raw `prompt_cache_hit_tokens` never reaches the adapter, so the record says where its numbers came from. */
const USAGE_SOURCE = 'normalized-usage-chunk'

/** True for non-null, non-array objects. */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Hex sha256 of a UTF-8 string. */
function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Canonical JSON: object keys sorted, array order preserved, non-JSON values
 * dropped (objects) or rendered as `null` (arrays). Local helper so the
 * digest never depends on key insertion order or a third-party library.
 */
function canonicalJson(value) {
  return serialize(value, new Set())
}

/** @param {unknown} value @param {Set<object>} seen */
function serialize(value, seen) {
  if (value === null) return 'null'
  const type = typeof value
  if (type === 'string') return JSON.stringify(value)
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (type === 'bigint') return JSON.stringify(value.toString())
  // undefined, function, symbol: not representable in JSON.
  if (type !== 'object') return 'null'
  if (seen.has(value)) return 'null'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map(item => serialize(item, seen)).join(',')}]`
    }
    const keys = Object.keys(value)
      .filter((key) => {
        const itemType = typeof value[key]
        return itemType !== 'undefined' && itemType !== 'function' && itemType !== 'symbol'
      })
      .sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${serialize(value[key], seen)}`).join(',')}}`
  } finally {
    // Siblings may legally repeat the same object; only cycles are cut.
    seen.delete(value)
  }
}

/** Round to six decimals without producing `-0`. */
function round6(value) {
  if (!Number.isFinite(value)) return 0
  const rounded = Math.round(value * 1e6) / 1e6
  return Object.is(rounded, -0) ? 0 : rounded
}

/** Read a non-negative finite token counter, defaulting to 0. */
function tokenCount(usage, key) {
  if (!isObject(usage)) return 0
  const raw = usage[key]
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 0
}

/**
 * Concatenate the text blocks of every system-role message, in order.
 *
 * Node 0 (the first entry) is the request prefix. On a route declaring
 * `systemPromptUpdate: 'in-history'` a changed prompt is appended as a later
 * system message instead of rewriting node 0, so the first entry alone cannot
 * tell "effective prompt changed" apart from "prefix rewritten".
 * The message payload is frozen and is only read, never mutated.
 */
function systemTexts(messages) {
  const texts = []
  if (!Array.isArray(messages)) return texts
  for (const message of messages) {
    if (!isObject(message) || message.role !== 'system') continue
    const content = message.content
    if (typeof content === 'string') {
      texts.push(content)
      continue
    }
    if (!Array.isArray(content)) {
      texts.push('')
      continue
    }
    let text = ''
    for (const block of content) {
      if (isObject(block) && block.type === 'text' && typeof block.text === 'string') text += block.text
    }
    texts.push(text)
  }
  return texts
}

/** First non-empty string among the candidates, else null. */
function stringOrNull(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return null
}

/**
 * Create the usage observer registered on `llm/stream`.
 * @param {{ logPath?: string, now?: () => number, onError?: (error: unknown) => void }} [config]
 * @returns {{
 *   wrapStream: (options: object, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>,
 *   readLog: () => object[],
 *   stats: () => { requests: number, meanHitRate: number, lastAt: string | null },
 * }}
 */
export function createUsageObserver({ logPath, now = () => Date.now(), onError = () => {} } = {}) {
  const hasLogPath = typeof logPath === 'string' && logPath.length > 0
  /** The directory is created at most once; every later append reuses it. */
  let directoryReady = false
  let reportedMissingPath = false

  /** Observer failures are reported, never thrown into the stream. */
  function report(error) {
    try {
      onError(error)
    } catch {
      // An error sink that throws must not break the observed stream either.
    }
  }

  function clockMs() {
    try {
      const value = now()
      if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime()
      if (typeof value === 'number' && Number.isFinite(value)) return value
    } catch (error) {
      report(error)
    }
    return Date.now()
  }

  function ensureDirectory() {
    if (directoryReady) return
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    directoryReady = true
  }

  function appendRecord(record) {
    ensureDirectory()
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8')
  }

  /** Build the CONTRACT.md record for one normalized usage chunk. */
  function buildRecord(options, chunk) {
    const opts = isObject(options) ? options : {}
    const messages = Array.isArray(opts.messages) ? opts.messages : []
    const tools = Array.isArray(opts.tools) ? opts.tools : []
    const usage = isObject(chunk) && isObject(chunk.usage) ? chunk.usage : chunk

    const systemParts = systemTexts(messages)
    const systemDigest = sha256(systemParts[0] ?? '')
    const systemDigestAll = sha256(systemParts.join('\n\n'))
    const toolsDigest = sha256(canonicalJson(tools))
    const inputTokens = tokenCount(usage, 'inputTokens')
    const cacheReadTokens = tokenCount(usage, 'cacheReadTokens')
    const cacheWriteTokens = tokenCount(usage, 'cacheWriteTokens')
    const billedInput = inputTokens + cacheReadTokens + cacheWriteTokens

    return {
      schema: SCHEMA,
      at: new Date(clockMs()).toISOString(),
      sessionId: stringOrNull(opts.sessionId),
      provider: stringOrNull(opts.provider),
      model: stringOrNull(opts.model),
      purpose: stringOrNull(opts.purpose),
      messageCount: messages.length,
      toolCount: tools.length,
      systemMessageCount: systemParts.length,
      systemDigest,
      systemDigestAll,
      toolsDigest,
      prefixDigest: sha256(`${systemDigest}:${toolsDigest}`),
      // Exactly the normalized TokenUsage object as received.
      usage,
      hitRate: billedInput > 0 ? round6(cacheReadTokens / billedInput) : 0,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      usageSource: USAGE_SOURCE,
    }
  }

  /** Guarded bookkeeping for one chunk; never throws. */
  function observeChunk(options, chunk) {
    try {
      if (!isObject(chunk) || chunk.type !== 'usage') return
      if (!hasLogPath) {
        if (!reportedMissingPath) {
          reportedMissingPath = true
          report(new TypeError('createUsageObserver: logPath must be a non-empty string; usage bookkeeping is disabled'))
        }
        return
      }
      appendRecord(buildRecord(options, chunk))
    } catch (error) {
      report(error)
    }
  }

  /**
   * `llm/stream` waterfall listener: calls `next()` for the downstream
   * iterable, yields every chunk unchanged in order, and records usage
   * chunks on the side. Downstream errors still propagate; only this
   * observer's own bookkeeping is swallowed.
   */
  function wrapStream(options, next) {
    return {
      [Symbol.asyncIterator]() {
        async function* iterate() {
          let source
          try {
            source = next()
          } catch (error) {
            report(error)
            throw error
          }
          for await (const chunk of source) {
            observeChunk(options, chunk)
            yield chunk
          }
        }
        return iterate()
      },
    }
  }

  /** Parsed records; a truncated trailing line (interrupted append) is skipped. */
  function readLog() {
    if (!hasLogPath) return []
    let text
    try {
      text = fs.readFileSync(logPath, 'utf8')
    } catch (error) {
      if (isObject(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return []
      report(error)
      return []
    }
    const records = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        records.push(JSON.parse(trimmed))
      } catch {
        // Tolerate a truncated last line; earlier lines are already complete.
      }
    }
    return records
  }

  /** `{ requests, meanHitRate, lastAt }` derived from the log. */
  function stats() {
    const records = readLog()
    const rates = []
    for (const record of records) {
      if (isObject(record) && typeof record.hitRate === 'number' && Number.isFinite(record.hitRate)) {
        rates.push(record.hitRate)
      }
    }
    const last = records.length > 0 ? records[records.length - 1] : null
    return {
      requests: records.length,
      meanHitRate: rates.length > 0 ? round6(rates.reduce((sum, rate) => sum + rate, 0) / rates.length) : 0,
      lastAt: isObject(last) && typeof last.at === 'string' ? last.at : null,
    }
  }

  return { wrapStream, readLog, stats }
}
