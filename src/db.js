/**
 * SQLite storage layer for dsh-context-array (M1 single-space schema).
 *
 * Built on the runtime's synchronous `node:sqlite` `DatabaseSync` API. That API
 * has no `db.transaction()` wrapper, so transactions are written by hand as
 * `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`.
 *
 * The DDL mirrors `dsh-context-array-v4.1.md` §4 (made idempotent with
 * `IF NOT EXISTS`) plus the two M1 additions `meta` and `session_bootstrap`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  DEFAULT_SPACE_ID,
  DEFAULT_SPACE_NAME,
  DEFAULT_SPACE_RULES,
  SCHEMA_VERSION,
} from './config.js';

/** `meta` keys shared with the usage observer (`src/observer.js`). */
export const META_KEYS = Object.freeze({
  schemaVersion: 'schema_version',
  usageRequests: 'usage_requests',
  usageLogs: 'usage_logs',
  usageLastAt: 'usage_last_at',
});

/** The whole §4 schema as one idempotent script. */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session_space_links (
  session_id TEXT,
  space_id TEXT,
  role TEXT CHECK(role IN ('admin', 'main', 'sub')),
  PRIMARY KEY (session_id, space_id)
);

CREATE TABLE IF NOT EXISTS memories (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  space_id TEXT NOT NULL,
  dimension TEXT CHECK(dimension IN ('working', 'recent', 'fact', 'reflection', 'personality')),
  content TEXT NOT NULL,
  embedding BLOB,
  superseded_by TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  source_session_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_space_valid ON memories(space_id, superseded_by);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='seq',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.seq, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.seq, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.seq, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.seq, new.content);
END;

CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  source_session_id TEXT,
  target_session_id TEXT,
  content TEXT,
  trigger_msg_id TEXT,
  dedupe_key TEXT,
  hop_count INT DEFAULT 0,
  status TEXT CHECK(status IN ('pending', 'read', 'failed')) DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(space_id, source_session_id, target_session_id, dedupe_key)
);

CREATE TABLE IF NOT EXISTS memory_queue (
  id TEXT PRIMARY KEY,
  source_session_id TEXT,
  raw_content TEXT,
  status TEXT CHECK(status IN ('pending', 'processing', 'done', 'rejected', 'failed')) DEFAULT 'pending',
  retry_count INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  claimed_at DATETIME,
  dedupe_key TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS session_l4_snapshot (
  session_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inbox_wake_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_session_id TEXT NOT NULL,
  source_session_id TEXT,
  inbox_id TEXT,
  throttled INTEGER NOT NULL DEFAULT 0,
  at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wake_log_target ON inbox_wake_log(target_session_id, at);
CREATE INDEX IF NOT EXISTS idx_wake_log_at ON inbox_wake_log(at);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS session_bootstrap (
  session_id TEXT PRIMARY KEY,
  bootstrapped_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session_persona_snapshot (
  session_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS persona_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  text TEXT NOT NULL DEFAULT '',
  updated_by TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session_persona_profile (
  session_id TEXT PRIMARY KEY,
  text TEXT NOT NULL DEFAULT '',
  updated_by TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

/**
 * Run `work` inside `BEGIN IMMEDIATE` / `COMMIT`, rolling back on any throw.
 *
 * @template T
 * @param {DatabaseSync} db
 * @param {() => T} work
 * @returns {T}
 */
function inTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction may already be gone; the original error is what matters.
    }
    throw error;
  }
}

/**
 * @param {string} text
 * @returns {string} hex sha256 of the UTF-8 bytes
 */
function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * node:sqlite returns null-prototype rows; hand plain objects to callers.
 *
 * @template {object} T
 * @param {T|null|undefined} row
 * @returns {T|null}
 */
function plainRow(row) {
  return row ? { ...row } : null;
}

/**
 * @param {unknown} value
 * @returns {number} non-negative integer, or 0 when unusable
 */
function toCount(value) {
  const count = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

/**
 * Normalise the `spaceIds` argument into a de-duplicated list of ids.
 *
 * @param {unknown} spaceIds array, Set (or other iterable), or a single id
 * @returns {string[]}
 */
function toIdList(spaceIds) {
  if (spaceIds === null || spaceIds === undefined) return [];
  const list =
    typeof spaceIds === 'string'
      ? [spaceIds]
      : typeof spaceIds[Symbol.iterator] === 'function'
        ? [...spaceIds]
        : [];
  return [...new Set(list.filter((id) => typeof id === 'string' && id !== ''))];
}

/**
 * Create the schema when absent and record the schema version.
 *
 * Idempotent: safe to run on every open, and on an already-migrated database.
 *
 * @param {DatabaseSync} db
 * @returns {{ schemaVersion: number }}
 */
export function migrate(db) {
  inTransaction(db, () => {
    db.exec(SCHEMA_SQL);
    // Additive upgrades for databases created before M3. Each step checks the live
    // column list first, so re-running is a no-op.
    const queueColumns = new Set(
      db.prepare('PRAGMA table_info(memory_queue)').all().map((column) => column.name),
    );
    if (!queueColumns.has('dedupe_key')) db.exec('ALTER TABLE memory_queue ADD COLUMN dedupe_key TEXT');
    if (!queueColumns.has('error')) db.exec('ALTER TABLE memory_queue ADD COLUMN error TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_memory_queue_dedupe ON memory_queue(dedupe_key)');
    db.exec("CREATE INDEX IF NOT EXISTS idx_memory_queue_status ON memory_queue(status, created_at)");

    const current = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (!(current >= SCHEMA_VERSION)) {
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
      META_KEYS.schemaVersion,
      String(SCHEMA_VERSION),
    );
  });
  return { schemaVersion: SCHEMA_VERSION };
}

/**
 * Read the single global persona profile.
 *
 * The persona is global (one agent identity), written by the agent itself through
 * `persona_write` and editable by the human in the panel.
 *
 * @param {any} db
 * @returns {{ text: string, updatedBy: string | null, updatedAt: string | null }}
 */
export function getPersonaProfile(db) {
  const row = db.prepare('SELECT text, updated_by, updated_at FROM persona_profile WHERE id = 1').get()
  return {
    text: typeof row?.text === 'string' ? row.text : '',
    updatedBy: row?.updated_by ?? null,
    updatedAt: row?.updated_at ?? null,
  }
}

/**
 * Replace the global persona text.
 *
 * @param {any} db
 * @param {{ text: string, updatedBy?: string | null }} input
 * @returns {{ text: string, updatedBy: string | null, updatedAt: string | null }}
 */
export function setPersonaProfile(db, { text, updatedBy = null } = {}) {
  db.prepare(
    `INSERT INTO persona_profile (id, text, updated_by, updated_at) VALUES (1, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET text = excluded.text, updated_by = excluded.updated_by,
                                   updated_at = CURRENT_TIMESTAMP`,
  ).run(String(text ?? ''), updatedBy === null ? null : String(updatedBy))
  return getPersonaProfile(db)
}

/**
 * Read one session's own persona row (the AI writes this by default).
 *
 * @param {any} db
 * @param {string} sessionId
 * @returns {{ text: string, updatedBy: string | null, updatedAt: string | null } | null}
 */
export function getSessionPersonaProfile(db, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const row = db
    .prepare('SELECT text, updated_by, updated_at FROM session_persona_profile WHERE session_id = ?')
    .get(sessionId)
  if (!row) return null
  return {
    text: typeof row.text === 'string' ? row.text : '',
    updatedBy: row.updated_by ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

/**
 * Replace one session's persona row.
 *
 * @param {any} db
 * @param {{ sessionId: string, text: string, updatedBy?: string | null }} input
 */
export function setSessionPersonaProfile(db, { sessionId, text, updatedBy = null } = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') throw new TypeError('setSessionPersonaProfile: sessionId required')
  db.prepare(
    `INSERT INTO session_persona_profile (session_id, text, updated_by, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(session_id) DO UPDATE SET text = excluded.text, updated_by = excluded.updated_by,
                                           updated_at = CURRENT_TIMESTAMP`,
  ).run(sessionId, String(text ?? ''), updatedBy === null ? null : String(updatedBy))
  return getSessionPersonaProfile(db, sessionId)
}

/**
 * Effective persona for one session: its own row, else the global default row.
 *
 * @param {any} db
 * @param {string} sessionId
 */
export function getEffectivePersona(db, sessionId) {
  const own = getSessionPersonaProfile(db, sessionId)
  if (own) return { ...own, scope: 'session' }
  return { ...getPersonaProfile(db), scope: 'global' }
}

/** Every space id, for global persona trait aggregation. */
export function listSpaceIds(db) {
  try {
    return db.prepare('SELECT id FROM memory_spaces ORDER BY id ASC').all().map((row) => row.id)
  } catch {
    return []
  }
}

/**
 * Freeze one session's personality block.
 *
 * Same contract as the L4 snapshot: the first render is stored and reused byte-for-byte
 * so the persona section cannot churn the cache and cannot be rewritten mid-session by
 * anything a tool returns.
 *
 * @param {{ sessionId: string, render: () => string }} input
 * @returns {{ text: string, hash: string, created: boolean }}
 */
export function getOrCreatePersonaSnapshot(db, { sessionId, render } = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new TypeError('getOrCreatePersonaSnapshot: sessionId must be a non-empty string');
  }
  if (typeof render !== 'function') {
    throw new TypeError('getOrCreatePersonaSnapshot: render must be a function');
  }
  const select = db.prepare('SELECT text, hash FROM session_persona_snapshot WHERE session_id = ?');
  const existing = select.get(sessionId);
  if (existing) return { text: existing.text, hash: existing.hash, created: false };

  const text = render();
  if (typeof text !== 'string') {
    throw new TypeError('getOrCreatePersonaSnapshot: render() must return a string');
  }
  const result = db
    .prepare('INSERT OR IGNORE INTO session_persona_snapshot(session_id, text, hash) VALUES (?, ?, ?)')
    .run(sessionId, text, sha256(text));
  const stored = select.get(sessionId);
  return { text: stored.text, hash: stored.hash, created: result.changes === 1 };
}

/**
 * Active `personality` memories across the given spaces, oldest first.
 *
 * @param {any} db
 * @param {readonly string[]} spaceIds
 * @returns {string[]}
 */
export function listPersonalityMemories(db, spaceIds) {
  const ids = Array.isArray(spaceIds) ? spaceIds.filter((id) => typeof id === 'string' && id !== '') : [];
  if (ids.length === 0) return [];
  try {
    return db
      .prepare(
        `SELECT content FROM memories
          WHERE dimension = 'personality' AND superseded_by IS NULL
            AND space_id IN (${ids.map(() => '?').join(',')})
          ORDER BY seq ASC`,
      )
      .all(...ids)
      .map((row) => row.content);
  } catch {
    return [];
  }
}

/**
 * Create `config.dataDir`, open the database in WAL mode and migrate it.
 *
 * @param {{ dataDir: string, dbPath?: string }} config resolved config (see `resolveConfig`)
 * @returns {{ db: DatabaseSync, config: object, meta: { schemaVersion: number }, close: () => void }}
 */
export function openStore(config) {
  if (config === null || typeof config !== 'object' || typeof config.dataDir !== 'string' || config.dataDir === '') {
    throw new TypeError('openStore: config.dataDir must be a non-empty string');
  }

  const dataDir = path.resolve(config.dataDir);
  const dbPath =
    typeof config.dbPath === 'string' && config.dbPath !== ''
      ? config.dbPath
      : path.join(dataDir, 'context-array.db');

  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  let closed = false;

  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    migrate(db);
  } catch (error) {
    closed = true;
    try {
      db.close();
    } catch {
      // Ignore close failures: the migration error is the useful one.
    }
    throw error;
  }

  return {
    db,
    config,
    meta: { schemaVersion: SCHEMA_VERSION },
    /** Close the database. Idempotent: later calls are no-ops. */
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

/**
 * Ensure the configured default space exists and return its row.
 *
 * The row is never updated afterwards: space name/rules are frozen for
 * existing sessions by design (they only feed the L4 snapshot).
 *
 * @param {DatabaseSync} db
 * @param {{ spaceId?: string, spaceName?: string, spaceRules?: string }} [cfg]
 * @returns {{ id: string, name: string, description: string|null, created_at: string }|null}
 */
export function ensureDefaultSpace(db, cfg) {
  const spaceId = cfg?.spaceId || DEFAULT_SPACE_ID;
  const spaceName = cfg?.spaceName || DEFAULT_SPACE_NAME;
  const spaceRules = cfg?.spaceRules || DEFAULT_SPACE_RULES;

  db.prepare('INSERT OR IGNORE INTO memory_spaces(id, name, description) VALUES (?, ?, ?)').run(
    spaceId,
    spaceName,
    spaceRules,
  );
  return plainRow(
    db
      .prepare('SELECT id, name, description, created_at FROM memory_spaces WHERE id = ?')
      .get(spaceId),
  );
}

/**
 * List all spaces in creation order.
 *
 * @param {DatabaseSync} db
 * @returns {Array<{ id: string, name: string, description: string|null, created_at: string }>}
 */
export function listSpaces(db) {
  return db
    .prepare(
      'SELECT id, name, description, created_at FROM memory_spaces ORDER BY created_at ASC, id ASC',
    )
    .all()
    .map((row) => ({ ...row }));
}

/**
 * Bind a session to spaces with one role (links are frozen per session/space).
 *
 * Unknown space ids are still linked; callers read them back through the join,
 * which only reports ids present in `memory_spaces`.
 *
 * @param {DatabaseSync} db
 * @param {string} sessionId
 * @param {string[]|Set<string>|string} spaceIds
 * @param {'admin'|'main'|'sub'} role
 * @returns {Array<{ id: string, name: string, description: string|null, created_at: string, role: string }>}
 */
export function bindSessionSpaces(db, sessionId, spaceIds, role) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new TypeError('bindSessionSpaces: sessionId must be a non-empty string');
  }
  if (role !== 'admin' && role !== 'main' && role !== 'sub') {
    throw new TypeError("bindSessionSpaces: role must be 'admin', 'main' or 'sub'");
  }

  const ids = toIdList(spaceIds);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO session_space_links(session_id, space_id, role) VALUES (?, ?, ?)',
  );
  inTransaction(db, () => {
    for (const spaceId of ids) insert.run(sessionId, spaceId, role);
  });

  return db
    .prepare(
      `SELECT s.id, s.name, s.description, s.created_at, l.role
         FROM session_space_links AS l
         JOIN memory_spaces AS s ON s.id = l.space_id
        WHERE l.session_id = ?
        ORDER BY l.space_id ASC`,
    )
    .all(sessionId)
    .map((row) => ({ ...row }));
}

/**
 * Return the frozen L4 snapshot of a session, creating it on first call.
 *
 * `render(spaces)` is only called when no snapshot exists; the text and its
 * sha256 are then persisted once and replayed byte-for-byte on later calls.
 *
 * @param {DatabaseSync} db
 * @param {{ sessionId: string, spaces: unknown, render: (spaces: unknown) => string }} args
 * @returns {{ text: string, hash: string, created: boolean }}
 */
export function getOrCreateL4Snapshot(db, { sessionId, spaces, render } = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new TypeError('getOrCreateL4Snapshot: sessionId must be a non-empty string');
  }
  if (typeof render !== 'function') {
    throw new TypeError('getOrCreateL4Snapshot: render must be a function');
  }

  const select = db.prepare('SELECT text, hash FROM session_l4_snapshot WHERE session_id = ?');
  const existing = select.get(sessionId);
  if (existing) {
    return { text: existing.text, hash: existing.hash, created: false };
  }

  const text = render(spaces);
  if (typeof text !== 'string') {
    throw new TypeError('getOrCreateL4Snapshot: render(spaces) must return a string');
  }
  const hash = sha256(text);
  const result = db
    .prepare('INSERT OR IGNORE INTO session_l4_snapshot(session_id, text, hash) VALUES (?, ?, ?)')
    .run(sessionId, text, hash);
  const stored = select.get(sessionId);

  return { text: stored.text, hash: stored.hash, created: result.changes === 1 };
}

/**
 * Record the first bootstrap of a session.
 *
 * @param {DatabaseSync} db
 * @param {string} sessionId
 * @returns {boolean} true only for the call that created the row
 */
export function markBootstrapped(db, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new TypeError('markBootstrapped: sessionId must be a non-empty string');
  }
  const result = db
    .prepare('INSERT OR IGNORE INTO session_bootstrap(session_id) VALUES (?)')
    .run(sessionId);
  return result.changes === 1;
}

/**
 * Read the usage counters the observer keeps in `meta`.
 *
 * Best effort: a missing/unmigrated `meta` table or unparsable values yield
 * zeros/null instead of throwing.
 *
 * @param {DatabaseSync} db
 * @returns {{ requests: number, logs: number, lastLogAt: string|null }}
 */
export function getUsageStats(db) {
  const stats = { requests: 0, logs: 0, lastLogAt: null };
  try {
    const read = db.prepare('SELECT value FROM meta WHERE key = ?');
    stats.requests = toCount(read.get(META_KEYS.usageRequests)?.value);
    stats.logs = toCount(read.get(META_KEYS.usageLogs)?.value);
    const lastLogAt = read.get(META_KEYS.usageLastAt)?.value;
    stats.lastLogAt = typeof lastLogAt === 'string' && lastLogAt !== '' ? lastLogAt : null;
  } catch {
    // meta is optional for a partially migrated database; report defaults.
  }
  return stats;
}
