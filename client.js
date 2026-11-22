/**
 * dsh-context-array — Web UI half (M4).
 *
 * One sidebar panel icon + one main panel with four tabs: spaces, memories, queue and
 * inbox. Data comes from the Host route `/api/context-array/*`; writes send
 * `x-context-array-ui: 1`, the same loopback guard the Host applies.
 *
 * Plain JavaScript, no build step: the browser module loader evaluates the factory.
 * Styles render as a component-local <style> element, so unmounting removes them.
 */
window.__ModuleLoader__.load({
  id: 'dsh-context-array',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const API = '/api/context-array';
    const TABS = [
      ['spaces', '空间'],
      ['memories', '记忆'],
      ['queue', '队列'],
      ['inbox', '留言箱'],
    ];
    const ROLES = [
      ['main', '主会话'],
      ['sub', '子会话'],
    ];
    const DELIVERY_TEXT = {
      woke: '已唤醒对方开始一轮',
      queued: '已排队（对方在线，下一步读到）',
      throttled: '已达每小时唤醒上限，已改为排队',
      offline: '目标会话不在线，已排队等它下次启动',
      duplicate: '相同内容已发送过，未重复投递',
    };
    const ERROR_TEXT = {
      SPACE_NAME_REQUIRED: '空间名称不能为空',
      SPACE_NOT_FOUND: '空间不存在',
      SPACE_NOT_EMPTY: '空间里还有记忆，先删除记忆再删空间',
      DEFAULT_SPACE: '默认空间不能删除',
      MEMORY_NOT_FOUND: '这条记忆已经不存在',
      BINDING_NOT_FOUND: '这条绑定已经不存在',
      NOT_PENDING: '这条留言已经处理过了',
      TARGET_AND_CONTENT_REQUIRED: '目标会话和内容都不能为空',
      ADMIN_ROLE_IS_CONFIG_ONLY: '管理员身份只能由部署配置或管理员工具授予，面板不提供升降级',
      INVALID_ROLE: '角色不合法',
      NOT_FOUND: '请求的资源不存在',
      LOCAL_ONLY: '只允许本机访问',
      UI_HEADER_REQUIRED: '请求缺少面板标记',
    };

    function message(error) {
      if (!error) return '未知错误';
      if (ERROR_TEXT[error]) return ERROR_TEXT[error];
      if (String(error).startsWith('HTTP ')) return '请求失败（' + String(error).slice(5) + '）';
      return String(error);
    }

    const CSS = `
.ca-panel { display: flex; flex-direction: column; height: 100%; min-height: 0;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); }
.ca-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l2); flex-wrap: wrap; }
.ca-title { font-size: 14px; font-weight: 600; margin-right: 8px; }
.ca-tabs { display: flex; gap: 4px; }
.ca-tab { border: 1px solid var(--dsw-alias-border-l2); background: transparent;
  color: var(--dsw-alias-label-secondary); border-radius: 6px; padding: 3px 10px;
  font-size: 12px; cursor: pointer; }
.ca-tab[aria-selected='true'] { color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-primary); }
.ca-status { font-size: 11px; min-height: 14px; margin-left: auto; max-width: 46%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ca-status.is-ok { color: var(--dsw-alias-label-secondary); }
.ca-status.is-error { color: var(--dsw-alias-state-error-primary); }
.ca-body { flex: 1; overflow: auto; padding: 12px 14px; display: flex;
  flex-direction: column; gap: 10px; }
.ca-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.5; }
.ca-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.ca-input { background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary);
  border-radius: 6px; padding: 4px 8px; font-size: 12px; min-width: 120px; }
.ca-btn { border: 1px solid var(--dsw-alias-border-l2); background: transparent;
  color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 3px 10px;
  font-size: 12px; cursor: pointer; }
.ca-btn:hover { border-color: var(--dsw-alias-label-primary); }
.ca-btn:disabled { opacity: 0.5; cursor: default; }
.ca-btn.is-danger { color: var(--dsw-alias-state-error-primary); }
.ca-muted { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.ca-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
.ca-card-head { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
.ca-name { font-size: 13px; font-weight: 600; }
.ca-content { font-size: 12px; white-space: pre-wrap; word-break: break-word; }
.ca-empty { color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 8px 0; }
.ca-icon { display: flex; align-items: center; justify-content: center;
  color: var(--dsw-alias-label-secondary); }
.ca-icon.is-active { color: var(--dsw-alias-label-primary); }
`;

    async function call(path, options) {
      const init = Object.assign({}, options);
      if ((init.method || 'GET') !== 'GET') {
        init.headers = Object.assign(
          { 'content-type': 'application/json', 'x-context-array-ui': '1' },
          init.headers,
        );
        init.body = JSON.stringify(init.body || {});
      }
      const response = await fetch(API + path, init);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(message(payload.error || 'HTTP ' + response.status));
      return payload;
    }

    function formatTime(timestamp) {
      if (!timestamp) return '';
      const date = new Date(String(timestamp).replace(' ', 'T') + 'Z');
      return Number.isNaN(date.getTime()) ? String(timestamp) : date.toLocaleString();
    }

    function SidebarIcon(props) {
      const size = Math.max(16, (props && props.size ? props.size : 22) - 2);
      return h(
        'span',
        {
          className: 'ca-icon' + (props && props.active ? ' is-active' : ''),
          role: 'img',
          'aria-label': '记忆',
        },
        h(
          'svg',
          { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, fill: 'none',
            stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('ellipse', { cx: 12, cy: 6, rx: 7, ry: 3 }),
          h('path', { d: 'M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6' }),
          h('path', { d: 'M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6' }),
        ),
      );
    }

    function Panel() {
      const [tab, setTab] = React.useState('spaces');
      const [overview, setOverview] = React.useState(null);
      const [queue, setQueue] = React.useState(null);
      const [inbox, setInbox] = React.useState([]);
      const [memories, setMemories] = React.useState([]);
      const [memorySpace, setMemorySpace] = React.useState('');
      const [status, setStatus] = React.useState({ kind: 'ok', text: '' });
      const [busy, setBusy] = React.useState(false);

      const [spaceName, setSpaceName] = React.useState('');
      const [spaceDesc, setSpaceDesc] = React.useState('');
      const [bindSession, setBindSession] = React.useState('');
      const [bindSpace, setBindSpace] = React.useState('');
      const [bindRole, setBindRole] = React.useState('main');
      const [inboxTarget, setInboxTarget] = React.useState('');
      const [inboxContent, setInboxContent] = React.useState('');
      const [inboxWake, setInboxWake] = React.useState(false);

      const statusTimer = React.useRef(null);
      function note(text, kind) {
        setStatus({ kind: kind || 'ok', text });
        if (statusTimer.current) clearTimeout(statusTimer.current);
        if (text) statusTimer.current = setTimeout(() => setStatus({ kind: 'ok', text: '' }), 6000);
      }
      React.useEffect(() => () => statusTimer.current && clearTimeout(statusTimer.current), []);

      async function refresh() {
        try {
          const [overviewData, queueData] = await Promise.all([call('/overview'), call('/queue')]);
          setOverview(overviewData);
          setQueue(queueData);
          const spaces = overviewData.spaces || [];
          if (spaces.length) {
            setMemorySpace((current) => (current && spaces.some((s) => s.id === current) ? current : spaces[0].id));
            setBindSpace((current) => (current && spaces.some((s) => s.id === current) ? current : spaces[0].id));
          }
        } catch (error) {
          note(error.message, 'error');
        }
      }

      async function refreshMemories(spaceId) {
        if (!spaceId) return;
        try {
          const data = await call('/memories?spaceId=' + encodeURIComponent(spaceId) + '&limit=100');
          setMemories(data.memories || []);
        } catch (error) {
          note(error.message, 'error');
        }
      }

      async function refreshInbox() {
        try {
          const data = await call('/inbox?status=pending');
          setInbox(data.messages || []);
        } catch (error) {
          note(error.message, 'error');
        }
      }

      React.useEffect(() => {
        refresh();
      }, []);

      // Each tab reloads on entry, so another window's change is one click away.
      React.useEffect(() => {
        if (tab === 'spaces') refresh();
        if (tab === 'memories') refreshMemories(memorySpace);
        if (tab === 'queue') refresh();
        if (tab === 'inbox') refreshInbox();
      }, [tab, memorySpace]);

      async function act(label, work) {
        if (busy) return;
        setBusy(true);
        try {
          const detail = await work();
          note(label + '：' + (detail || '完成'), 'ok');
          await refresh();
          if (tab === 'memories') await refreshMemories(memorySpace);
          if (tab === 'inbox') await refreshInbox();
        } catch (error) {
          note(label + '：' + error.message, 'error');
        } finally {
          setBusy(false);
        }
      }

      const spaces = (overview && overview.spaces) || [];
      const bindings = (overview && overview.bindings) || [];
      const sessions = (overview && overview.sessions) || [];
      const wakeLimit = (overview && overview.wakeMaxPerHour) || 10;
      const selectedSpace = spaces.find((space) => space.id === memorySpace);

      function sessionLabel(sessionId) {
        const row = sessions.find((entry) => entry.sessionId === sessionId);
        if (!row) return sessionId.slice(0, 8);
        return sessionId.slice(0, 8) + (row.links.length ? '（' + row.links.map((link) => link.spaceId + '/' + link.role).join('、') + '）' : '');
      }

      function renderSpaces() {
        return h(
          'div',
          { className: 'ca-body' },
          h(
            'div',
            { className: 'ca-hint' },
            '空间用于隔离不同项目的记忆。默认空间始终存在且不能删除；面板里的会话绑定只影响读取范围，管理员身份由部署配置决定。',
          ),
          h(
            'div',
            { className: 'ca-row' },
            h('button', { className: 'ca-btn', onClick: refresh, disabled: busy }, '刷新'),
          ),
          h(
            'div',
            { className: 'ca-card' },
            h('div', { className: 'ca-name' }, '新建空间'),
            h(
              'div',
              { className: 'ca-row' },
              h('label', { className: 'ca-muted', htmlFor: 'ca-space-name' }, '名称'),
              h('input', {
                id: 'ca-space-name',
                className: 'ca-input',
                value: spaceName,
                onChange: (e) => setSpaceName(e.target.value),
              }),
              h('label', { className: 'ca-muted', htmlFor: 'ca-space-desc' }, '描述'),
              h('input', {
                id: 'ca-space-desc',
                className: 'ca-input',
                value: spaceDesc,
                onChange: (e) => setSpaceDesc(e.target.value),
              }),
              h(
                'button',
                {
                  className: 'ca-btn',
                  disabled: busy,
                  onClick: () =>
                    act('创建空间', async () => {
                      const data = await call('/spaces/create', {
                        method: 'POST',
                        body: { name: spaceName, description: spaceDesc },
                      });
                      setSpaceName('');
                      setSpaceDesc('');
                      if (data.space) {
                        setMemorySpace(data.space.id);
                        setBindSpace(data.space.id);
                      }
                      return '已创建 ' + data.space.name;
                    }),
                },
                '创建',
              ),
            ),
          ),
          h(
            'div',
            { className: 'ca-card' },
            h('div', { className: 'ca-name' }, '空间列表'),
            spaces.length === 0
              ? h('div', { className: 'ca-empty' }, '正在读取空间…')
              : spaces.map((space) =>
                  h(
                    'div',
                    { className: 'ca-row', key: space.id },
                    h('span', { className: 'ca-name' }, space.name),
                    h('span', { className: 'ca-muted' }, space.id + ' · ' + space.memories + ' 条记忆 · ' + space.sessions + ' 个会话'),
                    space.id === 'space-default' ? null : h(
                      'button',
                      {
                        className: 'ca-btn is-danger',
                        disabled: busy,
                        onClick: () => {
                          if (!window.confirm('删除空间「' + space.name + '」？此操作不可恢复。')) return;
                          act('删除空间', async () => {
                            await call('/spaces/delete', { method: 'POST', body: { id: space.id } });
                            return '已删除 ' + space.name;
                          });
                        },
                      },
                      '删除',
                    ),
                  ),
                ),
          ),
          h(
            'div',
            { className: 'ca-card' },
            h('div', { className: 'ca-name' }, '会话绑定'),
            h(
              'div',
              { className: 'ca-hint' },
              '把某个会话绑定到空间后，它只能检索该空间内的记忆。会话 id 可从下方已知会话里点选。',
            ),
            h(
              'div',
              { className: 'ca-row' },
              h('label', { className: 'ca-muted', htmlFor: 'ca-bind-session' }, '会话 id'),
              h('input', {
                id: 'ca-bind-session',
                className: 'ca-input',
                placeholder: '点击下方按钮填入',
                value: bindSession,
                onChange: (e) => setBindSession(e.target.value),
              }),
              h(
                'select',
                { className: 'ca-input', value: bindSpace, onChange: (e) => setBindSpace(e.target.value) },
                spaces.map((space) => h('option', { key: space.id, value: space.id }, space.name)),
              ),
              h(
                'select',
                { className: 'ca-input', value: bindRole, onChange: (e) => setBindRole(e.target.value) },
                ROLES.map(([value, label]) => h('option', { key: value, value }, label)),
              ),
              h(
                'button',
                {
                  className: 'ca-btn',
                  disabled: busy,
                  onClick: () =>
                    act('绑定', async () => {
                      const data = await call('/bind', {
                        method: 'POST',
                        body: { sessionId: bindSession.trim(), spaceId: bindSpace, role: bindRole },
                      });
                      return sessionLabel(bindSession.trim()) + ' 已绑定 ' + bindSpace;
                    }),
                },
                '绑定',
              ),
            ),
            sessions.length === 0
              ? null
              : h(
                  'div',
                  { className: 'ca-row' },
                  h('span', { className: 'ca-muted' }, '已知会话：'),
                  sessions.map((row) =>
                    h(
                      'button',
                      {
                        key: row.sessionId,
                        className: 'ca-btn',
                        title: row.sessionId,
                        onClick: () => setBindSession(row.sessionId),
                      },
                      sessionLabel(row.sessionId),
                    ),
                  ),
                ),
            bindings.length === 0
              ? h('div', { className: 'ca-empty' }, '还没有绑定')
              : bindings.map((row) =>
                  h(
                    'div',
                    { className: 'ca-row', key: row.session_id + row.space_id },
                    h('span', { className: 'ca-muted' }, sessionLabel(row.session_id) + ' → ' + row.space_name + '（' + row.role + '）'),
                    h(
                      'button',
                      {
                        className: 'ca-btn',
                        disabled: busy,
                        onClick: () =>
                          act('解绑', async () => {
                            await call('/unbind', { method: 'POST', body: { sessionId: row.session_id, spaceId: row.space_id } });
                            return '已解绑';
                          }),
                      },
                      '解绑',
                    ),
                  ),
                ),
          ),
        );
      }

      function renderMemories() {
        const total = selectedSpace ? selectedSpace.memories : 0;
        return h(
          'div',
          { className: 'ca-body' },
          h(
            'div',
            { className: 'ca-row' },
            h(
              'select',
              { className: 'ca-input', value: memorySpace, onChange: (e) => setMemorySpace(e.target.value) },
              spaces.map((space) => h('option', { key: space.id, value: space.id }, space.name)),
            ),
            h('button', { className: 'ca-btn', disabled: busy, onClick: () => refreshMemories(memorySpace) }, '刷新'),
            h('span', { className: 'ca-muted' }, '已显示 ' + memories.length + ' / 共 ' + total + ' 条'),
          ),
          memories.length === 0
            ? h('div', { className: 'ca-empty' }, '这个空间还没有记忆。记忆由记忆管理员从对话里归档。')
            : memories.map((memory) =>
                h(
                  'div',
                  { className: 'ca-card', key: memory.id },
                  h(
                    'div',
                    { className: 'ca-card-head' },
                    h('span', { className: 'ca-muted' }, memory.dimension + ' · ' + formatTime(memory.timestamp)),
                    h(
                      'button',
                      {
                        className: 'ca-btn is-danger',
                        disabled: busy,
                        onClick: () => {
                          if (!window.confirm('删除这条记忆？此操作不可恢复。')) return;
                          act('删除记忆', async () => {
                            await call('/memories/delete', { method: 'POST', body: { id: memory.id } });
                            return '已删除';
                          });
                        },
                      },
                      '删除',
                    ),
                  ),
                  h('div', { className: 'ca-content' }, memory.content),
                ),
              ),
        );
      }

      function renderQueue() {
        const stats = queue || {};
        const rows = [
          ['pending', '待审核'],
          ['processing', '处理中'],
          ['done', '已归档'],
          ['rejected', '已拒绝'],
          ['failed', '失败'],
        ];
        return h(
          'div',
          { className: 'ca-body' },
          h(
            'div',
            { className: 'ca-row' },
            h('span', { className: 'ca-muted' }, '共 ' + (stats.total || 0) + ' 条'),
            h('button', { className: 'ca-btn', disabled: busy, onClick: refresh }, '刷新'),
          ),
          h(
            'div',
            { className: 'ca-card' },
            rows.map(([key, label]) => h('div', { className: 'ca-row', key }, h('span', { className: 'ca-muted' }, label), h('span', null, String(stats[key] || 0)))),
          ),
          h(
            'div',
            { className: 'ca-hint' },
            '队列由记忆管理员在对话里处理：memory_queue_claim 领取 → memory_archive 归档，或 memory_queue_settle 拒绝。面板只显示状态，不代替管理员做判定。',
          ),
        );
      }

      function renderInbox() {
        return h(
          'div',
          { className: 'ca-body' },
          h(
            'div',
            { className: 'ca-card' },
            h('div', { className: 'ca-name' }, '发送留言'),
            h(
              'div',
              { className: 'ca-hint' },
              '不勾选「唤醒」只排队：不产生计费轮次，对方下次有输入时读到。勾选唤醒会立刻开启对方一轮，每小时最多 ' + wakeLimit + ' 次，超限自动降级为排队。',
            ),
            h(
              'div',
              { className: 'ca-row' },
              h('label', { className: 'ca-muted', htmlFor: 'ca-inbox-target' }, '目标会话'),
              h('input', {
                id: 'ca-inbox-target',
                className: 'ca-input',
                placeholder: '点击下方按钮填入',
                value: inboxTarget,
                onChange: (e) => setInboxTarget(e.target.value),
              }),
              h('label', { className: 'ca-muted', htmlFor: 'ca-inbox-content' }, '内容'),
              h('input', {
                id: 'ca-inbox-content',
                className: 'ca-input',
                style: { flex: 1 },
                value: inboxContent,
                onChange: (e) => setInboxContent(e.target.value),
              }),
              h(
                'label',
                { className: 'ca-muted' },
                h('input', { type: 'checkbox', checked: inboxWake, onChange: (e) => setInboxWake(e.target.checked) }),
                ' 唤醒',
              ),
              h(
                'button',
                {
                  className: 'ca-btn',
                  disabled: busy,
                  onClick: () =>
                    act('发送留言', async () => {
                      const data = await call('/inbox/send', {
                        method: 'POST',
                        body: { targetSessionId: inboxTarget.trim(), content: inboxContent, wake: inboxWake },
                      });
                      setInboxContent('');
                      return DELIVERY_TEXT[data.delivery.mode] || data.delivery.mode;
                    }),
                },
                '发送',
              ),
            ),
            sessions.length === 0
              ? null
              : h(
                  'div',
                  { className: 'ca-row' },
                  h('span', { className: 'ca-muted' }, '已知会话：'),
                  sessions.map((row) =>
                    h(
                      'button',
                      { key: row.sessionId, className: 'ca-btn', title: row.sessionId, onClick: () => setInboxTarget(row.sessionId) },
                      sessionLabel(row.sessionId),
                    ),
                  ),
                ),
          ),
          h(
            'div',
            { className: 'ca-row' },
            h('span', { className: 'ca-muted' }, '全部待读留言（所有会话）· ' + inbox.length + ' 条'),
            h('button', { className: 'ca-btn', disabled: busy, onClick: refreshInbox }, '刷新'),
          ),
          inbox.length === 0
            ? h('div', { className: 'ca-empty' }, '没有待读留言')
            : inbox.map((row) =>
                h(
                  'div',
                  { className: 'ca-card', key: row.id },
                  h(
                    'div',
                    { className: 'ca-card-head' },
                    h('span', { className: 'ca-muted' }, (row.source_session_id || '面板').slice(0, 8) + ' → 发往 ' + (row.target_session_id || '').slice(0, 8) + ' · ' + formatTime(row.created_at)),
                    h(
                      'button',
                      {
                        className: 'ca-btn',
                        disabled: busy,
                        onClick: () =>
                          act('标记已读', async () => {
                            await call('/inbox/ack', { method: 'POST', body: { id: row.id } });
                            return '已标记';
                          }),
                      },
                      '已读',
                    ),
                  ),
                  h('div', { className: 'ca-content' }, row.content),
                ),
              ),
        );
      }

      return h(
        'div',
        { className: 'ca-panel' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'ca-head' },
          h('span', { className: 'ca-title' }, '记忆'),
          h(
            'div',
            { className: 'ca-tabs', role: 'tablist' },
            TABS.map(([key, label]) =>
              h(
                'button',
                {
                  key,
                  className: 'ca-tab',
                  role: 'tab',
                  'aria-selected': tab === key,
                  onClick: () => setTab(key),
                },
                label,
              ),
            ),
          ),
          h('span', { className: 'ca-status is-' + status.kind, role: 'status', 'aria-live': 'polite' }, status.text),
        ),
        tab === 'spaces' ? renderSpaces() : tab === 'memories' ? renderMemories() : tab === 'queue' ? renderQueue() : renderInbox(),
      );
    }

    function apply(ctx) {
      if (!ctx.slots) return;
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: 'context-array', order: 40, label: () => '记忆' },
          SidebarIcon,
        ),
      );
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'context-array' }, Panel));
    }

    return { inject: ['slots'], apply };
  },
});
