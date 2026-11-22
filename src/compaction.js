/**
 * Compaction takeover (M0-6) and history-replacement detection (M1-4).
 *
 * Facts that shaped this module:
 * - `ctx.compaction` is an abstract service seam (`dsh-compaction`); shipped
 *   implementers (`dsh-compaction-basic`) register it and own both the policy
 *   listeners and the surface replacement.
 * - A successful compaction REPLACES a surface span with one summary node
 *   (`surfaceOp: { op: 'replace', startSeq, endSeq }`), which invalidates the
 *   provider cache from that point on. Append-only "compression" cannot shrink
 *   a token budget, so the only real choice is when to pay that one-time cost.
 * - Registering a provider requires the default implementer to be absent:
 *   loading two implementations into one context is rejected by the service
 *   registry. Disable it with a bundle patch row (`- id: compaction-basic` /
 *   `disabled: true`) before switching this plugin to `observe`.
 *
 * `mode: 'off'`      — do nothing; the deployment keeps whatever it had.
 * `mode: 'observe'`  — claim the seam, log pressure samples, never fold. This is
 *                      the verification build: it proves the takeover path and
 *                      surfaces where a fold would happen, without risking data.
 * `mode: 'fold'`     — the same seam plus a real fold: summarize the oldest safe
 *                      range and replace it with one checkpoint message.
 */

import { foldSession } from './compaction-fold.js'

export const COMPACTION_MODES = Object.freeze(['off', 'observe', 'fold'])

/**
 * Build the `ctx.compaction` implementation used in `observe` mode.
 *
 * @param {{ mode?: string, events: { append: (record: object) => void }, now?: () => number }} input
 * @returns {{ name: string, compactIfNeeded: Function, compactNow: Function, compactRegion: Function }}
 */
export function createCompactionProvider({ mode = 'observe', events, now = () => Date.now(), foldOptions = null }) {
  function observe(trigger, agent) {
    events.append({
      type: 'compaction/observe',
      mode,
      trigger,
      at: new Date(now()).toISOString(),
      sessionId: agent?.id ?? null,
    })
  }

  if (mode === 'fold' && foldOptions !== null) {
    return {
      name: 'compaction',
      /** Automatic policy entry point; a real fold when pressure and safety allow it. */
      async compactIfNeeded(agent, trigger = 'pressure', signal) {
        observe(trigger, agent)
        return foldSession({ ...foldOptions, agent, trigger, signal })
      },
      /** Manual compaction entry point: fold regardless of the pressure policy. */
      async compactNow(agent, signal) {
        observe('manual', agent)
        return foldSession({ ...foldOptions, agent, trigger: 'manual', signal })
      },
      /** Explicit region folding is not exposed; automatic/manual folding covers M0-6. */
      async compactRegion() {
        throw new Error('context-array: compactRegion is not implemented')
      },
    }
  }

  return {
    name: 'compaction',
    /**
     * Automatic policy entry point. `observe` never folds: returning `null`
     * means "no safe or desired range", which every caller already handles.
     */
    async compactIfNeeded(agent, trigger) {
      observe(trigger, agent)
      return null
    },
    /** Manual `/compact` entry point; same no-op in `observe`. */
    async compactNow(agent) {
      observe('manual', agent)
      return null
    },
    /** Region folding is the destructive path and is not implemented in observe. */
    async compactRegion() {
      throw new Error('context-array: compactRegion is not implemented in observe mode')
    },
  }
}

/**
 * Claim the compaction seam in `observe` mode.
 *
 * @param {object} input
 * @param {any} input.ctx - plugin Host context
 * @param {{ compactionMode: string, compactionWarnTokens: number }} input.config
 * @param {{ append: (record: object) => void }} input.events
 * @param {(error: unknown) => void} [input.warn]
 * @param {() => number} [input.now]
 * @returns {{ installed: boolean, reason: string }}
 */
export function installCompactionTakeover({ ctx, config, events, warn = () => {}, now = () => Date.now() }) {
  if (config.compactionMode !== 'observe' && config.compactionMode !== 'fold') {
    return { installed: false, reason: 'off' }
  }

  const foldOptions = {
    ctx,
    config: {
      foldRatio: config.compactionFoldRatio,
      retainRatio: config.compactionRetainRatio,
      minFoldTokens: config.compactionMinFoldTokens,
      summaryMaxTokens: config.compactionSummaryMaxTokens,
    },
    events,
    warn,
  }
  const provider = createCompactionProvider({
    mode: config.compactionMode,
    events,
    now,
    foldOptions,
  })
  try {
    ctx.provide('compaction', provider)
  } catch (error) {
    // Most likely another implementation (dsh-compaction-basic) already owns the
    // seam. Report it instead of pretending the takeover happened.
    events.append({ type: 'compaction/provider-conflict', message: String(error?.message ?? error) })
    warn(error)
    return { installed: false, reason: 'conflict' }
  }
  events.append({ type: 'compaction/provider-installed', mode: config.compactionMode })

  const lastSampleAt = new Map()
  const alarmed = new Set()
  /** Cooldown for automatic fold attempts, per session. */
  const lastFoldAttemptAt = new Map()
  const alarmRatio = config.compactionAlarmRatio ?? 0.8

  /** Record at most one pressure sample per session per minute; never throws. */
  function samplePressure(payload) {
    const agent = payload?.agent
    if (!agent?.id) return
    const meter = ctx.get?.('tokenMeter')
    const pressure = meter?.contextPressure?.(agent.session)
    if (!pressure || !Number.isFinite(pressure.pressureTokens)) return
    const window = Number.isFinite(pressure.contextWindow) ? pressure.contextWindow : null
    const ratio = window && window > 0 ? pressure.pressureTokens / window : null

    // Folding is deliberately not implemented yet, so the only honest advice at
    // the alarm line is "start a new session before the window fills". Alarm once
    // per crossing; re-arm when pressure drops well below the line.
    if (ratio !== null && ratio >= alarmRatio) {
      if (!alarmed.has(agent.id)) {
        alarmed.add(agent.id)
        events.append({
          type: 'compaction/alarm',
          sessionId: agent.id,
          pressureTokens: pressure.pressureTokens,
          contextWindow: window,
          ratio: Math.round(ratio * 1000) / 1000,
          alarmRatio,
          advice: 'folding is not implemented; start a new session before the context window fills',
        })
      }
    } else if (ratio !== null && ratio < alarmRatio * 0.9) {
      alarmed.delete(agent.id)
    }

    if (pressure.pressureTokens < config.compactionWarnTokens) return
    if (now() - (lastSampleAt.get(agent.id) ?? 0) < 60_000) return
    lastSampleAt.set(agent.id, now())
    events.append({
      type: 'compaction/pressure',
      sessionId: agent.id,
      pressureTokens: pressure.pressureTokens,
      contextWindow: window,
      ratio: ratio === null ? null : Math.round(ratio * 1000) / 1000,
      warnTokens: config.compactionWarnTokens,
    })
  }

  // `agent/pre-step` is a cordis waterfall, not a broadcast: the loop awaits the
  // chain's return value and reads `decision.kind`. A listener that never calls
  // `next()` vetoes the chain, `preStep` receives `undefined` and the turn dies
  // with "Cannot read properties of undefined (reading 'kind')". Sampling is a
  // pure side effect, so it always delegates — including after an internal error.
  //
  // `observe` keeps the listener synchronous so the step pipeline is untouched;
  // only `fold` pays for an asynchronous summary inside pre-step.
  if (config.compactionMode === 'fold') {
    ctx.on('agent/pre-step', async (payload, next) => {
      try {
        samplePressure(payload)
      } catch (error) {
        warn(error)
      }
      try {
        await maybeFold(payload)
      } catch (error) {
        // A failed fold must never veto the step; any durable lock has already
        // been closed inside foldSession.
        warn(error)
      }
      return next()
    })
  } else {
    ctx.on('agent/pre-step', (payload, next) => {
      try {
        samplePressure(payload)
      } catch (error) {
        warn(error)
      }
      return next()
    })
  }

  /**
   * Attempt one automatic fold for this pre-step, with a per-session cooldown so a
   * session that cannot fold is not re-priced on every step.
   */
  async function maybeFold(payload) {
    const agent = payload?.agent
    if (!agent?.id) return
    const meter = ctx.get?.('tokenMeter')
    const pressure = meter?.contextPressure?.(agent.session)
    const window = pressure?.contextWindow
    const ratio = window && pressure?.pressureTokens ? pressure.pressureTokens / window : null
    if (ratio === null || ratio < config.compactionFoldRatio) return
    if (now() - (lastFoldAttemptAt.get(agent.id) ?? 0) < 300_000) return
    lastFoldAttemptAt.set(agent.id, now())
    await provider.compactIfNeeded(agent, 'pressure', payload?.signal)
  }

  return { installed: true, reason: config.compactionMode, provider }
}

/**
 * Record every history replacement, whoever performs it.
 *
 * This is what lets the usage log separate "steady state" from "the prefix was
 * just rewritten": compaction (`compaction/summary` + a replacing `user/message`)
 * and tool-result pruning both land as `surfaceOp: replace` events.
 *
 * @param {{ ctx: any, events: { append: (record: object) => void }, warn?: (error: unknown) => void }} input
 * @returns {{ dispose: () => void }}
 */
export function installHistoryReplacementWatch({ ctx, events, warn = () => {} }) {
  const dispose = ctx.on('session/event', (session, event) => {
    try {
      const op = event?.surfaceOp
      if (!op || op.op !== 'replace') return
      events.append({
        type: 'history/replace',
        sessionId: session?.id ?? null,
        eventType: event?.type ?? null,
        seq: event?.seq ?? null,
        startSeq: op.startSeq ?? null,
        endSeq: op.endSeq ?? null,
        sourceEvents: Array.isArray(event?.sourceEventSeqs) ? event.sourceEventSeqs.length : 0,
      })
    } catch (error) {
      warn(error)
    }
  })
  return { dispose }
}
