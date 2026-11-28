# 通联 - 多会话记忆插件（dsh-context-array）

面向 DeepSeek Harness 的本地多会话记忆插件。所有记忆、向量、观测数据都留在本机；
不联网、不调用外部 embedding 服务。

## 它做什么

- **五维记忆**：`working / recent / fact / reflection / personality`，SQLite 存储 + FTS5 trigram。
- **本地混合检索**：`multilingual-e5-small`（384 维，q8 ONNX，worker 线程）向量 top-20 与关键词 top-20，
  RRF 2:1 融合，`memory_search` 工具按需调用。
- **KV-cache 优先的上下文**：L1（基础规则）/ 人格块 / L3（角色）/ L4（空间规则）静态拼装，
  动态内容只追加在已缓存历史之后；每个请求把 `prefix_hit` 与 `whole_hit` 分开记录。
- **压缩接管**：`compactionMode: fold` 时接管 DSH 压缩，在轮次边界把较早历史折叠成一条摘要
  （保留系统头与最近上下文），失败会关锁并留下事件。
- **中央记忆管理员 + 异步队列**：普通会话只能 `memory_propose` 入队；管理员会话用
  `memory_queue_claim → memory_archive` 归档（本地算向量、支持 `supersedesId` 取代与回滚）。
- **多空间与会话隔离**：空间规则（L4）按会话快照冻结；改空间只影响新会话。
- **留言箱**：排队（不唤醒、不产生计费轮次）与唤醒（开新轮、每小时/全局/冷却限流），
  带 `hop_count`（上限 3）与限流标记。
- **人格防护**：人格块位于 L1 之后、L3 之前；外部工具结果（默认 `web_search`/`web_fetch`）命中
  12 条中英投毒规则时记录事件，`enforce` 模式追加"保持原人格"提醒。人格默认由 AI 写自己的对话，
  人类可在侧边栏面板里任选一个对话修改。

## 侧边栏面板

左侧边栏「记忆」图标打开主面板，共五个页签：

| 页签 | 内容 |
|---|---|
| 空间 | 新建/编辑空间（名称与 L4 规则）、会话绑定（下拉选主会话）、删除空间（要求无有效记忆） |
| 记忆 | 按空间与维度浏览有效记忆；只读，人类不能编辑或删除 |
| 队列 | 只读：状态计数、卡住的 processing、failed 的重试次数与错误 |
| 留言箱 | 从下拉选目标会话发留言；可勾选唤醒；显示跳数与限流标记 |
| 人格 | 选对话（或全局默认）编辑人格；显示防护模式、投毒记录与最近修改者 |

## 安装

发布到 npm 后，包名是 `dsh-context-array`：

- 交给 DSH 插件管理器：`plugin_manager install_bundle`，target 填 `dsh-context-array`；
  或使用图形界面 **Plugins → Add plugin**（入口以当前 DSH 版本为准）。
- 首次安装后下载一次本地模型：在包目录执行 `node tools/fetch-model.mjs`
  （约 129 MiB；离线可用，sha256 校验、断点续传）。
- 不想用向量检索可设 `enableEmbedding: false`，只走关键词路。

## 更新

插件启动后检查 npm 上的新版本；面板顶部可直接更新（走 DSH 插件管理器，HMR 生效或提示重启）。
`updatePolicy: auto` 时 registry 安装会自动更新；本地链接/路径安装只提示、不自动覆盖。

## 权限与数据

- 记忆写入只由记忆管理员（管理员会话工具）完成；人类在面板里**只读**。
- 人格按对话存储：AI 用 `persona_write` 写当前对话，人类可在面板里改同一行。
- 数据目录默认 `~/.dsh/context-array/`：`context-array.db`、`usage.jsonl`、`events.jsonl`、`models/`。
- 无遥测、无远程调用；embedding 模型只从本地目录加载。

## 配置（常用）

| 键 | 代码默认 | 说明 |
|---|---|---|
| `spaceId` / `spaceName` / `spaceRules` | `space-default` / … | 默认空间（L4 规则） |
| `compactionMode` | `off` | `off`/`observe`/`fold`；随包 patch 设为 `fold` |
| `adminSessionIds` | `[]` | 中央记忆管理员会话 id |
| `enableEmbedding` | `true` | `false` 时只用关键词检索 |
| `personaGuard` | `observe` | `off`/`observe`/`enforce` |
| `personaGuardTools` | `["web_search","web_fetch"]` | 监视哪些工具的外部结果 |
| `queueStaleMinutes` / `queueMaxRetries` | `10` / `3` | 队列过期回收与重试上限 |
| `wakeMaxPerHour` / `wakeGlobalMaxPerHour` / `wakeCooldownMinutes` | `10` / `30` / `10` | 留言箱唤醒限流 |

## 已知边界

- 面板未做视觉美化；点击流需要在真实页面里验证。
- 每轮自动检索注入 `<memory>` 尚未接线（当前只有按需 `memory_search` 工具）。
- 留言 `hop_count`/限流依赖宿主 `agent/inbox/claimed` 事件，冷启动的历史留言不参与归因。
- 压缩折叠会一次性失效前缀缓存（设计上接受的代价）；折叠事件可在 `events.jsonl` 单独审计。

## 许可

MIT © 2026 LSwzx。仓库：<https://github.com/LSwzx/dsh-context-array>。
