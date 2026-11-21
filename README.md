# Context array

Locally hosted five-dimension memory for DeepSeek Harness (DSH), built around one
hard rule: **never rewrite the cached request prefix**. Everything dynamic is
appended after it; everything static is registered while the prompt is assembled.

This repository currently contains the **M1** slice from
[`dsh-context-array-v4.1.md`](dsh-context-array-v4.1.md): the observation and
append layer, the static single-space store, and the L1/L3/L4 prompt sections
(L2 is the tool declaration field, owned by DSH, not by this plugin).

## What M1 implements

| Piece | File | Behavior |
|---|---|---|
| L1/L3/L4 prompt sections | `src/prompt.js`, `index.js` | L1 (base rules) and L3 (role rules) are global static sections; L4 (space rules) is scoped per session and rendered from a per-session snapshot, so editing a space never rewrites an existing session's system node. L2 is the request's tool declaration, not a section. |
| Static store | `src/db.js` | SQLite via the runtime's built-in `node:sqlite` (no native build): spaces, session bindings, five-dimension memories, FTS5 `trigram` index with content-table triggers, inbox, memory queue, L4 snapshots, wake log. |
| Usage observer | `src/observer.js` | Wraps the `llm/stream` waterfall and passes every chunk through unchanged while recording one JSONL line per model request: normalized `usage`, `hitRate`, and `systemDigest` / `toolsDigest` / `prefixDigest`. |
| Append layer | `src/append.js`, `index.js` | One bootstrap snapshot per new session, delivered with `agent.inject()` — queued for the next `agent/pre-step`, never waking the agent and never touching the cached prefix. |

`prefixDigest` is the M1 cache metric: identical digests across requests prove that
**system node 0 + the tool declarations** were unchanged. A prompt DSH appends in
history (`systemPromptUpdate: 'in-history'`) keeps that prefix reusable while node 0
stays byte-identical; `systemMessageCount` and `systemDigestAll` are what reveal such
an append.

M1 was verified end-to-end on live sessions — real hit rates, a stable prefix digest,
and the two lifecycle defects it exposed are recorded in
[`docs/M1-RESULTS.md`](docs/M1-RESULTS.md).

## Install

The package root is the bundle root; there is no nested directory.

In the DSH GUI open **Plugins → Add plugin**, and choose this directory
(`D:\dshprogram\dsh-context-array`). Installation links the checkout, so later edits
load without copying files; the running Host picks them up when the plugin row is
toggled or DSH restarts.

## Configuration

The bundle's patch row (`cordis.patch.yml`) accepts:

| Key | Default | Meaning |
|---|---|---|
| `dataDir` | `<home>/.dsh/context-array` | Where the SQLite database and `usage.jsonl` live. |
| `spaceId` / `spaceName` / `spaceRules` | `space-default` / `Default space` / … | The single static space created at first activation. |
| `observeUsage` | `true` | Record one usage line per model request. |
| `bootstrapMessages` | `true` | Inject one snapshot message per new session. |

## Verify

```powershell
node --test                            # unit + wiring tests
node docs/analyze-usage.mjs            # summarize the captured log
Get-Content "$env:USERPROFILE\.dsh\context-array\usage.jsonl" -Tail 3
```

Each JSONL line carries the provider-reported counters; the hit rate is computed as
`cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)`.

## Verified limitation

Verified against DSH `0.2.2-rc.3` (preconditions) and `0.2.2-rc.5` (M1 run).

DSH adapters report **normalized** `TokenUsage`; the provider's raw usage JSON
(`cache_read_input_tokens` for the DeepSeek Messages route, `prompt_cache_hit_tokens`
for OpenAI-compatible routes) is consumed inside the adapter and is not exposed to
plugins. Records therefore keep the normalized object verbatim and mark
`usageSource: "normalized-usage-chunk"`.

## Design document

The full product and architecture document — KV-cache layers L1–L5, five-dimension
spaces, memory manager queue, inbox storm control, schema and milestones — is
[`dsh-context-array-v4.1.md`](dsh-context-array-v4.1.md). Its §0 records the five
platform preconditions verified against DSH `0.2.2-rc.3`; the M1 end-to-end run
happened on `0.2.2-rc.5`.
