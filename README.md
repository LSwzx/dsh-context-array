# Context array（上下文阵列）

面向 DeepSeek Harness（DSH）的**本地五维记忆**插件，围绕一条硬规则构建：
**绝不重写被缓存的前缀**。动态内容一律追加在已缓存历史之后，静态内容只在拼装阶段注册。

当前仓库包含设计文档
[`dsh-context-array-v4.1.md`](dsh-context-array-v4.1.md) 里程碑 **M1** 的实现、
**M0-6 压缩接管机制**、**M1-4 双轨缓存指标**，以及端到端实测记录
[`docs/M1-RESULTS.md`](docs/M1-RESULTS.md)。

> **状态**：M1 已跑通；M0-6 的"接管"已验证（能认领 `ctx.compaction`、能看到压力），
> 但**折叠策略未实现**，`observe` 模式下不会发生压缩；M1-4 双轨指标已上线。
> **两个受控实验把"前缀被改动打穿"这条风险基本排除了**：本机这条 `in-history` 路由上，
> 改提示词不会重写系统节点 0（变化作为追加 `system` 消息进历史）；运行期增删工具也不会改动
> 请求的声明块（变化以 `developer` 消息的 `tool-addition`/`tool-removal` 追加），`prefixHit`
> 全程为 1。真正能改写前缀的只剩：非 in-history 路由、新序列起点的声明块变化、压缩替换。
> 所以**压缩折叠是接下来唯一的主要收益/风险点**。

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
| 压缩接管 | `src/compaction.js` | `compactionMode: observe` 时用 `ctx.provide('compaction', …)` 认领 seam，记录压力采样，**从不折叠**；同时侦测任何 `surfaceOp: replace` 并写入 `events.jsonl`。 |

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

在 DSH 图形界面打开 **插件 → 添加插件（Plugins → Add plugin）**，选择本目录
（`D:\dshprogram\dsh-context-array`）。安装是"链接检出目录"的方式，后续改动不需要重新拷贝；
运行中的 Host 在插件行被切换或 DSH 重启后加载新代码。

> `package.json` 里的 `dsh.bundle.patch` 指向同目录 `cordis.patch.yml`，它插入一条
> `context-array` 插件行。

## 配置

`cordis.patch.yml` 的配置项：

| 键 | 默认值 | 含义 |
|---|---|---|
| `dataDir` | `<home>/.dsh/context-array` | SQLite 库、`usage.jsonl`、`events.jsonl` 的目录 |
| `spaceId` / `spaceName` / `spaceRules` | `space-default` / `Default space` / … | 首次激活时创建的单一静态空间 |
| `observeUsage` | `true` | 每个上报 usage 的请求写一行记录 |
| `bootstrapMessages` | `true` | 每个新会话注入一条 bootstrap 快照 |
| `compactionMode` | `observe` | `off` 不动部署；`observe` 认领 `ctx.compaction` 但**永不折叠**（实测模式） |
| `compactionWarnTokens` | `300000` | `observe` 模式下压力采样阈值（token） |
| `promptSaltFile` | `<dataDir>/prompt-salt.txt` | 诊断用：改这个文件可在观测层不停的情况下改 L1，做缓存受控实验 |

> ⚠️ `observe` 会占用 `ctx.compaction`。**如果部署里还要启用 `dsh-compaction-basic`，请先把它
> 关掉，或把本项设为 `off`**，否则两个实现者会冲突（插件会记 `compaction/provider-conflict`，
> 默认实现加载失败）。

## 验证

```powershell
node --test                              # 单元 + 接线测试（73 项）
node docs/analyze-usage.mjs              # 双轨指标 + TTL 空档 + 压缩事件
Get-Content "$env:USERPROFILE\.dsh\context-array\usage.jsonl" -Tail 3
Get-Content "$env:USERPROFILE\.dsh\context-array\events.jsonl" -Tail 3
```

每个请求一行，字段含义见 [`docs/DETAIL.md`](docs/DETAIL.md)；`events.jsonl` 记录接管、
压力采样与历史替换。

## 实测结果（整段口径，样本 = 2 个会话 / 98 条请求）

| 会话 | 请求数 | 不同 `prefixDigest` | 命中率 min / mean / max | 累计命中 |
|---|---|---|---|---|
| 长历史会话 | 49 | **1** | 0.9933 / **0.9986** / 0.9996 | 99.86%（17,932,672 / 24,523） |
| 冷启动会话 | 49 | **1** | 0 / 0.9534 / 0.9987 | 97.92% |

`prefixDigest` 每个会话全程只有 1 个值，说明**节点 0 + 工具声明确实逐字节不变**，
这是前缀可复用的证据；命中率数字本身**不能**当作架构验收（见上面第 2 条）。

实测还暴露并修掉了两个真缺陷：

1. **安装前已存活的会话收不到 `agent/created`**，因此拿不到 L4、也收不到 bootstrap。
   修复：激活时遍历 `ctx.get('agents')?.list()` 补做一次。
2. **agent 作用域的段注册不随插件卸载撤销**（禁用插件后 L4 仍残留在提示词里）。
   修复：把每个 L4 段的 disposer 收进插件 fiber 的 `ctx.effect`，并监听 `agent/disposed`。

## 已知边界

- 插件只能拿到适配器折算后的规范化 `TokenUsage`，**原始 provider usage JSON 不可达**；
  记录以 `usageSource: "normalized-usage-chunk"` 标注。
- **压缩只验证了"接管"，没验证"折叠"**：`observe` 模式认领 seam 但不折叠；本 profile
  本来也没有 `compaction-basic`，所以行为与接管前一致。真正折叠需要调用表层替换 API，
  尚未实现。
- **前缀改写后命中不跌的反常现象待复核**（工具数 62→63、节点 0 消失后恢复，`cacheRead`
  仍 ≈ 495k）。受控实验（只改节点 0 一段文本、观测层不断）尚未做；在它出结果前，
  "改前缀必失效"不是已证事实。
- 双轨指标只有 **8 个样本**（同一天、同一会话新代码加载后），`prefixTokens` 是字符启发式
  估算而非 provider 真值。
- 样本不是规模验证；跨会话同账号复用、压缩折叠成本均未测。
- embedding / 检索 / 记忆管理员 / 留言箱属于 M2–M4，尚未实现；M2 第一个实验是
  "在 worker 或子进程里加载 `multilingual-e5-small` 并输出一条 384 维向量"，
  因为 onnxruntime 的 CPU 推理是同步阻塞的，放主进程会卡死整个 Host。

## 文档

- 设计文档（含第 0 节六项前置验证、L1–L5 分层、压缩接管）：[`dsh-context-array-v4.1.md`](dsh-context-array-v4.1.md)
- M1 实测记录：[`docs/M1-RESULTS.md`](docs/M1-RESULTS.md)
- 插件详情页文案：[`docs/DETAIL.md`](docs/DETAIL.md)
- M1 实现的模块契约：[`CONTRACT.md`](CONTRACT.md)
- 贡献流程与不可协商的规则：[`CONTRIBUTING.md`](CONTRIBUTING.md)
- 许可证：[`LICENSE`](LICENSE)

前置验证取自 DSH `0.2.2-rc.3`，M1 端到端跑在 `0.2.2-rc.5`（Desktop profile，Electron + Node 24.21，
内置 SQLite 3.53.4）。

## 许可证

[MIT](LICENSE) © 2026 LSwzx。贡献即表示同意以同一许可授权。
