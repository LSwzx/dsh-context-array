# M4 实测记录（留言箱 + 多空间 + 侧边栏 UI）

对应设计文档里程碑 **M4**：留言箱（排队 + 唤醒 + 限流）、多空间隔离、DSH 侧会话绑定与记忆浏览 UI。
环境：DSH `0.2.2-rc.5`、本机 desktop profile、页面 `http://127.0.0.1:25146`。

## 交付面

| 部分 | 文件 | 内容 |
|---|---|---|
| 空间/绑定/记忆浏览 | `src/spaces.js` | 空间增删改查（默认空间与非空空间拒删）、绑定 upsert/解绑、记忆列表（过滤已取代，只读：人类不删除） |
| 留言箱 | `src/inbox.js` | 排队（`agent.inject`，不唤醒、不计费启动轮次）与唤醒（`agent.followup`，滑动小时限流 10 次、写 `inbox_wake_log`） |
| Host HTTP API | `src/http-api.js` | `/api/context-array` 前缀路由；读接口 loopback-only，写接口额外要求 `x-context-array-ui: 1` |
| 工具 | `src/memory-tools.js` | 新增 `memory_bind` / `memory_unbind` / `inbox_send` / `inbox_list` / `inbox_ack`，身份一律取宿主注入的 `exec.agent.id` |
| 侧边栏 UI | `client.js` | `sidebar.panellist` 图标（order 40）+ `main` 面板（key `context-array`），四个页签：空间 / 记忆 / 队列 / 留言箱 |

## 运行证据

### 1. 客户端注册（实时，未刷新页面）

插件启用后，运行中的页面直接热加载了客户端 bundle。`Slots.listSubTree` 复核：

```
sidebar.panellist 占用者：plugins, schedules, github, tang, context-array(order 40, active)
main 槽占用者：tang, plugins, conversation, github, schedules, context-array(active)
```

两个注册都 active，没有出现 slot entry crash（`slot entry crashed in ...` 会表现为该槽位空白）。

### 2. 宿主 API（真实 HTTP 请求）

```
GET  /api/context-array/health   → ok=true, spaces=1, queue.pending=0
GET  /api/context-array/overview → spaces=1, bindings=13, sessions=13
```

`bindings=13` 是 M1 以来真实会话累积的绑定，说明面板读的是真实存储而不是演示数据。
> 注：v4.3.2 起已取消自动绑定，未绑定会话改用隐式默认空间，因此该数字不再成立（属历史记录）。

### 3. 写接口守卫（单测）

- 缺 `x-context-array-ui` 头 → `403 UI_HEADER_REQUIRED`；
- 非 loopback 来源 → `403 LOCAL_ONLY`；
- 删除非空空间 → `409 SPACE_NOT_EMPTY`（并返回记忆条数）；
- 删除默认空间 → `409 DEFAULT_SPACE`。

### 4. 留言箱语义（单测 + 工具链）

- 无 live agent → `delivery.mode = "offline"`，消息仍入库（不丢）；
- 不唤醒 → `agent.inject()`，`inject` 收到 `{content, source.kind:'context-array-inbox'}`，不产生 followup；
- 唤醒 → `agent.followup()`，`inbox_wake_log` 记一条非 throttled；
- 达到每小时上限 → 模式降级为 `throttled`：**仍然 inject 排队，只是不唤醒**，并记一条 throttled 日志；
- 工具侧同样的语义：`inbox_send(wake:true)` → `delivery: "woke"`，目标会话 `inbox_list` 能看到，`inbox_ack` 后不再 pending。

## 权限与边界（本里程碑的取舍）

1. **UI 不做权限提升**：面板的绑定角色只提供「主会话 / 子会话」；`admin` 会被 `/bind` 直接以
   `403 ADMIN_ROLE_IS_CONFIG_ONLY` 拒绝。管理员身份只能来自部署配置 `adminSessionIds` 或既有的
   `role=admin` 绑定——这一点由单测覆盖，并且是安全边界而不是 UI 提示。
2. **队列的领取/归档不在 UI 做**：那是记忆管理员的模型侧职责（`memory_queue_claim` / `memory_archive` /
   `memory_queue_settle`），面板只显示计数。避免 UI 绕过"管理员判定 + supersede 回滚"这套逻辑。
3. **会话 id 靠输入或已知会话快捷按钮**：面板是 root 作用域，拿不到"当前会话"的稳定注入；M4 先提供
   已知会话列表（来自 `session_space_links`，按钮带完整 id 的 title 与已绑空间/角色）+ 文本框。
   绑定自己的当前会话最可靠的方式仍是对话里的 `memory_bind`（身份由宿主注入）。
4. **没有做美化**：按用户要求只保留基础操控；颜色全部用 `--dsw-alias-*` token，未引入任何
   Harness Client 包，也没有 portal 或读别人 DOM。

## UX 审查与修复（M4 收尾）

用 subagent 做了一次独立 UX 审查（只读）。审查发现的问题逐条修复：

| 级别 | 问题 | 修复 |
|---|---|---|
| H1 | 样式注入依赖不存在的 `styles` 服务 | 改为在面板组件内渲染 `<style>` 元素（挂载/卸载自动随组件），不再依赖服务 |
| H2 | 业务失败被当成功（`/bind`、`/unbind`、`/inbox/ack` 恒 200） | 服务端失败改为 403/404/409 且带 `error` 字段；客户端 `call()` 把错误码翻成中文句子 |
| H3 | 留言投递结果被丢弃、重复发送会重复注入 | 客户端显示 `已唤醒/已排队/已限流/目标离线/重复`；服务端 `deduped` 时跳过投递（不再 inject 第二次） |
| H4 | 删除无确认 | 空间与记忆删除前 `window.confirm` |
| M1 | `--dsw-alias-border-subtle` / `label-danger` / `bg-elevated` 不是真 token | 改为 `border-l2` / `state-error-primary` / `bg-layer-1` |
| M2 | 新建空间后绑定下拉不跟随 | 创建成功即把两个下拉切到新空间；初始值取第一个真实空间 |
| M3 | 已知会话按钮只有 8 位前缀、不可辨识 | 按钮显示已绑空间/角色 + `title` 完整 id |
| M4 | 留言箱显示"待读"但其实是全局列表 | 标题改为「全部待读留言（所有会话）」，每行标出发往哪个会话 |
| M5 | 空间页无刷新、留言箱进入不刷新 | 按页签统一触发对应刷新 |
| M6 | 记忆数量把"取回条数"说成总数 | 显示「已显示 N / 共 M 条」 |
| M7 | 状态行是唯一反馈且永不消失 | 成功 6 秒自动清除、失败用错误色、`role="status" aria-live` |
| M8 | `/bind` 可写入 `admin`，等于 UI 提权 | 服务端拒绝 admin 角色（403），面板只留主/子会话 |
| L1–L5 | UTC 时间原样显示、限流文案硬编码、空名 500、无 label/aria、队列页中英混排 | 时间转本地、限流值取自 `/overview`、空名 400、补 label/role、状态名中文化 |

仍未做（明确保留）：UI 文案没有走 Client locale 服务（硬编码中文）；记忆列表最多 100 条、没有"加载更多"；
管理员给会话升权的入口仍然只在配置/工具侧。


## 已知未验证项

- **视觉与点击流**：本会话没有浏览器控制能力，无法截图或点击；面板的渲染效果、四个页签的切换、表单按钮的实际点击只做了代码级与 API 级验证。需要用户刷新页面后目视确认一次。
- **唤醒的 followup 时序**：单测用 stub agent 验证了调用与限流记录；真实"发一条唤醒后目标会话立刻开始一轮"未在本里程碑实测（会消耗一次真实轮次）。
- **嵌入到 `pnpm run dev:web` 的 HMR 流程**：本插件是手写 bundle，无构建步骤；修改 `client.js` 后由 client-modules 重新组合并热加载，已由本次启用验证。

## M4 收尾：口径修正 + 队列页（v4.3.1）

实现四页签时按评审意见做了以下修正：

1. **空间删除口径**：`deleteSpace` 只按有效记忆判定非空，并连同该空间的已取代记忆行、`inbox` 行一起清除；
   列表计数与禁用条件同口径。后端未更新前的兜底提示会说明"含已取代的旧记忆共 N 条，面板暂时无法清理"。
2. **记忆筛选/分页**：`GET /memories` 增加 `dimension`、`offset`，返回 `total`；筛选在后端完成，
   因此空态可以确定地写"这个空间没有「fact」维度的记忆"，而不是"已加载的 100 条里没有"。
3. **时间**：统一 `new Date(ts.replace(' ', 'T') + 'Z')` 再本地化；SQLite `CURRENT_TIMESTAMP` 是 UTC 无时区。
4. ~~删除记忆文案~~：v0.4.4 起按"人类没有权限修改记忆"取消删除入口，`/memories/delete` 改为 403 只读拒绝。
5. **队列明细**：`GET /queue`（`stats/items/total/hasMore/stuckCount/stuckAfterSeconds/maxRetries`）+
   `GET /queue/:id`（完整 `raw_content`）。列表含 `retry_count`、`claimed_ago_seconds`、
   `content_preview`（200 字）、`content_length`；processing 超过 `stuckAfterSeconds` 的单独标记；
   failed 显示重试次数与 `error`。面板对队列只读，领取/归档/拒绝仍只走管理员工具。
6. **会话标题**：本版本客户端契约（`SessionRetainInfo`/`SessionSnapshot`/`SessionSearchResultItem`）
   没有标题字段，因此面板只显示 id 前缀 + 复制，并按"已绑定本空间 / 其它已知会话"分组，不做标题猜测。

验证：单测 **172 项全绿**；live `GET /queue` 返回明细与 `stuckCount`，`GET /memories?...&dimension=fact`
返回 `total`；面板脚本通过语法检查并在运行页面热加载（`sidebar.panellist` + `main` 均 active）。

## 复现

```powershell
cd D:\dshprogram\dsh-context-array
node --test test/spaces.test.mjs test/inbox.test.mjs test/http-api.test.mjs test/memory-tools.test.mjs
# 面板：刷新 DSH 页面 → 左侧边栏最后一个图标「记忆」
# API：curl http://127.0.0.1:25146/api/context-array/health
```
