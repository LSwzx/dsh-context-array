/**
 * Tests for src/db-memories.js — memory writes, the FTS5 trigram keyword path,
 * the LIKE fallback and the vector-scan query.
 *
 * Every test works inside its own os.tmpdir() directory and removes it again;
 * nothing here touches the user's ~/.dsh.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openStore } from '../src/db.js';
import {
  DEFAULT_KEYWORD_LIMIT,
  DIMENSIONS,
  MEMORY_ERRORS,
  countMemories,
  fromBlob,
  insertMemory,
  keywordSearchMode,
  listActiveEmbeddings,
  listMemoryHistory,
  normalizeSpaceIds,
  searchKeyword,
  toBlob,
} from '../src/db-memories.js';

const SPACE = 'space-default';
const SESSION = 'session-test';

/**
 * Open a migrated store in a fresh temp directory and clean it up afterwards.
 *
 * @param {import('node:test').TestContext} t
 * @returns {{ db: import('node:sqlite').DatabaseSync, store: object }}
 */
function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-context-array-mem-'));
  const store = openStore({ dataDir: path.join(dir, 'data') });
  t.after(() => {
    try {
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  return { db: store.db, store };
}

/** Insert one memory with terse arguments. */
function add(db, id, content, extra = {}) {
  return insertMemory(db, {
    id,
    spaceId: SPACE,
    dimension: 'fact',
    content,
    sourceSessionId: SESSION,
    ...extra,
  });
}

/** Search one space and return just the ids, best match first. */
function ids(db, query, extra = {}) {
  return searchKeyword(db, { spaceIds: [SPACE], query, ...extra }).map((row) => row.id);
}

/** A normalised 3-dim vector. */
function vec(x, y, z) {
  const length = Math.hypot(x, y, z) || 1;
  return new Float32Array([x / length, y / length, z / length]);
}

test('insertMemory stores a row and countMemories reports it', (t) => {
  const { db } = tempStore(t);
  assert.deepEqual(countMemories(db), { total: 0, active: 0 });

  const id = add(db, 'm1', '用户偏好深色主题和中文界面');
  assert.equal(id, 'm1');
  assert.deepEqual(countMemories(db), { total: 1, active: 1 });
});

test('FTS5 trigram matches Chinese substrings of three or more characters', (t) => {
  const { db } = tempStore(t);
  add(db, 'm1', '用户偏好深色主题和中文界面');

  assert.deepEqual(ids(db, '深色主题'), ['m1']);
  assert.deepEqual(ids(db, '中文界'), ['m1']);
  assert.deepEqual(ids(db, '和中文'), ['m1']);
  assert.deepEqual(ids(db, '不存在的词'), []);
});

test('FTS5 matches English terms independently and ranks by bm25', (t) => {
  const { db } = tempStore(t);
  add(db, 'm1', 'prefers a dark color theme in editors');
  add(db, 'm2', 'the editor font is too small');
  add(db, 'm3', '颜色主题');

  // Two terms, OR-ed: both documents contain one of them.
  assert.deepEqual(ids(db, 'dark theme').sort(), ['m1']);
  assert.deepEqual(ids(db, 'editor').sort(), ['m1', 'm2']);

  const rows = searchKeyword(db, { spaceIds: [SPACE], query: 'editor theme' });
  assert.deepEqual(rows.map((row) => row.id), ['m1', 'm2']);
  assert.ok(rows[0].score > rows[1].score, 'bm25 score must be higher for the better match');
  assert.equal(rows[0].spaceId, SPACE);
  assert.equal(rows[0].dimension, 'fact');
  assert.equal(rows[0].content, 'prefers a dark color theme in editors');
});

test('searchKeyword filters by space and by validity, in both paths', (t) => {
  const { db } = tempStore(t);
  add(db, 'mine', '深色主题偏好');
  add(db, 'theirs', '深色主题偏好', { spaceId: 'space-other' });
  add(db, 'stale', '深色主题偏好', { spaceId: SPACE });
  // Supersede "stale" so it must drop out of every path.
  insertMemory(db, {
    id: 'fresh',
    spaceId: SPACE,
    dimension: 'fact',
    content: '深色主题偏好（新）',
    sourceSessionId: SESSION,
    supersedesId: 'stale',
  });

  assert.deepEqual(ids(db, '深色主题偏好').sort(), ['fresh', 'mine']);
  // 2-character query: the LIKE fallback applies the same filters.
  assert.deepEqual(ids(db, '深色').sort(), ['fresh', 'mine']);
  // Isolation is per space: the other space only sees its own memory.
  assert.deepEqual(ids(db, '深色主题偏好', { spaceIds: ['space-other'] }), ['theirs']);
  assert.deepEqual(ids(db, '深色主题偏好', { spaceIds: ['space-unbound'] }), []);
  assert.deepEqual(ids(db, '深色主题偏好', { spaceIds: [] }), []);
});

test('supersede records the pointer and hides the old memory', (t) => {
  const { db } = tempStore(t);
  add(db, 'old', '项目截止日期是三月');
  add(db, 'new', '项目截止日期是四月', { supersedesId: 'old' });

  const row = db.prepare('SELECT superseded_by FROM memories WHERE id = ?').get('old');
  assert.equal(row.superseded_by, 'new');
  assert.deepEqual(countMemories(db), { total: 2, active: 1 });
  assert.equal(countMemories(db).total - countMemories(db).active, 1);

  // Keyword path: only the replacement.
  assert.deepEqual(ids(db, '项目截止日期'), ['new']);
  assert.deepEqual(ids(db, '三月'), []);
  // Vector path: only the replacement.
  assert.deepEqual(
    listActiveEmbeddings(db, [SPACE]).map((memory) => memory.id),
    [],
    'neither row has an embedding',
  );
});

test('a failed supersede rolls the whole insert back', (t) => {
  const { db } = tempStore(t);

  assert.throws(
    () => add(db, 'orphan', '新的记忆', { supersedesId: 'does-not-exist' }),
    (error) => {
      assert.equal(error.code, MEMORY_ERRORS.supersedeFailed);
      assert.match(error.message, /SUPERSEDE_FAILED|cannot supersede/u);
      return true;
    },
  );
  // The insert must be gone as well, not just the update.
  assert.deepEqual(countMemories(db), { total: 0, active: 0 });
  assert.deepEqual(ids(db, '新的记忆'), []);

  // Cross-space supersede is refused for the same reason.
  add(db, 'in-a', '旧记忆', { spaceId: 'space-a' });
  assert.throws(
    () =>
      insertMemory(db, {
        id: 'in-b',
        spaceId: 'space-b',
        dimension: 'fact',
        content: '新记忆',
        sourceSessionId: SESSION,
        supersedesId: 'in-a',
      }),
    (error) => error.code === MEMORY_ERRORS.supersedeFailed,
  );
  assert.deepEqual(countMemories(db), { total: 1, active: 1 });

  // Superseding an already superseded memory fails too.
  add(db, 'a2', '旧记忆二', { spaceId: 'space-a' });
  add(db, 'a3', '新记忆二', { spaceId: 'space-a', supersedesId: 'a2' });
  assert.throws(
    () => add(db, 'a4', '新记忆三', { spaceId: 'space-a', supersedesId: 'a2' }),
    (error) => error.code === MEMORY_ERRORS.supersedeFailed,
  );
});

test('short queries use the LIKE fallback with literal wildcards escaped', (t) => {
  const { db } = tempStore(t);
  add(db, 'zh', '用户偏好深色主题');
  add(db, 'percent', '折扣 50%off 活动');
  add(db, 'underscore', '字段 user_id 已存在');
  add(db, 'decoy1', 'no xo here');
  add(db, 'decoy2', 'zzid');

  // 2 characters: below the trigram threshold.
  assert.deepEqual(ids(db, '深色'), ['zh']);
  assert.deepEqual(ids(db, '偏好'), ['zh']);
  assert.equal(ids(db, '偏好').length, 1);

  // '%' must be a literal, not a wildcard: unescaped it would also hit decoy1.
  assert.deepEqual(ids(db, '%o'), ['percent']);
  // '_' must be a literal, not a single-character wildcard.
  assert.deepEqual(ids(db, '_i'), ['underscore']);

  // A single ASCII character still resolves through LIKE.
  assert.deepEqual(ids(db, 'z'), ['decoy2']);
});

test('keywordSearchMode mirrors the path searchKeyword actually takes', (t) => {
  const { db } = tempStore(t);
  add(db, 'zh', '用户偏好深色主题');

  assert.equal(keywordSearchMode('深色主题'), 'fts');
  assert.equal(keywordSearchMode('deep dark'), 'fts');
  assert.equal(keywordSearchMode('深色'), 'like');
  assert.equal(keywordSearchMode('z'), 'like');
  // Three or more characters, but no term reaches a trigram: LIKE as well.
  assert.equal(keywordSearchMode('用户 偏好'), 'like');
  assert.equal(keywordSearchMode('  '), 'skipped');
  assert.equal(keywordSearchMode(''), 'skipped');
  assert.equal(keywordSearchMode(null), 'skipped');
  assert.equal(keywordSearchMode(42), 'skipped');

  // And the mode agrees with real hits: the mixed short-term query works.
  assert.deepEqual(ids(db, '用户 偏好'), ['zh']);
});

test('degenerate FTS queries fall back instead of throwing', (t) => {
  const { db } = tempStore(t);
  add(db, 'm1', '用户偏好深色主题');

  for (const query of ['***', '"""', '"', 'AND', 'NEAR(', '-', '\\', '😀😀😀', '  深色  ']) {
    const result = searchKeyword(db, { spaceIds: [SPACE], query });
    assert.ok(Array.isArray(result), `query ${JSON.stringify(query)} must return an array`);
  }
  assert.deepEqual(ids(db, '  深色  '), ['m1'], 'surrounding whitespace is trimmed');
  assert.deepEqual(ids(db, '😀😀😀'), []);
});

test('searchKeyword honours the limit and stays deterministic', (t) => {
  const { db } = tempStore(t);
  for (let index = 0; index < 25; index += 1) {
    add(db, `m${String(index).padStart(2, '0')}`, `共同话题 第 ${index} 条`);
  }

  assert.equal(searchKeyword(db, { spaceIds: [SPACE], query: '共同话题' }).length, DEFAULT_KEYWORD_LIMIT);
  assert.equal(searchKeyword(db, { spaceIds: [SPACE], query: '共同话题', limit: 5 }).length, 5);
  assert.equal(searchKeyword(db, { spaceIds: [SPACE], query: '共同话题', limit: 0 }).length, DEFAULT_KEYWORD_LIMIT);

  assert.deepEqual(
    searchKeyword(db, { spaceIds: [SPACE], query: '共同话题', limit: 5 }),
    searchKeyword(db, { spaceIds: [SPACE], query: '共同话题', limit: 5 }),
  );
});

test('listActiveEmbeddings returns Float32Array copies for valid rows only', (t) => {
  const { db } = tempStore(t);
  const stored = vec(0.6, 0.8, 0);
  add(db, 'with-vector', '有向量的记忆', { embedding: stored });
  add(db, 'without-vector', '没有向量的记忆');

  const active = listActiveEmbeddings(db, [SPACE]);
  assert.equal(active.length, 1);
  const [memory] = active;
  assert.equal(memory.id, 'with-vector');
  assert.equal(memory.spaceId, SPACE);
  assert.equal(memory.dimension, 'fact');
  assert.equal(memory.content, '有向量的记忆');
  assert.ok(memory.vec instanceof Float32Array);
  assert.equal(memory.vec.length, 3);
  for (let index = 0; index < 3; index += 1) {
    assert.ok(Math.abs(memory.vec[index] - stored[index]) < 1e-6);
  }

  // The decoded buffer must be a private copy: mutating it cannot corrupt the row.
  memory.vec[0] = 99;
  const reRead = listActiveEmbeddings(db, [SPACE])[0];
  assert.ok(Math.abs(reRead.vec[0] - stored[0]) < 1e-6);

  // Space filtering and the empty-id short circuit.
  assert.deepEqual(listActiveEmbeddings(db, ['space-other']), []);
  assert.deepEqual(listActiveEmbeddings(db, []), []);
});

test('embedding BLOB helpers round-trip and reject corrupt bytes', (t) => {
  const { db } = tempStore(t);
  const values = new Float32Array([0.1, 0.2, 0.3, 0.4]);
  const blob = toBlob(values);
  assert.ok(blob instanceof Uint8Array);
  assert.equal(blob.byteLength, 16);

  const decoded = fromBlob(blob);
  assert.ok(decoded instanceof Float32Array);
  assert.equal(decoded.length, 4);
  for (let index = 0; index < 4; index += 1) {
    assert.ok(Math.abs(decoded[index] - values[index]) < 1e-6);
  }

  assert.equal(fromBlob(null), null);
  assert.equal(fromBlob(undefined), null);
  assert.throws(() => fromBlob(new Uint8Array(3)), (error) => {
    assert.equal(error.code, MEMORY_ERRORS.blobBadLength);
    return true;
  });
  assert.throws(() => toBlob('nope'), TypeError);
  assert.deepEqual(Array.from(fromBlob(toBlob([0.5, -0.5]))), [0.5, -0.5]);

  // A stored BLOB survives the SQLite round-trip through the real table.
  add(db, 'm1', '带向量的记忆', { embedding: values });
  assert.equal(listActiveEmbeddings(db, [SPACE])[0].vec.byteLength, 16);
});

test('insertMemory validates its arguments before writing anything', (t) => {
  const { db } = tempStore(t);

  // Required arguments: content and spaceId have no default.
  assert.throws(
    () => insertMemory(db, { spaceId: SPACE, sourceSessionId: SESSION }),
    TypeError,
  );
  assert.throws(
    () => insertMemory(db, { id: 'x', content: 'x', sourceSessionId: SESSION }),
    TypeError,
  );
  assert.throws(() => insertMemory(db, { id: 'x', spaceId: '', content: 'x', sourceSessionId: SESSION }), TypeError);
  assert.throws(() => insertMemory(db, { id: 'x', spaceId: SPACE, content: '   ', sourceSessionId: SESSION }), TypeError);
  assert.throws(
    () => insertMemory(db, { id: 'x', spaceId: SPACE, content: 'x', sourceSessionId: SESSION, dimension: 'nope' }),
    (error) => {
      assert.match(error.message, /dimension must be one of/u);
      for (const dimension of DIMENSIONS) assert.match(error.message, new RegExp(dimension, 'u'));
      return true;
    },
  );
  assert.throws(
    () => insertMemory(db, { id: 'x', spaceId: SPACE, content: 'x', sourceSessionId: '' }),
    TypeError,
  );
  assert.deepEqual(countMemories(db), { total: 0, active: 0 });
});

test('insertMemory generates an id when none is supplied', (t) => {
  const { db } = tempStore(t);
  const id = insertMemory(db, {
    spaceId: SPACE,
    dimension: 'recent',
    content: '自动生成 id 的记忆',
    sourceSessionId: SESSION,
  });
  assert.match(id, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(ids(db, '自动生成'), [id]);
  const row = db.prepare('SELECT dimension, embedding, superseded_by FROM memories WHERE id = ?').get(id);
  assert.equal(row.dimension, 'recent');
  assert.equal(row.embedding, null);
  assert.equal(row.superseded_by, null);
});

test('normalizeSpaceIds accepts the shapes callers actually pass', () => {
  assert.deepEqual(normalizeSpaceIds(['a', 'b', 'a']), ['a', 'b']);
  assert.deepEqual(normalizeSpaceIds(new Set(['b', 'a'])), ['b', 'a']);
  assert.deepEqual(normalizeSpaceIds('a'), ['a']);
  assert.deepEqual(normalizeSpaceIds(undefined), []);
  assert.deepEqual(normalizeSpaceIds(null), []);
  assert.deepEqual(normalizeSpaceIds(['a', '', 42, null]), ['a']);
  assert.deepEqual(normalizeSpaceIds(7), []);
});

test('time-bound dimensions older than seven days are filtered in SQL', (t) => {
  const { db } = tempStore(t)
  add(db, 'recent-new', '新的近期计划：明天交报告', { dimension: 'recent' })
  add(db, 'recent-old', '旧的近期计划：上周已经过期的事', { dimension: 'recent' })
  add(db, 'working-old', '旧的工作状态：正在等旧订单', { dimension: 'working' })
  add(db, 'fact-old', '去年确定的事实：用户住在北京', { dimension: 'fact' })
  db.prepare("UPDATE memories SET timestamp = datetime('now', '-8 days') WHERE id IN ('recent-old','working-old','fact-old')").run()

  const hits = searchKeyword(db, { spaceIds: [SPACE], query: '近期计划' }).map((row) => row.id)
  assert.deepEqual(hits, ['recent-new'], 'expired recent rows never reach retrieval')

  const working = searchKeyword(db, { spaceIds: [SPACE], query: '工作状态' }).map((row) => row.id)
  assert.deepEqual(working, [], 'expired working rows never reach retrieval')

  const facts = searchKeyword(db, { spaceIds: [SPACE], query: '确定的事实' }).map((row) => row.id)
  assert.deepEqual(facts, ['fact-old'], 'fact rows are not time-bound')

  const vectors = listActiveEmbeddings(db, [SPACE]).map((row) => row.id)
  assert.ok(!vectors.includes('recent-old') && !vectors.includes('working-old'))
})

test('listMemoryHistory walks the single supersede chain oldest first', (t) => {
  const { db } = tempStore(t)
  add(db, 'v1', '用户预算为 1 万', { dimension: 'fact' })
  add(db, 'v2', '用户预算为 1.2 万', { dimension: 'fact', supersedesId: 'v1' })
  add(db, 'v3', '用户预算为 1.5 万', { dimension: 'fact', supersedesId: 'v2' })

  const history = listMemoryHistory(db, 'v3')
  assert.deepEqual(history.map((row) => row.id), ['v1', 'v2', 'v3'])
  assert.deepEqual(history.map((row) => row.current), [false, false, true])
  assert.equal(history[2].supersededBy, null)
  assert.equal(history[1].supersededBy, 'v3')

  // Asking from the middle still returns the whole chain.
  assert.deepEqual(listMemoryHistory(db, 'v2').map((row) => row.id), ['v1', 'v2', 'v3'])
  assert.deepEqual(listMemoryHistory(db, 'missing'), [])
})

test('retrieval never sees superseded rows even when the chain exists', (t) => {
  const { db } = tempStore(t)
  add(db, 'a', '用户喜欢深色主题', { dimension: 'fact' })
  add(db, 'b', '用户喜欢浅色主题', { dimension: 'fact', supersedesId: 'a' })
  const ids = searchKeyword(db, { spaceIds: [SPACE], query: '用户喜欢' }).map((row) => row.id)
  assert.deepEqual(ids, ['b'])
})
