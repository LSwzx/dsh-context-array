/**
 * Real-conversation E2E scenario for the context-array plugin.
 *
 * The runner needs the live host (`ctx.agents`), so it is imported and driven by the
 * admin-only `e2e_run` tool (`src/e2e-tool.js`); it cannot create DSH sessions from a
 * plain `node` process. `node tools/e2e-real.mjs` only prints the scenario and refuses
 * to run without a host.
 *
 * What it does:
 *   1. deletes the previous `space-e2e` fixtures and recreates the space,
 *   2. creates four brand-new blank sessions (admin, main, sub1, sub2) and binds them,
 *   3. sends five rounds of long, human-sounding chat (no tool-argument prompts),
 *   4. waits for every turn to finish, attempts one manual `context_compact`,
 *   5. reads usage.jsonl, compares against docs/e2e-data.json (the tool-only run),
 *   6. writes docs/E2E-REAL-REPORT.md.
 */

import fs from 'node:fs'
import path from 'node:path'

export const SPACE_ID = 'space-e2e'
export const SPACE_NAME = 'E2E 真实对话空间'
export const SPACE_RULES = '真实对话验收专用空间；规则在会话创建时冻结。'

/** Five rounds of deliberately chatty, human-sounding Chinese. */
export const NATURAL_ROUNDS = [
  {
    round: 1,
    role: 'main',
    text:
      '我今天想去买个新电脑，主要是用来打游戏，偶尔也写点代码，预算大概一万五左右。我自己看了半天，拯救者和 ROG 都挺心动的，但实在拿不定主意，你觉得哪个更合适？还有，我平时不喜欢风扇太吵，屏幕希望看着舒服一点。对了，麻烦你把这个偏好记一下，免得我下次又要重新讲一遍。',
    expect: '自然语言建议 + 用 memory_propose 记下偏好',
  },
  {
    round: 2,
    role: 'admin',
    text:
      '我是这个空间的管理员，刚接手，想先看看有没有新的记忆候选需要处理。如果有的话，帮我按事实类的维度归档到这个空间里；内容看着不靠谱或者只是测试占位的，就直接拒掉，别往库里写。处理完之后跟我说一下队列现在什么情况，剩几条、有没有卡住的。',
    expect: '自然语言汇报 + memory_queue_claim / memory_archive（或拒绝）+ 队列统计',
  },
  {
    round: 3,
    role: 'sub1',
    text:
      '之前主会话好像聊过要买什么电脑来着，我记不太清了。你能帮我翻一下他的需求吗？主要是预算、用途和尺寸偏好这些，我怕回头推荐错了。翻到之后顺便给我讲个关于电脑的冷笑话，今天有点困，需要提提神，别太冷到让人尴尬就行。',
    expect: '自然语言总结（用 memory_search 召回）+ 笑话',
  },
  {
    round: 4,
    role: 'sub2',
    text:
      '帮我给主会话留个言吧，就问问他电脑定了没有、要不要我帮忙比价，语气随意一点，像同事之间聊天那样，别太正式。另外我自己这边也顺手记一条：我倾向于买轻薄本，续航要长，重量最好控制在一公斤半以内，因为经常要背来背去。麻烦你把这条也提到候选队列里去。',
    expect: '自然语言回复 + inbox_send（不唤醒）+ memory_propose',
  },
  {
    round: 5,
    role: 'main',
    text:
      '我回来啦，刚才好像有人给我留言？你帮我看看收件箱里有什么，有的话读一下、顺手标成已读，然后简单跟我说说重点。另外这个会话聊得有点长了，你试试用 context_compact 把前面的内容压缩一下，如果内容太少压不了也如实告诉我，别硬压。',
    expect: '自然语言汇报 + inbox_list / inbox_ack + context_compact 尝试',
  },
]

export const PRICE = { miss: 2.0, hit: 0.2, output: 3.0 } // RMB per 1M tokens

/** Usage rows start after this line index (set by the runner before rounds). */
export function analyzeUsage(rows, { price = PRICE } = {}) {
  const groups = new Map()
  const totals = { requests: 0, prompt: 0, miss: 0, hit: 0, output: 0, prefix: 0, prefixHit: 0, tools: 0 }
  for (const row of rows) {
    const usage = row.usage ?? {}
    const group = groups.get(row.sessionId) ?? {
      sessionId: row.sessionId,
      requests: 0,
      prompt: 0,
      miss: 0,
      hit: 0,
      output: 0,
      tools: 0,
    }
    group.requests += 1
    group.miss += usage.inputTokens ?? 0
    group.hit += usage.cacheReadTokens ?? 0
    group.output += usage.outputTokens ?? 0
    group.prompt += (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
    group.hitRate = group.prompt > 0 ? group.hit / group.prompt : 0
    groups.set(row.sessionId, group)
    totals.requests += 1
    totals.miss += usage.inputTokens ?? 0
    totals.hit += usage.cacheReadTokens ?? 0
    totals.output += usage.outputTokens ?? 0
    totals.prompt += (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
    totals.prefix += row.prefixTokens ?? 0
    totals.prefixHit += row.prefixHitTokens ?? 0
    totals.tools += row.toolCount ?? 0
  }
  const cost = (miss, hit, output) => (miss * price.miss + hit * price.hit + output * price.output) / 1e6
  const actual = cost(totals.miss, totals.hit, totals.output)
  const noCache = cost(totals.prompt, 0, totals.output)
  totals.hitRate = totals.prompt > 0 ? totals.hit / totals.prompt : 0
  totals.prefixHitRate = totals.prefix > 0 ? totals.prefixHit / totals.prefix : 0
  return {
    sessions: [...groups.values()],
    totals,
    cost: {
      actual,
      noCache,
      savings: noCache - actual,
      savingsPct: noCache > 0 ? (noCache - actual) / noCache : 0,
    },
    price,
  }
}

function money(value) {
  return '¥' + value.toFixed(2)
}

/** Render the final Markdown report. */
export function renderReport({ runAt, usage, toolOnly, toolOnlyPath, results = [], price = PRICE }) {
  const t = usage.totals
  const c = usage.cost
  const lines = [
    '# dsh-context-array 真实对话 E2E 报告',
    '',
    `- 运行时间：${runAt}`,
    `- 场景：4 个全新空白会话（管理员 / 主会话 / 子会话 1 / 子会话 2）+ 空间 \`${SPACE_ID}\``,
    '- Prompt：5 轮硬编码的长自然语言对话（每轮 100 字以上），不是工具参数',
    `- 数据源：\`usage.jsonl\`；价格假设（人民币/百万 token）：miss ${price.miss} / hit ${price.hit} / output ${price.output}`,
    '',
    '## 1. 五轮对话脚本',
    '',
    '| 轮次 | 会话 | 请求数 | 结果 |',
    '|---|---|---:|---|',
  ]
  for (const round of NATURAL_ROUNDS) {
    const result = results.find((entry) => entry.round === round.round)
    lines.push(
      `| R${round.round} | ${round.role} | ${result?.requests ?? 0} | ${result?.sent ? '已产生自然语言回复' : '失败' + (result?.error ? '：' + result.error : '')} |`,
    )
  }
  lines.push(
    '',
    '### 完整 Prompt',
    '',
  )
  for (const round of NATURAL_ROUNDS) {
    lines.push(
      `**R${round.round}（${round.role}）**：`,
      '',
      '> ' + round.text.replace(/\n/g, ' '),
      '',
    )
  }
  lines.push(
    '## 2. 实测 Token',
    '',
    '| 会话 | 请求数 | prompt | miss | cacheRead | 命中率 | output |',
    '|---|---:|---:|---:|---:|---:|---:|',
  )
  for (const row of usage.sessions) {
    lines.push(
      `| ${row.sessionId.slice(0, 8)} | ${row.requests} | ${row.prompt.toLocaleString()} | ` +
        `${row.miss.toLocaleString()} | ${row.hit.toLocaleString()} | ` +
        `${(row.hitRate * 100).toFixed(2)}% | ${row.output.toLocaleString()} |`,
    )
  }
  lines.push(
    `| **合计** | **${t.requests}** | **${t.prompt.toLocaleString()}** | **${t.miss.toLocaleString()}** | ` +
      `**${t.hit.toLocaleString()}** | **${(t.hitRate * 100).toFixed(2)}%** | **${t.output.toLocaleString()}** |`,
    '',
    '## 3. 成本对比',
    '',
    '| 方案 | 费用 | 说明 |',
    '|---|---:|---|',
    `| 实测：插件 + 缓存 | **${money(c.actual)}** | miss 按 ${price.miss}、hit 按 ${price.hit}、output 按 ${price.output} |`,
    `| 无插件（全量重算） | **${money(c.noCache)}** | 每轮 prompt 全按 miss 计费 |`,
    `| 节省 | **${money(c.savings)}（${(c.savingsPct * 100).toFixed(1)}%）** | 本次 ${t.requests} 个请求 |`,
    '',
    '### 与上一版「纯工具调用」测试对比',
    '',
    '| 指标 | 纯工具调用 E2E | 真实对话 E2E |',
    '|---|---:|---:|',
    `| 请求数 | ${toolOnly?.totals.requests ?? '—'} | ${t.requests} |`,
    `| prompt tokens | ${toolOnly?.totals.prompt.toLocaleString() ?? '—'} | ${t.prompt.toLocaleString()} |`,
    `| 缓存命中率 | ${toolOnly ? (toolOnly.totals.hitRate * 100).toFixed(2) + '%' : '—'} | ${(t.hitRate * 100).toFixed(2)}% |`,
    `| output tokens | ${toolOnly?.totals.output.toLocaleString() ?? '—'} | ${t.output.toLocaleString()} |`,
    `| 实测费用 | ${toolOnly ? money(toolOnly.cost.actual) : '—'} | ${money(c.actual)} |`,
    `| 无缓存费用 | ${toolOnly ? money(toolOnly.cost.noCache) : '—'} | ${money(c.noCache)} |`,
    `| 节省比例 | ${toolOnly ? (toolOnly.cost.savingsPct * 100).toFixed(1) + '%' : '—'} | ${(c.savingsPct * 100).toFixed(1)}% |`,
    '',
    '## 4. 结论',
    '',
    '- 真实对话每轮都会追加自然语言历史，prompt 随轮次增长；缓存命中率反映的是"增长部分按 miss、历史按 hit"。',
    '- 纯工具调用场景的输出/对话很少，prompt 增长慢；真实聊天更能代表日常使用的成本形态。',
    '- 插件通过稳定 L1–L4 前缀，使历史前缀可持续命中；每轮新增的消息按 miss 计费，这是无法避免的增量。',
    '',
    '## 5. 次轮改进',
    '',
    '- 折叠在短会话里可能无可折叠内容（`context_compact` 会如实报错）；要覆盖折叠需要 ≥ 数轮长对话或更低的阈值。',
    '- 无插件对照需要另起 Host（禁用插件）才能真实测；当前"无缓存"列是按同一 prompt 全量 miss 的理论值。',
    '',
  )
  return lines.join('\n')
}

/**
 * Drive the whole scenario. `host` is supplied by `src/e2e-tool.js`:
 *   cleanFixtures(), ensureSpace(), bind(sessionId, role), createSession(),
 *   send(sessionId, text), waitIdle(sessionId), usageLines(), now().
 */
export async function runE2E({ host, reportPath, log = () => {} }) {
  const runAt = new Date().toISOString()
  await host.cleanFixtures()
  await host.ensureSpace()
  const sessions = {}
  for (const role of ['admin', 'main', 'sub1', 'sub2']) {
    sessions[role] = await host.createSession(role)
    await host.bind(sessions[role], role === 'admin' ? 'admin' : role === 'main' ? 'main' : 'sub')
    log(`session ${role} ${sessions[role]}`)
  }

  const before = await host.usageLines()
  const results = []
  for (const round of NATURAL_ROUNDS) {
    const sessionId = sessions[round.role]
    log(`round ${round.round} -> ${round.role}`)
    const outcome = await host.send(sessionId, round.text)
    results.push({ round: round.round, role: round.role, sessionId, ...outcome })
  }

  const after = await host.usageLines()
  const rows = after.slice(before).filter((row) => Object.values(sessions).includes(row.sessionId))
  const usage = analyzeUsage(rows)

  let toolOnly = null
  let toolOnlyPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'docs', 'e2e-data.json')
  try {
    toolOnly = JSON.parse(fs.readFileSync(toolOnlyPath, 'utf8'))
  } catch {
    toolOnly = null
  }

  const report = renderReport({ runAt, usage, toolOnly, toolOnlyPath, results })
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, report, 'utf8')
  return { runAt, sessions, results, usage, reportPath }
}
