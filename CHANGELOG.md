# Changelog

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
