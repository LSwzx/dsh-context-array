/**
 * Tests for src/retrieval.js — hybrid search, RRF fusion and path weights,
 * determinism, the token budget, degradation when the embedder fails, and the
 * `<memory>` rendering.
 *
 * Every test works inside its own os.tmpdir() directory and removes it
 * afterwards; nothing here touches the user's ~/.dsh.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openStore } from '../src/db.js';
import { countMemories, insertMemory } from '../src/db-memories.js';
import {
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_RESULT_LIMIT,
  DEFAULT_WEIGHTS,
  KEYWORD_TOP_K,
  RRF_K,
  VECTOR_TOP_K,
  createRetriever,
  estimateMemoryTokens,
  renderBlock,
} from '../src/retrieval.js';

const SPACE = 'space-default';
const SESSION = 'session-test';

/**
 * Round to 6 decimals, mirroring the module's output rounding.
 *
 * @param {number} value
 * @returns {number}
 */
function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Open a migrated store in a fresh temp directory and clean it up afterwards.
 *
 * @param {import('node:test').TestContext} t
 * @returns {{ db: import('node:sqlite').DatabaseSync, store: object }}
 */
function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-context-array-ret-'));
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

/** A normalised 3-dim vector, so the dot product is a cosine. */
function vec(x, y, z) {
  const length = Math.hypot(x, y, z) || 1;
  return new Float32Array([x / length, y / length, z / length]);
}

/** An embedder that always answers the same vector. */
function constantEmbedder(vector) {
  return async () => vector;
}

/** A clock that yields `values` in order and then repeats the last one. */
function clock(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

/** Insert one memory with an optional embedding. */
function add(db, id, content, options = {}) {
  return insertMemory(db, {
    id,
    spaceId: options.spaceId ?? SPACE,
    dimension: options.dimension ?? 'fact',
    content,
    embedding: options.embedding ?? null,
    sourceSessionId: SESSION,
  });
}

/**
 * The standard fixture: three active memories, one per semantic direction.
 *
 * @param {import('node:test').TestContext} t
 */
function fixture(t) {
  const { db } = tempStore(t);
  add(db, 'm1', '深色主题偏好', { embedding: vec(1, 0, 0) });
  add(db, 'm2', '浅色主题偏好', { embedding: vec(0, 1, 0) });
  add(db, 'm3', '完全无关的内容', { embedding: vec(-1, 0, 0) });
  return db;
}

test('exports the documented constants and default weights', () => {
  assert.equal(RRF_K, 60);
  assert.equal(VECTOR_TOP_K, 20);
  assert.equal(KEYWORD_TOP_K, 20);
  assert.equal(DEFAULT_BUDGET_TOKENS, 800);
  assert.equal(DEFAULT_RESULT_LIMIT, 8);

  // M2 eval decision: the semantic path outranks the exact-match rescue path.
  assert.deepEqual(DEFAULT_WEIGHTS, { vector: 2, keyword: 1 });
  assert.ok(Object.isFrozen(DEFAULT_WEIGHTS));
  assert.ok(DEFAULT_WEIGHTS.vector > DEFAULT_WEIGHTS.keyword);

  assert.equal(estimateMemoryTokens(''), 0);
  assert.equal(estimateMemoryTokens('abcd'), 5);
  assert.equal(estimateMemoryTokens('深色主题'), 5);
  assert.equal(estimateMemoryTokens('abcdefgh'), 6);
  assert.equal(estimateMemoryTokens(null), 0);
});

test('unit RRF weights reproduce the textbook 2/(K+1), 1/(K+2), 1/(K+3)', async (t) => {
  const db = fixture(t);
  const retriever = createRetriever({
    db,
    embedQuery: constantEmbedder(vec(1, 0, 0)),
    weights: { vector: 1, keyword: 1 },
    now: clock([1000, 1007]),
  });

  // '深色主题偏好' is one trigram term and matches m1 only.
  const result = await retriever.search({ spaceIds: [SPACE], query: '深色主题偏好' });

  assert.deepEqual(
    result.items.map((item) => item.id),
    ['m1', 'm2', 'm3'],
    'both-path match first, then vector-only by cosine',
  );
  assert.deepEqual(result.items[0].sources, ['vector', 'keyword']);
  assert.deepEqual(result.items[1].sources, ['vector']);
  // 1/(60+1) + 1/(60+1), then one rank per remaining vector-only candidate.
  assert.equal(result.items[0].score, round6(2 / (RRF_K + 1)));
  assert.equal(result.items[1].score, round6(1 / (RRF_K + 2)));
  assert.equal(result.items[2].score, round6(1 / (RRF_K + 3)));
  assert.equal(result.items[0].spaceId, SPACE);
  assert.equal(result.items[0].dimension, 'fact');
  assert.equal(result.items[0].content, '深色主题偏好');

  assert.equal(result.diagnostics.vectorCandidates, 3);
  assert.equal(result.diagnostics.keywordCandidates, 1);
  assert.equal(result.diagnostics.usedVector, true);
  assert.equal(result.diagnostics.usedKeyword, true);
  assert.equal(result.diagnostics.budgetTokens, DEFAULT_BUDGET_TOKENS);
  assert.equal(result.diagnostics.keywordMode, 'fts');
  assert.equal(result.diagnostics.vectorScanned, 3);
  assert.equal(result.diagnostics.error, null);
  assert.equal(result.diagnostics.elapsedMs, 7, 'elapsedMs comes from the injected clock');
  assert.equal(
    result.diagnostics.estimatedTokens,
    result.items.reduce((sum, item) => sum + estimateMemoryTokens(item.content), 0),
  );
});

test('default weights give a both-path memory (2+1)/(K+1) and favour the vector path', async (t) => {
  const db = fixture(t);
  const retriever = createRetriever({ db, embedQuery: constantEmbedder(vec(1, 0, 0)) });

  const result = await retriever.search({ spaceIds: [SPACE], query: '深色主题偏好' });

  assert.deepEqual(result.items.map((item) => item.id), ['m1', 'm2', 'm3']);
  assert.equal(result.items[0].score, round6((2 + 1) / (RRF_K + 1)));
  assert.equal(result.items[1].score, round6(2 / (RRF_K + 2)));
  // The vector weight dominates, so the cross-path memory is not merely a tie.
  assert.ok(result.items[0].score > result.items[1].score);
  assert.ok(DEFAULT_WEIGHTS.vector > DEFAULT_WEIGHTS.keyword);

  // Unusable weight values fall back to the documented defaults.
  const fallback = createRetriever({
    db,
    embedQuery: constantEmbedder(vec(1, 0, 0)),
    weights: { vector: 0, keyword: -3 },
  });
  const fallbackResult = await fallback.search({ spaceIds: [SPACE], query: '深色主题偏好' });
  assert.deepEqual(fallbackResult.items, result.items);
});

test('repeated searches are deterministic and break ties by id', async (t) => {
  const db = tempStore(t).db;
  // Inserted in an order that does not match id order on purpose.
  add(db, 'z-tie', '同样的内容', { embedding: vec(1, 0, 0) });
  add(db, 'a-tie', '同样的内容', { embedding: vec(1, 0, 0) });
  const retriever = createRetriever({
    db,
    embedQuery: constantEmbedder(vec(1, 0, 0)),
    // A frozen clock keeps `elapsedMs` (and therefore the whole result) comparable.
    now: () => 500,
  });

  const first = await retriever.search({ spaceIds: [SPACE], query: '同样的内容' });
  const second = await retriever.search({ spaceIds: [SPACE], query: '同样的内容' });

  assert.deepEqual(first, second);
  assert.deepEqual(first.items.map((item) => item.id), ['a-tie', 'z-tie']);
});

test('an empty scope or a blank query answers empty without touching the store', async () => {
  let embedded = 0;
  let queried = 0;
  const db = {
    prepare() {
      queried += 1;
      throw new Error('search must not query the store for an empty scope');
    },
  };
  const retriever = createRetriever({
    db,
    embedQuery: async () => {
      embedded += 1;
      return vec(1, 0, 0);
    },
    now: clock([10, 12]),
  });

  const empty = await retriever.search({ spaceIds: [], query: '深色主题偏好' });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.diagnostics.keywordMode, 'skipped');
  assert.equal(empty.diagnostics.usedVector, false);
  assert.equal(empty.diagnostics.usedKeyword, false);
  assert.equal(empty.diagnostics.vectorCandidates, 0);
  assert.equal(empty.diagnostics.keywordCandidates, 0);
  assert.equal(empty.diagnostics.elapsedMs, 2);
  assert.equal(empty.diagnostics.error, null);

  for (const query of ['', '   ', '\n\t']) {
    const blank = await retriever.search({ spaceIds: [SPACE], query });
    assert.deepEqual(blank.items, []);
    assert.equal(blank.diagnostics.keywordMode, 'skipped');
  }

  assert.equal(embedded, 0, 'no embedding is requested for an empty scope/query');
  assert.equal(queried, 0, 'the database is never opened in this case');
});

test('a throwing embedQuery degrades to the keyword path', async (t) => {
  const db = fixture(t);
  const retriever = createRetriever({
    db,
    embedQuery: async () => {
      throw new Error('embed worker crashed');
    },
  });

  const result = await retriever.search({ spaceIds: [SPACE], query: '深色主题偏好' });

  assert.deepEqual(result.items.map((item) => item.id), ['m1']);
  assert.deepEqual(result.items[0].sources, ['keyword']);
  assert.equal(result.items[0].score, round6(DEFAULT_WEIGHTS.keyword / (RRF_K + 1)));
  assert.equal(result.diagnostics.usedVector, false);
  assert.equal(result.diagnostics.usedKeyword, true);
  assert.equal(result.diagnostics.vectorCandidates, 0);
  assert.equal(result.diagnostics.keywordCandidates, 1);
  assert.match(result.diagnostics.error, /embed worker crashed/u);
});

test('null or malformed embedQuery results degrade to the keyword path', async (t) => {
  const db = fixture(t);
  for (const [embedQuery, expected] of [
    [async () => null, 'EMBED_QUERY_NULL'],
    [async () => undefined, 'EMBED_QUERY_NULL'],
    [async () => 'not a vector', 'EMBED_QUERY_INVALID'],
    [async () => [], 'EMBED_QUERY_INVALID'],
    [async () => new Float32Array(0), 'EMBED_QUERY_INVALID'],
  ]) {
    const retriever = createRetriever({ db, embedQuery });
    const result = await retriever.search({ spaceIds: [SPACE], query: '深色主题偏好' });
    assert.deepEqual(result.items.map((item) => item.id), ['m1'], String(embedQuery));
    assert.equal(result.diagnostics.usedVector, false);
    assert.equal(result.diagnostics.usedKeyword, true);
    assert.equal(result.diagnostics.error, expected);
  }
});

test('a missing embedder still serves keyword results', async (t) => {
  const db = fixture(t);
  for (const embedQuery of [undefined, null]) {
    const retriever = createRetriever({ db, embedQuery });
    const result = await retriever.search({ spaceIds: [SPACE], query: '深色主题偏好' });
    assert.deepEqual(result.items.map((item) => item.id), ['m1']);
    assert.equal(result.diagnostics.error, 'EMBEDDER_UNAVAILABLE');
    assert.equal(result.diagnostics.usedVector, false);
  }
});

test('a two-character query uses the LIKE fallback and still runs the vector path', async (t) => {
  const db = fixture(t);
  const retriever = createRetriever({ db, embedQuery: constantEmbedder(vec(1, 0, 0)) });

  const result = await retriever.search({ spaceIds: [SPACE], query: '深色' });

  assert.equal(result.diagnostics.keywordMode, 'like');
  assert.equal(result.diagnostics.keywordCandidates, 1);
  assert.equal(result.diagnostics.vectorCandidates, 3);
  assert.deepEqual(result.items[0].id, 'm1');
  assert.deepEqual(result.items[0].sources, ['vector', 'keyword']);
  // LIKE hits the 2-character query, which a trigram MATCH never could.
  assert.equal(result.items[0].content, '深色主题偏好');

  // A longer query whose every term is below the trigram size also takes LIKE.
  const mixed = await retriever.search({ spaceIds: [SPACE], query: '深色 主题' });
  assert.equal(mixed.diagnostics.keywordMode, 'like');
  assert.deepEqual(mixed.items[0].id, 'm1');
});

test('superseded memories appear in neither path', async (t) => {
  const db = tempStore(t).db;
  add(db, 'old', '深色主题偏好', { embedding: vec(1, 0, 0) });
  insertMemory(db, {
    id: 'new',
    spaceId: SPACE,
    dimension: 'fact',
    content: '浅色主题偏好',
    embedding: vec(0, 1, 0),
    sourceSessionId: SESSION,
    supersedesId: 'old',
  });
  assert.deepEqual(countMemories(db), { total: 2, active: 1 });

  const retriever = createRetriever({ db, embedQuery: constantEmbedder(vec(1, 0, 0)) });
  const result = await retriever.search({ spaceIds: [SPACE], query: '深色主题偏好' });

  // The vector path scans only valid rows (the old one had the best cosine).
  assert.equal(result.diagnostics.vectorScanned, 1);
  assert.deepEqual(result.items.map((item) => item.id), ['new']);
  assert.deepEqual(result.items[0].sources, ['vector']);
});

test('the token budget truncates but always keeps one memory', async (t) => {
  const db = tempStore(t).db;
  const content = '共识内容 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const cost = estimateMemoryTokens(content);
  for (const id of ['b1', 'b2', 'b3']) add(db, id, content, { embedding: vec(1, 0, 0) });

  const tight = await createRetriever({
    db,
    embedQuery: constantEmbedder(vec(1, 0, 0)),
    budgetTokens: cost - 1,
  }).search({ spaceIds: [SPACE], query: '共识内容' });

  assert.deepEqual(tight.items.map((item) => item.id), ['b1'], 'ties break on id, so b1 survives');
  assert.equal(tight.diagnostics.estimatedTokens, cost);
  assert.equal(tight.diagnostics.budgetTokens, cost - 1);

  const roomy = await createRetriever({
    db,
    embedQuery: constantEmbedder(vec(1, 0, 0)),
    budgetTokens: cost * 2,
  }).search({ spaceIds: [SPACE], query: '共识内容' });

  assert.deepEqual(roomy.items.map((item) => item.id), ['b1', 'b2']);
  assert.equal(roomy.diagnostics.estimatedTokens, cost * 2);

  // An invalid budget falls back to the documented default.
  const fallback = await createRetriever({ db, budgetTokens: -5 }).search({
    spaceIds: [SPACE],
    query: '共识内容',
  });
  assert.equal(fallback.diagnostics.budgetTokens, DEFAULT_BUDGET_TOKENS);
});

test('limit caps the fused result', async (t) => {
  const db = fixture(t);
  const retriever = createRetriever({ db, embedQuery: constantEmbedder(vec(1, 0, 0)) });

  const limited = await retriever.search({ spaceIds: [SPACE], query: '主题', limit: 2 });
  assert.equal(limited.items.length, 2);
  assert.equal(limited.diagnostics.vectorCandidates, 3);

  const defaulted = await retriever.search({ spaceIds: [SPACE], query: '主题', limit: 0 });
  assert.equal(defaulted.items.length, 3);
  assert.ok(defaulted.items.length <= DEFAULT_RESULT_LIMIT);
});

test('each path keeps at most twenty candidates', async (t) => {
  const db = tempStore(t).db;
  for (let index = 0; index < 25; index += 1) {
    add(db, `m${String(index).padStart(2, '0')}`, `共同话题 第 ${index} 条`, {
      embedding: vec(1, index, 0),
    });
  }
  const retriever = createRetriever({ db, embedQuery: constantEmbedder(vec(1, 0, 0)) });

  const result = await retriever.search({ spaceIds: [SPACE], query: '共同话题' });

  assert.equal(result.diagnostics.vectorCandidates, VECTOR_TOP_K);
  assert.equal(result.diagnostics.keywordCandidates, KEYWORD_TOP_K);
  assert.equal(result.diagnostics.vectorScanned, 25);
});

test('a dimension mismatch is skipped instead of throwing', async (t) => {
  const db = fixture(t); // stored vectors are 3-dim
  const retriever = createRetriever({ db, embedQuery: async () => new Float32Array([1, 0]) });

  const result = await retriever.search({ spaceIds: [SPACE], query: '深色主题偏好' });

  assert.equal(result.diagnostics.vectorScanned, 0);
  assert.equal(result.diagnostics.vectorCandidates, 0);
  assert.equal(result.diagnostics.usedVector, true, 'the path ran, it just had nothing comparable');
  assert.deepEqual(result.items.map((item) => item.id), ['m1']);
});

test('an empty store yields empty items but a live vector path', async (t) => {
  const db = tempStore(t).db;
  const retriever = createRetriever({ db, embedQuery: constantEmbedder(vec(1, 0, 0)) });

  const result = await retriever.search({ spaceIds: [SPACE], query: '深色主题偏好' });

  assert.deepEqual(result.items, []);
  assert.equal(result.diagnostics.usedVector, true);
  assert.equal(result.diagnostics.usedKeyword, true);
  assert.equal(result.diagnostics.vectorCandidates, 0);
  assert.equal(result.diagnostics.keywordCandidates, 0);
  assert.equal(result.diagnostics.estimatedTokens, 0);
  assert.equal(result.diagnostics.error, null);
});

test('search ignores a non-string query and non-iterable spaceIds', async (t) => {
  const db = fixture(t);
  const retriever = createRetriever({ db, embedQuery: constantEmbedder(vec(1, 0, 0)) });

  assert.deepEqual((await retriever.search({ spaceIds: [SPACE], query: null })).items, []);
  assert.deepEqual((await retriever.search({ spaceIds: 42, query: '深色主题' })).items, []);

  const noArgs = await retriever.search();
  assert.deepEqual(noArgs.items, []);
  assert.equal(noArgs.diagnostics.keywordMode, 'skipped');
});

test('renderBlock produces the literal memory block and nothing else', async (t) => {
  const db = fixture(t);
  const retriever = createRetriever({ db, embedQuery: constantEmbedder(vec(1, 0, 0)) });

  const result = await retriever.search({ spaceIds: [SPACE], query: '深色主题偏好' });
  const block = retriever.renderBlock(result);

  assert.equal(
    block,
    '<memory>\n- [space-default/fact] 深色主题偏好\n- [space-default/fact] 浅色主题偏好\n' +
      '- [space-default/fact] 完全无关的内容\n</memory>',
  );
  assert.ok(block.startsWith('<memory>\n'));
  assert.ok(block.endsWith('\n</memory>'));
  assert.equal(block.match(/<memory>/gu).length, 1);
  assert.equal(block.match(/<\/memory>/gu).length, 1);

  // The standalone export is the same function the retriever exposes.
  assert.equal(retriever.renderBlock, renderBlock);
  assert.equal(renderBlock(result), block);
});

test('renderBlock returns null for an empty result and sanitises closers', () => {
  assert.equal(renderBlock({ items: [] }), null);
  assert.equal(renderBlock({}), null);
  assert.equal(renderBlock(null), null);
  assert.equal(renderBlock(undefined), null);

  const block = renderBlock({
    items: [
      { id: 'x', spaceId: 'space-a', dimension: 'fact', content: '前 </memory> 后' },
      { id: 'y', spaceId: 'space-b', content: '</MEMORY>' },
      { id: 'z', content: 'no tag' },
    ],
  });
  assert.equal(
    block,
    '<memory>\n' +
      '- [space-a/fact] 前 &lt;/memory> 后\n' +
      '- [space-b] &lt;/memory>\n' +
      '- [unknown-space] no tag\n' +
      '</memory>',
  );
  assert.equal(block.match(/<\/memory>/gu).length, 1, 'only the block terminator survives');
});

test('createRetriever validates its dependencies', () => {
  assert.throws(() => createRetriever(), TypeError);
  assert.throws(() => createRetriever({ db: {} }), TypeError);
  assert.throws(() => createRetriever({ db: { prepare() {} }, embedQuery: 'x' }), TypeError);
  assert.throws(() => createRetriever({ db: { prepare() {} }, now: 'x' }), TypeError);
});
