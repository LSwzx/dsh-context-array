/**
 * Memory row I/O plus the two retrieval queries of M2 (local hybrid search).
 *
 * This module owns every read/write of the `memories` table and its
 * `memories_fts` trigram index (schema from `src/db.js`, see
 * `dsh-context-array-v4.1.md` §4). The API is deliberately synchronous —
 * `node:sqlite`'s `DatabaseSync` has no async variant — so a caller that needs
 * an embedding must await it *before* calling `insertMemory`, which opens
 * `BEGIN IMMEDIATE` and therefore must not be nested inside another
 * transaction.
 *
 * Embedding BLOBs are raw little-endian Float32 bytes. Writes may hand over a
 * zero-copy view; reads always copy, because `node:sqlite` returns a
 * `Uint8Array` over a pooled `ArrayBuffer` whose `byteOffset` is not guaranteed
 * to be a multiple of 4 (a `Float32Array` view over it would throw).
 */
import crypto from 'node:crypto';

/** The five dimensions allowed by the `memories.dimension` CHECK constraint. */
export const DIMENSIONS = Object.freeze([
  'working',
  'recent',
  'fact',
  'reflection',
  'personality',
]);

/** Codes carried on `error.code` so callers can branch without parsing text. */
export const MEMORY_ERRORS = Object.freeze({
  supersedeFailed: 'SUPERSEDE_FAILED',
  blobBadLength: 'EMBEDDING_BLOB_BAD_LENGTH',
});

/** Default `searchKeyword` page size, matching the §3.3 "top 20" of each path. */
export const DEFAULT_KEYWORD_LIMIT = 20;

/** A trigram MATCH needs three characters; below that the `LIKE` path takes over. */
const TRIGRAM_MIN_CHARS = 3;

/**
 * Build an `Error` carrying a stable `code`.
 *
 * @param {string} code one of `MEMORY_ERRORS`
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Normalise a `spaceIds` argument into a de-duplicated list of usable ids.
 *
 * Accepts an array, a `Set`, any other iterable, or a single id string.
 * Blank/non-string members are dropped instead of throwing: retrieval is a
 * best-effort path and must never fail because a caller passed junk.
 *
 * @param {unknown} spaceIds
 * @returns {string[]}
 */
export function normalizeSpaceIds(spaceIds) {
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
 * Return `${count} placeholders` (`?, ?, ?`) for a dynamic `IN (...)` clause.
 *
 * Only the count of ids reaches the SQL text, never an id itself.
 *
 * @param {number} count
 * @returns {string}
 */
function placeholders(count) {
  return new Array(count).fill('?').join(', ');
}

/**
 * Coerce a positive integer, falling back to `fallback` when unusable.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveInt(value, fallback) {
  const number = typeof value === 'number' ? value : Number.NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

/**
 * Require a non-empty string argument.
 *
 * @param {unknown} value
 * @param {string} label argument name used in the error message
 * @returns {string}
 */
function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Serialise a vector into the raw little-endian Float32 bytes stored in SQLite.
 *
 * @param {Float32Array|number[]} values
 * @returns {Buffer} zero-copy view for a `Float32Array`, a fresh buffer for an array
 */
export function toBlob(values) {
  if (values instanceof Float32Array) {
    return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
  }
  if (Array.isArray(values)) {
    return Buffer.from(new Float32Array(values).buffer);
  }
  throw new TypeError('toBlob: expected a Float32Array or an array of numbers');
}

/**
 * Decode an embedding BLOB into a private `Float32Array` copy.
 *
 * The copy is mandatory: the bytes may start at an unaligned offset inside a
 * pooled `ArrayBuffer`, so a view would throw `RangeError`. The length must be a
 * multiple of 4; anything else means the row is corrupt, which is reported
 * loudly rather than silently skipped.
 *
 * @param {Uint8Array|Buffer|null|undefined} blob
 * @returns {Float32Array|null} `null` for a SQL `NULL` embedding
 * @throws {Error & { code: 'EMBEDDING_BLOB_BAD_LENGTH' }}
 */
export function fromBlob(blob) {
  if (blob === null || blob === undefined) return null;
  if (!ArrayBuffer.isView(blob)) {
    throw new TypeError('fromBlob: expected a Uint8Array/Buffer or null');
  }
  if (blob.byteLength % 4 !== 0) {
    throw codedError(
      MEMORY_ERRORS.blobBadLength,
      `fromBlob: embedding BLOB length ${blob.byteLength} is not a multiple of 4`,
    );
  }
  // `slice` copies the exact byte range, so the result starts at offset 0.
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

/**
 * Insert one memory, optionally superseding an older one in the same space.
 *
 * Both statements run in one `BEGIN IMMEDIATE` transaction: a supersede that
 * does not affect exactly one row (unknown id, another space, or already
 * superseded) throws `SUPERSEDE_FAILED` and rolls the insert back, so a new
 * memory can never exist next to a stale one it claimed to replace.
 *
 * Works with `embedding: null`: keyword retrieval still sees the row, the
 * vector path simply skips it.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   id?: string, spaceId: string, dimension?: string, content: string,
 *   embedding?: Float32Array|number[]|null, sourceSessionId: string,
 *   supersedesId?: string|null,
 * }} args
 * @returns {string} the id of the inserted memory
 * @throws {Error & { code: string }} `SUPERSEDE_FAILED` when the replacement fails
 */
export function insertMemory(db, args = {}) {
  const {
    id = crypto.randomUUID(),
    spaceId,
    dimension = 'fact',
    content,
    embedding = null,
    sourceSessionId,
    supersedesId = null,
  } = args;

  const memoryId = requireText(id, 'insertMemory: id');
  const space = requireText(spaceId, 'insertMemory: spaceId');
  const body = requireText(content, 'insertMemory: content');
  const session = requireText(sourceSessionId, 'insertMemory: sourceSessionId');
  if (!DIMENSIONS.includes(dimension)) {
    throw new TypeError(`insertMemory: dimension must be one of ${DIMENSIONS.join(', ')}`);
  }
  if (supersedesId !== null && supersedesId !== undefined) {
    requireText(supersedesId, 'insertMemory: supersedesId');
  }
  // Encoding happens before the transaction: the only work inside the write lock
  // is the two statements.
  const blob = embedding === null || embedding === undefined ? null : toBlob(embedding);

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO memories(id, space_id, dimension, content, embedding, source_session_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(memoryId, space, dimension, body, blob, session);

    if (supersedesId !== null && supersedesId !== undefined) {
      const result = db
        .prepare(
          `UPDATE memories SET superseded_by = ?
            WHERE id = ? AND space_id = ? AND superseded_by IS NULL`,
        )
        .run(memoryId, supersedesId, space);
      if (result.changes !== 1) {
        throw codedError(
          MEMORY_ERRORS.supersedeFailed,
          `insertMemory: cannot supersede ${supersedesId} in space ${space} ` +
            '(missing, in another space, or already superseded)',
        );
      }
    }

    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction may already be gone; the original error is what matters.
    }
    throw error;
  }

  return memoryId;
}

/**
 * Every valid memory of the given spaces that carries an embedding.
 *
 * This is the vector path's full scan (§3.3: brute force is fine at MVP scale).
 * Rows are ordered by `seq` so the scan itself is deterministic; rows without
 * an embedding are excluded because they cannot be scored.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Iterable<string>|string} spaceIds
 * @returns {Array<{ id: string, spaceId: string, dimension: string, content: string, vec: Float32Array }>}
 * @throws {Error & { code: 'EMBEDDING_BLOB_BAD_LENGTH' }} when a stored BLOB is corrupt
 */
export function listActiveEmbeddings(db, spaceIds) {
  const ids = normalizeSpaceIds(spaceIds);
  if (ids.length === 0) return [];

  const rows = db
    .prepare(
      `SELECT id, space_id, dimension, content, embedding
         FROM memories
        WHERE superseded_by IS NULL
          AND embedding IS NOT NULL
          AND space_id IN (${placeholders(ids.length)})
        ORDER BY seq ASC`,
    )
    .all(...ids);

  return rows.map((row) => ({
    id: row.id,
    spaceId: row.space_id,
    dimension: row.dimension,
    content: row.content,
    vec: fromBlob(row.embedding),
  }));
}

/**
 * Escape `%`, `_` and `\` so a literal can be embedded in a `LIKE` pattern.
 *
 * The pattern must be queried with `ESCAPE '\'`.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeLike(text) {
  return text.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * Quote one term as an FTS5 string, doubling embedded double quotes.
 *
 * Quoting makes every character literal, so operators (`AND`, `*`, `-`, `"`)
 * in user input can never change the shape of the query.
 *
 * @param {string} term
 * @returns {string}
 */
function quoteFtsTerm(term) {
  return `"${term.replace(/"/g, '""')}"`;
}

/**
 * Split a query into whitespace-separated terms that a trigram index can use.
 *
 * @param {string} query already trimmed
 * @returns {string[]}
 */
function trigramTerms(query) {
  return query
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term !== '' && [...term].length >= TRIGRAM_MIN_CHARS);
}

/**
 * Decide which keyword path a query takes: `'fts'`, `'like'` or `'skipped'`.
 *
 * A query of three or more characters normally uses FTS5, but a query whose
 * every whitespace-separated term is shorter than a trigram (`用户 偏好`) has
 * nothing to MATCH, so it takes the `LIKE` path as well.
 *
 * @param {unknown} query
 * @returns {'fts'|'like'|'skipped'}
 */
export function keywordSearchMode(query) {
  if (typeof query !== 'string') return 'skipped';
  const trimmed = query.trim();
  if (trimmed === '') return 'skipped';
  if ([...trimmed].length < TRIGRAM_MIN_CHARS) return 'like';
  return trigramTerms(trimmed).length === 0 ? 'like' : 'fts';
}

/**
 * Keyword search over one space set, ranked by BM25 (or by row order for LIKE).
 *
 * Two paths, exactly as §3.3 requires:
 * - query of three or more characters: FTS5 trigram `MATCH`. Terms are quoted
 *   and OR-ed, so `深色主题` stays a literal substring while `dark theme` still
 *   matches a memory containing either word. Invalid/degenerate queries fall
 *   back to the `LIKE` path instead of throwing.
 * - shorter query (or no usable trigram term): `LIKE '%…%'` per term, which is
 *   what makes 1–2 character Chinese queries work at all.
 *
 * Superseded rows (`superseded_by IS NOT NULL`) never appear, in either path.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ spaceIds: Iterable<string>|string, query: string, limit?: number }} args
 * @returns {Array<{ id: string, spaceId: string, dimension: string, content: string, score: number }>}
 *   Best match first. `score` is `-bm25` (higher is better); the `LIKE` fallback
 *   has no relevance signal and reports `0`, ordering by insertion sequence.
 */
export function searchKeyword(db, args = {}) {
  const { spaceIds, query, limit = DEFAULT_KEYWORD_LIMIT } = args;
  const ids = normalizeSpaceIds(spaceIds);
  if (ids.length === 0) return [];

  const mode = keywordSearchMode(query);
  if (mode === 'skipped') return [];

  const trimmed = query.trim();
  const cap = positiveInt(limit, DEFAULT_KEYWORD_LIMIT);

  if (mode === 'like') {
    const patterns = trimmed.split(/\s+/u).filter((term) => term !== '');
    return searchKeywordLike(db, ids, patterns, cap);
  }
  return searchKeywordFts(db, ids, trigramTerms(trimmed), cap);
}

/**
 * FTS5 trigram path: `MATCH` the OR of quoted terms, BM25 ascending.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string[]} ids non-empty space ids
 * @param {string[]} terms at least one term of ≥ 3 characters
 * @param {number} cap
 * @returns {Array<{ id: string, spaceId: string, dimension: string, content: string, score: number }>}
 */
function searchKeywordFts(db, ids, terms, cap) {
  const matchQuery = terms.map(quoteFtsTerm).join(' OR ');
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT memories.id AS id,
                memories.space_id AS space_id,
                memories.dimension AS dimension,
                memories.content AS content,
                bm25(memories_fts) AS rank
           FROM memories_fts
           JOIN memories ON memories.seq = memories_fts.rowid
          WHERE memories_fts MATCH ?
            AND memories.superseded_by IS NULL
            AND memories.space_id IN (${placeholders(ids.length)})
          ORDER BY rank ASC, memories.id ASC
          LIMIT ?`,
      )
      .all(matchQuery, ...ids, cap);
  } catch {
    // A query the trigram tokenizer rejects still has to answer: LIKE is the
    // documented fallback and cannot mis-parse user text.
    return searchKeywordLike(db, ids, terms, cap);
  }

  return rows.map((row) => ({
    id: row.id,
    spaceId: row.space_id,
    dimension: row.dimension,
    content: row.content,
    // bm25() is negative; negate so callers always see "higher is better".
    score: -Number(row.rank ?? 0),
  }));
}

/**
 * `LIKE` fallback path: literal substring match per term, OR-ed together.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string[]} ids non-empty space ids
 * @param {string[]} patterns literal substrings (already trimmed, non-empty)
 * @param {number} cap
 * @returns {Array<{ id: string, spaceId: string, dimension: string, content: string, score: number }>}
 */
function searchKeywordLike(db, ids, patterns, cap) {
  const matches = patterns.map(() => "content LIKE ? ESCAPE '\\'").join(' OR ');
  const bound = patterns.map((pattern) => `%${escapeLike(pattern)}%`);

  return db
    .prepare(
      `SELECT id, space_id, dimension, content
         FROM memories
        WHERE superseded_by IS NULL
          AND space_id IN (${placeholders(ids.length)})
          AND (${matches})
        ORDER BY seq ASC, id ASC
        LIMIT ?`,
    )
    .all(...ids, ...bound, cap)
    .map((row) => ({
      id: row.id,
      spaceId: row.space_id,
      dimension: row.dimension,
      content: row.content,
      score: 0,
    }));
}

/**
 * Count memories, total and still valid.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ total: number, active: number }} integers (0 on an empty table)
 */
export function countMemories(db) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN superseded_by IS NULL THEN 1 ELSE 0 END) AS active
         FROM memories`,
    )
    .get();
  return {
    total: Number(row?.total ?? 0) || 0,
    active: Number(row?.active ?? 0) || 0,
  };
}
