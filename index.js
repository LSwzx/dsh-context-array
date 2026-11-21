/**
 * dsh-context-array — M1 slice.
 *
 * Wires the four M1 pieces into the Host:
 *   1. static L1–L4 prompt sections (L4 scoped per session from a persisted snapshot),
 *   2. the single-space static SQLite store,
 *   3. the `llm/stream` usage observer (normalized usage + prefix digests),
 *   4. the append layer (`agent.inject`) that emits one bootstrap snapshot per session.
 *
 * Nothing here rewrites history: prompt text is registered while assembling, and
 * everything dynamic is appended after the cached prefix.
 */

import { resolveConfig } from './src/config.js'
import {
  bindSessionSpaces,
  ensureDefaultSpace,
  getOrCreateL4Snapshot,
  markBootstrapped,
  openStore,
} from './src/db.js'
import {
  L1_ORDER,
  L1_SECTION,
  L1_TEXT,
  L3_ORDER,
  L3_SECTION,
  L3_TEXT,
  L4_ORDER,
  L4_SECTION,
  renderBootstrapSection,
  renderL4,
} from './src/prompt.js'
import { createUsageObserver } from './src/observer.js'
import { buildBootstrapMessage, deliverBootstrap } from './src/append.js'

export const name = 'dsh-context-array'
export const inject = ['systemPrompt', 'llm']

/** Sources that represent a fresh conversation for this session. */
const BOOTSTRAP_SOURCES = new Set(['startup', 'clear'])

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const store = openStore(config)
  const warn = (scope) => (error) => {
    try {
      const logger = ctx.logger?.('dsh-context-array')
      if (logger?.warn) logger.warn(`[${scope}] ${error?.message ?? error}`)
      else console.error(`[dsh-context-array] ${scope}:`, error)
    } catch {
      // Diagnostics must never break activation or a turn.
    }
  }

  ctx.effect(() => () => store.close(), 'context-array:store')
  ensureDefaultSpace(store.db, config)

  if (config.observeUsage) {
    const observer = createUsageObserver({
      logPath: config.usageLogPath,
      onError: warn('usage-observer'),
    })
    ctx.on('llm/stream', observer.wrapStream)
  }

  // L1 and L3 are global and static, so every session on this deployment shares
  // the same bytes.
  ctx.systemPrompt.section({ name: L1_SECTION, order: L1_ORDER, text: L1_TEXT, interpolate: false })
  ctx.systemPrompt.section({ name: L3_SECTION, order: L3_ORDER, text: L3_TEXT, interpolate: false })

  // L4 sections are registered on an agent's own context, which outlives this
  // plugin fiber. Keep their disposers so unloading the plugin withdraws them
  // instead of leaving a stale prompt section behind.
  /** @type {Map<string, () => void>} */
  const agentSections = new Map()
  ctx.effect(
    () => () => {
      for (const dispose of agentSections.values()) {
        try {
          dispose?.()
        } catch {
          // A section whose agent is already gone cannot be withdrawn again.
        }
      }
      agentSections.clear()
    },
    'context-array:agent-sections',
  )

  /** Withdraw one session's L4 section (agent disposal or plugin unload). */
  function releaseAgentSection(sessionId) {
    const dispose = agentSections.get(sessionId)
    if (!dispose) return
    agentSections.delete(sessionId)
    try {
      dispose()
    } catch {
      // Already withdrawn.
    }
  }

  /**
   * Bind a session to its spaces, freeze its L4 text, register the scoped L4
   * section before the session assembles its next prompt, and (once) queue the
   * bootstrap snapshot.
   *
   * @param {{ id?: string, ctx?: object, inject?: (message: object) => unknown } | undefined} agent
   * @param {string | undefined} source
   */
  function bootstrapAgent(agent, source) {
    if (!agent?.id || !agent.ctx?.systemPrompt) return
    try {
      const spaces = bindSessionSpaces(store.db, agent.id, [config.spaceId], 'main')
      const snapshot = getOrCreateL4Snapshot(store.db, { sessionId: agent.id, spaces, render: renderL4 })

      if (!agentSections.has(agent.id)) {
        agentSections.set(
          agent.id,
          agent.ctx.systemPrompt.section({
            name: L4_SECTION,
            order: L4_ORDER,
            text: snapshot.text,
            interpolate: false,
          }),
        )
      }

      if (!config.bootstrapMessages) return
      if (source !== undefined && !BOOTSTRAP_SOURCES.has(source)) return
      if (!markBootstrapped(store.db, agent.id)) return
      deliverBootstrap(
        agent,
        buildBootstrapMessage({ sections: [renderBootstrapSection(spaces)] }),
        { onError: warn('bootstrap') },
      )
    } catch (error) {
      warn('bootstrap')(error)
    }
  }

  ctx.on('agent/created', (payload) => bootstrapAgent(payload?.agent, payload?.source))
  ctx.on('agent/disposed', (payload) => {
    if (payload?.agent?.id) releaseAgentSection(payload.agent.id)
  })

  // Agents that were already live when this bundle activated never emit
  // `agent/created`. Without this sweep their sessions would keep only L1/L3
  // until a restart, and would never receive their L4 section.
  try {
    const agents = ctx.get?.('agents')
    for (const agent of agents?.list?.() ?? []) bootstrapAgent(agent, 'startup')
  } catch (error) {
    warn('live-agents')(error)
  }
}
