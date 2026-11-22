/**
 * `context_compact` — manual compaction for the calling session (`fold` mode only).
 *
 * Registered only when `compactionMode: 'fold'`, so the default deployment has no
 * destructive tool. Identity comes from the host-injected execution context: the
 * tool can only fold the session that called it, never another one.
 */

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['folded'],
  properties: {
    folded: { type: 'boolean' },
    compactionId: { type: 'string' },
    shadowedStart: { type: 'number' },
    shadowedEnd: { type: 'number' },
    shadowedTokenCount: { type: 'number' },
    keptNodes: { type: 'number' },
    reason: { type: 'string' },
  },
}

/**
 * @param {{ compaction: { compactNow: Function }, warn?: (error: unknown) => void }} input
 * @returns {object} ToolDefinition
 */
export function createContextCompactTool({ compaction, warn = () => {} }) {
  return {
    name: 'context_compact',
    description:
      "Compress this session's older history into one summary message (manual compaction). " +
      'The oldest complete turns are replaced by a summary; the most recent turns are kept. ' +
      'Use it when the session is getting long and you want to free context budget.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: OUTPUT_SCHEMA,
      render(args, value) {
        if (!value?.folded) {
          return [{ type: 'text', text: `context_compact: nothing folded (${value?.reason ?? 'NO_SAFE_RANGE'}).` }]
        }
        return [
          {
            type: 'text',
            text:
              `context_compact: folded surface nodes ${value.shadowedStart}–${value.shadowedEnd} ` +
              `(${value.shadowedTokenCount} estimated tokens) into one summary; ` +
              `kept the most recent ${value.keptNodes} nodes. compactionId=${value.compactionId}.`,
          },
        ]
      },
    },
    async execute(args, exec) {
      const agent = exec?.agent
      if (!agent?.session) return { folded: false, reason: 'NO_SESSION_IDENTITY' }
      try {
        const result = await compaction.compactNow(agent, exec?.signal)
        if (!result) return { folded: false, reason: 'NO_SAFE_RANGE' }
        return {
          folded: true,
          compactionId: result.compactionId,
          shadowedStart: result.shadowedRange.start,
          shadowedEnd: result.shadowedRange.end,
          shadowedTokenCount: result.shadowedTokenCount,
          keptNodes: Array.isArray(result.keptSeqs) ? result.keptSeqs.length : undefined,
        }
      } catch (error) {
        warn(error)
        return { folded: false, reason: String(error?.message ?? error) }
      }
    },
  }
}
