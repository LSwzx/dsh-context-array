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
import fs from 'node:fs'
import {
  ensureDefaultSpace,
  getEffectivePersona,
  getOrCreateL4Snapshot,
  listPersonalityMemories,
  markBootstrapped,
  openStore,
} from './src/db.js'
import {
  ADMIN_L3_ORDER,
  ADMIN_L3_SECTION,
  ADMIN_L3_TEXT,
  L1_ORDER,
  L1_SECTION,
  L1_TEXT,
  L3_ORDER,
  L3_SECTION,
  L3_TEXT,
  L4_ORDER,
  L4_SECTION,
  PERSONA_ORDER,
  PERSONA_SECTION,
  renderBootstrapSection,
  renderL4,
  withSalt,
} from './src/prompt.js'
import { buildPersonaText, createPersonaGuard } from './src/persona.js'
import { createPersonaWriteTool } from './src/persona-tool.js'
import { createUsageObserver } from './src/observer.js'
import { buildBootstrapMessage, deliverBootstrap } from './src/append.js'
import { createEventLog } from './src/events.js'
import { installCompactionTakeover, installHistoryReplacementWatch } from './src/compaction.js'
import { createEmbeddingClient } from './src/embedding/client.js'
import { createRetriever } from './src/retrieval.js'
import { createMemorySearchTool } from './src/memory-tool.js'
import { createContextCompactTool } from './src/compact-tool.js'
import { createMemoryTools } from './src/memory-tools.js'
import { createInboxTracker } from './src/inbox-tracker.js'
import { registerContextArrayApi } from './src/http-api.js'

export const name = 'dsh-context-array'
export const inject = ['systemPrompt', 'llm', 'tools']

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

  // M1-4: record every history replacement (compaction, tool-result pruning),
  // so the usage log can tell steady state from "the prefix was just rewritten".
  const events = createEventLog({ logPath: config.eventsLogPath, onError: warn('events') })
  installHistoryReplacementWatch({ ctx, events, warn: warn('history-replace') })

  // M0-6: claim the compaction seam when asked to. `off` leaves the deployment
  // untouched; `observe` proves the takeover without ever folding history.
  const takeover = installCompactionTakeover({
    ctx,
    config,
    events,
    warn: warn('compaction'),
    now: () => Date.now(),
  })
  if (takeover.installed) ctx.logger?.('dsh-context-array')?.info?.(`[compaction] seam claimed in ${takeover.reason} mode`)

  // `fold` mode also exposes manual compaction to the model. Identity is the
  // caller's own session, so it can only fold itself.
  if (takeover.installed && takeover.reason === 'fold' && takeover.provider) {
    try {
      ctx.tools.register(
        createContextCompactTool({ compaction: takeover.provider, warn: warn('context-compact') }),
      )
    } catch (error) {
      warn('context-compact')(error)
    }
  }

  // M2: local embedding + hybrid retrieval, exposed to the model as `memory_search`.
  // The model loads lazily inside a worker on the first query, so activation and
  // prompt assembly never wait for it; disabling `enableEmbedding` falls back to
  // the keyword path only.
  const embedder = config.enableEmbedding
    ? createEmbeddingClient({ modelsDir: config.modelsDir, onError: warn('embedding') })
    : null
  if (embedder) ctx.effect(() => () => embedder.close(), 'context-array:embedding')
  const retriever = createRetriever({
    db: store.db,
    embedQuery: embedder ? (text) => embedder.embedQuery(text) : null,
  })
  try {
    ctx.tools.register(
      createMemorySearchTool({ db: store.db, retriever, warn: warn('memory-tool'), defaultSpaceId: config.spaceId }),
    )
  } catch (error) {
    warn('memory-tool')(error)
  }

  // M3: proposal queue + the manager's write path. `memory_propose` is open to every
  // session; claim/archive/settle self-gate on a server-side admin check.
  try {
    for (const tool of createMemoryTools({
      db: store.db,
      embedPassage: embedder ? (text) => embedder.embedPassage(text) : null,
      config,
      warn: warn('memory-tools'),
      ctx,
      inboxTracker,
    })) {
      ctx.tools.register(tool)
    }
  } catch (error) {
    warn('memory-tools')(error)
  }

  // The agent records its own persona; the human edits the same row in the panel.
  try {
    ctx.tools.register(createPersonaWriteTool({ db: store.db, warn: warn('persona-write') }))
  } catch (error) {
    warn('persona-write')(error)
  }

  // Persona guard: watches external tool results for hijack attempts. The waterfall
  // listener always delegates to `next()`; it only records (observe) or adds a
  // reassertion context (enforce), so a tool result is never blocked here.
  const personaGuard = createPersonaGuard({ config, events, warn: warn('persona-guard') })
  ctx.on('tools/post-execute', (exec, result, next) => personaGuard.handle(exec, result, next))

  // Inbox hop tracking: `agent/inbox/claimed` proves a delivered message started the
  // current turn, `agent/turn-stopping` closes it. Used for hop_count and the one-wake
  // per source per turn rule.
  const inboxTracker = createInboxTracker({ db: store.db, warn: warn('inbox-tracker') })
  ctx.on('agent/inbox/claimed', (payload) => inboxTracker.onClaimed(payload))
  ctx.on('agent/turn-stopping', (payload) => inboxTracker.onTurnStopping(payload))

  // M4: the sidebar panel's Host API. Optional: deployments without a web server
  // simply never expose the panel's data.
  try {
    const disposeApi = registerContextArrayApi({
      ctx,
      db: store.db,
      config,
      warn: warn('http-api'),
      events,
      inboxTracker,
      persona: {
        mode: personaGuard.mode,
        tools: personaGuard.tools,
        alerts: personaGuard.alerts,
        traits: config.personaTraits,
      },
    })
    ctx.effect(() => disposeApi, 'context-array:http-api')
  } catch (error) {
    warn('http-api')(error)
  }

  // L1 and L3 are global and static, so every session on this deployment shares
  // the same bytes. The L1 text is a provider (not a literal) purely so the
  // diagnostic salt file can change node 0 while the observer keeps running; with
  // no salt file the rendered text is byte-identical to L1_TEXT.
  const readSalt = () => {
    try {
      return fs.readFileSync(config.promptSaltFile, 'utf8').slice(0, 200)
    } catch {
      return ''
    }
  }
  ctx.systemPrompt.section({
    name: L1_SECTION,
    order: L1_ORDER,
    text: () => withSalt(L1_TEXT, readSalt()),
    interpolate: false,
  })
  ctx.systemPrompt.section({ name: L3_SECTION, order: L3_ORDER, text: L3_TEXT, interpolate: false })

  // L4 sections are registered on an agent's own context, which outlives this
  // plugin fiber. Keep their disposers so unloading the plugin withdraws them
  // instead of leaving a stale prompt section behind.
  /** @type {Map<string, () => void>} */
  const agentSections = new Map()
  /** Admin-role sections, keyed by session; same lifecycle rule. @type {Map<string, (() => void)[]>} */
  const roleSections = new Map()
  /** Per-session persona sections (text provider reads the session/global row live). @type {Map<string, () => void>} */
  const personaSections = new Map()
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
      for (const disposers of roleSections.values()) {
        for (const dispose of disposers) {
          try {
            dispose?.()
          } catch {
            // Same as above.
          }
        }
      }
      roleSections.clear()
      for (const dispose of personaSections.values()) {
        try {
          dispose?.()
        } catch {
          // Same as above.
        }
      }
      personaSections.clear()
    },
    'context-array:agent-sections',
  )

  /** Withdraw one session's sections (agent disposal or plugin unload). */
  function releaseAgentSection(sessionId) {
    const entry = agentSections.get(sessionId)
    if (entry !== undefined) {
      agentSections.delete(sessionId)
      try {
        entry()
      } catch {
        // Already withdrawn.
      }
    }
    const persona = personaSections.get(sessionId)
    if (persona !== undefined) {
      personaSections.delete(sessionId)
      try {
        persona()
      } catch {
        // Already withdrawn.
      }
    }
    const roleEntry = roleSections.get(sessionId)
    if (roleEntry === undefined) return
    roleSections.delete(sessionId)
    for (const dispose of roleEntry) {
      try {
        dispose()
      } catch {
        // Already withdrawn.
      }
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
      // No implicit write: an unbound session simply reads the default space. The
      // plugin must not create a binding row for every session it sees.
      const bound = store.db
        .prepare(
          `SELECT s.id, s.name, s.description, l.role
             FROM session_space_links AS l
             JOIN memory_spaces AS s ON s.id = l.space_id
            WHERE l.session_id = ?
            ORDER BY l.space_id ASC`,
        )
        .all(agent.id)
      // The DB row is the source of truth for the default space (the panel can edit it);
      // config only seeds that row at first boot. Falling back to config here made every
      // newly created session use the stale config text.
      const implicitSpace =
        store.db.prepare('SELECT id, name, description FROM memory_spaces WHERE id = ?').get(config.spaceId) ?? null
      const spaces = bound.length
        ? bound
        : [
            {
              id: config.spaceId,
              name: implicitSpace?.name ?? config.spaceName,
              description: implicitSpace?.description ?? config.spaceRules,
              role: 'main',
              implicit: true,
            },
          ]
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

      // Persona: per-conversation identity. The text provider reads the session row
      // (or the global fallback) on every assembly, so an AI write (`persona_write`) or
      // a human edit in the panel applies from the next prompt without a frozen snapshot.
      if (!personaSections.has(agent.id)) {
        personaSections.set(
          agent.id,
          agent.ctx.systemPrompt.section({
            name: PERSONA_SECTION,
            order: PERSONA_ORDER,
            text: () =>
              buildPersonaText({
                traits: config.personaTraits,
                memories: listPersonalityMemories(store.db, spaces.map((space) => space.id)),
                profile: getEffectivePersona(store.db, agent.id).text,
              }),
            interpolate: false,
          }),
        )
      }

      // M3: the central memory manager gets its own L3 section. Role comes from the
      // deployment allow-list or the frozen binding — never from the model.
      const isAdmin = config.adminSessionIds.includes(agent.id) || spaces.some((space) => space.role === 'admin')
      if (isAdmin && !roleSections.has(agent.id)) {
        roleSections.set(agent.id, [
          agent.ctx.systemPrompt.section({
            name: ADMIN_L3_SECTION,
            order: ADMIN_L3_ORDER,
            text: ADMIN_L3_TEXT,
            interpolate: false,
          }),
        ])
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
