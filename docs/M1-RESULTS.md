# M1 实测记录（端到端）

> **口径警告（v4.1.4 补）**：本文件记录的是**整段命中率**（`whole_hit = cacheRead / (input + cacheRead + cacheWrite)`）。
> 它**不是**这套架构的验收指标：L5 每轮追加、L1–L4 不变时，整段命中率天然很高，会掩盖"前缀其实没被保护"。
> 真正的架构指标是 `prefix_hit = 命中的 L1–L4 token / L1–L4 总长`，尚未测量（见设计文档 M1-4）。
> 另外两条前提也**未实测**：缓存 TTL（小时级，非永久）与跨会话复用要求同一账号。M1 的数字只说明"在本机连续会话中，前缀确实没变且缓存被复用"。

本文件记录 `dsh-context-array` M1 切片在真实 DSH 会话中的实测结果，对应设计文档
[`dsh-context-array-v4.1.md`](../dsh-context-array-v4.1.md) 第 0 节与第 6 节 M1 的三步
（M1-1 真实 usage、M1-2 命中率、M1-3 多会话稳态）。所有命中率均为**整段口径**。

- 环境：实测实例 DSH `0.2.2-rc.5`（Desktop profile，Electron + Node 24.21.0，内置 SQLite 3.53.4）；第 0 节取数时同一安装读到的是 `0.2.2-rc.3`，本会话中途 DSH 重启/更新过一次
- 日期：2026-11-21
- 数据来源：`%USERPROFILE%\.dsh\context-array\usage.jsonl`（插件自身写入），已由
  [`analyze-usage.mjs`](analyze-usage.mjs) 汇总
- 撰写时快照：**98 条请求记录 / 2 个会话**（日志随会话持续增长，复现时数字会更大）

## M1-1 真实请求的 usage

真实路由：`provider=deepseek-official`、`model=deepseek-flash`（Messages 协议）。

一条真实记录（节选，原样来自 `usage.jsonl`）：

```json
{
  "schema": 1,
  "at": "2026-11-21T13:36:58.692Z",
  "sessionId": "ef62b67e-09a8-4f18-9424-c7b3aa449cef",
  "provider": "deepseek-official",
  "model": "deepseek-flash",
  "messageCount": 330,
  "toolCount": 62,
  "systemMessageCount": 1,
  "systemDigest": "3d4e11cfcd354398235719ce99479ff48286c3ca419ab42a9a8cff6fc8f339d8",
  "toolsDigest": "17ec6ecce533cef1c68227b5f7fba13cbac266ccf51511296c6df3883291f607",
  "prefixDigest": "75230294264b8cbc4c3a55aae413a686100f3e75f0255723fa92fb459dc50dfa",
  "usage": { "inputTokens": 2249, "outputTokens": 491, "cacheReadTokens": 332288, "cacheWriteTokens": 0, "totalTokens": 335028 },
  "hitRate": 0.993277,
  "inputTokens": 2249,
  "cacheReadTokens": 332288,
  "cacheWriteTokens": 0,
  "usageSource": "normalized-usage-chunk"
}
```

结论（修正文档 0.1-② 的待定项）：

1. **能拿到缓存命中数**，但拿到的是规范化字段 `TokenUsage.cacheReadTokens`，不是任何原始
   provider 字段。插件侧看不到 `prompt_cache_hit_tokens` / `cache_read_input_tokens` 的
   原始 JSON —— 适配器消费后只暴露 `TokenUsage`。
2. 本路由 **`cacheWriteTokens` 恒为 0**，实测 28 条全部为 0；因此命中率分母实际是
   `inputTokens + cacheReadTokens`。这与 `dsh-llm-deepseek` 读取 `cache_read_input_tokens`
   的代码路径一致（Messages 协议无 cache-creation 计数）。
3. `usage` 里带有 `totalTokens`，且满足
   `totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`（首条：
   2249 + 491 + 332288 + 0 = 335028）。

## M1-2 命中率与前缀摘要

命中率公式：`cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)`。

长会话（`ef62b67e…`，历史 330+ 条消息）49 次请求：

| 指标 | 值 |
|---|---|
| 不同 `prefixDigest` 数 | **1**（全程不变） |
| 命中率 min / mean / max | 0.9933 / **0.9986** / 0.9996 |
| 累计 cacheRead / 未命中输入 | 17,932,672 / 24,523 token（合计命中 **99.86%**） |

新会话（`419514ec…`，冷启动）49 次请求：

| 指标 | 值 |
|---|---|
| 不同 `prefixDigest` 数 | **1** |
| 首请求命中率 | 0（无缓存可复用，22440 输入 token 全价） |
| 后续 min / mean / max | 0.7812 / 0.9534 / 0.9987（累计命中 97.92%） |

两会话合计稳态（命中率 ≥ 0.5 的 97 条）：mean **0.9861**、min 0.7812、max 0.9996。
**远高于文档设定的 70% 阈值。** 新会话命中率偏低只是历史尚短（可复用前缀太小），
与设计无关。

`prefixDigest` 全程恒定（每个会话各 1 个值）证明：渲染后的系统节点（第 0 号节点）与
工具声明在整段会话里逐字节不变 —— 这正是 L1–L2 前缀可复用的充分证据。

## 实测中发现的真实行为与两个缺陷

### 行为：提示词变更走 `in-history` 追加，节点 0 不变

长会话的 `systemDigest`（第 0 号节点）全程为 `3d4e11cf…` 不变，但 `systemMessageCount`
从 1 涨到 **6**，`systemDigestAll` 也随之为新值 —— 说明 L4 段加入、以及插件反复
disable/enable 造成的有效提示词变化，**都是追加新的 `system` 消息，而不是重写节点 0**。
实测取数：

```
13:38:59  sys=3d4e11cf  sysAll=a85dbe57  sysMsgs=6  hit=0.995253
```

这印证了文档 0.2-3 的结论（`systemPromptUpdate: 'in-history'`），也给出一个代价：
**每个保留的提示词版本会持续计入 token，直到压缩遮蔽它**。因此插件必须避免无意义的
提示词抖动（重复注册同一段文本不会产生事件，但如果文本真的变了就会留一份新快照）。

### 缺陷 1：安装前已存活的会话拿不到 L4

`agent/created` 只在 Agent 创建时触发。插件安装时已经 live 的会话（包括安装当时的
本会话）不会收到该事件，于是只有全局 L1/L3、没有 L4，也收不到 bootstrap。
**修复**：`apply()` 末尾遍历 `ctx.get('agents')?.list()`，对已存活 Agent 补做同样流程
（见 `index.js` 的 live-agent sweep）。实测：修复并重新激活后，本会话的
`session_l4_snapshot` 与 `session_bootstrap` 立即补上，`<context-array-spaces>` 出现在
下一轮请求的系统提示词里。

### 缺陷 2：agent 作用域的段注册不随插件卸载撤销

`agent.ctx.systemPrompt.section()` 注册在 Agent 自己的上下文上。禁用插件后实测发现：
全局 L1/L3 消失，但 **`<context-array-spaces>`（L4）仍然留在提示词里** —— 段注册没有
挂在插件 fiber 上，卸载插件不会撤销。
**修复**：把每个 L4 段的 disposer 收进插件 fiber 的 `ctx.effect`（`agent/disposed` 时
提前释放），卸载插件即撤销。修复后单测覆盖了「卸载后 L4 消失」。

> 已知残留：修复前产生的那条 L4 注册已随旧 fiber 一起丢失 disposer，本会话会保留它
> 直到该 Agent 销毁或 DSH 重启。文本与当前实现一致，不影响正确性。

## M1-4 双轨指标与 M0-6 压缩接管（2026-11-22）

这一天的工作补上了 v4.1.4 列出的两个阻塞项。结论如下，先给最重要的三条：

1. **双轨指标已实现**：每个请求记录 `prefixHit / prefixTokens / prefixHitTokens / wholeHit`。
2. **缓存存活时间远超假设**：会话空闲 **13.5 小时**后第一次请求仍然命中（`cacheReadTokens`
   396,544，`wholeHit` 0.9974），2.4 小时那次也命中。文档里"TTL 小时级"的写法偏保守。
3. **出现一个必须复核的反常现象**：工具声明从 62 个变成 63 个（`toolsDigest` 变了、
   `prefixDigest` 跟着变），以及"禁用插件→重新启用"（系统节点 0 先消失再恢复）之后，
   下一次请求的 `cacheReadTokens` **依然远大于整个 `prefixTokens`**（例如
   `cacheRead=495,616` vs `prefixTokens=17,957`）。按"最长连续前缀匹配"的假设，前缀改动
   应当让命中跌到工具声明那一段（约 16k）甚至接近 0，**实测没有跌**。在把这个现象查清
   之前，文档 0.2-3 / 2 节规则 4 里"改前缀必失效"的推论都只能算未证实。

### 指标定义与实现

```text
prefixTokens    = estimate(系统节点 0) + estimate(工具声明)   # 都是 DSH 固定启发式：4 字符/token + 固定开销
prefixHitTokens = min(prefixTokens, cacheReadTokens)          # provider 命中是最长前导匹配
prefixHit       = prefixHitTokens / prefixTokens
wholeHit        = cacheRead / (input + cacheRead + cacheWrite)
```

实测的 `prefixTokens ≈ 17,957`，其中**系统节点 1,833、工具声明 16,124 —— 工具占 89.8%**。
也就是说这套架构真正要保护的前缀，绝大部分是工具声明，而不是我们写的 L1–L4 文本；
优化前缀长度时应该先看工具面。

### 实测数字

- 新代码加载后共 **8 个请求**（长会话 `ef62b67e…`）带双轨字段：
  `prefixHit` min/mean/max = **1 / 1 / 1**（0 个部分命中），
  `wholeHit` 0.9955 / 0.9978 / 0.9994，
  `cacheReadTokens - prefixTokens` 的最小余量 **477,659**。
- **TTL 探针**（日志空档分析）：间隔 808 分钟与 146.5 分钟后的首请求都命中了。
  → 该路由/账号下缓存存活 **≥ 13.5 小时**。"小时级 TTL"不再是风险假设。
- **跨会话/同账号**：另一个会话（子代理）首请求 `cacheRead=0`，但它的系统提示词与主会话
  不同（子代理上下文），因此**不能**用它判定"同账号跨会话复用"；需要两个前缀完全一致的
  会话做受控实验，尚未做。

### M0-6 压缩接管：机制已验证，折叠策略未实现

- 插件新增 `compactionMode: off | observe`。`observe` 会用
  `ctx.provide('compaction', 实现)` 认领 seam，`compactIfNeeded` / `compactNow` 只记录、
  **永远返回 `null` 不折叠**；`compactRegion` 直接抛"未实现"。
- 实测事件（`events.jsonl`）：

  ```json
  {"type":"compaction/provider-installed","mode":"observe"}
  {"type":"compaction/pressure","sessionId":"ef62b67e…","pressureTokens":495613,"contextWindow":1048576,"warnTokens":300000}
  ```

  → 本 profile 里 `compaction-basic` 未加载，所以 `ctx.provide` 没有冲突，接管成功；
  每轮 pre-step 都能读到压力（约 47% 窗口）。**折叠策略没有实现**，所以 `observe` 期间
  不会发生任何压缩——与接管前的现状一致（该 profile 本来就没有实现者）。
- 任何 `surfaceOp: replace` 事件都会被 `history/replace` 记录，用于把"前缀被重写"的
  轮次从稳态统计里剔除；实测期间该计数为 **0**，说明没有发生压缩或剪枝。

### 受控实验（`promptSalt`）：结论是"这个路由不会重写节点 0"

实现：L1 文本改成在**每次拼装时**读 `<dataDir>/prompt-salt.txt` 的 provider（文件不存在时
与静态文本逐字节相同），这样改文件就能改提示词，而**观测层始终在跑**。

实验步骤与结果（同一会话 `ef62b67e…`，全程 `prefixTokens = 17,957`）：

| 时刻 | 动作 | `systemDigest`（节点 0） | `systemDigestAll` | `systemMessageCount` | `cacheReadTokens` | `prefixHit` |
|---|---|---|---|---|---|---|
| 06:56:18 | 基线（无 salt） | `3d4e11cf` | `663d6890` | 10 | 543,360 | 1 |
| 06:56:26 | 写入 salt=A 前的请求 | `3d4e11cf` | `f29746a4` | 12 | 545,664 | 1 |
| 06:56:30 | salt=A 生效 | `3d4e11cf` | `0fa2f32a` | 13 | 547,712 | 1 |
| 06:56:49 | salt=A 稳定 | `3d4e11cf` | `0fa2f32a` | 13 | 549,760 | 1 |

**节点 0 从头到尾没变**（`systemDigest` 恒为 `3d4e11cf`），变的只有 `systemDigestAll` 与
`systemMessageCount`。也就是说：在这条 `in-history` 路由上，渲染后的提示词（含我们的
L1/L3/L4 与新增的 salt）是**作为追加的 `system` 消息**进入历史的，**不会重写节点 0**。

这条结论比原来那个"反常现象"更精确，也修正了文档里的一个隐含错误：

1. **"改提示词会打穿前缀"在这个路由上基本不成立**——DSH 的协调逻辑会追加而不是改写节点 0。
   真正能把节点 0 改掉的只剩：不具备 `systemPromptUpdate` 的路由、新请求序列开始且有效文本
   不同、以及压缩的表层替换（`surfaceOp: replace`）。
2. **这个会话的 L1–L4 其实不在节点 0 里**（会话在插件安装前就存在，节点 0 是原始基础提示词；
   我们的段以 in-history 快照形式追加）。对**新会话**才是"段进入节点 0"。因此
   `prefixHit` 的分母（节点 0 + 工具）测的是"基础提示词 + 工具"这段，而不是"我们的段"。
3. 之前"工具数 62→63 而命中不跌"的现象因此**仍未被解释**（那是唯一一次真正动了请求前部
   字节的改动）。要干净地测它，需要一次可控的工具增删（例如启用/停用一个带工具的插件），
   留待下一轮。

**对收益模型的影响**：由于该路由不会因提示词变化重写节点 0，"前缀被自己的提示词改动打穿"
这条成本路径在正常使用下几乎不存在；收益模型应主要覆盖**压缩折叠**与**工具集变更**两类
真实破坏源。按真实日志估算的节省见 [`CACHE-SAVINGS.md`](CACHE-SAVINGS.md)。

### 工具集变更实验（干净对照：只增删一个工具，观测层不动）

做法：运行期启用/停用 `include:tool-todo`（只改工具集，不碰本插件，观测层全程在线）。

| 时刻 | 动作 | 宿主工具数 | 请求 `toolCount` | `toolsDigest` | `cacheRead` | `input` | `prefixHit` |
|---|---|---|---|---|---|---|---|
| 07:02:36 | 基线（未加工具） | — | 63 | `c2588914` | 567,296 | 200 | 1 |
| 07:02:44 | 启用 `tool-todo` 后首请求 | 64（含 `todo_write`） | 63 | `c2588914` | 569,216 | 170 | 1 |
| 07:02:53 | 加入工具后的下一步 | 64 | 63 | `c2588914` | 570,496 | **11,106** | 1（wholeHit 0.9809） |
| 07:03:08 | 停用 `tool-todo` 后 | 63 | 63 | `c2588914` | 583,296 | 202 | 1 |

结论：

1. **运行期增删工具不会改写请求里的"已声明工具集"**。宿主工具列表 63↔64 变化，但
   `llm/stream` 收到的 `options.tools` 数量与 `toolsDigest` **全程不变**、`cacheRead`
   一直上升、`prefixHit` 恒 1。说明在这条 `addition-only` 路由上，工具变化是作为
   `developer` 消息里的 `tool-addition` / `tool-removal` 块**追加进历史**的，声明块不变。
2. **一次工具增/删的一次性成本 ≈ 11k token 未命中**（那一请求 `input=11,106`，
   `wholeHit` 从 0.9994 降到 0.9809），一次性、后续立刻恢复命中。
3. 之前"62→63 而命中不跌"的记录点，现在可以解释为**新请求序列起点刷新了声明块**，
   且该次刷新没有造成可见的缓存损失——但"序列起点改声明块是否必然打穿"仍没有被单独隔离
   出来（需要两个新会话、前缀不同才能真正对照）。这一点保留为残余问题，不影响主结论：
   **正常使用中，提示词与工具的变化都不会以我们预期的方式打穿缓存。**

## 复现方式

```powershell
cd D:\dshprogram\dsh-context-array
node --test                                  # 74 项单测
node docs\analyze-usage.mjs                  # 双轨指标 + TTL 空档 + 压缩事件
node docs\savings-estimate.mjs               # 按真实日志估算节省
Get-Content "$env:USERPROFILE\.dsh\context-array\usage.jsonl" -Tail 5
Get-Content "$env:USERPROFILE\.dsh\context-array\events.jsonl" -Tail 5
```

插件安装后任意新会话或任意一次模型请求都会落一行记录；`prefixDigest` 相同即"节点 0 +
工具声明"未变；`events.jsonl` 记录接管、压力与历史替换。

## 局限

1. **只能拿到规范化 usage**。原始 provider JSON 不可达，`usageSource` 字段已标注。
2. **双轨指标只有 8 个样本**（同一会话、同一天新代码加载后），且 `prefixTokens` 是字符
   启发式估算，不是 provider 真值；`prefixHit` 依赖"命中=最长前导匹配"的假设，而该假设
   正被上面那个反常现象挑战。
3. **压缩接管只验证了"能认领"，没有验证"能折叠"**：折叠策略（何时、折哪段、摘要怎么生成）
   尚未实现；`observe` 模式下长会话不会被压缩。
4. TTL 只观测到"≥ 13.5 小时仍有命中"，没有测到失效边界；跨会话同账号复用未做受控实验。
5. 反复 disable/enable 会让 `systemMessageCount` 增长（每次有效提示词变化追加一份快照），
   这是本次实测的人为操作，不是正常运行时行为。
