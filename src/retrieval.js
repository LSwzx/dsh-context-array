/**
 * Local hybrid retrieval for M2: vector scan + FTS5 trigram, fused with RRF and
 * cut to a token budget, rendered as one `<memory>…</memory>` block.
 *
 * Design: `dsh-context-array-v4.1.md` §3.3. Two properties matter more than
 * accuracy here:
 *
 * - **Never fail a turn.** The embedder is injected and may be missing, may
 *   throw, or may return `null`; the vector path then degrades to "unavailable"
 *   while the keyword path still answers. Diagnostics record why.
 * - **Deterministic output.** Identical input yields identical order and scores
 *   on the same database (ties break on id), so a repeated turn appends the same
 *   block and tests can assert exact shapes.
 *
 * The module never writes: results are per-turn, used once, and never cached as
 * a message or snapshot (§2 rule 2, §3.3 "不写快照").
 */
import {
  keywordSearchMode,
  listActiveEmbeddings,
  normalizeSpaceIds,
  searchKeyword,
} from './db-memories.js';

/** RRF damping constant: `score = Σ 1 / (RRF_K + rank)`, rank starting at 1. */
export const RRF_K = 60;

/** Candidates taken from each path before fusion (§3.3: top 20 each). */
export const VECTOR_TOP_K = 20;
export const KEYWORD_TOP_K = 20;

/** Default per-turn budget for the rendered block, in estimated tokens. */
export const DEFAULT_BUDGET_TOKENS = 800;

/** Default number of memories in the final block. */
export const DEFAULT_RESULT_LIMIT = 8;

/**
 * Default RRF path weights. Measured on the M2 eval set (40 memories, 15 queries):
 * `1:1` gave MRR 0.8889 while `2:1` gave 0.9667 at identical recall@5, so the
 * semantic path wins ties and the keyword path stays as a rescue channel.
 */
export const DEFAULT_WEIGHTS = Object.freeze({ vector: 2, keyword: 1 });

/**
 * Estimate the tokens one memory costs, using DSH's fixed heuristic.
 *
 * Same formula as `src/prefix.js` / `dsh-token-meter`: `ceil(chars / 4) + 4`.
 * It is deliberately not a real tokenizer — the number only has to be stable
 * across turns and roughly proportional to cost.
 *
 * @param {unknown} content
 * @returns {number} non-negative integer
 */
export function estimateMemoryTokens(content) {
  const text = typeof content === 'string' ? content : String(content ?? '');
  return text === '' ? 0 : Math.ceil(text.length / 4) + 4;
}

/**
 * Dot product. Stored and query vectors are L2-normalised, so this is cosine.
 *
 * @param {Float32Array} a
 * @param {Float32Array} b same length as `a`
 * @returns {number}
 */
function dot(a, b) {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index];
  return sum;
}

/**
 * Deterministic descending sort: score first, id ascending on ties.
 *
 * @template {{ id: string, score: number }} T
 * @param {T[]} items
 * @returns {T[]} the same array, sorted in place
 */
function sortByScore(items) {
  return items.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  });
}

/**
 * Round to 6 decimals so float summation noise never shows up in output.
 *
 * @param {number} value
 * @returns {number}
 */
function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Coerce one positive integer argument, falling back to a default.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Coerce one positive finite number argument, falling back to a default.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Turn an unknown embedder result into a usable vector.
 *
 * @param {unknown} value
 * @returns {Float32Array|null} `null` when the value cannot be a query vector
 */
function asQueryVector(value) {
  if (value instanceof Float32Array) return value.length > 0 ? value : null;
  if (ArrayBuffer.isView(value) && value.length > 0) {
    return Float32Array.from(value);
  }
  if (Array.isArray(value) && value.length > 0) {
    return Float32Array.from(value);
  }
  return null;
}

/**
 * Render one line of the block: `- [space/dimension] content`.
 *
 * @param {{ spaceId?: string, dimension?: string }} item
 * @returns {string}
 */
function renderTag(item) {
  const space = typeof item.spaceId === 'string' && item.spaceId !== '' ? item.spaceId : 'unknown-space';
  const dimension =
    typeof item.dimension === 'string' && item.dimension !== '' ? `/${item.dimension}` : '';
  return `${space}${dimension}`;
}

/**
 * Neutralise a memory body that would otherwise close the block early.
 *
 * Memory text is data, never instructions; it must not be able to terminate the
 * `<memory>` element it is rendered inside.
 *
 * @param {unknown} content
 * @returns {string}
 */
function escapeBlockContent(content) {
  return String(content ?? '').replace(/<\/memory/giu, '&lt;/memory');
}

/**
 * Render a search result as the literal `<memory>…</memory>` block.
 *
 * Shape (one line per memory, stable for a given result):
 *
 * ```text
 * <memory>
 * - [space-default/fact] 用户偏好深色主题
 * </memory>
 * ```
 *
 * @param {{ items?: Array<{ spaceId?: string, dimension?: string, content?: string }> }|null|undefined} result
 * @returns {string|null} `null` when there is nothing to append
 */
export function renderBlock(result) {
  const items = Array.isArray(result?.items) ? result.items : [];
  if (items.length === 0) return null;
  const lines = items.map((item) => `- [${renderTag(item)}] ${escapeBlockContent(item.content)}`);
  return `<memory>\n${lines.join('\n')}\n</memory>`;
}

/**
 * Create the per-turn retriever used by the L5 append seam.
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   embedQuery?: ((text: string) => Promise<Float32Array|null>)|null,
 *   budgetTokens?: number,
 *   now?: () => number,
 * }} args
 *   `db` is the open store's `DatabaseSync`; `embedQuery` is the async RPC into
 *   the embedding worker (`(text) => Promise<Float32Array|null>`), and may be
 *   absent, in which case only the keyword path runs; `now` is injectable so
 *   `elapsedMs` is testable.
 * @returns {{
 *   search: (args: { spaceIds: Iterable<string>|string, query: string, limit?: number }) => Promise<{
 *     items: Array<{ id: string, spaceId: string, dimension: string, content: string, score: number, sources: string[] }>,
 *     diagnostics: {
 *       vectorCandidates: number,
 *       keywordCandidates: number,
 *       usedVector: boolean,
 *       usedKeyword: boolean,
 *       budgetTokens: number,
 *       estimatedTokens: number,
 *       elapsedMs: number,
 *       error: string|null,
 *       keywordMode: string,
 *       vectorScanned: number,
 *     },
 *   }>,
 *   renderBlock: typeof renderBlock,
 * }}
 *   `items[].score` is the rounded RRF sum; `sources` lists the contributing
 *   paths in fusion order (`vector`, then `keyword`); ties break on id.
 *
 *   Diagnostics are for the log, not for branching on ranking:
 *   - `vectorCandidates` / `keywordCandidates`: candidates each path produced
 *     (capped at 20), before fusion.
 *   - `usedVector` / `usedKeyword`: the path was available and produced a
 *     candidate list — `false` means "degraded", which is expected and harmless.
 *   - `vectorScanned`: rows actually compared in the vector scan (rows without
 *     an embedding, or of another dimension, are not counted).
 *   - `keywordMode`: `'fts'`, `'like'`, or `'skipped'`.
 *   - `error`: `null` when everything worked, else the first degradation reason
 *     (`EMBEDDER_UNAVAILABLE`, `EMBED_QUERY_NULL`, `EMBED_QUERY_INVALID`, a
 *     thrown embedder message, or a corrupt-embedding message). Keyword results
 *     are still returned when it is set.
 *   - `estimatedTokens`: sum over the returned items; `elapsedMs` is measured
 *     with the injected `now`.
 */
export function createRetriever({
  db,
  embedQuery = null,
  budgetTokens = DEFAULT_BUDGET_TOKENS,
  now = () => Date.now(),
  // RRF weights. The vector path carries the semantic signal; the keyword path
  // mainly rescues exact identifiers. Weighting vector higher was measured to
  // improve MRR without changing recall@5 (see docs/M2-EVAL.md).
  weights = DEFAULT_WEIGHTS,
} = {}) {
  if (db === null || typeof db !== 'object' || typeof db.prepare !== 'function') {
    throw new TypeError('createRetriever: db must be an open node:sqlite DatabaseSync');
  }
  if (embedQuery !== null && embedQuery !== undefined && typeof embedQuery !== 'function') {
    throw new TypeError('createRetriever: embedQuery must be a function or null');
  }
  if (now !== null && typeof now !== 'function') {
    throw new TypeError('createRetriever: now must be a function');
  }

  const budget = positiveInt(budgetTokens, DEFAULT_BUDGET_TOKENS);
  const clock = typeof now === 'function' ? now : () => Date.now();
  const embedder = typeof embedQuery === 'function' ? embedQuery : null;
  const vectorWeight = positiveNumber(weights?.vector, DEFAULT_WEIGHTS.vector);
  const keywordWeight = positiveNumber(weights?.keyword, DEFAULT_WEIGHTS.keyword);

  /** Read the clock, ignoring a clock that returns junk. */
  function readClock() {
    const value = Number(clock());
    return Number.isFinite(value) ? value : 0;
  }

  /**
   * Vector path: embed the query, score every valid memory of the space set,
   * keep the top `VECTOR_TOP_K`.
   *
   * Every failure mode (no embedder, throw, `null`, junk, unreadable BLOB) is
   * converted into "path unavailable" plus a reason — never into a throw.
   *
   * @param {string[]} spaceIds non-empty
   * @param {string} query
   */
  async function vectorPath(spaceIds, query) {
    if (embedder === null) {
      return { items: [], scanned: 0, error: 'EMBEDDER_UNAVAILABLE' };
    }

    let embedded;
    try {
      embedded = await embedder(query);
    } catch (error) {
      const message =
        error !== null && typeof error === 'object' && typeof error.message === 'string'
          ? error.message
          : String(error);
      return { items: [], scanned: 0, error: message };
    }
    if (embedded === null || embedded === undefined) {
      return { items: [], scanned: 0, error: 'EMBED_QUERY_NULL' };
    }

    const queryVector = asQueryVector(embedded);
    if (queryVector === null) {
      return { items: [], scanned: 0, error: 'EMBED_QUERY_INVALID' };
    }

    let rows;
    try {
      rows = listActiveEmbeddings(db, spaceIds);
    } catch (error) {
      const message =
        error !== null && typeof error === 'object' && typeof error.message === 'string'
          ? error.message
          : String(error);
      return { items: [], scanned: 0, error: message };
    }

    let scanned = 0;
    const scored = [];
    for (const row of rows) {
      // A differently sized embedding cannot be compared; skip it instead of
      // pretending the memory is irrelevant.
      if (row.vec === null || row.vec.length !== queryVector.length) continue;
      scanned += 1;
      scored.push({
        id: row.id,
        spaceId: row.spaceId,
        dimension: row.dimension,
        content: row.content,
        score: dot(queryVector, row.vec),
      });
    }

    sortByScore(scored);
    return { items: scored.slice(0, VECTOR_TOP_K), scanned, error: null };
  }

  /**
   * Keyword path: FTS5 trigram, or `LIKE` for short queries.
   *
   * @param {string[]} spaceIds non-empty
   * @param {string} query
   */
  function keywordPath(spaceIds, query) {
    // Ask the storage layer which path it will take, so the diagnostic cannot
    // drift from the actual query plan.
    const mode = keywordSearchMode(query);
    try {
      const items = searchKeyword(db, { spaceIds, query, limit: KEYWORD_TOP_K });
      return { items, mode, error: null };
    } catch (error) {
      const message =
        error !== null && typeof error === 'object' && typeof error.message === 'string'
          ? error.message
          : String(error);
      return { items: [], mode, error: message };
    }
  }

  /**
   * One hybrid search.
   *
   * Pipeline: vector top 20 + keyword top 20 → RRF fusion (`1 / (60 + rank)`,
   * summed per memory, `sources` recording which paths matched) → descending
   * score, ties by id → top `limit` → token-budget cut (greedy, at least one
   * memory always survives).
   *
   * @param {{ spaceIds: Iterable<string>|string, query: string, limit?: number }} args
   */
  async function search(args = {}) {
    const started = readClock();
    const spaceIds = normalizeSpaceIds(args.spaceIds);
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const limit = positiveInt(args.limit, DEFAULT_RESULT_LIMIT);

    const diagnostics = {
      vectorCandidates: 0,
      keywordCandidates: 0,
      usedVector: false,
      usedKeyword: false,
      budgetTokens: budget,
      estimatedTokens: 0,
      elapsedMs: 0,
      error: null,
      keywordMode: 'skipped',
      vectorScanned: 0,
    };

    // No spaces means no scope at all: answer empty without touching the store,
    // the embedder, or the clock beyond the initial read.
    if (spaceIds.length === 0 || query === '') {
      diagnostics.elapsedMs = Math.max(0, readClock() - started);
      return { items: [], diagnostics };
    }

    const vector = await vectorPath(spaceIds, query);
    const keyword = keywordPath(spaceIds, query);

    diagnostics.vectorCandidates = vector.items.length;
    diagnostics.keywordCandidates = keyword.items.length;
    diagnostics.usedVector = vector.error === null;
    diagnostics.usedKeyword = keyword.error === null;
    diagnostics.vectorScanned = vector.scanned;
    diagnostics.keywordMode = keyword.mode;
    diagnostics.error = vector.error ?? keyword.error ?? null;

    /** @type {Map<string, { id: string, spaceId: string, dimension: string, content: string, score: number, sources: string[] }>} */
    const fused = new Map();
    const add = (item, source, rank) => {
      let entry = fused.get(item.id);
      if (entry === undefined) {
        entry = {
          id: item.id,
          spaceId: item.spaceId,
          dimension: item.dimension,
          content: item.content,
          score: 0,
          sources: [],
        };
        fused.set(item.id, entry);
      }
      entry.score += (source === 'vector' ? vectorWeight : keywordWeight) / (RRF_K + rank + 1);
      if (!entry.sources.includes(source)) entry.sources.push(source);
    };
    vector.items.forEach((item, index) => add(item, 'vector', index));
    keyword.items.forEach((item, index) => add(item, 'keyword', index));

    const ranked = sortByScore([...fused.values()]);

    const items = [];
    let estimatedTokens = 0;
    for (const entry of ranked) {
      if (items.length >= limit) break;
      const cost = estimateMemoryTokens(entry.content);
      // Budget is a hard cap, but never return nothing when something matched.
      if (items.length > 0 && estimatedTokens + cost > budget) break;
      items.push({ ...entry, score: round6(entry.score) });
      estimatedTokens += cost;
    }

    diagnostics.estimatedTokens = estimatedTokens;
    diagnostics.elapsedMs = Math.max(0, readClock() - started);
    return { items, diagnostics };
  }

  return { search, renderBlock };
}
