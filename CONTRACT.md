# M1 implementation contract (dsh-context-array)

Plain ESM JavaScript (`"type": "module"`), no build step, no TypeScript. One runtime dependency:
`@huggingface/transformers` for the local embedding worker.
Runtime: the DSH Host process (Electron-as-Node 24.21) — `node:sqlite`, `node:crypto`, `node:fs`,
`node:path`, `node:os`, plus `node:worker_threads` for the embedding worker.
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
//   schemaVersion,  // 3
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

Tables: `memory_spaces`, `session_space_links`, `memories`, `memories_fts` (FTS5 `tokenize='trigram'`, `content='memories'`, `content_rowid='seq'`) with triggers `memories_ai`, `memories_ad`, `memories_au`; `inbox`, `memory_queue`, `session_l4_snapshot`, `inbox_wake_log`, `session_persona_snapshot` (persona block freeze, schema 3), plus M1 additions `meta(key TEXT PRIMARY KEY, value TEXT)` and `session_bootstrap(session_id TEXT PRIMARY KEY, bootstrapped_at DATETIME DEFAULT CURRENT_TIMESTAMP)`.
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
export const COMPACTION_MODES // ['off', 'observe', 'fold']

export function createCompactionProvider({ mode, events, now, foldOptions })
// -> { name: 'compaction', compactIfNeeded, compactNow, compactRegion }
// observe records a sample and returns null; fold delegates to src/compaction-fold.js;
// compactRegion still throws (automatic/manual folding covers it).

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
export const TIME_BOUND_DIMENSION_DAYS = 7
export function activeMemoryPredicate(alias)  // superseded_by IS NULL + recent/working freshness
export function listMemoryHistory(db, memoryId)  // recursive both-direction supersede chain
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

## `src/compaction-fold.js` (M0-6)

```js
export function sessionEvents(session)            // snapshotEvents() -> eventAt(seq) fallback; Session has no `events`
export function inspectEntryState(session)        // -> { openTurn, unmatchedStartSeq }
export function planFold({ session, measurement, config, onSkip })
// keeps surface node 0 (the system prompt), folds from node 1 up to a turn/start boundary,
// retains >= config.retainRatio of surface tokens, requires >= config.minFoldTokens
export function summarizationMessages(session, shadowedSeqs)
export async function summarize({ llm, messages, target, config, signal })
export function commitFold({ session, start, end, shadowedSeqs, shadowedTokenCount, summaryText,
                             target, maxTokens, usage, turn, keptSeqs })
// compaction/start -> compaction/summary -> user/message(kind 'compact-checkpoint', surfaceOp replace) -> compaction/end
// any throw after the lock appends compaction/end with an `error` payload
export async function foldSession({ ctx, agent, trigger, signal, config, events, warn })
```

## `src/compact-tool.js` (M0-6)

```js
export function createContextCompactTool({ compaction, warn })
// -> ToolDefinition `context_compact` (no parameters); registered only in `fold` mode.
// execute(args, exec) folds exec.agent's own session via compaction.compactNow and reports
// { folded, compactionId, shadowedStart, shadowedEnd, shadowedTokenCount, keptNodes, reason? }.
```

## `src/queue.js` (M3)

```js
export const QUEUE_STATUSES                    // pending | processing | done | rejected | failed
export function proposalDedupeKey(sourceSessionId, rawContent, now)  // sha256(session + content + UTC hour)
export function enqueueProposal(db, { sourceSessionId, rawContent, now })
// -> { id, deduped }; never writes `memories`
export function claimNext(db, { staleMinutes = 10, maxRetries = 3 })
// one BEGIN IMMEDIATE: requeue stale processing -> fail exhausted pending -> UPDATE ... RETURNING oldest
// -> claimed row (retry_count already incremented) or null
export function settleClaim(db, id, status, { error })   // done|rejected|failed, processing only
export function queueStats(db)                            // per-status counts + total
export function listQueueItems(db, { status, sourceSessionId, limit, offset, staleMinutes, maxRetries })
// -> { items, total, hasMore, stuckCount, stuckAfterSeconds, maxRetries }
// items carry: id, status, retry_count, created_at, claimed_at, error, source_session_id,
//              content_preview (200 chars), content_length, claimed_ago_seconds
export function getQueueItem(db, id)                      // one row + full raw_content, or null
```

## `src/memory-tools.js` (M3)

```js
export function sessionBinding(db, sessionId, fallbackSpaceId)  // -> { spaceIds, role, implicit? }
export function createMemoryTools({ db, embedPassage, config, warn, ctx, inboxTracker })
// -> [memory_propose, memory_queue_claim, memory_archive, memory_queue_settle,
//     memory_queue_stats, memory_bind, memory_unbind, inbox_send, inbox_list, inbox_ack,
//     memory_search is registered separately by src/memory-tool.js]
```
- `memory_propose` is open to every session and only enqueues.
- Claim/archive/settle/stats are admin-gated **server-side**: `session_space_links.role === 'admin'`
  or `config.adminSessionIds` contains the caller's `exec.agent.id`. Tool arguments cannot name a
  session or space that is not the caller's own; `memory_archive` re-checks `spaceId` membership and
  rolls the whole insert back when `supersedesId` cannot be applied.
- An embedder failure degrades to `embedded:false` (keyword retrieval still works) instead of failing
  the archive.

## `src/spaces.js` (M4)

```js
export function getSpace(db, id)
export function listSpacesDetailed(db)          // + memories / sessions counts
export function createSpace(db, { name, description })      // id = space-<8 hex>
export function updateSpace(db, { id, name, description })
export function deleteSpace(db, id, { defaultSpaceId })   // refuses the configured default and spaces with ACTIVE memories;
                                                          // the panel drives the supersede-then-delete flow
                                                // otherwise clears memories (incl. superseded), inbox and links
export function countActiveMemories(db, spaceId, dimension?)
export function listMemories(db, { spaceId, dimension, limit, offset, includeSuperseded })
export function deleteMemory(db, id)
export function listBindings(db)                // [{ session_id, space_id, role, space_name }]
export function listKnownSessions(db)           // [{ sessionId, links: [{spaceId, role}] }]
export function bindSessionToSpace(db, { sessionId, spaceId, role })
export function unbindSessionFromSpace(db, { sessionId, spaceId })
```

## `src/inbox.js` (M4)

```js
export const INBOX_SOURCE_KIND = 'context-array-inbox'
export const DEFAULT_WAKE_MAX_PER_HOUR = 10
export function sendInbox(db, { spaceId, sourceSessionId, targetSessionId, content })   // dedupe by content hash
export function listInbox(db, { targetSessionId, status, limit })
export function acknowledgeInbox(db, id)
export function wakeCountLastHour(db, targetSessionId)
export function noteWake(db, { targetSessionId, sourceSessionId, inboxId, throttled })
export function deliverInbox(ctx, { db, targetSessionId, content, wake, maxPerHour,
                                   globalMaxPerHour, cooldownMinutes, sourceSessionId, inboxId })
// throttled reasons: global | cooldown | hourly; every throttled attempt still injects + logs
// globalWakeCountLastHour(db), lastWakeAt(db, targetSessionId) are exported helpers
// -> { mode: 'woke' | 'queued' | 'throttled' | 'offline' }
// wake uses agent.followup(); everything else uses agent.inject(); over-limit wakes still inject.
```

## `src/http-api.js` (M4)

```js
export const API_PREFIX = '/api/context-array'
export function registerRoute(ctx, route, { events, warn })  // ctx.inject(["webServer"]) + http-api/* events
export function registerContextArrayApi({ ctx, db, config, warn, events, persona })  // -> disposer
```
Routes: `GET /health`, `GET /overview` (spaces, bindings, `sessions: [{ sessionId, links, live, title, titleSource }]`, queue,
`wakeMaxPerHour`, defaultSpaceId; the session list is the host corpus from
`ctx.get('sessionQuery').listSessions()` (live + persisted), titled via `readTitleSnapshots()`
with `sessionTitle.get()` as the live fallback), `POST /spaces/create|/spaces/update|/spaces/delete`,
`GET /memories/:id/history` (recursive CTE over `superseded_by`, oldest first; 404 when the id is unknown),
`GET /overview` also returns `admin: { adminSessionId, configuredCount, boundCount, canClaim }`,
`POST /admin/claim { sessionId }` (one-time onboarding; 409 `ADMIN_ALREADY_EXISTS` once an admin exists;
404 `SESSION_NOT_FOUND` for subagent/unknown sessions; writes one `role='admin'` binding to the default space),
`GET /queue/stats` (`GROUP BY status` counters),
`GET /memories?spaceId=&dimension=&limit=&offset=` (returns `{ memories, total, limit, offset, dimension }`),
`POST /memories/delete` (always `403 MEMORY_READ_ONLY`: the UI is read-only for memory),
`POST /bind|/unbind`,
`GET /queue?status=&sourceSessionId=&limit=&offset=` (returns `{ stats, items, total, hasMore, stuckCount,
stuckAfterSeconds, maxRetries }`), `GET /queue/:id` (full `raw_content`),
`GET /inbox?targetSessionId=&status=`, `POST /inbox/send|/inbox/ack`.
Reads are loopback-only; writes additionally require the `x-context-array-ui: 1` header. The queue
endpoints are read-only by design: claiming/archiving/settling stay in the admin tools.

## `client.js` (M4)

Hand-written browser bundle (`window.__ModuleLoader__.load({ id, factory })`), no build step.
Registers `sidebar.panellist` (`id: 'context-array'`, order 40, label `记忆`) and the `main`
keyed panel (`key: 'context-array'`). Styles render as a component-local `<style>` element (no
`styles` service dependency); tab content is wrapped in a React error boundary. It never imports a
Harness Client package and never touches another plugin's DOM.

## `src/persona.js` (M5, persona hijack protection)

```js
export const PERSONA_GUARD_MODES = Object.freeze(['off', 'observe', 'enforce'])
export const DEFAULT_PERSONA_GUARD_MODE = 'observe'
export const DEFAULT_PERSONA_GUARD_TOOLS = Object.freeze(['web_search', 'web_fetch'])
export const PERSONA_PATTERNS            // 12 bilingual high-precision rules { id, re }
export function contentText(content)     // model-visible text blocks only, 100k cap
export function detectHijack(text)       // -> [{ id, excerpt }]
export function buildPersonaText({ traits, memories })   // frozen <context-array-personality> block
export function reassertionMessage(toolName, matches)    // enforce-mode user message
export function createPersonaGuard({ config, events, warn, now })
// -> { mode, tools, alerts, handle(exec, result, next) }
// handle always awaits next(); it records persona/hijack-suspected and, only in
// enforce mode on an accepted decision, appends one additionalContexts entry.
```

The frozen block is stored by `getOrCreatePersonaSnapshot(db, { sessionId, render })` in
`session_persona_snapshot` and registered as prompt section `context-array:personality`
(order 150, between L1 and L3).

## `src/inbox-tracker.js` (M4 follow-up)

```js
export const MAX_HOP_COUNT = 3
export function createInboxTracker({ db, now, warn })
// -> { noteDelivery, onClaimed, onTurnStopping, triggerOf, nextHop, consumeWake }
```
Wire it to the host events: `agent/inbox/claimed` marks the row read and opens a turn
trigger; `agent/turn-stopping` closes it. `nextHop(sessionId)` returns `{ hop, triggerMsgId }`
or `null` at the ceiling; `consumeWake(sessionId)` enforces one wake per source per turn.

## `src/update.js` (npm update)

```js
export const PACKAGE_VERSION
export function compareVersions(left, right)   // -1 | 0 | 1
export function createUpdateChecker({ ctx, config, events, warn, now })
// -> { status, check({ auto }), install(version) }
// check() uses ctx.get("pluginManager").listBundles()/listVersions(name);
// auto-update installs only when the bundle source is "registry"; a path install is
// reported as available but never overwritten. install() calls updateBundle(name, version).
```

## Config keys

`dataDir`, `spaceId`, `spaceName`, `spaceRules`, `observeUsage`, `bootstrapMessages`,
`compactionMode` (code default `off`; the shipped patch sets `fold`), `compactionWarnTokens`
(code default `400000`), `compactionAlarmRatio` (code default `0.8`), `compactionFoldRatio` (default `0.85`),
`compactionRetainRatio` (default `0.3`), `compactionMinFoldTokens` (default `8000`),
`compactionSummaryMaxTokens` (default `600`), `promptSaltFile` (diagnostic; defaults to
`<dataDir>/prompt-salt.txt`), `enableEmbedding` (default `true`), `modelsDir`
(default `<dataDir>/models`), `adminSessionIds` (default `[]`),
`queueStaleMinutes` (default `10`), `queueMaxRetries` (default `3`), `wakeMaxPerHour`
(default `10`), `personaGuard` (`off` | `observe` | `enforce`, default `observe`),
`personaTraits` (default `[]`), `personaGuardTools` (default `["web_search","web_fetch"]`),
`wakeGlobalMaxPerHour` (default `30`), `wakeCooldownMinutes` (default `10`),
`updateCheck` (default `true`), `updatePolicy` (`off` | `notify` | `auto`, default `notify`;
the shipped patch uses `auto`), `updateCheckIntervalHours` (default `6`),
`updateCheckDelaySeconds` (default `30`), `schemaVersion` (5), derived `dbPath`,
`usageLogPath`, `eventsLogPath`.

## Tests

`node --test` (built-in `node:test` + `node:assert/strict`; run it from the repository root — `node --test test/` is not a valid target on Node 24). Each owner runs only its own test files with `node --test test/<file>.mjs`. Tests must not touch `%USERPROFILE%\.dsh`; use `os.tmpdir()` directories and delete them afterwards.
