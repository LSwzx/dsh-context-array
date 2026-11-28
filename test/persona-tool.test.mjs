/**
 * The agent writes its own per-conversation persona; the human picks any conversation
 * (or the global default) in the panel and edits it.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { resolveConfig } from '../src/config.js'
import {
  ensureDefaultSpace,
  getEffectivePersona,
  getPersonaProfile,
  getSessionPersonaProfile,
  openStore,
  setPersonaProfile,
  setSessionPersonaProfile,
} from '../src/db.js'
import { buildPersonaText } from '../src/persona.js'
import { createPersonaWriteTool } from '../src/persona-tool.js'

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-array-persona-tool-'))
  const config = resolveConfig({ dataDir })
  const opened = openStore(config)
  ensureDefaultSpace(opened.db, config)
  t.after(() => {
    opened.close()
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  return opened.db
}

test('the persona section renders the stored profile and invites a first write', () => {
  const withProfile = buildPersonaText({ profile: '我叫肥鱼，称呼用户为老板。' })
  assert.match(withProfile, /YOUR PERSONA/)
  assert.match(withProfile, /我叫肥鱼/)

  const empty = buildPersonaText({})
  assert.match(empty, /no recorded persona yet/)
  assert.match(empty, /persona_write/)
})

test('persona_write writes the calling session by default and appends', async (t) => {
  const db = fixture(t)
  const tool = createPersonaWriteTool({ db })

  const first = await tool.execute({ text: '我叫肥鱼。' }, { agent: { id: 's1' } })
  assert.equal(first.updated, true)
  assert.equal(first.scope, 'session')
  assert.equal(getSessionPersonaProfile(db, 's1').text, '我叫肥鱼。')
  assert.equal(getSessionPersonaProfile(db, 's1').updatedBy, 'agent')
  assert.equal(getPersonaProfile(db).text, '', 'a session write does not touch the global fallback')

  const appended = await tool.execute({ text: '保持简洁。', mode: 'append' }, { agent: { id: 's1' } })
  assert.equal(appended.mode, 'append')
  assert.equal(getSessionPersonaProfile(db, 's1').text, '我叫肥鱼。\n保持简洁。')
  assert.equal(getEffectivePersona(db, 's1').text, '我叫肥鱼。\n保持简洁。')
  assert.equal(getEffectivePersona(db, 'other').scope, 'global')

  const globalWrite = await tool.execute({ text: '默认人格', scope: 'global' }, { agent: { id: 's1' } })
  assert.equal(globalWrite.scope, 'global')
  assert.equal(getPersonaProfile(db).text, '默认人格')

  const cleared = await tool.execute({ text: '' }, { agent: { id: 's1' } })
  assert.equal(cleared.updated, false)
  assert.equal(getSessionPersonaProfile(db, 's1').text, '我叫肥鱼。\n保持简洁。')
})

test('a human edit and an agent edit share the same per-session row', (t) => {
  const db = fixture(t)
  setSessionPersonaProfile(db, { sessionId: 's1', text: 'AI 写的初版', updatedBy: 'agent' })
  setSessionPersonaProfile(db, { sessionId: 's1', text: '用户改过的版本', updatedBy: 'human' })
  const profile = getSessionPersonaProfile(db, 's1')
  assert.equal(profile.text, '用户改过的版本')
  assert.equal(profile.updatedBy, 'human')
  assert.ok(profile.updatedAt)
  assert.match(buildPersonaText({ profile: getEffectivePersona(db, 's1').text }), /用户改过的版本/)
  assert.equal(getEffectivePersona(db, 's2').scope, 'global')
})
