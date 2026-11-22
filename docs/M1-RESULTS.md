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

## 复现方式

```powershell
cd D:\dshprogram\dsh-context-array
node --test                                  # 54 项单测
node docs\analyze-usage.mjs                  # 汇总真实 usage.jsonl
Get-Content "$env:USERPROFILE\.dsh\context-array\usage.jsonl" -Tail 5
```

插件安装后任意新会话或任意一次模型请求都会落一行记录；`prefixDigest` 相同即前缀未变。

## 局限

1. **只能拿到规范化 usage**。原始 provider JSON 不可达，`usageSource` 字段已标注。
2. **样本只有 2 个会话**（一个长历史、一个冷启动），且都来自同一个 Desktop profile；
   「多会话」在 M1 只覆盖到并发两会话，不是规模验证。
3. **本 profile 未启用 `compaction-basic`**，实测期间压缩没有发生，因此没有观测到
   「压缩导致前缀失效」的样本；文档 0.2-5 的压缩轮次标注仍是设计约定，未被实测覆盖。
4. 反复 disable/enable 会让 `systemMessageCount` 增长（每次有效提示词变化追加一份快照），
   这是本次实测的人为操作，不是正常运行时行为；正常使用下该值应稳定在 1–2。
