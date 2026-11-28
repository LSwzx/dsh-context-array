/**
 * `e2e_run` / `e2e_status` — admin-only driver for tools/e2e-real.mjs.
 *
 * The scenario needs the live host (`ctx.agents`) to create blank sessions and deliver
 * natural-language turns, which a standalone node script cannot do. This tool supplies
 * that host, runs the scenario in the background, and lets the admin poll progress.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'

import { runE2E } from '../tools/e2e-real.mjs'
import { sessionBinding } from './memory-tools.js'

const REPORT_URL = new URL('../docs/E2E-REAL-REPORT.md', import.meta.url)

/**
 * @param {{ ctx: any, db: any, config: any, events?: any, warn?: Function }} input
 */
export function createE2ETool({ ctx, db, config, events = null, warn = () => {} }) {
  const isAdmin = (sessionId) =>
    new Set(Array.isArray(config.adminSessionIds) ? config.adminSessionIds : []).has(sessionId) ||
    sessionBinding(db, sessionId, config.spaceId).role === 'admin'
  let state = { running: false, startedAt: null, finishedAt: null, progress: [], result: null, error: null }
  let routeOptions = {}

  const log = (message) => {
    state.progress.push({ at: new Date().toISOString(), message })
    try {
      events?.append({ type: 'e2e/progress', message, at: new Date().toISOString() })
    } catch {
      // Observability only.
    }
  }

  const usagePath = config.usageLogPath
  const readUsage = () => {
    try {
      return fs
        .readFileSync(usagePath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
  const countFor = (sessionId) => readUsage().filter((row) => row.sessionId === sessionId).length

  async function waitIdle(sessionId, timeoutMs = 120_000) {
    const started = Date.now()
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    let lastCount = countFor(sessionId)
    let stable = 0
    while (Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      const count = countFor(sessionId)
      if (count === lastCount) {
        stable += 1
        if (stable >= 3 && count > 0) return { requests: count }
      } else {
        stable = 0
        lastCount = count
      }
    }
    return { requests: lastCount, timedOut: true }
  }

  const host = {
    cleanFixtures() {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare('DELETE FROM memories WHERE space_id = ?').run('space-e2e')
        db.prepare('DELETE FROM session_space_links WHERE space_id = ?').run('space-e2e')
        db.prepare('DELETE FROM inbox WHERE space_id = ? OR content LIKE ?').run('space-e2e', '%E2E%')
        db.prepare('DELETE FROM memory_spaces WHERE id = ?').run('space-e2e')
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    ensureSpace() {
      db.prepare('INSERT INTO memory_spaces (id, name, description) VALUES (?, ?, ?)').run(
        'space-e2e',
        'E2E 真实对话空间',
        '真实对话验收专用空间；规则在会话创建时冻结。',
      )
    },
    bind(sessionId, role) {
      db.prepare(
        `INSERT INTO session_space_links (session_id, space_id, role) VALUES (?, 'space-e2e', ?)
         ON CONFLICT(session_id, space_id) DO UPDATE SET role = excluded.role`,
      ).run(sessionId, role)
    },
    async createSession(label) {
      const sessionId = crypto.randomUUID()
      const agents = ctx.get?.('agents')
      if (!agents?.create) throw new Error('agents service unavailable')
      await agents.create({
        sessionId,
        meta: { cwd: process.cwd() },
        agentOptions: Object.keys(routeOptions).length > 0 ? routeOptions : undefined,
      })
      return sessionId
    },
    async send(sessionId, text) {
      const agents = ctx.get?.('agents')
      const agent = agents?.get?.(sessionId)
      if (!agent) return { sent: false, error: 'agent-not-live' }
      const before = countFor(sessionId)
      const shapes = [
        () => agent.followup({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }),
        () => agent.followup({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
        () => agent.followup({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'context-array' } }),
      ]
      for (const [index, shape] of shapes.entries()) {
        try {
          shape()
        } catch (error) {
          log(`round send shape ${index} rejected: ${String(error?.message ?? error)}`)
          continue
        }
        for (let wait = 0; wait < 8; wait += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2_000))
          if (countFor(sessionId) > before) {
            const outcome = await waitIdle(sessionId)
            return { sent: true, shape: index, ...outcome }
          }
        }
        log(`round send shape ${index} started no request`)
      }
      return { sent: false, error: 'turn-not-started' }
    },
    usageLines: async () => readUsage(),
    now: () => new Date().toISOString(),
  }

  const reportPath = REPORT_URL.pathname.replace(/^\/([A-Za-z]:)/, '$1')

  async function run(adminSessionId) {
    state = { running: true, startedAt: new Date().toISOString(), finishedAt: null, progress: [], result: null, error: null }
    const admin = ctx.get?.('agents')?.get?.(adminSessionId)
    if (admin?.options) {
      const { provider, model, reasoningEffort } = admin.options
      routeOptions = {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      }
      log(`route ${routeOptions.provider ?? '?'}/${routeOptions.model ?? '?'}`)
    }
    const offError = ctx.on?.('agent/error', (payload) =>
      log('agent/error ' + String(payload?.error?.message ?? payload).slice(0, 200)),
    )
    try {
      const result = await runE2E({ host, reportPath, log })
      state.result = {
        reportPath,
        sessions: result.sessions,
        rounds: result.results,
        totals: result.usage.totals,
        cost: result.usage.cost,
      }
    } catch (error) {
      warn(error)
      state.error = String(error?.message ?? error)
    } finally {
      try {
        offError?.()
      } catch {
        // Listener removal is best effort.
      }
      state.running = false
      state.finishedAt = new Date().toISOString()
    }
  }

  const runTool = {
    name: 'e2e_run',
    description:
      'Run the full real-conversation E2E scenario (admin only): clean the test space, create four brand-new',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'E2E started' }] },
    async execute(args, exec) {
      if (!isAdmin(exec?.agent?.id)) return { started: false, error: 'ADMIN_ONLY' }
      if (state.running) return { started: false, running: true }
      run(exec?.agent?.id).catch(() => {})
      return { started: true, reportPath }
    },
  }

  const statusTool = {
    name: 'e2e_status',
    description: 'Report progress of the real-conversation E2E scenario (admin only).',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!isAdmin(exec?.agent?.id)) return { error: 'ADMIN_ONLY' }
      return {
        running: state.running,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        progress: state.progress.slice(-8),
        result: state.result,
        error: state.error,
      }
    },
  }

  return [runTool, statusTool]
}
