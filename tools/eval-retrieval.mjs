// M2 retrieval evaluation: seed a throwaway store, then compare hybrid /
// keyword-only / vector-only retrieval on the same queries.
//
// Usage: node tools/eval-retrieval.mjs [--models <dir>] [--json]
// Requires the local embedding model (tools/fetch-model.mjs). If the model is
// unavailable the script falls back to keyword-only and says so.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveConfig } from '../src/config.js'
import { migrate, openStore } from '../src/db.js'
import { insertMemory, listActiveEmbeddings } from '../src/db-memories.js'
import { createRetriever } from '../src/retrieval.js'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const modelsIndex = args.indexOf('--models')
const modelsDir =
  modelsIndex >= 0 && args[modelsIndex + 1]
    ? path.resolve(args[modelsIndex + 1])
    : path.join(os.homedir(), '.dsh', 'context-array', 'models')

const SPACES = ['space-default', 'space-work']

/** [id, spaceId, dimension, content] — content carries the query keyword on purpose. */
const MEMORIES = [
  ['m01', 'space-default', 'fact', '用户偏好深色主题，界面默认使用暗色配色。'],
  ['m02', 'space-default', 'fact', '用户所在时区是 Asia/Shanghai，时间是 UTC+8。'],
  ['m03', 'space-default', 'fact', '项目仓库使用 pnpm 而不是 npm 安装依赖。'],
  ['m04', 'space-default', 'fact', '数据库选用 SQLite，通过 node:sqlite 访问。'],
  ['m05', 'space-default', 'fact', '插件的配置目录是 %USERPROFILE%\\.dsh\\context-array。'],
  ['m06', 'space-default', 'reflection', '上次因为没先跑测试就提交，导致 CI 失败。'],
  ['m07', 'space-default', 'reflection', '压缩会原地改写历史，是缓存命中的主要风险。'],
  ['m08', 'space-default', 'personality', '回答保持简洁，先给结论再给理由。'],
  ['m09', 'space-default', 'recent', '昨天完成了 M0-6 压缩接管的验证。'],
  ['m10', 'space-default', 'recent', '今天把缓存双轨指标接进了 usage 日志。'],
  ['m11', 'space-default', 'working', '当前正在实现 M2 的本地向量检索。'],
  ['m12', 'space-default', 'working', '下一步要跑 30-50 条真实记忆的小评测。'],
  ['m13', 'space-work', 'fact', 'GitHub 仓库是 LSwzx/dsh-context-array，默认分支 main。'],
  ['m14', 'space-work', 'fact', 'GitHub 加速器 fastgithub 监听 127.0.0.1:443。'],
  ['m15', 'space-work', 'fact', 'hosts 文件把 github.com 指向 127.0.0.1。'],
  ['m16', 'space-work', 'fact', 'API 调用需要 GitHub token，存放在 git credential 里。'],
  ['m17', 'space-work', 'recent', '文档版本已经推进到 v4.1.7。'],
  ['m18', 'space-work', 'recent', 'M2 的 embedding 实验放在 worker_threads 里跑。'],
  ['m19', 'space-work', 'reflection', '先做受控实验再改架构，比拍脑袋靠谱。'],
  ['m20', 'space-work', 'working', '正在等 embedding 子代理回报 onnxruntime 能否加载。'],
  ['m21', 'space-default', 'fact', 'DeepSeek 缓存按小时级 TTL 失效，实测 13.5 小时仍命中。'],
  ['m22', 'space-default', 'fact', 'prompt_cache_hit_tokens 会被适配器折算成 cacheReadTokens。'],
  ['m23', 'space-default', 'fact', '工具声明在请求前缀里占比约九成。'],
  ['m24', 'space-default', 'fact', '系统提示词变化会追加新的 system 消息，不重写节点 0。'],
  ['m25', 'space-default', 'fact', '留言箱的主动唤醒需要冷却，避免多会话互相唤醒。'],
  ['m26', 'space-work', 'fact', '五维记忆是 working、recent、fact、reflection、personality。'],
  ['m27', 'space-work', 'fact', '检索融合用 RRF，k 取 60。'],
  ['m28', 'space-work', 'fact', '短查询不足 3 个字符时改用 LIKE 兜底。'],
  ['m29', 'space-work', 'fact', 'FTS5 使用 trigram 分词器以支持中文子串匹配。'],
  ['m30', 'space-work', 'fact', '向量模型是 multilingual-e5-small，384 维。'],
  ['m31', 'space-default', 'fact', 'e5 模型要求入库文本加 passage: 前缀，查询加 query: 前缀。'],
  ['m32', 'space-default', 'fact', '记忆条目通过 superseded_by 指针标记失效。'],
  ['m33', 'space-default', 'fact', '管理员会话是唯一能写正式记忆库的角色。'],
  ['m34', 'space-default', 'fact', '普通会话只能通过 memory_queue 提交候选记忆。'],
  ['m35', 'space-work', 'fact', 'WAL 模式加 busy_timeout 才能撑住多会话并发写。'],
  ['m36', 'space-work', 'fact', 'BLOB 读出必须拷贝，否则 byteOffset 不对齐会抛异常。'],
  ['m37', 'space-default', 'recent', 'M1 的 54 项测试已经扩到 111 项。'],
  ['m38', 'space-default', 'recent', '插件当前以 observe 模式接管压缩，不做折叠。'],
  ['m39', 'space-default', 'fact', '上下文窗口是 1048576 token。'],
  ['m40', 'space-default', 'fact', '压力超过窗口 80% 时插件会记录 compaction/alarm 事件。'],
]

/** [query, expectedId] — expected id must appear in the top-5 of a good retriever. */
const QUERIES = [
  ['深色主题', 'm01'],
  ['时区', 'm02'],
  ['pnpm 安装依赖', 'm03'],
  ['数据库用什么', 'm04'],
  ['配置目录在哪', 'm05'],
  ['CI 失败的教训', 'm06'],
  ['压缩的风险', 'm07'],
  ['GitHub 仓库地址', 'm13'],
  ['fastgithub 监听端口', 'm14'],
  ['token 存放位置', 'm16'],
  ['短查询兜底', 'm28'],
  ['向量模型维度', 'm30'],
  ['缓存 TTL 实测', 'm21'],
  ['并发写 SQLite', 'm35'],
  ['上下文窗口大小', 'm39'],
]

const TOP_K = 5

const round = (value, digits = 2) => Number(value.toFixed(digits))

function recallAtK(rankedIds, expectedId) {
  return rankedIds.slice(0, TOP_K).includes(expectedId) ? 1 : 0
}

function reciprocalRank(rankedIds, expectedId) {
  const index = rankedIds.indexOf(expectedId)
  return index < 0 ? 0 : 1 / (index + 1)
}

async function loadEmbedder() {
  try {
    const { createEmbeddingClient } = await import('../src/embedding/client.js')
    const client = createEmbeddingClient({ modelsDir })
    const info = await client.ready()
    return { client, info }
  } catch (error) {
    return { client: null, info: { error: String(error?.message ?? error) } }
  }
}

function vectorOnlySearch(db, spaceIds, queryVec, limit) {
  const rows = listActiveEmbeddings(db, spaceIds)
  const scored = []
  for (const row of rows) {
    if (row.vec.length !== queryVec.length) continue
    let dot = 0
    for (let i = 0; i < queryVec.length; i += 1) dot += row.vec[i] * queryVec[i]
    scored.push({ id: row.id, score: dot })
  }
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
  return scored.slice(0, limit)
}

async function run() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-array-eval-'))
  const store = openStore(resolveConfig({ dataDir }))
  const { db } = store
  migrate(db)

  const { client, info } = await loadEmbedder()
  const embedPassage = client ? (text) => client.embedPassage(text) : null

  const spaceIds = SPACES
  for (const [id, spaceId, dimension, content] of MEMORIES) {
    const embedding = embedPassage ? await embedPassage(content) : null
    insertMemory(db, { id, spaceId, dimension, content, embedding, sourceSessionId: 'eval-seed' })
  }

  const embedQuery = client ? (text) => client.embedQuery(text) : null
  // Compare RRF weightings on the same seeds/queries.
  const retriever = createRetriever({ db, embedQuery })
  const weightVariants = {
    'hybrid-1:1': createRetriever({ db, embedQuery, weights: { vector: 1, keyword: 1 } }),
    'hybrid-2:1': createRetriever({ db, embedQuery, weights: { vector: 2, keyword: 1 } }),
    'hybrid-3:1': createRetriever({ db, embedQuery, weights: { vector: 3, keyword: 1 } }),
  }
  const keywordOnly = createRetriever({ db, embedQuery: null })

  const modes = { hybrid: [], keywordOnly: [], vectorOnly: [] }
  for (const name of Object.keys(weightVariants)) modes[name] = []
  const timings = { hybrid: [], keywordOnly: [], vectorOnly: [] }
  for (const name of Object.keys(weightVariants)) timings[name] = []

  for (const [query, expectedId] of QUERIES) {
    let started = performance.now()
    const hybrid = await retriever.search({ spaceIds, query, limit: TOP_K })
    timings.hybrid.push(performance.now() - started)
    modes.hybrid.push({
      query,
      expectedId,
      ids: hybrid.items.map((item) => item.id),
      diagnostics: hybrid.diagnostics,
    })

    for (const [name, variant] of Object.entries(weightVariants)) {
      started = performance.now()
      const result = await variant.search({ spaceIds, query, limit: TOP_K })
      timings[name].push(performance.now() - started)
      modes[name].push({ query, expectedId, ids: result.items.map((item) => item.id) })
    }

    started = performance.now()
    const keyword = await keywordOnly.search({ spaceIds, query, limit: TOP_K })
    timings.keywordOnly.push(performance.now() - started)
    modes.keywordOnly.push({ query, expectedId, ids: keyword.items.map((item) => item.id) })

    if (client && embedQuery) {
      const queryVec = await embedQuery(query)
      started = performance.now()
      const vectors = vectorOnlySearch(db, spaceIds, queryVec, TOP_K)
      timings.vectorOnly.push(performance.now() - started)
      modes.vectorOnly.push({ query, expectedId, ids: vectors.map((row) => row.id) })
    }
  }

  const summary = {}
  for (const [mode, rows] of Object.entries(modes)) {
    if (rows.length === 0) continue
    summary[mode] = {
      queries: rows.length,
      recallAt5: round(rows.reduce((sum, row) => sum + recallAtK(row.ids, row.expectedId), 0) / rows.length, 4),
      mrr: round(rows.reduce((sum, row) => sum + reciprocalRank(row.ids, row.expectedId), 0) / rows.length, 4),
      latencyMsMedian: round(timings[mode].sort((a, b) => a - b)[Math.floor(timings[mode].length / 2)], 2),
    }
  }

  const failures = {
    hybrid: modes.hybrid.filter((row) => !recallAtK(row.ids, row.expectedId)).map((row) => `${row.query} → ${row.expectedId}`),
    keywordOnly: modes.keywordOnly.filter((row) => !recallAtK(row.ids, row.expectedId)).map((row) => `${row.query} → ${row.expectedId}`),
    vectorOnly: modes.vectorOnly.filter((row) => !recallAtK(row.ids, row.expectedId)).map((row) => `${row.query} → ${row.expectedId}`),
  }

  const result = {
    memories: MEMORIES.length,
    queries: QUERIES.length,
    spaces: SPACES.length,
    embedding: client
      ? { model: info.model, dimensions: info.dimensions, loadMs: info.loadMs }
      : { unavailable: info.error },
    summary,
    failures,
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`memories=${result.memories} queries=${result.queries} spaces=${result.spaces}`)
    console.log(`embedding=${JSON.stringify(result.embedding)}`)
    for (const [mode, values] of Object.entries(summary)) {
      console.log(`${mode.padEnd(12)} recall@${TOP_K}=${values.recallAt5}  mrr=${values.mrr}  median=${values.latencyMsMedian}ms`)
    }
    for (const [mode, list] of Object.entries(failures)) {
      if (list.length) console.log(`misses[${mode}]: ${list.join(', ')}`)
    }
  }

  if (client) await client.close()
  store.close()
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

await run()
