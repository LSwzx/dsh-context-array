# 贡献指南

本项目是 DeepSeek Harness（DSH）的本地记忆插件，最重要的不是功能多少，而是
**不破坏 KV Cache 前提**。改动前请先读完本文件与设计文档第 0 节。

## 当前状态（决定了什么能改）

- **M1 已实现并端到端验证**：L1/L3/L4 提示词段、单空间静态存储、usage 观测、追加层。
- **M0 第六项（压缩接管）未验证**，它阻塞 M2。压缩会在阈值处原地替换历史、打断缓存；
  在它被收编之前，不要基于"缓存一定被保护"去写检索逻辑。
- **M1-4（双轨指标）未做**：目前只有整段命中率 `whole_hit`，架构指标 `prefix_hit`
  还没实现。新增任何"提升命中率"的改动前，先确认你测的是哪个数。

详见 [`dsh-context-array-v4.1.md`](dsh-context-array-v4.1.md)（现行版本 v4.1.4）。

## 不可协商的规则

1. **不改写历史前缀**。动态内容只能追加（`agent.inject()`、`agent/pre-step` 的 enter 批次、
   工具 `additionalContexts`）；不要注册成 prompt section/context，那里会被渲染成系统节点
   或 `<system-reminder>` 用户消息，变化即重写前缀。
2. **工具顺序与定义保持固定**。`deepseek-flash` 只声明 `toolUpdate: 'addition-only'`：
   新增工具可以追加，删除、改定义、改序都会让缓存从首个变化 token 起失效。
3. **身份与归属只由宿主注入**。`session_id` / `space_id` 永远不作为工具参数；调用者身份取
   `exec.agent.id`，空间归属由后端按会话查绑定表。任何"让模型自己填 id"的实现都不接受。
4. **并发写必须 WAL + busy_timeout**。连接打开即 `PRAGMA journal_mode = WAL`、
   `PRAGMA busy_timeout = 5000`；事务手写 `BEGIN IMMEDIATE / COMMIT / ROLLBACK`
   （`DatabaseSync` 没有 `db.transaction()`，也不支持嵌套 `BEGIN`。
5. **BLOB 读出要拷贝**。`node:sqlite` 返回的 `Uint8Array` 的 `byteOffset` 不保证 4 字节对齐，
   直接建 `Float32Array` 视图会抛 `RangeError`。
6. **本地优先、离线优先**。记忆原文不离开本机；embedding 必须在本地跑。

## 开发环境

- Node.js ≥ 22.5（运行时自带 `node:sqlite`，无需 better-sqlite3）。
- ESM（`"type": "module"`），**无构建步骤**。
- 依赖边界：只有本地 embedding 需要运行时依赖（`@huggingface/transformers`，M2 引入）；
  其它模块保持零依赖，只允许 `node:` 内置模块。不要 `import` `@deepseek-ai/*`
  （profile 安装的 bundle 解析不到它们）。
- 重型推理（onnxruntime）**必须在 worker 里**：主线程同步推理会卡死整个 Host。
- 代码与测试全部为纯 JS + `node:test`。

```powershell
cd dsh-context-array
npm install                 # 仅首次 / 依赖变化时
node tools/fetch-model.mjs  # 下载 e5-small 到 <dataDir>/models（幂等，可离线复用）
node --test                 # 从仓库根运行；node --test test/ 在 Node 24 下会报错
node tools/eval-retrieval.mjs
node docs/analyze-usage.mjs # 汇总本机 usage.jsonl（只读）
```

> **编码红线**：仓库文件全是 UTF-8。**不要**用 PowerShell 的 `Get-Content`/`Set-Content`
> 读写含中文的仓库文件（Windows PowerShell 5.1 默认按 GBK 解释，会把 UTF-8 中文写坏，
> 且不可逆）。用文件写工具，或 Node/Python 显式指定 `utf8`。提交前跑
> `node "$env:TEMP\check-encoding.mjs" .`（脚本内容见 git 历史）或自查 U+FFFD。

## 目录约定

| 路径 | 内容 |
|---|---|
| `index.js` | 插件入口：`apply(ctx, config)`，注册段、观测、追加层、压缩接管、检索工具与生命周期清理 |
| `src/prompt.js` | L1/L3/L4 的纯文本与确定性渲染（字节稳定是第一要求） |
| `src/db.js` | SQLite 建表、迁移与查询（schema 与设计文档 §4 对齐） |
| `src/db-memories.js` | 记忆写入/取代、FTS5 检索、向量扫描的 SQL 层 |
| `src/retrieval.js` | 混合检索：双路候选 + RRF（默认 2:1）+ token 预算 + `<memory>` 渲染 |
| `src/embedding/` | worker 线程里的 e5-small 推理 + 主线程 async RPC 客户端 |
| `src/memory-tool.js` | `memory_search` 工具定义（身份由宿主注入） |
| `src/config.js` | 配置解析与默认值（非法值回退，绝不抛错） |
| `src/observer.js` | `llm/stream` 旁路观测：usage 记录、摘要与命中率 |
| `src/prefix.js` | 前缀 token 估算与双轨指标（`prefixHit` / `wholeHit`） |
| `src/compaction.js` | 压缩接管（observe）、压力告警、历史替换侦测 |
| `src/append.js` | L5 追加层：bootstrap 消息构造与投递（绝不抛进轮次） |
| `src/events.js` | `events.jsonl` 追加日志（压缩/告警/替换） |
| `test/` | `node --test` 用例；**只允许写 `os.tmpdir()`**，结束清理，绝不碰 `%USERPROFILE%\.dsh` |
| `tools/` | 模型下载、种子记忆、检索评测（开发工具，不参与运行时） |
| `docs/` | 插件详情页、M1/M2 实测记录、节省测算、usage 分析脚本 |
| `CONTRACT.md` | 各模块的导出签名与记录字段契约，改接口先改它 |

## 提交前检查清单

- [ ] `node --test` 全绿（新增行为必须有对应用例）。
- [ ] 没有把 `.db`、`.jsonl`、`node_modules/`、临时脚本提交进来（见 `.gitignore`）。
- [ ] 改了接口/记录字段：同步更新 `CONTRACT.md` 与 `docs/DETAIL.md` 里的示例。
- [ ] 改了设计：同步更新设计文档，并在第 8 节修订记录里写清版本、改了什么、为什么。
- [ ] 涉及缓存的改动：说明它影响 `prefix_hit` 还是 `whole_hit`，并给出前后数字。
- [ ] 涉及 prompt 段的改动：确认同一空间集合下渲染文本逐字节一致（`prefixDigest` 不变）。

## 本地验证插件

在 DSH 图形界面 **插件 → 添加插件（Plugins → Add plugin）**，选择本目录；安装是链接检出目录，
改动后需要切换插件行或重启 DSH 才会加载新代码。随后在任意会话发一条消息，检查：

```powershell
Get-Content "$env:USERPROFILE\.dsh\context-array\usage.jsonl" -Tail 3
```

出现一行带 `usage` / `hitRate` / `prefixDigest` 的记录即说明观测层生效；
`prefixDigest` 在连续请求中保持不变，才说明前缀没被改坏。

## 提交信息与许可

- 提交信息用英文祈使句作标题（`feat: …` / `fix: …` / `docs: …`），正文可写中文，说明
  **为什么**改、影响哪个缓存指标、怎么验证的。
- 每个提交应保持仓库可运行：不提交半成品接口、不留下失败的测试。
- 提交即表示你同意以 [MIT](LICENSE) 许可贡献这些代码；请只提交你有权贡献的内容
  （第三方代码需附许可与出处）。
