/**
 * M4 space management and bindings.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { resolveConfig } from '../src/config.js'
import { bindSessionSpaces, ensureDefaultSpace, openStore } from '../src/db.js'
import {
  bindSessionToSpace,
  createSpace,
  deleteMemory,
  deleteSpace,
  getSpace,
  listBindings,
  listKnownSessions,
  listMemories,
  listSpacesDetailed,
  unbindSessionFromSpace,
  updateSpace,
} from '../src/spaces.js'

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-array-spaces-'))
  const config = resolveConfig({ dataDir })
  const opened = openStore(config)
  ensureDefaultSpace(opened.db, config)
  t.after(() => {
    opened.close()
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  return opened.db
}

test('spaces can be created, renamed and listed with counts', (t) => {
  const db = fixture(t)
  const space = createSpace(db, { name: 'Work', description: 'job facts' })
  assert.match(space.id, /^space-[0-9a-f]{8}$/)
  updateSpace(db, { id: space.id, name: 'Work 2' })
  assert.equal(getSpace(db, space.id).name, 'Work 2')

  const spaces = listSpacesDetailed(db)
  assert.equal(spaces.length, 2)
  assert.equal(spaces.find((row) => row.id === space.id).memories, 0)
  assert.equal(spaces.find((row) => row.id === space.id).sessions, 0)
})

test('delete refuses the default space and non-empty spaces', (t) => {
  const db = fixture(t)
  assert.deepEqual(deleteSpace(db, 'space-default'), { deleted: false, reason: 'DEFAULT_SPACE' })

  const space = createSpace(db, { name: 'Temp' })
  db.prepare('INSERT INTO memories (id, space_id, dimension, content, source_session_id) VALUES (?, ?, ?, ?, ?)').run(
    'm1',
    space.id,
    'fact',
    'x',
    's1',
  )
  const refused = deleteSpace(db, space.id)
  assert.equal(refused.deleted, false)
  assert.equal(refused.reason, 'SPACE_NOT_EMPTY')

  deleteMemory(db, 'm1')
  assert.deepEqual(deleteSpace(db, space.id), { deleted: true })
  assert.equal(getSpace(db, space.id), null)
})

test('bindings upsert, list and unbind', (t) => {
  const db = fixture(t)
  const space = createSpace(db, { name: 'Second' })
  assert.deepEqual(bindSessionToSpace(db, { sessionId: 's1', spaceId: space.id }), {
    bound: true,
    sessionId: 's1',
    spaceId: space.id,
    role: 'main',
  })
  bindSessionToSpace(db, { sessionId: 's1', spaceId: space.id, role: 'admin' })
  const rows = listBindings(db).filter((row) => row.session_id === 's1')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].role, 'admin')

  const known = listKnownSessions(db)
  assert.deepEqual(known, [{ sessionId: 's1', links: [{ spaceId: space.id, role: 'admin' }] }])

  assert.deepEqual(unbindSessionFromSpace(db, { sessionId: 's1', spaceId: space.id }), { unbound: true })
  assert.deepEqual(unbindSessionFromSpace(db, { sessionId: 's1', spaceId: space.id }), { unbound: false })
})

test('bind refuses an unknown space', (t) => {
  const db = fixture(t)
  assert.equal(bindSessionToSpace(db, { sessionId: 's1', spaceId: 'space-missing' }).reason, 'SPACE_NOT_FOUND')
})

test('memories list newest first and hide superseded ones', (t) => {
  const db = fixture(t)
  const space = createSpace(db, { name: 'List' })
  for (const [id, content] of [
    ['a', 'first'],
    ['b', 'second'],
  ]) {
    db.prepare('INSERT INTO memories (id, space_id, dimension, content, source_session_id) VALUES (?, ?, ?, ?, ?)').run(
      id,
      space.id,
      'fact',
      content,
      's1',
    )
  }
  const rows = listMemories(db, { spaceId: space.id })
  assert.deepEqual(
    rows.map((row) => row.id),
    ['b', 'a'],
  )

  db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run('c', 'b')
  assert.deepEqual(
    listMemories(db, { spaceId: space.id }).map((row) => row.id),
    ['a'],
  )
  assert.equal(listMemories(db, { spaceId: space.id, includeSuperseded: true }).length, 2)
})
