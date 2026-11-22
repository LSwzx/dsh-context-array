/**
 * Token estimates for the cached L1–L4 prefix and the dual hit metrics (M1-4).
 *
 * The heuristic is identical to DSH's own fixed estimator
 * (`dsh-token-meter/src/estimate.ts`): four characters per token, plus the
 * same small structural overheads. Replicating it here keeps the plugin free of
 * `@deepseek-ai/*` imports while producing the numbers the Host itself would.
 *
 * Why two metrics:
 * - `prefixHit` answers "was the L1–L4 region served from cache" — the thing
 *   this architecture exists to protect.
 * - `wholeHit` is what providers report (`cacheReadTokens / billed input`) and
 *   is naturally high whenever L5 only appends, so it can hide a broken prefix.
 *
 * Provider caching matches the longest leading token span, so the tokens served
 * from cache for the prefix are `min(prefixTokens, cacheReadTokens)`.
 */

const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4
const ROLE_OVERHEAD = 4

/** Round to six decimals without producing `-0`. */
function round6(value) {
  if (!Number.isFinite(value)) return 0
  const rounded = Math.round(value * 1e6) / 1e6
  return Object.is(rounded, -0) ? 0 : rounded
}

/** Heuristic price of one rendered system message (text density + role framing). */
export function estimateSystemMessage(message) {
  if (!message || !Array.isArray(message.content) || message.content.length === 0) return 0
  let characters = 0
  for (const block of message.content) {
    characters += block?.type === 'text' ? String(block.text ?? '').length : JSON.stringify(block).length
  }
  return Math.ceil(characters / CHARS_PER_TOKEN) + ROLE_OVERHEAD
}

/** Heuristic price of the tool-schema part of a request envelope. */
export function estimateToolsTokens(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0
  return Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

/**
 * Compute the L1–L4 prefix size and the share of it that came from cache.
 *
 * Only system node 0 counts as prefix: a prompt DSH appends in history
 * (`systemPromptUpdate: 'in-history'`) rides the history tail, not the prefix.
 *
 * @param {object} input
 * @param {readonly object[]} input.messages - request messages, in order
 * @param {readonly object[]} [input.tools] - request tool declarations
 * @param {object} [input.usage] - normalized TokenUsage reported for this request
 * @returns {{
 *   systemTokens: number,
 *   toolTokens: number,
 *   prefixTokens: number,
 *   prefixHitTokens: number,
 *   prefixHit: number,
 *   wholeHit: number,
 * }}
 */
export function computePrefixMetrics({ messages, tools, usage }) {
  const list = Array.isArray(messages) ? messages : []
  const system0 = list.find((message) => message?.role === 'system')
  const systemTokens = estimateSystemMessage(system0)
  const toolTokens = estimateToolsTokens(tools)
  const prefixTokens = systemTokens + toolTokens

  const cacheRead = Number.isFinite(usage?.cacheReadTokens) ? usage.cacheReadTokens : 0
  const uncachedInput = Number.isFinite(usage?.inputTokens) ? usage.inputTokens : 0
  const cacheWrite = Number.isFinite(usage?.cacheWriteTokens) ? usage.cacheWriteTokens : 0

  const prefixHitTokens = Math.min(prefixTokens, Math.max(0, cacheRead))
  const billedInput = uncachedInput + cacheRead + cacheWrite

  return {
    systemTokens,
    toolTokens,
    prefixTokens,
    prefixHitTokens,
    prefixHit: prefixTokens > 0 ? round6(prefixHitTokens / prefixTokens) : 0,
    wholeHit: billedInput > 0 ? round6(cacheRead / billedInput) : 0,
  }
}
