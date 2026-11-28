# Context array（上下文阵列）

面向 DeepSeek Harness（DSH）的**本地五维记忆**插件，围绕一条硬规则构建：
**绝不重写被缓存的前缀**。动态内容一律追加在已缓存历史之后，静态内容只在拼装阶段注册。

当前仓库包含设计文档
[`dsh-context-array-v4.1.md`](dsh-context-array-v4.1.md) 里程碑 **M1**（观测 / 追加 / 静态存储）
与 **M2**（本地 embedding + 混合检索）的实现，以及 **M0-6 压缩接管机制**、**M1-4 双轨缓存指标**。
实测记录：[`docs/M1-RESULTS.md`](docs/M1-RESULTS.md)、[`docs/M2-RESULTS.md`](docs/M2-RESULTS.md)。

> **已知问题（2026-11-28 评审，待修）**：见 [`docs/REVIEW-2026-11-28.md`](docs/REVIEW-2026-11-28.md)。
> P0-0（面板 404）、P0-1（编辑默认空间不生效）与 P1 四项已修（v0.4.1），见该文档的"修复状态"；
> 剩余为文档口径问题。面板 404 的修复需刷新页面后目视确认。
>
> **状态**：M1–M4 全部完成并实测。
> **M0-6 压缩已接管并实装折叠**（`compactionMode: fold`）：保留系统头、在轮次边界把较早区间换成一条
> `compact-checkpoint` 摘要，金丝雀实测折了 13 个节点 / 6,855 token 且会话继续正常。
> **两个受控实验也把"前缀被改动打穿"这条风险排除了**：该 `in-history` 路由上改提示词不会重写系统节点 0；
> 运行期增删工具也不改声明块，`prefixHit` 恒 1。真正会打断缓存的是**压缩折叠**本身——这是设计上已知并接受
> 的一次性代价，折叠轮次在 `events.jsonl` 里以 `history/replace` / `compaction/folded` 单独标记。
> **M3** 中央记忆管理员与异步队列已跑通（入队 → 原子领取 → 归档 → 检索召回）。
> **安装后不会自动绑定任何会话**：未绑定的会话默认使用默认空间（检索与 L4 照常），需要隔离时再绑定；面板首次打开有新手引导。
> **M4** 留言箱（排队/唤醒/限流）+ 多空间 + 侧边栏面板已跑通：左侧边栏最后一个图标「记忆」打开面板，
> 可管理空间、浏览记忆（只读）、查看队列、给其他会话发留言。删除空间只在空间没有有效记忆时可用；有记忆时提示先由记忆管理员用 `supersedesId` 取代。

## 缓存节省测算（真实日志）

221 个请求、81.5M 提示词 token，其中 99.76% 命中缓存。若无缓存、每请求全价重算：

| 命中价/未命中价 `r` | 计费输入等价值 | 相对无缓存节省 |
|---|---|---|
| 0.25 | 20.5M | **74.8%** |
| 0.10 | 8.3M | **89.8%** |
| 0.05 | 4.3M | **94.8%** |

关键不是省那 18k 的 L1–L4，而是**防止一次前缀破坏把 369k 的平均提示词整段打回全价**
（≈400 倍于正常一步的未命中量）。完整模型、反事实假设与边界见
[`docs/CACHE-SAVINGS.md`](docs/CACHE-SAVINGS.md)，复现：`node docs/savings-estimate.mjs`。

## 已实现的东西

| 组成 | 文件 | 行为 |
|---|---|---|
| L1/L3/L4 提示词段 | `src/prompt.js`、`index.js` | L1（基础规则）与 L3（角色规则）是全局静态段；L4（空间规则）按会话作用域注册，文本来自每会话快照——改空间描述不会改写已存在会话的系统节点。L2 是请求里的工具声明，不归本插件注册。 |
| 静态存储 | `src/db.js` | 用运行时自带的 `node:sqlite`（无需原生编译）：空间、会话绑定、五维记忆、FTS5 `trigram` 索引与外部内容表触发器、inbox、记忆队列、L4 快照、唤醒日志。 |
| usage 观测 | `src/observer.js`、`src/prefix.js` | 包裹 `llm/stream` waterfall，原样透传每个分块，同时为每个请求写一行 JSONL：规范化 `usage`、`wholeHit`、**双轨指标 `prefixHit` / `prefixTokens` / `prefixHitTokens`**，以及 `systemDigest` / `systemDigestAll` / `toolsDigest` / `prefixDigest`。 |
| 追加层 | `src/append.js`、`index.js` | 每个新会话注入一条 bootstrap 快照，走 `agent.inject()`：排队到下一次 `agent/pre-step`，不唤醒 Agent，也不碰已缓存前缀。 |
| 压缩接管 | `src/compaction.js`、`src/compaction-fold.js` | `compactionMode: fold` 时接管 `ctx.compaction` 并真的折叠：保留系统头、在轮次边界把较早区间替换成一条摘要（`history/replace`），失败会补写 `compaction/end` 关锁；压力到 `alarmRatio` 先落一条 `compaction/alarm`。 |
| 手动压缩工具 | `src/compact-tool.js` | `context_compact()`：只在 `fold` 模式注册，只能折叠调用者自己的会话（身份取宿主注入的 `exec.agent.id`）。 |
| 本地 embedding | `src/embedding/client.js`、`src/embedding/worker.js` | worker 线程加载 `multilingual-e5-small`（384 维，q8 ONNX），主线程只做 async RPC；首次加载约 1.7 s，单条推理中位 12.5 ms，60 条排队时主线程定时器漂移中位 3 ms。 |
| 混合检索 | `src/db-memories.js`、`src/retrieval.js` | 向量 top-20（点积=余弦）+ FTS5 trigram top-20（短查询 LIKE 兜底），RRF 融合（默认权重 **2:1**），按 token 预算截断，输出 `<memory>` 块；embedding 不可用时自动降级为关键词路。 |
| 检索工具 | `src/memory-tool.js` | `memory_search(query, limit?)`：身份取宿主注入的 `exec.agent.id`，空间归属查 `session_space_links`（未绑定时用默认空间兜底），模型不能指定 session/space。 |
| 记忆管理员 | `src/queue.js`、`src/memory-tools.js`、`src/prompt.js` | `memory_propose` 任何会话只入队；`memory_queue_claim` / `memory_archive` / `memory_queue_settle` / `memory_queue_stats` 仅管理员。队列原子领取、过期接管、重试上限、小时桶去重；归档本地算 embedding、校验绑定空间、取代失败整体回滚；管理员会话额外注入防注入 L3 段。 |
| 留言箱与多空间 | `src/inbox.js`、`src/spaces.js`、`src/http-api.js` | `inbox_send(wake?)` 排队走 `agent.inject`（不唤醒），唤醒走 `agent.followup` 并受每小时 10 次限流 + 每目标 10 分钟冷却 + 全局每小时 30 次（超限降级排队）；留言带 `hop_count`（≤3，来源轮次由宿主 `agent/inbox/claimed` 归因，超限拒绝），主会话可读绑定空间内全部留言、子会话只读定向给自己的；工具 `memory_bind` / `memory_unbind` / `inbox_list` / `inbox_ack`。空间增删改查、绑定、记忆浏览/删除经 `/api/context-array`（读 loopback-only，写需 `x-context-array-ui: 1`）。 |
| 人格劫持防护 | `src/persona.js`、`src/db.js`、`index.js` | 冻结人格块（section order 150，L1↔L3）：固定身份规则 + `personaTraits` + 有效 `personality` 记忆，每会话首次渲染后逐字节复用；`tools/post-execute` 监视 `web_search`/`web_fetch` 的文本，12 条中英规则命中后记 `persona/hijack-suspected`，`enforce` 模式追加 `<persona-guard>` 提醒（不阻断工具结果）。 |
| 记忆只读约束 | `src/http-api.js`、`client.js` | 人类没有修改记忆的权限：面板不提供编辑/删除，`POST /memories/delete` 恒为 `403 MEMORY_READ_ONLY`；记忆的写入与取代只能由记忆管理员通过 `memory_archive` 等工具完成。 |
| 侧边栏面板 | `client.js` | 左侧边栏图标「记忆」+ 主面板五个页签（空间 / 记忆 / 队列 / 留言箱 / 人格）；绑定与留言都从**会话下拉**选择（标题来自宿主 `sessionTitle`，无标题显示 id 前缀与在线标记），不需要手输 id；纯手写 bundle，无构建步骤；只用 `--dsw-alias-*` 主题 token。 |

## 三条最容易搞混的口径

1. **`prefixDigest` 只覆盖"系统节点 0 + 工具声明"**，不是整段 L1–L4 的哈希。
   DSH 在 `systemPromptUpdate: 'in-history'` 路由上会把变化后的提示词**追加**为新的
   `system` 消息，节点 0 不变——所以还要看 `systemMessageCount`（是否变多）与
   `systemDigestAll`（有效提示词是否变了）。
2. **命中率必须双轨**：
   - `prefixHit = min(prefixTokens, cacheReadTokens) / prefixTokens` —— 架构指标（目标 ≥ 95%）。
     `prefixTokens` 用 DSH 固定启发式估算"系统节点 0 + 工具声明"；实测 17,957 里**工具占 89.8%**。
   - `wholeHit = cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)` —— 只是成本参考。
   只报 `wholeHit` 会得到假数据：L5 每轮追加时它天然很高，掩盖前缀其实没被保护。
3. **缓存前提的实测状态**：TTL 已实测 **≥ 13.5 小时**（空闲 808 分钟后首请求仍命中 396,544 token）；
   **跨会话是否要求同账号仍未验证**（缺少前缀一致的两个会话做对照）。

## 安装

包根就是 bundle 根，**没有嵌套目录**。

```powershell
cd D:\dshprogram\dsh-context-array
npm install                            # 一个运行时依赖：@huggingface/transformers
node tools/fetch-model.mjs             # 下载 e5-small 到 <dataDir>/models（幂等，约 129 MiB / 3 分钟）
```

然后在 DSH 图形界面打开 **插件 → 添加插件（Plugins → Add plugin）**，选择本目录
（`D:\dshprogram\dsh-context-array`）。安装是"链接检出目录"的方式，后续改动不需要重新拷贝；
运行中的 Host 在插件行被切换或 DSH 重启后加载新代码。

> `package.json` 里的 `dsh.bundle.patch` 指向同目录 `cordis.patch.yml`，它插入一条
> `context-array` 插件行。模型可离线使用；`allowRemoteModels` 在 worker 里保持关闭，只读本地目录。

## 配置

`cordis.patch.yml` 的配置项：

| 键 | 默认值 | 含义 |
|---|---|---|
| `dataDir` | `<home>/.dsh/context-array` | SQLite 库、`usage.jsonl`、`events.jsonl`、`models/` 的根目录 |
| `spaceId` / `spaceName` / `spaceRules` | `space-default` / `Default space` / … | 首次激活时创建的单一静态空间 |
| `observeUsage` | `true` | 每个上报 usage 的请求写一行记录 |
| `bootstrapMessages` | `true` | 每个新会话注入一条 bootstrap 快照 |
| `compactionMode` | `fold` | `off` 不动部署；`observe` 只采样+告警不折叠；`fold` 接管并真折叠 |
| `compactionWarnTokens` | `300000` | 压力采样记录阈值（token） |
| `compactionAlarmRatio` | `0.7` | 压力到窗口该比例时写 `compaction/alarm` |
| `compactionFoldRatio` | `0.85` | 压力到窗口该比例才自动折叠 |
| `compactionRetainRatio` | `0.3` | 折叠后至少保留的 surface token 比例 |
| `compactionMinFoldTokens` | `8000` | 小于该 token 的区间不折叠 |
| `compactionSummaryMaxTokens` | `600` | 摘要生成的最大输出 token |
| `promptSaltFile` | `<dataDir>/prompt-salt.txt` | 诊断用：改这个文件可在观测层不停的情况下改 L1，做缓存受控实验 |
| `enableEmbedding` | `true` | 关掉则只走关键词检索（不启动 worker、不加载模型） |
| `modelsDir` | `<dataDir>/models` | 本地模型目录 |
| `adminSessionIds` | `[]` | 中央记忆管理员的会话 id（部署配置，模型不可写；M4 会有 UI 绑定） |
| `queueStaleMinutes` | `10` | 领取超过该分钟的 processing 行回到 pending |
| `queueMaxRetries` | `3` | 重试达到该值的 pending 行置 failed |
| `wakeMaxPerHour` | `10` | 同一目标会话每小时最多被唤醒次数（超限降级为排队） |
| `wakeGlobalMaxPerHour` | `30` | 全局每小时唤醒上限（防会话互相唤醒风暴，超限降级为排队） |
| `wakeCooldownMinutes` | `10` | 同一目标两次唤醒的最小间隔 |
| `personaGuard` | `observe` | `off` 关闭；`observe` 只记录投毒尝试；`enforce` 记录并在该步追加保持人格的提醒 |
| `personaTraits` | `[]` | 部署级人格特征（每行一条），与新会话冻结的人格块一起注入 |
| `personaGuardTools` | `["web_search","web_fetch"]` | 监视哪些工具的外部结果 |

> ⚠️ `observe` 会占用 `ctx.compaction`。**如果部署里还要启用 `dsh-compaction-basic`，请先把它
> 关掉，或把本项设为 `off`**，否则两个实现者会冲突（插件会记 `compaction/provider-conflict`，
> 默认实现加载失败）。

## 验证

```powershell
node --test                              # 全仓单元 + 接线测试（195 项）
node docs/analyze-usage.mjs              # 双轨指标 + TTL 空档 + 压缩事件
node tools/seed-memories.mjs             # 往当前库塞 3 条种子记忆（幂等，用于快速试 memory_search）
node tools/eval-retrieval.mjs            # M2 检索评测（向量 / 关键词 / 混合权重对比）
Get-Content "$env:USERPROFILE\.dsh\context-array\usage.jsonl" -Tail 3
Get-Content "$env:USERPROFILE\.dsh\context-array\events.jsonl" -Tail 3
```

每个请求一行，字段含义见 [`docs/DETAIL.md`](docs/DETAIL.md)；`events.jsonl` 记录接管、
压力采样、告警、折叠与历史替换。工具示例：

```
memory_search("前缀缓存会不会因为改提示词失效")
→ 3 hit(s) (vector=true, keyword=true)
- [space-default/reflection] DeepSeek 前缀缓存实测很耐用：… (score 0.0164)

context_compact()
→ context_compact: folded surface nodes 12–50 (6855 estimated tokens) into one summary;
  kept the most recent 12 nodes. compactionId=9069fee1-…            # 仅 fold 模式
```

## 实测结果（整段口径，样本 = 2 个会话 / 98 条请求）

| 会话 | 请求数 | 不同 `prefixDigest` | 命中率 min / mean / max | 累计命中 |
|---|---|---|---|---|
| 长历史会话 | 49 | **1** | 0.9933 / **0.9986** / 0.9996 | 99.86%（17,932,672 / 24,523） |
| 冷启动会话 | 49 | **1** | 0 / 0.9534 / 0.9987 | 97.92% |

早期样本里 `prefixDigest` 每个会话全程只有 1 个值（节点 0 + 工具声明逐字节不变）；后来压缩折叠与工具变更会出现多个值（当前会话实测 6 个），所以该结论只适用于没有折叠/工具变更的稳定段，
这是前缀可复用的证据；命中率数字本身**不能**当作架构验收（见上面第 2 条）。

实测还暴露并修掉了两个真缺陷：

1. **安装前已存活的会话收不到 `agent/created`**，因此拿不到 L4、也收不到 bootstrap。
   修复：激活时遍历 `ctx.get('agents')?.list()` 补做一次。
2. **agent 作用域的段注册不随插件卸载撤销**（禁用插件后 L4 仍残留在提示词里）。
   修复：把每个 L4 段的 disposer 收进插件 fiber 的 `ctx.effect`，并监听 `agent/disposed`。

## 已知边界

- 插件只能拿到适配器折算后的规范化 `TokenUsage`，**原始 provider usage JSON 不可达**；
  记录以 `usageSource: "normalized-usage-chunk"` 标注。
- **压缩折叠已实装，代价是已知的**：折叠把较早区间替换成一条摘要，替换点之后的缓存会失效一次，
  之后重新建立。折叠只在轮次边界、保留系统头、保留 ≥30% 尾部时发生；`foldRatio 0.85` 意味着
  长会话到 85% 窗口才折一次。参数未经多轮标定（见设计文档 §7）。
- **检索是"按需调用"而不是"每轮自动注入"**：`memory_search` 工具已可用，但自动把 `<memory>`
  块追加到 L5 要等 M3 有真实记忆后再做，否则每轮注入低价值内容反而稀释上下文。
- **依赖从零变为一个**：`@huggingface/transformers` + onnxruntime，`node_modules` 约 463 MiB，
  模型 129 MiB 需单独下载（`tools/fetch-model.mjs`）。瘦身方案（省 ~158 MB）未实施。
- 双轨指标只有 **8 个样本**（同一会话新代码加载后），`prefixTokens` 是字符启发式估算而非 provider 真值。
- 样本不是规模验证；跨会话同账号复用、压缩折叠成本均未测。
- 记忆管理员与留言箱属于 M3/M4：**M3 已实现**（见 `docs/M3-RESULTS.md`），留言箱与多空间 UI 属 M4。
- 管理员资格目前靠 `adminSessionIds` 配置或 `session_space_links.role='admin'`；没有后台自动轮询，
  `memory_queue_claim` 是按需调用的工具（是否常驻管理员见设计文档 §7）。

## 文档

- 设计文档（第 0 节六项前置验证、L1–L5 分层、压缩接管、M2 实测）：[`dsh-context-array-v4.1.md`](dsh-context-array-v4.1.md)
- M1 实测记录（含 M0-6 折叠实测）：[`docs/M1-RESULTS.md`](docs/M1-RESULTS.md)
- M2 实测记录（embedding + 检索评测）：[`docs/M2-RESULTS.md`](docs/M2-RESULTS.md)
- M3 实测记录（管理员 + 异步队列）：[`docs/M3-RESULTS.md`](docs/M3-RESULTS.md)
- M4 实测记录（留言箱 + 多空间 + 侧边栏 UI）：[`docs/M4-RESULTS.md`](docs/M4-RESULTS.md)
- 人格劫持防护说明：[`docs/PERSONA-GUARD.md`](docs/PERSONA-GUARD.md)
- 缓存节省测算：[`docs/CACHE-SAVINGS.md`](docs/CACHE-SAVINGS.md)
- 插件详情页文案：[`docs/DETAIL.md`](docs/DETAIL.md)
- 模块契约：[`CONTRACT.md`](CONTRACT.md)
- 贡献流程与不可协商的规则：[`CONTRIBUTING.md`](CONTRIBUTING.md)
- 许可证：[`LICENSE`](LICENSE)

前置验证取自 DSH `0.2.2-rc.3`，M1/M2 端到端跑在 `0.2.2-rc.5`（Desktop profile，Electron 44.7 + Node 24.21，
内置 SQLite 3.53.4）。

## 许可证

[MIT](LICENSE) © 2026 LSwzx。贡献即表示同意以同一许可授权。
