/**
 * Space, binding and memory-browsing operations shared by the M4 HTTP API.
 *
 * These are plain data functions over the SQLite store: the router, the tools and
 * the tests all call the same code, so a UI action and a tool answer cannot drift.
 */

import crypto from 'node:crypto'

import { DEFAULT_SPACE_ID } from './config.js'

/** Resolve one space row, or null. */
export function getSpace(db, id) {
  return db.prepare('SELECT id, name, description, created_at FROM memory_spaces WHERE id = ?').get(id) ?? null
}

/** All spaces with live-memory and binding counts, ordered by id. */
export function listSpacesDetailed(db) {
  return db
    .prepare(
      `SELECT s.id, s.name, s.description, s.created_at,
              (SELECT COUNT(*) FROM memories AS m
                WHERE m.space_id = s.id AND m.superseded_by IS NULL) AS memories,
              (SELECT COUNT(*) FROM session_space_links AS l WHERE l.space_id = s.id) AS sessions
         FROM memory_spaces AS s
        ORDER BY s.id ASC`,
    )
    .all()
}

/** Create a space; ids stay machine-stable (`space-<hex>`), names are display text. */
export function createSpace(db, { name, description = '' } = {}) {
  const cleanName = String(name ?? '').trim()
  if (cleanName === '') throw new Error('SPACE_NAME_REQUIRED')
  if (cleanName.length > 120) throw new Error('SPACE_NAME_TOO_LONG')
  const id = `space-${crypto.randomBytes(4).toString('hex')}`
  db.prepare('INSERT INTO memory_spaces (id, name, description) VALUES (?, ?, ?)').run(
    id,
    cleanName,
    String(description ?? ''),
  )
  return getSpace(db, id)
}

/** Rename/re-describe a space. */
export function updateSpace(db, { id, name, description } = {}) {
  const current = getSpace(db, id)
  if (!current) return null
  const nextName = name === undefined ? current.name : String(name).trim()
  if (nextName === '') throw new Error('SPACE_NAME_REQUIRED')
  const nextDescription = description === undefined ? current.description ?? '' : String(description)
  db.prepare('UPDATE memory_spaces SET name = ?, description = ? WHERE id = ?').run(nextName, nextDescription, id)
  return getSpace(db, id)
}

/**
 * Delete a space. Refuses the default space and any space that still has an ACTIVE
 * memory (the same predicate `listSpacesDetailed` counts, so the UI can disable the
 * action with the same number it shows). Superseded rows do not block deletion; they
 * are cleared together with the space so no orphan history survives it.
 */
export function deleteSpace(db, id, { defaultSpaceId = DEFAULT_SPACE_ID } = {}) {
  if (id === defaultSpaceId) return { deleted: false, reason: 'DEFAULT_SPACE' }
  const row = getSpace(db, id)
  if (!row) return { deleted: false, reason: 'NOT_FOUND' }
  const active = countActiveMemories(db, id)
  if (active > 0) return { deleted: false, reason: 'SPACE_NOT_EMPTY', memories: active }
  db.prepare('DELETE FROM memories WHERE space_id = ?').run(id)
  db.prepare('DELETE FROM inbox WHERE space_id = ?').run(id)
  db.prepare('DELETE FROM session_space_links WHERE space_id = ?').run(id)
  db.prepare('DELETE FROM memory_spaces WHERE id = ?').run(id)
  return { deleted: true }
}

/** Active (not superseded) memory count for one space, optionally one dimension. */
export function countActiveMemories(db, spaceId, dimension) {
  const row = dimension
    ? db
        .prepare(
          'SELECT COUNT(*) AS n FROM memories WHERE space_id = ? AND dimension = ? AND superseded_by IS NULL',
        )
        .get(spaceId, dimension)
    : db
        .prepare('SELECT COUNT(*) AS n FROM memories WHERE space_id = ? AND superseded_by IS NULL')
        .get(spaceId)
  return Number(row?.n ?? 0) || 0
}

/**
 * Memories in one space, newest first.
 *
 * @param {{ spaceId: string, dimension?: string, limit?: number, offset?: number, includeSuperseded?: boolean }} input
 */
export function listMemories(db, { spaceId, dimension, limit = 100, offset = 0, includeSuperseded = false } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200)
  const safeOffset = Math.max(Number(offset) || 0, 0)
  const conditions = ['space_id = ?']
  const params = [spaceId]
  if (!includeSuperseded) conditions.push('superseded_by IS NULL')
  if (dimension) {
    conditions.push('dimension = ?')
    params.push(dimension)
  }
  return db
    .prepare(
      `SELECT id, space_id, dimension, content, timestamp, superseded_by, source_session_id
         FROM memories
        WHERE ${conditions.join(' AND ')}
        ORDER BY seq DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, safeLimit, safeOffset)
}

/** Delete one memory (hard delete; the store is local and user-controlled). */
export function deleteMemory(db, id) {
  const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  return result.changes === 1
}

/** Every binding, one row per (session, space). */
export function listBindings(db) {
  return db
    .prepare(
      `SELECT l.session_id, l.space_id, l.role, s.name AS space_name
         FROM session_space_links AS l
         JOIN memory_spaces AS s ON s.id = l.space_id
        ORDER BY l.session_id ASC, l.space_id ASC`,
    )
    .all()
}

/** Sessions with at least one binding; the panel's picker source. */
export function listKnownSessions(db) {
  const rows = db
    .prepare(
      `SELECT session_id, GROUP_CONCAT(space_id || ':' || role) AS links
         FROM session_space_links
        GROUP BY session_id
        ORDER BY session_id ASC`,
    )
    .all()
  return rows.map((row) => ({
    sessionId: row.session_id,
    links: String(row.links ?? '')
      .split(',')
      .filter(Boolean)
      .map((pair) => {
        const index = pair.lastIndexOf(':')
        return { spaceId: pair.slice(0, index), role: pair.slice(index + 1) }
      }),
  }))
}

/** Upsert one link; role defaults to `main`. */
export function bindSessionToSpace(db, { sessionId, spaceId, role = 'main' } = {}) {
  if (!getSpace(db, spaceId)) return { bound: false, reason: 'SPACE_NOT_FOUND' }
  db.prepare(
    `INSERT INTO session_space_links (session_id, space_id, role) VALUES (?, ?, ?)
     ON CONFLICT(session_id, space_id) DO UPDATE SET role = excluded.role`,
  ).run(sessionId, spaceId, role)
  return { bound: true, sessionId, spaceId, role }
}

/** Remove one link. */
export function unbindSessionFromSpace(db, { sessionId, spaceId } = {}) {
  const result = db
    .prepare('DELETE FROM session_space_links WHERE session_id = ? AND space_id = ?')
    .run(sessionId, spaceId)
  return { unbound: result.changes === 1 }
}
