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
  countActiveMemories,
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
  assert.equal(refused.memories, 1)

  deleteMemory(db, 'm1')
  assert.deepEqual(deleteSpace(db, space.id), { deleted: true })
  assert.equal(getSpace(db, space.id), null)
})

test('deletion counts only active memories but clears superseded rows and inbox rows', (t) => {
  const db = fixture(t)
  const space = createSpace(db, { name: 'Legacy' })
  const insert = (id, supersededBy) =>
    db
      .prepare('INSERT INTO memories (id, space_id, dimension, content, source_session_id, superseded_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, space.id, 'fact', id, 's1', supersededBy)
  insert('old', 'new')
  insert('new', null)
  db.prepare("INSERT INTO inbox (id, space_id, source_session_id, target_session_id, content) VALUES (?, ?, ?, ?, ?)").run(
    'inbox-1',
    space.id,
    's1',
    's2',
    'hi',
  )

  // Active memory blocks deletion with the same count the list shows.
  const blocked = deleteSpace(db, space.id)
  assert.equal(blocked.deleted, false)
  assert.equal(blocked.memories, 1)
  assert.equal(countActiveMemories(db, space.id), 1)

  // Remove the active one: only the superseded row is left, which must not block.
  db.prepare('DELETE FROM memories WHERE id = ?').run('new')
  assert.deepEqual(deleteSpace(db, space.id), { deleted: true })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE space_id = ?').get(space.id).n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE space_id = ?').get(space.id).n, 0)
})

test('listMemories filters by dimension, paginates, and countActiveMemories agrees', (t) => {
  const db = fixture(t)
  const space = createSpace(db, { name: 'Filter' })
  const insert = (id, dimension) =>
    db
      .prepare('INSERT INTO memories (id, space_id, dimension, content, source_session_id) VALUES (?, ?, ?, ?, ?)')
      .run(id, space.id, dimension, id, 's1')
  insert('a', 'fact')
  insert('b', 'fact')
  insert('c', 'reflection')

  assert.equal(countActiveMemories(db, space.id), 3)
  assert.equal(countActiveMemories(db, space.id, 'fact'), 2)
  assert.deepEqual(
    listMemories(db, { spaceId: space.id, dimension: 'fact' }).map((row) => row.id),
    ['b', 'a'],
  )
  assert.deepEqual(
    listMemories(db, { spaceId: space.id, dimension: 'fact', limit: 1, offset: 1 }).map((row) => row.id),
    ['a'],
  )
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

test('the protected default space follows the configured id, not a hardcoded one', (t) => {
  const db = fixture(t)
  const customDefault = createSpace(db, { name: 'Custom default' })
  assert.deepEqual(deleteSpace(db, customDefault.id, { defaultSpaceId: customDefault.id }), {
    deleted: false,
    reason: 'DEFAULT_SPACE',
  })
  // The built-in id is deletable when it is no longer the configured default and empty.
  assert.deepEqual(deleteSpace(db, 'space-default', { defaultSpaceId: customDefault.id }), { deleted: true })
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
