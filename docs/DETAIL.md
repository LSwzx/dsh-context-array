# Context array — M1

## What this plugin does right now

It installs the **observation and append layer** plus the **static single-space
store** described in the project document's milestone M1. Nothing in this version
writes memory automatically; it establishes the machinery the later milestones
(M2–M4) build on.

### 1. L1–L4 prompt sections

DSH renders prompt sections into a single `system`-role message that becomes node 0
of the derived history. This plugin registers three sections at fixed orders
(100, 200, 300 — free positions between the deployment persona and first-party tool
guidance):

- **L1** — base rules and safety (static text).
- **L3** — role rules (static text).
- **L4** — space rules, registered in the agent's own scope.

L4 is rendered from the session's bound space set, sorted by space id, with no
timestamps. On first sight of a session the exact rendered text is persisted in
`session_l4_snapshot`; every later request reuses that snapshot. Editing a space's
name or description therefore affects **new** sessions only and can never rewrite an
existing session's node 0.

### 2. Static store

The SQLite database lives at `~/.dsh/context-array/context-array.db` by default and
is created with the schema from the design document §4: `memory_spaces`,
`session_space_links`, `memories` (explicit integer `seq` primary key), the FTS5
`trigram` index over `memories` with its three content-table triggers, `inbox`,
`memory_queue`, `session_l4_snapshot`, `inbox_wake_log`, plus `meta` and
`session_bootstrap`.

It uses the runtime's built-in `node:sqlite`, so there is no native build step. The
API is synchronous (`DatabaseSync`) and has no `db.transaction()` wrapper, so
transactions are written as `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`.

### 3. Usage observer

The `llm/stream` waterfall exposes every model call. The observer wraps the stream
and passes each chunk through untouched while recording one JSON line per request:

```json
{
  "schema": 1,
  "at": "2026-11-21T13:36:58.692Z",
  "sessionId": "…",
  "provider": "deepseek-official",
  "model": "deepseek-flash",
  "messageCount": 330,
  "toolCount": 62,
  "systemMessageCount": 1,
  "systemDigest": "…",
  "systemDigestAll": "…",
  "toolsDigest": "…",
  "prefixDigest": "…",
  "usage": { "inputTokens": 2249, "outputTokens": 491, "cacheReadTokens": 332288, "cacheWriteTokens": 0, "totalTokens": 335028 },
  "hitRate": 0.993277,
  "inputTokens": 2249,
  "cacheReadTokens": 332288,
  "cacheWriteTokens": 0,
  "usageSource": "normalized-usage-chunk"
}
```

`prefixDigest` is the cache metric: two requests with the same digest sent the same
system node and the same tool declarations, which is exactly what DeepSeek's prefix
cache needs. `systemDigest` covers node 0 only; `systemMessageCount` and
`systemDigestAll` expose a prompt that DSH appended in history
(`systemPromptUpdate: 'in-history'`) — those keep the prefix reusable but add tokens
for every retained version.

### 4. Append layer

For a new conversation the plugin injects one small snapshot message through
`agent.inject()`. That queues model-facing context for the next `agent/pre-step`:
it is appended after `step/start` (after the cached prefix), it does not wake an idle
agent, and it never changes L1–L4. The injection is idempotent per session
(`session_bootstrap`) and never throws into the turn.

## How to verify

1. Install this directory as a plugin in the DSH profile.
2. Send one message in a new session; a real model request happens.
3. Read the tail of `~/.dsh/context-array/usage.jsonl` — there is one line per
   request with the provider-reported counters and the computed hit rate.
4. Compare `prefixDigest` across consecutive requests in the same session: equal
   digests mean the L1–L4 bytes are stable and the request is cache-eligible.
5. Send another message and check that `hitRate` is high while `prefixDigest`
   matches the previous line.

## Limitations

- Only normalized `TokenUsage` is exposed to plugins; the provider's raw usage JSON
  is not reachable. Records mark this explicitly with `usageSource`.
- Memory retrieval, the manager queue, and the inbox are schema-only in M1; M2–M4
  implement them.
- Embedding runs on CPU and is not part of M1. When M2 adds it, it must run in a
  worker or child process: `onnxruntime` inference is synchronous and would otherwise
  block the whole Host.
