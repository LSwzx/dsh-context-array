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

## Tests

`node --test` (built-in `node:test` + `node:assert/strict`; run it from the repository root — `node --test test/` is not a valid target on Node 24). Each owner runs only its own test files with `node --test test/<file>.mjs`. Tests must not touch `%USERPROFILE%\.dsh`; use `os.tmpdir()` directories and delete them afterwards.
