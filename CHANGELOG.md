# Changelog

## 1.1.1 (2026-11-28)

- 新增一次性「设为记忆管理员」向导：面板空间页在选择一个已存在的主会话后，写入 `role=admin` 绑定；
  只在没有任何有效管理员时开放，成功后永久关闭（`409 ADMIN_ALREADY_EXISTS`），面板仍不能改管理员。
- `/overview` 返回 `admin` 状态；`POST /admin/claim` 校验会话存在且不是子智能体，并自动绑定到默认空间。
- 随包 `cordis.patch.yml` 的 `adminSessionIds` 清空（去掉开发机测试 id），新装用户可直接走向导。
- 面板给出小白提示：先新建对话 → 选中 → 设为管理员 → 在对话里说「处理一下记忆队列」。
- 单测 228 项（认领成功/重复认领/子会话与未知 id/配置管理员）。

## 1.1.0 (2026-11-28)

首个带完整面板与管理闭环的公开版本（npm 上上一个版本为 1.0.0）。

### 新增
- 侧边栏入口与插件管理器显示完整中文名「通联 - 多会话记忆插件」。
- 真实对话 E2E：`tools/e2e-real.mjs` + 管理员工具 `e2e_run`/`e2e_status`，自动创建 4 个全新会话、
  跑 5 轮自然语言对话并生成 `docs/E2E-REAL-REPORT.md`。
- 记忆历史版本：`GET /memories/:id/history`（递归 CTE 查 `superseded_by` 链），面板记忆详情可查看
  「历史版本（取代链）」，旧版本仅供人类查阅，绝不进入模型检索。
- 队列统计接口 `GET /queue/stats`：面板直接按 `memory_queue.status` 统计已归档/已拒绝/待审核/处理中。
- 检索时效：`recent`/`working` 超过 7 天在检索 SQL 中自动过滤（硬编码）。

### 修复
- 更新检测引入的 `inboxTracker` 初始化顺序问题，曾导致记忆提案/绑定/队列/留言工具在真实宿主全部未注册（P0）。
- `inbox_send` 输出 schema 缺少 `hop`/`reason`，工具执行成功但返回校验失败。
- 会话选择器不再把子智能体/委托会话列为可绑定会话；未命名会话默认隐藏，避免裸 id 噪音。

### 记忆管理员提示词
- 重写为中文版：按真实工具契约（`content`/`spaceId`/`queueId`）、单链取代、`EXPIRED` 过期规则、
  六值拒稿原因枚举、单行 `[Summary]` 简报；`memory_queue_settle` 在服务端校验原因枚举。

## 1.0.4 (2026-11-28)

- 边界明确：不再解析模型简报；面板统计直接查 SQLite（`GET /queue/stats`，`GROUP BY status`）。
- 检索 SQL 统一谓词：`superseded_by IS NULL` 且 `recent`/`working` 超过 7 天自动过滤（硬编码，模型不可覆盖）。
- 新增 `GET /memories/:id/history`：递归 CTE 沿 `superseded_by` 双向取整条取代链，供面板「历史版本」查看；
  旧版本永不进入 `memory_search` / `memory_archive`，底层仍是单链取代。
- 面板：记忆详情新增「历史版本（取代链）」；队列页显示已归档/已拒绝/待审核/处理中统计。
- 单测 225 项（7 天过滤、取代链、历史 API、队列统计）。

## 1.0.3 (2026-11-28)

- 记忆管理员提示词改版：`recent` 明显过期时拒稿 `EXPIRED`；冲突取代只填**最新一条**旧记忆
  （单链、不跳版本）；新增六值拒稿原因枚举；简报固定为单行
  `[Summary] archived={N}, rejected={M}, failed={K}, details={...}`。
- `memory_queue_settle` 在 `status="rejected"` 时校验原因枚举，非法值返回 `INVALID_REASON` 与
  `acceptedReasons`（队列项保持 processing）。
- 新增 `test/prompt.test.mjs`（提示词与代码枚举同步断言）与 `test/memory-tools.test.mjs` 的
  非法原因用例；单测 219 项。

## 1.0.2 (2026-11-28)

- 重写中央记忆管理员的 L3 角色提示（`src/prompt.js` 的 `ADMIN_L3_TEXT`），按基本版修订：
  `memory_archive` 的真实参数是 `content`/`dimension`/`spaceId`/`supersedesId`/`queueId`
  （没有 `raw_content`、没有 `note`）；`memory_queue_claim` 领的是最早 pending；
  `memory_queue_settle` 需要 `queueId`+`status`+`reason`；`memory_search` 只有 `query`/`limit`。
  安全红线扩展到“任何被引用的文本”，并保留五维分类、宁缺毋滥与简报纪律。
- 新增 `docs/MEMORY-MANAGER-PROMPT.md`（修订对照表 + 完整提示词）与 `test/prompt.test.mjs`。

## 1.0.1 (2026-11-28)

- 侧边栏入口名称改为「通联 - 多会话记忆插件」（此前硬编码为「记忆」）。
- **修复（P0）**：新增更新检测时 `inboxTracker` 在工具注册之后才初始化，
  `createMemoryTools` 读取未初始化常量触发 TDZ，记忆提案/绑定/队列/留言工具全部未注册。
  已把初始化提前；`apply.test` 现在断言这些工具确实注册。
- **修复**：`inbox_send` 输出 schema 缺 `hop`/`reason`，`additionalProperties:false` 导致
  工具执行成功但返回校验失败（E2E R4 发现）。
- 新增实机验证与 Token 收益报告 `docs/E2E-REPORT.md` + 原始数据 `docs/e2e-data.json`。
- 新增 `tools/e2e-real.mjs` 真实对话 E2E：通过 `ctx.agents` 创建 4 个全新空白会话、5 轮硬编码自然语言对话，
  `e2e_run`/`e2e_status` 管理员工具驱动，自动生成 `docs/E2E-REAL-REPORT.md`（实测 ¥0.14 vs 无缓存 ¥0.83，省 83.2%）。

## 1.0.0 (2026-11-28)

首个 npm 发布版本，插件中文名 **通联 - 多会话记忆插件**（包名 `dsh-context-array`）。

首个公开版本汇总 M0–M5：

- **M0 前置验证**：压缩 seam 接管与真实折叠（保留系统头、轮次边界、失败关锁），
  双轨缓存指标（`prefix_hit` / `whole_hit`），以及 13 种事件审计。
- **M1 观测与静态层**：L1/L3/L4 提示词段、按会话 L4 快照、usage 逐请求记录、
  每会话一次 bootstrap 追加。
- **M2 本地检索**：`multilingual-e5-small`（384 维 q8）worker 推理、FTS5 trigram 关键词路、
  RRF 2:1 混合检索、`memory_search` 工具。
- **M3 记忆管理员**：提案队列（原子领取/过期回收/重试上限/小时桶去重）、
  `memory_archive` 本地算向量与 `supersedesId` 回滚、管理员防注入段。
- **M4 多空间与留言箱**：空间 CRUD 与绑定、留言排队/唤醒（每小时 + 全局 + 冷却限流）、
  侧边栏五页签面板、主会话选择器（过滤子智能体）、会话选择器隐藏未命名会话。
- **M5 人格防护**：每对话人格（AI 可写、人类可改）、12 条中英投毒规则、
  `observe/enforce` 守护；人格块位于 L1 与 L3 之间。
- **更新检测与自动更新**：通过 DSH 插件管理器检查 npm 新版本，面板一键更新；
  `updatePolicy: auto` 时 registry 安装会自动更新，本地链接安装只提示。

安装后请执行一次 `node tools/fetch-model.mjs` 下载本地 embedding 模型（约 129 MiB）；
不想用向量检索可设置 `enableEmbedding: false`。

已知问题与修复状态见 `docs/REVIEW-2026-11-28.md`。
