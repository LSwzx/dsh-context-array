# M1 implementation contract (dsh-context-array)

Plain ESM JavaScript (`"type": "module"`), **no npm dependencies**, no build step, no TypeScript.
Runtime: the DSH Host process (Electron-as-Node 24.21) — `node:sqlite`, `node:crypto`, `node:fs`, `node:path`, `node:os` only.
Do not import `@deepseek-ai/*` packages: profile-installed bundles cannot resolve them reliably.

Repository root is `D:\dshprogram\dsh-context-array`. The package root **is** the repo root — never add a nested folder.

## Module boundaries (write only inside your assigned files)

| Owner | Files |
|---|---|
| lead | `index.js`, `src/prompt.js`, `package.json`, `cordis.patch.yml`, `locale/`, `icon.svg`, `docs/`, `README.md` |
| db-core | `src/db.js`, `src/config.js`, `test/db.test.mjs`, `test/config.test.mjs` |
| observer | `src/observer.js`, `src/append.js`, `test/observer.test.mjs`, `test/append.test.mjs` |

## `src/config.js`

```js
export function resolveConfig(raw) // raw = the Loader row's config object, may be undefined/partial
// returns frozen:
// {
//   dataDir,        // absolute; '' -> path.join(os.homedir(), '.dsh', 'context-array')
//   dbPath,         // path.join(dataDir, 'context-array.db')
//   usageLogPath,   // path.join(dataDir, 'usage.jsonl')
//   spaceId,        // default 'space-default'
//   spaceName,      // default 'Default space'
//   spaceRules,     // default '...'
//   observeUsage,   // default true
//   bootstrapMessages, // default true
//   schemaVersion,  // 1
// }
```
Unknown keys are preserved, values validated by type; invalid values fall back to the default (never throw).

## `src/db.js`

Uses `node:sqlite` `DatabaseSync`. Synchronous API. **Transactions: `db.exec('BEGIN IMMEDIATE')` / `'COMMIT'` / `'ROLLBACK'`, never `db.transaction()`.**

```js
export function openStore(config) // creates dataDir (recursive), opens db, PRAGMA journal_mode=WAL, migrate()
// returns {
//   db,            // DatabaseSync
//   config,
//   close(),       // idempotent
//   meta: { schemaVersion },
// }

export function migrate(db)                  // idempotent, bumps user_version / meta.schema_version
export function ensureDefaultSpace(db, cfg)  // INSERT OR IGNORE the configured space; returns the row
export function listSpaces(db)               // -> [{ id, name, description, created_at }]
export function bindSessionSpaces(db, sessionId, spaceIds, role)
// INSERT OR IGNORE into session_space_links for each id; role in ('admin','main','sub')
// returns the effective space rows for that session, ordered by space_id
export function getOrCreateL4Snapshot(db, { sessionId, spaces, render })
// render(spaces) -> string. Persists { session_id, text, hash } once; returns { text, hash, created:boolean }
export function markBootstrapped(db, sessionId) // -> true when this call created the row (first bootstrap)
export function getUsageStats(db)            // -> { requests, logs, lastLogAt } read from meta table (best effort)
```

### Schema (must match `dsh-context-array-v4.1.md` §4)

Tables: `memory_spaces`, `session_space_links`, `memories`, `memories_fts` (FTS5 `tokenize='trigram'`, `content='memories'`, `content_rowid='seq'`) with triggers `memories_ai`, `memories_ad`, `memories_au`; `inbox`, `memory_queue`, `session_l4_snapshot`, `inbox_wake_log`, plus M1 additions `meta(key TEXT PRIMARY KEY, value TEXT)` and `session_bootstrap(session_id TEXT PRIMARY KEY, bootstrapped_at DATETIME DEFAULT CURRENT_TIMESTAMP)`.
`memories.embedding` is BLOB (nullable). Never read a BLOB into a typed array here.
Commit the full §4 DDL as one `CREATE ... IF NOT EXISTS` script; tests assert every table + the FTS5 trigram path works with Chinese text.

## `src/observer.js`

```js
export function createUsageObserver({ logPath, now = () => Date.now(), onError = () => {} })
// returns { wrapStream(options, next), readLog(), stats() }

// wrapStream is registered on the 'llm/stream' waterfall:
//   ctx.on('llm/stream', observer.wrapStream)
// It MUST return an AsyncIterable and MUST pass every chunk through unchanged (same object identity, same order).
// It MUST never throw into the stream: all bookkeeping is guarded.
```

On `chunk.type === 'usage'` build one record and append one JSON line to `logPath`:

```json
{
  "schema": 1,
  "at": "2026-11-21T13:00:00.000Z",
  "sessionId": "…|null",
  "provider": "deepseek-official",
  "model": "deepseek-flash",
  "purpose": null,
  "messageCount": 12,
  "toolCount": 9,
  "systemMessageCount": 1,
  "systemDigest": "sha256-of-first-system-role-message-text",
  "systemDigestAll": "sha256-of-all-system-role-message-texts-joined",
  "toolsDigest": "sha256-of-canonical-json-of-tool-names-and-parameters",
  "prefixDigest": "sha256(systemDigest + ':' + toolsDigest)",
  "wholeHit": 0.0,
  "prefixHit": 0.0,
  "prefixTokens": 0,
  "prefixHitTokens": 0,
  "systemTokens": 0,
  "toolTokens": 0,
  "usage": { ...the normalized TokenUsage object verbatim... },
  "hitRate": 0.0,
  "inputTokens": 0,
  "cacheReadTokens": 0,
  "cacheWriteTokens": 0
}
```

Rules:
- `hitRate = cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)`; `0` when the denominator is 0; round to 6 decimals.
- `usage` must be the **normalized** object exactly as received (DeepSeek's raw `prompt_cache_hit_tokens` is not exposed by the adapter — record `usageSource: 'normalized-usage-chunk'` in the record so the limitation is explicit).
- Message text extraction: a message's `content` is an array of blocks; use `block.type === 'text' ? block.text : ''`; the payload is frozen, never mutate it.
- `wholeHit` is the provider-reported share; `prefixHit` is the architecture metric from `src/prefix.js` (`min(prefixTokens, cacheReadTokens) / prefixTokens`, node 0 + tools only, DSH's fixed 4-chars-per-token heuristic). Both must be recorded; never present `wholeHit` as the architecture number.
- Append with `fs.appendFileSync` (sync, no ordering races) after creating the directory once.
- `readLog()` returns parsed records; tolerate a truncated last line.
- `stats()` returns `{ requests, meanHitRate, lastAt }`.
- `toolsDigest` = sha256 of the canonical JSON of the **whole `tools` array** (deep key sort, array order preserved, non-JSON members dropped); an empty/absent tool list digests the canonical empty array. `systemDigest` covers system node 0 only; `systemDigestAll` covers every system-role message joined by a blank line, so an in-history prompt append is visible.
- Canonical JSON: sorted object keys, stable output (write a local helper; do not rely on third-party libs).

## `src/append.js`

```js
export function buildBootstrapMessage({ sections })  // sections: [{ name, text }]
// -> {
//   role: 'user',
//   id: crypto.randomUUID(),
//   source: { kind: 'context-array', form: 'snapshot', sections },
//   content: [{ type: 'text', text: '<context-array-bootstrap>\n…\n</context-array-bootstrap>' }],
// }

export function deliverBootstrap(agent, message, { onError } = {})
// agent.inject(message) inside try/catch; returns true when accepted, false when the runtime rejected it.
// NEVER throw: a failed bootstrap must not break the turn.
```
The injected message is queued by `agent.inject()` for the next `agent/pre-step` (it does **not** wake the agent), which is exactly the M1 "append layer": appended after `step/start`, never touching the L1–L4 prefix.

## `src/prefix.js`

```js
export function estimateSystemMessage(message)      // ceil(text chars / 4) + 4; 0 for empty content
export function estimateToolsTokens(tools)          // ceil(JSON.length / 4) + 4; 0 when absent/empty
export function computePrefixMetrics({ messages, tools, usage })
// -> { systemTokens, toolTokens, prefixTokens, prefixHitTokens, prefixHit, wholeHit }
```
Identical to DSH's fixed estimator (`dsh-token-meter/src/estimate.ts`). Only the FIRST
system-role message counts as prefix; in-history system appends are history, not prefix.

## `src/events.js`

```js
export function createEventLog({ logPath, now, onError }) // -> { append(record) }
```
One JSONL line per fact, `at` ISO timestamp prepended, every write guarded.

## `src/compaction.js`

```js
export const COMPACTION_MODES // ['off', 'observe']

export function createCompactionProvider({ mode, events, now })
// -> { name: 'compaction', compactIfNeeded, compactNow, compactRegion }
// compactIfNeeded/compactNow record a sample and return null (never fold);
// compactRegion throws (destructive path not implemented).

export function installCompactionTakeover({ ctx, config, events, warn, now })
// 'off' -> { installed: false, reason: 'off' } and nothing is claimed.
// 'observe' -> ctx.provide('compaction', provider) + per-session pressure sampling
//              (throttled to one sample per session per minute above warnTokens).
//              A taken seam reports { installed: false, reason: 'conflict' } and logs
//              compaction/provider-conflict instead of pretending success.

export function installHistoryReplacementWatch({ ctx, events, warn })
// Records every session event carrying surfaceOp.op === 'replace' as history/replace.
```
Takeover REQUIRES the default implementer to be absent (`dsh-compaction-basic` disabled
by patch row); two providers in one context cannot coexist.

## `src/db-memories.js` (M2)

```js
export const DIMENSIONS / MEMORY_ERRORS / DEFAULT_KEYWORD_LIMIT
export function normalizeSpaceIds(spaceIds)          // -> string[]; junk dropped, de-duped
export function toBlob(values)                       // Float32Array|number[] -> Buffer view
export function fromBlob(blob)                       // Uint8Array|null -> Float32Array|null (ALWAYS copies)
export function insertMemory(db, {id?, spaceId, dimension='fact', content, embedding=null, sourceSessionId, supersedesId=null})
                                     // -> id; BEGIN IMMEDIATE; supersede rows!==1 -> SUPERSEDE_FAILED + rollback
export function listActiveEmbeddings(db, spaceIds)   // -> [{id, spaceId, dimension, content, vec}]
export function keywordSearchMode(query)             // -> 'fts' | 'like' | 'skipped'
export function searchKeyword(db, {spaceIds, query, limit=20})  // -> [{id, spaceId, dimension, content, score}]
export function countMemories(db)                    // -> { total, active }
```

## `src/retrieval.js` (M2)

```js
export const RRF_K / VECTOR_TOP_K / KEYWORD_TOP_K / DEFAULT_BUDGET_TOKENS / DEFAULT_RESULT_LIMIT
export const DEFAULT_WEIGHTS                          // { vector: 2, keyword: 1 } — MRR-tuned (see docs/M2-RESULTS.md)
export function estimateMemoryTokens(content)         // ceil(chars/4)+4
export function renderBlock(result)                   // '<memory>…</memory>' | null; sanitises '</memory>'
export function createRetriever({ db, embedQuery=null, budgetTokens=800, now, weights=DEFAULT_WEIGHTS })
// -> { search({spaceIds, query, limit}), renderBlock }
// search -> { items: [{id, spaceId, dimension, content, score, sources}], diagnostics }
// Embedder failure degrades to keyword-only and reports it in diagnostics.error; it never throws.
```

## `src/embedding/` (M2)

```js
// client.js (main thread)
export function createEmbeddingClient({ modelsDir, onError }) // -> { ready(), embedPassage(), embedQuery(), stats(), close() }
// worker.js (worker_threads entry; loads the model, runs inference, L2-normalises)
//   model path: <modelsDir>/Xenova/multilingual-e5-small
//   prefixes:   'passage: ' / 'query: ' (e5 requirement)
// codes: EMBEDDING_TIMEOUT | EMBEDDING_WORKER_ERROR | EMBEDDING_WORKER_EXITED | EMBEDDING_WORKER_UNSTABLE | EMBEDDING_CLOSED
```

## `src/memory-tool.js` (M2)

```js
export function createMemorySearchTool({ db, retriever, warn })
// -> ToolDefinition for `memory_search`:
//    parameters: { query: string, limit?: integer 1..20 }
//    output.schema: { query, items[], diagnostics }  (diagnostics open)
//    execute(args, exec): spaces come from exec.agent.id + session_space_links;
//    a model can never pass session_id or space_id.
```

## Config keys

`dataDir`, `spaceId`, `spaceName`, `spaceRules`, `observeUsage`, `bootstrapMessages`,
`compactionMode` (`off` | `observe`, defaults to `off`), `compactionWarnTokens`
(default `300000`), `compactionAlarmRatio` (default `0.8`), `promptSaltFile` (diagnostic;
defaults to `<dataDir>/prompt-salt.txt`), `enableEmbedding` (default `true`),
`modelsDir` (default `<dataDir>/models`), derived `dbPath`, `usageLogPath`,
`eventsLogPath`, `schemaVersion`.

## Tests

`node --test` (built-in `node:test` + `node:assert/strict`; run it from the repository root — `node --test test/` is not a valid target on Node 24). Each owner runs only its own test files with `node --test test/<file>.mjs`. Tests must not touch `%USERPROFILE%\.dsh`; use `os.tmpdir()` directories and delete them afterwards.
