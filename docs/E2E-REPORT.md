# dsh-context-array 实机验证与 Token 收益报告

- 日期：2026-11-28
- 插件：**通联 - 多会话记忆插件**（npm `dsh-context-array`，本次验证版本 1.0.0 + 本地热修 1.0.1）
- 环境：DSH 0.2.2-rc.5，模型 `deepseek-flash`（provider `deepseek-official`），Windows
- 数据源：`~/.dsh/context-array/usage.jsonl`（逐请求上报，`usageSource=normalized-usage-chunk`）
- 原始数据：[`e2e-data.json`](e2e-data.json)（本报告所有数字可由该文件复算）

---

## 1. UI 修复：侧边栏名称

**问题**：`client.js` 里侧边栏 slot 的 `label` 硬编码为「记忆」，插件管理器/本地化标题改了也不影响侧边栏。

**修复**（[client.js](../client.js)）：

```js
ctx.slots.register(
  { name: 'sidebar.panellist', id: 'context-array', order: 40,
    label: () => '通联 - 多会话记忆插件' },
  SidebarIcon,
)
// 图标 aria-label 同步为「通联 - 多会话记忆插件」
```

**确认方式**（无法在本终端截图，故给可复现步骤）：

1. 刷新 Web 页面（客户端 bundle 在插件重载后重新拉起）。
2. 鼠标悬停左侧边栏最后一个图标：tooltip / 无障碍名称为「通联 - 多会话记忆插件」。
3. 侧边栏宽度较窄时文字会被截断显示，但完整名称在 tooltip 与读屏标签中；这是 DSH 侧边栏的既有宽度限制。
4. 插件管理器列表中的标题已由 `locale/zh.json` 的 `meta.title` 提供，同样为「通联 - 多会话记忆插件」。

> 版本说明：`1.0.0` 已发布到 npm；本次热修的侧边栏名称、E2E 中发现的两个 bug 已进入 **1.0.1**，需要再执行一次 `npm publish`（npm 账号开了 2FA，需要 OTP）。

---

## 2. 实机测试环境与 5 轮脚本

### 2.1 会话与空间

| 角色 | 会话 | 说明 |
|---|---|---|
| 管理员 | 本会话 `ef62b67e` | `adminSessionIds` 内，唯一写入方 |
| 主会话 | `e2e-main`（`eff3a653`） | 绑定 `space-e2e`；提交候选、读留言 |
| 子会话 1 | `e2e-sub1`（`9520a295`） | 绑定 `space-e2e`；混合检索 |
| 子会话 2 | `e2e-sub2`（`4ac1bb76`） | 绑定 `space-e2e`；提交候选、发留言 |

测试空间 `space-e2e`（名称「E2E 测试空间」，L4 规则文本「E2E 空间规则：仅用于插件端到端验收，规则在会话创建时冻结。」）。
三个会话均在自己的首轮里通过 `memory_bind` 绑定到 `space-e2e`。

### 2.2 五轮对话脚本（实际执行）

| 轮次 | 会话 | Prompt 脚本（要点） | 实际结果 |
|---|---|---|---|
| R1 | 主会话 | ① `memory_bind {"spaceId":"space-e2e"}` ② `memory_propose {"raw_content":"E2E 候选记忆 A：通联插件通过空间隔离与 L1-L4 前缀缓存降低多会话成本。","note":"E2E R1"}` | `PROPOSE_OK a05ceea2-…` |
| R2 | 管理员 | `memory_queue_claim` → 审阅候选 A → `memory_archive {content:A, dimension:"fact", spaceId:"space-e2e", queueId:a05ceea2}` | 归档 `d786f95a-…`，`embedded=true` |
| R3 | 子会话 1 | ① `memory_bind` ② `memory_search {"query":"E2E 候选记忆 空间隔离 前缀缓存","limit":3}` | `hits=1`，top1 正是记忆 A → 跨空间绑定 + 混合检索召回成功 |
| R4 | 子会话 2 | ① `memory_bind` ② `memory_propose {候选B}` ③ `inbox_send {"targetSessionId":"eff3a653…","content":"E2E 留言：来自子会话 2 的跨会话消息。","wake":false}` | 候选 B `0a00c041`；留言入队（wake=false，未唤醒）；管理员随后 `memory_queue_settle status=rejected`，`stats: pending=0 done=2 rejected=1` |
| R5 | 主会话 | ① `inbox_list {"status":"all","limit":5}` ② `inbox_ack {inboxId}` | `INBOX_OK count=1 from=4ac1bb76` → 跨会话留言箱闭环 |

### 2.3 功能覆盖

| 能力 | 覆盖轮次 | 结论 |
|---|---|---|
| 空间创建 / 会话绑定 | 准备阶段 + R1/R3/R4 | 通过（`space-e2e`，3 会话绑定） |
| 候选记忆提交（propose，不写库） | R1、R4 | 通过，两条候选入队 |
| 管理员审核 → 归档（含本地 embedding） | R2 | 通过，`embedded=true` |
| 管理员拒绝路径 | R4 管理员步骤 | 通过（`rejected`） |
| 队列统计 | R4 | 通过：`pending=0 processing=0 done=2 rejected=1 failed=0` |
| 混合检索（向量 + 关键词 + RRF） | R3 | 通过，跨会话召回记忆 A |
| 跨会话留言（排队，不唤醒） | R4 → R5 | 通过，`hop` 记录、读后 ack |
| 会话人格 / 角色段注入 | 全程 | 提示词中可见 `<context-array-personality>` 与管理员的 `role="admin"` 段 |
| 压缩折叠（fold） | 测试期间自动触发 | 管理员提示词从 ~726k 降到 ~156k（-78%），见 §4.3 |

### 2.4 E2E 中发现并修复的问题

1. **记忆工具全部丢失（P0）**：新增更新检测时把 `inboxTracker` 的创建放在了工具注册之后，`createMemoryTools` 读取未初始化的 `const` 触发 TDZ，注册整体被 `catch` 吞掉——表现为 `memory_search` 之外的管理员/留言工具全部不存在。已把 tracker 初始化提前到工具注册之前。
2. **`inbox_send` 返回值校验失败**：输出 schema 没声明 `hop`/`reason`，`additionalProperties:false` 导致工具执行成功但返回校验失败。已补齐 schema；留言本身仍正确入队（R5 已验证）。

---

## 3. Token 数据

### 3.1 采集口径

`usage.jsonl` 每条记录来自 DSH 的 usage chunk：`inputTokens`（未命中缓存的全价输入）、`cacheReadTokens`（命中缓存）、`outputTokens`。
统计窗口为 E2E 开始时间 `2026-11-28T05:37:33Z` 之后的全部请求（含管理员编排本测试产生的请求）。

### 3.2 实测汇总

| 会话 | 请求数 | prompt tokens | 未命中（miss） | 命中（cacheRead） | 命中率 | output |
|---|---:|---:|---:|---:|---:|---:|
| 管理员（本会话） | 33 | 18,209,636 | 85,604 | 18,124,032 | 99.53% | 10,015 |
| 主会话 e2e-main | 6 | 146,867 | 25,139 | 121,728 | 82.88% | 351 |
| 子会话 1 e2e-sub1 | 3 | 72,751 | 1,583 | 71,168 | 97.82% | 148 |
| 子会话 2 e2e-sub2 | 3 | 73,528 | 1,720 | 71,808 | 97.66% | 704 |
| **合计** | **45** | **18,502,782** | **114,046** | **18,388,736** | **99.38%** | **11,218** |

- 整体缓存命中率 **99.38%**；`prefixHit` 几乎恒为 1（仅折叠那一轮为 0）。
- L1–L4 前缀本身（`prefixTokens` 合计 884,656，`prefixHitTokens` 865k，命中率 **97.77%**）约为 19k/请求量级；
  大头是整段会话历史的缓存复用。

### 3.3 成本对比（价格假设）

DeepSeek 公开价近似（**人民币/百万 token**，可在 `e2e-data.json` 改参数复算）：

| 项目 | 单价 |
|---|---:|
| 未命中输入 | ¥2.0 / M |
| 命中输入 | ¥0.2 / M（= miss 的 10%） |
| 输出 | ¥3.0 / M |

| 方案 | 公式 | 费用 | 相对无缓存 |
|---|---|---:|---:|
| **实测：插件 + 缓存生效** | miss×2.0 + hit×0.2 + output×3.0 | **¥3.94** | **省 89.4%** |
| 理论：不使用插件（无前缀缓存，每轮全量按 miss 计费） | prompt×2.0 + output×3.0 | **¥37.04** | — |

- 节省：**¥33.10**（本次 45 个请求）。
- 若你的实际命中价为 miss 的 25%：实测 ¥9.46，仍省 74.5%；若为 50%：实测 ¥18.65，省 49.6%。

**L1–L4 前缀专项**：前缀合计 884,656 token。无缓存需 ¥1.77；缓存后 ¥0.21；前缀这一项省 **¥1.56（88.0%）**。
前缀在总 prompt 中占比不大（<5%），所以**总账的 89% 节省主要来自整段历史复用**；L1–L4 的作用是让前缀稳定、不被打穿（`prefixHit=1`），从而让整段前缀可缓存——两者叠加才是上表的结果。

### 3.4 压缩折叠的观测

测试期间管理员触发一次 `compactionMode: fold` 折叠：prompt 从 ~726k 降至 ~156k（-78%），`history/replace` 事件可审计。
折叠本身带来一次前缀失效（那一轮 prefixHit=0），之后重新建立缓存——这是设计中已接受的一次性代价，已包含在实测成本中。

---

## 4. 结论与建议

1. **功能链路全部打通**：propose → 管理员 claim/archive → 跨会话检索 → 留言排队/读取/ack → 拒绝路径与队列统计，5 轮全部按预期。
2. **缓存收益显著**：本次实测 ¥3.94 vs 无缓存 ¥37.04，节省 89.4%；在保守价（hit=50%）下仍节省约一半。
3. **插件自身开销可控**：每请求固定注入约 19k token 的 L1–L4 前缀（系统+工具声明为主），一旦缓存命中只按命中价计。
4. **管理员会话是成本主体**：本次 45 个请求中管理员占 33 个、18.2M prompt，主要因为编排过程本身在长会话里；实际日常使用中管理员轮次远少于这个密度。
5. **待办**：
   - 发布 1.0.1（含侧边栏名称、TDZ、`inbox_send` schema 修复；需要 OTP）。
   - 面板仍缺分页（记忆 >100 条时只显示前 100）。
   - 建议把管理员编排/测试类请求与业务请求在报表中分开统计，避免把"测试开销"计入产品收益。

> 预算说明：按上述计价，本次 E2E 实测费用约 **¥3.94**，在分配的 ¥8 以内；若你的实际单价不同，用 `e2e-data.json` 的 `priceAssumption` 重算即可。
