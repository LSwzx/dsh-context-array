/**
 * Wiring smoke test for `index.js`: runs `apply()` against a fake Host context
 * so the plugin's registration, snapshot reuse, and bootstrap-once behavior are
 * proven before the bundle is installed into a profile.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'

/** Minimal stand-in for the Cordis context the plugin talks to. */
function createFakeHost() {
  const sections = []
  const listeners = new Map()
  const effects = []
  const agentSections = []
  const ctx = {
    logger: () => ({ warn() {} }),
    effect(execute) {
      effects.push(execute())
      return () => {}
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {}
    },
  }
  const agent = {
    id: 'session-1',
    ctx: {
      systemPrompt: {
        section(section) {
          agentSections.push(section)
          return () => {
            agentSections.splice(agentSections.indexOf(section), 1)
          }
        },
      },
    },
    injected: [],
    inject(message) {
      this.injected.push(message)
      return undefined
    },
  }
  const provided = []
  ctx.provide = (name, value) => {
    provided.push({ name, value })
    return () => {}
  }
  ctx.get = (name) => {
    if (name === 'tokenMeter') return { contextPressure: () => ({ pressureTokens: 0, contextWindow: 1_048_576 }) }
    if (name === 'agents') return undefined
    return undefined
  }
  return { ctx, agent, sections, agentSections, listeners, effects, provided }
}

/**
 * Apply the plugin into a fake host on a throwaway data directory.
 * Disposers run before the directory is removed, because Windows cannot delete
 * an open SQLite file.
 */
function setup(t, config = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-array-apply-'))
  const host = createFakeHost()
  apply(host.ctx, { dataDir, ...config })
  t.after(() => {
    for (const dispose of host.effects) {
      try {
        dispose?.()
      } catch {
        // Disposal is best effort in a throwaway directory.
      }
    }
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  return { dataDir, host }
}

test('apply registers L1/L3 globally and one L4 section per session', (t) => {
  const { host } = setup(t)

  const names = host.sections.map((section) => section.name)
  assert.deepEqual(names, ['context-array:l1', 'context-array:l3'])
  assert.deepEqual(
    host.sections.map((section) => section.order),
    [100, 200],
  )

  const [agentCreated] = host.listeners.get('agent/created') ?? []
  assert.equal(typeof agentCreated, 'function')
  agentCreated({ agent: host.agent, source: 'startup' })

  assert.equal(host.agentSections.length, 1)
  const l4 = host.agentSections[0]
  assert.equal(l4.name, 'context-array:l4')
  assert.equal(l4.order, 300)
  assert.match(l4.text, /<context-array-spaces>/)
  assert.match(l4.text, /space: space-default/)

  assert.equal(host.agent.injected.length, 1)
  const message = host.agent.injected[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'context-array')
  assert.equal(message.source.form, 'snapshot')
  assert.match(message.content[0].text, /<context-array-bootstrap>/)
})

test('L4 text is snapshotted once and replayed byte-for-byte', (t) => {
  const { dataDir, host } = setup(t)
  const [agentCreated] = host.listeners.get('agent/created') ?? []

  agentCreated({ agent: host.agent, source: 'startup' })
  const first = host.agentSections[0].text

  // A second event on the same session reuses the section and the snapshot.
  agentCreated({ agent: host.agent, source: 'resume' })
  assert.equal(host.agentSections.length, 1, 'the section is registered once per session')
  assert.equal(host.agentSections[0].text, first)

  // Editing the space row afterwards cannot change the frozen snapshot.
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const db = new DatabaseSync(path.join(dataDir, 'context-array.db'))
  db.prepare('UPDATE memory_spaces SET name = ?, description = ? WHERE id = ?').run(
    'Renamed',
    'New rules',
    'space-default',
  )
  const stored = db.prepare('SELECT text FROM session_l4_snapshot').get().text
  db.close()
  assert.equal(stored, first, 'the persisted L4 text is unchanged')
})

test('bootstrap is injected once per session and never on resume', (t) => {
  const { host } = setup(t)
  const [agentCreated] = host.listeners.get('agent/created') ?? []

  agentCreated({ agent: host.agent, source: 'startup' })
  assert.equal(host.agent.injected.length, 1)

  agentCreated({ agent: host.agent, source: 'resume' })
  agentCreated({ agent: host.agent, source: 'startup' })
  assert.equal(host.agent.injected.length, 1, 'no second bootstrap for the same session')

  const other = { ...host.agent, id: 'session-2', injected: [] }
  agentCreated({ agent: other, source: 'startup' })
  assert.equal(other.injected.length, 1, 'a new session gets its own bootstrap')
})

test('a failing agent.inject never propagates', (t) => {
  const { host } = setup(t)
  const [agentCreated] = host.listeners.get('agent/created') ?? []
  const broken = {
    ...host.agent,
    id: 'session-broken',
    inject() {
      throw new Error('boom')
    },
  }
  assert.doesNotThrow(() => agentCreated({ agent: broken, source: 'startup' }))
})

test('unloading the plugin withdraws the agent-scoped L4 section', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-array-unload-'))
  const host = createFakeHost()
  apply(host.ctx, { dataDir })
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))

  const [agentCreated] = host.listeners.get('agent/created') ?? []
  agentCreated({ agent: host.agent, source: 'startup' })
  assert.equal(host.agentSections.length, 1)

  // Cordis unwinds a fiber's effects in reverse order; doing the same here
  // proves the agent-scoped registration is owned by this plugin fiber.
  for (const dispose of [...host.effects].reverse()) {
    try {
      dispose?.()
    } catch {
      // best effort
    }
  }
  assert.equal(host.agentSections.length, 0, 'L4 section withdrawn with the plugin')
})

test('a second bootstrap for the same session does not duplicate the L4 section', (t) => {
  const { host } = setup(t)
  const [agentCreated] = host.listeners.get('agent/created') ?? []
  agentCreated({ agent: host.agent, source: 'startup' })
  agentCreated({ agent: host.agent, source: 'startup' })
  assert.equal(host.agentSections.length, 1)
})

test('agents already live at activation are bootstrapped without agent/created', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-array-live-'))
  const host = createFakeHost()
  const live = { ...host.agent, id: 'session-live', injected: [], sections: [] }
  live.ctx = {
    systemPrompt: {
      section(section) {
        live.sections.push(section)
        return () => {}
      },
    },
  }
  host.ctx.get = (name) => (name === 'agents' ? { list: () => [live] } : undefined)

  apply(host.ctx, { dataDir })
  t.after(() => {
    for (const dispose of host.effects) {
      try {
        dispose?.()
      } catch {
        // best effort
      }
    }
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  assert.equal(live.sections.length, 1)
  assert.equal(live.sections[0].name, 'context-array:l4')
  assert.match(live.sections[0].text, /space: space-default/)
  assert.equal(live.injected.length, 1)
  assert.match(live.injected[0].content[0].text, /<context-array-bootstrap>/)
})

test('L1 text is a provider that stays byte-identical until the salt file exists', (t) => {
  const { dataDir, host } = setup(t)
  const l1 = host.sections.find((section) => section.name === 'context-array:l1')
  assert.equal(typeof l1.text, 'function')
  const plain = l1.text({})
  assert.equal(plain.includes('<context-array-salt>'), false)

  fs.writeFileSync(path.join(dataDir, 'prompt-salt.txt'), 'experiment-A')
  const salted = l1.text({})
  assert.equal(salted.startsWith(plain), true)
  assert.match(salted, /<context-array-salt>experiment-A<\/context-array-salt>/)
  // Deterministic while the file is unchanged.
  assert.equal(l1.text({}), salted)
})

test('compaction takeover is opt-in: default leaves the seam untouched', (t) => {
  const { host } = setup(t)
  assert.equal(host.provided.length, 0, 'off mode must not claim ctx.compaction')
})

test('observe mode claims the seam once and records it in events.jsonl', (t) => {
  const { dataDir, host } = setup(t, { compactionMode: 'observe' })
  assert.equal(host.provided.length, 1)
  assert.equal(host.provided[0].name, 'compaction')
  assert.equal(typeof host.provided[0].value.compactIfNeeded, 'function')

  const events = fs
    .readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(events[0].type, 'compaction/provider-installed')
})

test('history replacement events are recorded even with compaction off', (t) => {
  const { dataDir, host } = setup(t)
  const [sessionEvent] = host.listeners.get('session/event') ?? []
  assert.equal(typeof sessionEvent, 'function')
  sessionEvent({ id: 'session-1' }, { type: 'user/message', seq: 9, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 8 } })
  const events = fs
    .readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(events[0].type, 'history/replace')
  assert.equal(events[0].sessionId, 'session-1')
})

test('the llm/stream listener records usage and passes chunks through', async (t) => {
  const { dataDir, host } = setup(t)

  const [wrap] = host.listeners.get('llm/stream') ?? []
  assert.equal(typeof wrap, 'function')

  const chunks = [
    { type: 'text-delta', index: 0, text: 'hi' },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 90, cacheWriteTokens: 0 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const options = {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    sessionId: 'session-1',
    messages: [{ role: 'system', content: [{ type: 'text', text: 'L1L3L4' }] }],
    tools: [{ name: 'read', description: 'd', parameters: { type: 'object' } }],
  }
  const stream = wrap(options, () =>
    (async function* () {
      yield* chunks
    })(),
  )

  const seen = []
  for await (const chunk of stream) seen.push(chunk)

  assert.equal(seen.length, 3)
  for (let i = 0; i < chunks.length; i += 1) assert.equal(seen[i], chunks[i], 'chunk identity preserved')

  const records = fs
    .readFileSync(path.join(dataDir, 'usage.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(records.length, 1)
  assert.equal(records[0].hitRate, 0.9)
  assert.equal(records[0].cacheReadTokens, 90)
  assert.equal(records[0].usageSource, 'normalized-usage-chunk')
})
