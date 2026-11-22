// Seed the live store with a few memories so `memory_search` has something to
// return during the M2 end-to-end check. Idempotent by fixed ids.
import os from 'node:os'
import path from 'node:path'

import { resolveConfig } from '../src/config.js'
import { openStore } from '../src/db.js'
import { insertMemory, countMemories } from '../src/db-memories.js'
import { createEmbeddingClient } from '../src/embedding/client.js'

const dataDir = path.join(os.homedir(), '.dsh', 'context-array')
const config = resolveConfig({ dataDir })
const store = openStore(config)

const SEEDS = [
  ['seed-theme', 'fact', '用户偏好深色主题：界面默认使用暗色配色，避免纯白背景。'],
  ['seed-github', 'fact', '本项目的 GitHub 仓库是 LSwzx/dsh-context-array，默认分支 main，推送走 fastgithub 加速。'],
  ['seed-cache', 'reflection', 'DeepSeek 前缀缓存实测很耐用：13.5 小时空闲后首个请求仍命中；改提示词不会重写系统节点 0。'],
]

const client = createEmbeddingClient({ modelsDir: config.modelsDir })
const info = await client.ready()
console.log(`embedding ${info.model} dims=${info.dimensions} loadMs=${info.loadMs}`)

for (const [id, dimension, content] of SEEDS) {
  const embedding = await client.embedPassage(content)
  insertMemory(store.db, {
    id,
    spaceId: config.spaceId,
    dimension,
    content,
    embedding,
    sourceSessionId: 'lead-seed',
  })
  console.log(`seeded ${id} (${dimension}) vec=${embedding.length}`)
}

console.log('counts:', JSON.stringify(countMemories(store.db)))
await client.close()
store.close()
