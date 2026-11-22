# Context array（上下文阵列）

面向 DeepSeek Harness（DSH）的**本地五维记忆**插件，围绕一条硬规则构建：
**绝不重写被缓存的前缀**。动态内容一律追加在已缓存历史之后，静态内容只在拼装阶段注册。

当前仓库包含设计文档
[`dsh-context-array-v4.1.md`](dsh-context-array-v4.1.md) 里程碑 **M1** 的完整实现，
以及端到端实测记录 [`docs/M1-RESULTS.md`](docs/M1-RESULTS.md)。

> **状态**：M1 已实现并在真实会话中跑通。
> **M0 第六项（压缩接管）尚未验证**，它是 M2 的开工前提——DSH 自带压缩会在阈值处
> 原地替换历史，替换点之后缓存必然失效；不收编它，这套架构的前提当场作废。

## M1 实现了什么

| 组成 | 文件 | 行为 |
|---|---|---|
| L1/L3/L4 提示词段 | `src/prompt.js`、`index.js` | L1（基础规则）与 L3（角色规则）是全局静态段；L4（空间规则）按会话作用域注册，文本来自每会话快照——改空间描述不会改写已存在会话的系统节点。L2 是请求里的工具声明，不归本插件注册。 |
| 静态存储 | `src/db.js` | 用运行时自带的 `node:sqlite`（无需原生编译）：空间、会话绑定、五维记忆、FTS5 `trigram` 索引与外部内容表触发器、inbox、记忆队列、L4 快照、唤醒日志。 |
| usage 观测 | `src/observer.js` | 包裹 `llm/stream` waterfall，原样透传每个分块，同时为每个请求写一行 JSONL：规范化 `usage`、`hitRate`，以及 `systemDigest` / `systemDigestAll` / `toolsDigest` / `prefixDigest`。 |
| 追加层 | `src/append.js`、`index.js` | 每个新会话注入一条 bootstrap 快照，走 `agent.inject()`：排队到下一次 `agent/pre-step`，不唤醒 Agent，也不碰已缓存前缀。 |

## 三条最容易搞混的口径

1. **`prefixDigest` 只覆盖"系统节点 0 + 工具声明"**，不是整段 L1–L4 的哈希。
   DSH 在 `systemPromptUpdate: 'in-history'` 路由上会把变化后的提示词**追加**为新的
   `system` 消息，节点 0 不变——所以还要看 `systemMessageCount`（是否变多）与
   `systemDigestAll`（有效提示词是否变了）。
2. **命中率必须双轨**：
   - `prefix_hit = 命中的 L1–L4 token / L1–L4 总长` —— 这才是架构指标（目标 ≥ 95%）；
   - `whole_hit = cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)` —— 只是成本参考。
   只报 `whole_hit` 会得到假数据：L5 每轮追加时它天然很高，掩盖前缀其实没被保护。
   **当前代码只算了 `whole_hit`，`prefix_hit` 尚未实现（M1-4）。**
3. **缓存前提尚未实测**：DeepSeek 缓存有 TTL（小时级，不是永久），跨会话复用要求同一账号 /
   同一 key。这两条写进了验收条件，但还没跑过验证。

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
| `dataDir` | `<home>/.dsh/context-array` | SQLite 库与 `usage.jsonl` 的目录 |
| `spaceId` / `spaceName` / `spaceRules` | `space-default` / `Default space` / … | 首次激活时创建的单一静态空间 |
| `observeUsage` | `true` | 每个上报 usage 的请求写一行记录 |
| `bootstrapMessages` | `true` | 每个新会话注入一条 bootstrap 快照 |

## 验证

```powershell
node --test                              # 单元 + 接线测试（54 项）
node docs/analyze-usage.mjs              # 汇总已抓到的 usage 日志
Get-Content "$env:USERPROFILE\.dsh\context-array\usage.jsonl" -Tail 3
```

每个请求一行，字段含义见 [`docs/DETAIL.md`](docs/DETAIL.md)。

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
- 本 profile 未启用 `compaction-basic`，实测期间**没有压缩样本**；压缩接管（M0-6）未验证。
- 样本只有 2 个会话，不是规模验证；`prefix_hit`、缓存 TTL、同账号前提均待补测（M1-4）。
- embedding / 检索 / 记忆管理员 / 留言箱属于 M2–M4，尚未实现；M2 第一个实验是
  "在 worker 或子进程里加载 `multilingual-e5-small` 并输出一条 384 维向量"，
  因为 onnxruntime 的 CPU 推理是同步阻塞的，放主进程会卡死整个 Host。

## 文档

- 设计文档（含第 0 节六项前置验证、L1–L5 分层、压缩接管）：[`dsh-context-array-v4.1.md`](dsh-context-array-v4.1.md)
- M1 实测记录：[`docs/M1-RESULTS.md`](docs/M1-RESULTS.md)
- 插件详情页文案：[`docs/DETAIL.md`](docs/DETAIL.md)
- M1 实现的模块契约：[`CONTRACT.md`](CONTRACT.md)

前置验证取自 DSH `0.2.2-rc.3`，M1 端到端跑在 `0.2.2-rc.5`（Desktop profile，Electron + Node 24.21，
内置 SQLite 3.53.4）。

## 许可证

MIT
