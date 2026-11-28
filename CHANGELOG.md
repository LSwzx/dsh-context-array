# Changelog

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

安装后请执行一次 `node tools/fetch-model.mjs` 下载本地 embedding 模型（约 129 MiB）；
不想用向量检索可设置 `enableEmbedding: false`。

已知问题与修复状态见 `docs/REVIEW-2026-11-28.md`。
