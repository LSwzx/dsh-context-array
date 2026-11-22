/**
 * Tests for src/db.js — schema, migrations, FTS5 trigram path and the M1 helpers.
 *
 * Every test works inside its own os.tmpdir() directory and removes it again;
 * nothing here touches the user's ~/.dsh.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveConfig, SCHEMA_VERSION } from '../src/config.js';
import {
  META_KEYS,
  bindSessionSpaces,
  ensureDefaultSpace,
  getOrCreateL4Snapshot,
  getUsageStats,
  listSpaces,
  markBootstrapped,
  migrate,
  openStore,
} from '../src/db.js';

const REQUIRED_TABLES = [
  'memory_spaces',
  'session_space_links',
  'memories',
  'memories_fts',
  'inbox',
  'memory_queue',
  'session_l4_snapshot',
  'inbox_wake_log',
  'meta',
  'session_bootstrap',
];
const REQUIRED_INDEXES = [
  'idx_memories_space_valid',
  'idx_wake_log_target',
  'idx_wake_log_at',
  'idx_memory_queue_dedupe',
  'idx_memory_queue_status',
];
const REQUIRED_TRIGGERS = ['memories_ai', 'memories_ad', 'memories_au'];

/**
 * Open a migrated store in a fresh temp directory and clean it up afterwards.
 *
 * @param {import('node:test').TestContext} t
 * @param {object} [raw] extra config overrides
 * @returns {{ dir: string, config: object, store: object, db: import('node:sqlite').DatabaseSync }}
 */
function tempStore(t, raw = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-context-array-'));
  const config = resolveConfig({ dataDir: path.join(dir, 'data'), ...raw });
  const store = openStore(config);
  t.after(() => {
    try {
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  return { dir, config, store, db: store.db };
}

/** Insert a memory row (FTS is maintained by the triggers) and return its seq. */
function insertMemory(db, { id, content, spaceId = 'space-default', dimension = 'fact', embedding = null }) {
  const result = db
    .prepare(
      `INSERT INTO memories(id, space_id, dimension, content, embedding, source_session_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, spaceId, dimension, content, embedding, 'session-test');
  return Number(result.lastInsertRowid);
}

/** FTS5 trigram MATCH, returning the matched seq values. */
function ftsMatch(db, query) {
  return db
    .prepare('SELECT rowid FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rowid ASC')
    .all(query)
    .map((row) => Number(row.rowid));
}

test('openStore() creates the data dir, a WAL database and migrates it', (t) => {
  const { dir, config, store, db } = tempStore(t);

  assert.ok(fs.statSync(config.dataDir).isDirectory());
  assert.ok(fs.statSync(config.dbPath).isFile());
  assert.ok(config.dataDir.startsWith(dir));
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION);
  assert.equal(
    db.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEYS.schemaVersion).value,
    String(SCHEMA_VERSION),
  );
  assert.deepEqual(store.meta, { schemaVersion: SCHEMA_VERSION });
  assert.equal(store.config, config);
});

test('migrate() is idempotent and keeps recording the schema version', (t) => {
  const { db } = tempStore(t);

  assert.deepEqual(migrate(db), { schemaVersion: SCHEMA_VERSION });
  assert.deepEqual(migrate(db), { schemaVersion: SCHEMA_VERSION });

  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION);
  assert.equal(
    db.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEYS.schemaVersion).value,
    String(SCHEMA_VERSION),
  );
});

test('reopening the same database path does not throw', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-context-array-'));
  const config = resolveConfig({ dataDir: path.join(dir, 'data') });
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const first = openStore(config);
  stores.push(first);
  first.close();
  const second = openStore(config);
  stores.push(second);
  assert.deepEqual(second.meta, { schemaVersion: SCHEMA_VERSION });
  assert.deepEqual(listSpaces(second.db), []);
  second.close();

  // Two live connections on the same path must also coexist.
  const a = openStore(config);
  const b = openStore(config);
  stores.push(a, b);
  ensureDefaultSpace(a.db, config);
  assert.equal(listSpaces(b.db).length, 1);
});

test('the schema contains every table, index and trigger from the contract', (t) => {
  const { db } = tempStore(t);

  const namesOf = (type) =>
    new Set(
      db
        .prepare('SELECT name FROM sqlite_master WHERE type = ?')
        .all(type)
        .map((row) => row.name),
    );

  const tables = namesOf('table');
  const indexes = namesOf('index');
  const triggers = namesOf('trigger');

  for (const table of REQUIRED_TABLES) assert.ok(tables.has(table), `missing table ${table}`);
  for (const index of REQUIRED_INDEXES) assert.ok(indexes.has(index), `missing index ${index}`);
  for (const trigger of REQUIRED_TRIGGERS) assert.ok(triggers.has(trigger), `missing trigger ${trigger}`);
});

test('memories_fts is an external-content trigram FTS5 table keyed on seq', (t) => {
  const { db } = tempStore(t);

  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts'").get().sql;
  assert.match(sql, /fts5/i);
  assert.match(sql, /content='memories'/);
  assert.match(sql, /content_rowid='seq'/);
  assert.match(sql, /tokenize='trigram'/);

  const embeddingType = db
    .prepare('SELECT type FROM pragma_table_info(?) WHERE name = ?')
    .all('memories', 'embedding')[0].type;
  assert.equal(embeddingType, 'BLOB');
});

test('Chinese trigram MATCH finds memories and rowid maps to the explicit seq', (t) => {
  const { db } = tempStore(t);

  const seq = insertMemory(db, {
    id: 'm1',
    dimension: 'fact',
    content: '五维记忆库设计：中文子串检索与 trigram 分词',
    embedding: Buffer.from([1, 2, 3]),
  });
  insertMemory(db, { id: 'm2', content: 'unrelated English row about sqlite internals' });

  assert.deepEqual(ftsMatch(db, '中文子串'), [seq]);
  assert.deepEqual(ftsMatch(db, '五维记忆'), [seq]);

  const hit = db.prepare('SELECT rowid, content FROM memories_fts WHERE memories_fts MATCH ?').get('trigram 分词');
  assert.equal(Number(hit.rowid), seq);
  assert.match(hit.content, /trigram/);

  // embedding is stored as a BLOB and stays nullable.
  assert.equal(db.prepare('SELECT embedding FROM memories WHERE seq = ?').get(seq).embedding.length, 3);
  assert.equal(db.prepare('SELECT embedding FROM memories WHERE id = ?').get('m2').embedding, null);
});

test('FTS triggers stay in sync on update and delete, and VACUUM keeps seq stable', (t) => {
  const { db } = tempStore(t);

  const seq = insertMemory(db, { id: 'm1', content: '五维记忆库：中文子串检索测试' });
  assert.deepEqual(ftsMatch(db, '中文子串'), [seq]);

  db.prepare('UPDATE memories SET content = ? WHERE seq = ?').run('完全不同的内容 alpha beta', seq);
  assert.deepEqual(ftsMatch(db, '中文子串'), []);
  assert.deepEqual(ftsMatch(db, 'beta'), [seq]);
  assert.equal(db.prepare('SELECT content FROM memories_fts WHERE rowid = ?').get(seq).content, '完全不同的内容 alpha beta');

  db.exec('VACUUM');
  assert.deepEqual(ftsMatch(db, 'beta'), [seq], 'rowid == seq survives VACUUM');
  assert.equal(Number(db.prepare('SELECT seq FROM memories WHERE id = ?').get('m1').seq), seq);

  db.prepare('DELETE FROM memories WHERE seq = ?').run(seq);
  assert.deepEqual(ftsMatch(db, 'beta'), []);
});

test('ensureDefaultSpace() inserts the configured space once and never rewrites it', (t) => {
  const { db } = tempStore(t);
  const config = resolveConfig({
    spaceId: 'space-main',
    spaceName: 'Main space',
    spaceRules: 'Rules of the main space.',
  });

  const row = ensureDefaultSpace(db, config);
  assert.equal(row.id, 'space-main');
  assert.equal(row.name, 'Main space');
  assert.equal(row.description, 'Rules of the main space.');
  assert.equal(typeof row.created_at, 'string');

  const again = ensureDefaultSpace(db, resolveConfig({ spaceId: 'space-main', spaceName: 'Renamed', spaceRules: 'New rules.' }));
  assert.equal(again.name, 'Main space', 'an existing space is frozen');
  assert.equal(again.description, 'Rules of the main space.');
  assert.equal(listSpaces(db).length, 1);
});

test('listSpaces() returns spaces in creation order', (t) => {
  const { db } = tempStore(t);
  const config = resolveConfig({});

  ensureDefaultSpace(db, config);
  db.prepare('INSERT INTO memory_spaces(id, name, description) VALUES (?, ?, ?)').run(
    'space-second',
    'Second',
    null,
  );

  assert.deepEqual(
    listSpaces(db).map((space) => space.id),
    [config.spaceId, 'space-second'],
  );
  assert.equal(listSpaces(db)[1].description, null);
});

test('bindSessionSpaces() links spaces, freezes the role and returns rows ordered by space_id', (t) => {
  const { db } = tempStore(t);
  db.prepare('INSERT INTO memory_spaces(id, name) VALUES (?, ?)').run('space-a', 'A');
  db.prepare('INSERT INTO memory_spaces(id, name) VALUES (?, ?)').run('space-b', 'B');

  const rows = bindSessionSpaces(db, 'session-1', ['space-b', 'space-a'], 'main');
  assert.deepEqual(
    rows.map((row) => [row.id, row.role]),
    [
      ['space-a', 'main'],
      ['space-b', 'main'],
    ],
  );

  const frozen = bindSessionSpaces(db, 'session-1', ['space-a', 'space-b'], 'sub');
  assert.deepEqual(
    frozen.map((row) => row.role),
    ['main', 'main'],
    'the first binding wins',
  );

  // Dedupes ids, skips blanks; every remaining id gets a link, but only rows
  // backed by an existing space are reported back.
  const deduped = bindSessionSpaces(db, 'session-2', ['space-a', 'space-a', '', 'ghost'], 'sub');
  assert.deepEqual(
    deduped.map((row) => row.id),
    ['space-a'],
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM session_space_links WHERE session_id = ?').get('session-2').n,
    2,
    'space-a and ghost are linked, the duplicate and blank id are not',
  );
});

test('bindSessionSpaces() rejects an invalid role or session id', (t) => {
  const { db } = tempStore(t);

  assert.throws(() => bindSessionSpaces(db, 'session-1', ['space-a'], 'owner'), TypeError);
  assert.throws(() => bindSessionSpaces(db, '', ['space-a'], 'main'), TypeError);
});

test('bindSessionSpaces() keeps every session isolated from the others', (t) => {
  const { db } = tempStore(t);
  db.prepare('INSERT INTO memory_spaces(id, name) VALUES (?, ?)').run('space-a', 'A');
  db.prepare('INSERT INTO memory_spaces(id, name) VALUES (?, ?)').run('space-b', 'B');

  bindSessionSpaces(db, 'session-1', ['space-a'], 'main');
  bindSessionSpaces(db, 'session-2', ['space-b'], 'admin');

  assert.deepEqual(
    bindSessionSpaces(db, 'session-1', [], 'main').map((row) => row.id),
    ['space-a'],
  );
  assert.deepEqual(
    bindSessionSpaces(db, 'session-2', [], 'admin').map((row) => row.id),
    ['space-b'],
  );
  assert.deepEqual(bindSessionSpaces(db, 'session-3', [], 'sub'), []);
});

test('getOrCreateL4Snapshot() renders once, then replays the frozen text byte for byte', (t) => {
  const { db } = tempStore(t);
  const spaces = [{ id: 'space-default', name: 'Default space' }];
  const expectedText = '# L4\nspace: space-default\nrules: shared workspace facts';
  let calls = 0;
  const render = (spacesArg) => {
    calls += 1;
    assert.equal(spacesArg, spaces);
    return expectedText;
  };

  const first = getOrCreateL4Snapshot(db, { sessionId: 'session-1', spaces, render });
  assert.equal(first.created, true);
  assert.equal(first.text, expectedText);
  assert.equal(
    first.hash,
    crypto.createHash('sha256').update(first.text, 'utf8').digest('hex'),
  );
  assert.equal(calls, 1);

  const second = getOrCreateL4Snapshot(db, {
    sessionId: 'session-1',
    spaces: [{ id: 'space-other' }],
    render: () => {
      calls += 1;
      return 'CHANGED TEXT';
    },
  });
  assert.equal(second.created, false);
  assert.equal(second.text, first.text);
  assert.equal(second.hash, first.hash);
  assert.equal(calls, 1, 'render() is not called again');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_l4_snapshot').get().n, 1);
});

test('getOrCreateL4Snapshot() keeps one snapshot per session', (t) => {
  const { db } = tempStore(t);

  const one = getOrCreateL4Snapshot(db, {
    sessionId: 'session-1',
    spaces: [{ id: 'space-a' }],
    render: (spaces) => `L4 ${spaces[0].id}`,
  });
  const two = getOrCreateL4Snapshot(db, {
    sessionId: 'session-2',
    spaces: [{ id: 'space-b' }],
    render: (spaces) => `L4 ${spaces[0].id}`,
  });

  assert.equal(one.created, true);
  assert.equal(two.created, true);
  assert.equal(one.text, 'L4 space-a');
  assert.equal(two.text, 'L4 space-b');
  assert.notEqual(one.hash, two.hash);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_l4_snapshot').get().n, 2);
});

test('getOrCreateL4Snapshot() validates its arguments', (t) => {
  const { db } = tempStore(t);

  assert.throws(() => getOrCreateL4Snapshot(db, { sessionId: '', render: () => 'x' }), TypeError);
  assert.throws(() => getOrCreateL4Snapshot(db, { sessionId: 'session-1' }), TypeError);
  assert.throws(
    () => getOrCreateL4Snapshot(db, { sessionId: 'session-1', render: () => 42 }),
    TypeError,
  );
});

test('markBootstrapped() is true only for the first bootstrap of a session', (t) => {
  const { db } = tempStore(t);

  assert.equal(markBootstrapped(db, 'session-1'), true);
  assert.equal(markBootstrapped(db, 'session-1'), false);
  assert.equal(markBootstrapped(db, 'session-1'), false);
  assert.equal(markBootstrapped(db, 'session-2'), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_bootstrap').get().n, 2);
  assert.throws(() => markBootstrapped(db, ''), TypeError);
});

test('getUsageStats() reads the meta counters best effort', (t) => {
  const { db } = tempStore(t);

  assert.deepEqual(getUsageStats(db), { requests: 0, logs: 0, lastLogAt: null });

  const write = db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)');
  write.run(META_KEYS.usageRequests, '17');
  write.run(META_KEYS.usageLogs, '42');
  write.run(META_KEYS.usageLastAt, '2026-11-21T13:00:00.000Z');
  assert.deepEqual(getUsageStats(db), {
    requests: 17,
    logs: 42,
    lastLogAt: '2026-11-21T13:00:00.000Z',
  });

  write.run(META_KEYS.usageRequests, 'not-a-number');
  write.run(META_KEYS.usageLogs, '-5');
  write.run(META_KEYS.usageLastAt, '');
  assert.deepEqual(getUsageStats(db), { requests: 0, logs: 0, lastLogAt: null });
});

test('close() is idempotent', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-context-array-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = openStore(resolveConfig({ dataDir: path.join(dir, 'data') }));
  store.close();
  store.close();

  const reopened = openStore(resolveConfig({ dataDir: path.join(dir, 'data') }));
  assert.equal(listSpaces(reopened.db).length, 0);
  reopened.close();
});

test('openStore() requires a non-empty config.dataDir', () => {
  assert.throws(() => openStore({}), TypeError);
  assert.throws(() => openStore({ dataDir: '' }), TypeError);
  assert.throws(() => openStore(null), TypeError);
});
