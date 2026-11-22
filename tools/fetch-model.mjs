#!/usr/bin/env node
/**
 * Download the local embedding model from hf-mirror.com.
 *
 * The model is **not** vendored into git. It lives next to the plugin data
 * (`%USERPROFILE%\.dsh\context-array\models\Xenova\multilingual-e5-small`) and is
 * loaded by `src/embedding/worker.js` through `@huggingface/transformers` with
 * remote access disabled, so a missing file is a hard, local, diagnosable error.
 *
 * Usage:
 *   node tools/fetch-model.mjs                    # q8 weights into the default data dir
 *   node tools/fetch-model.mjs --dtype fp32       # full-precision weights (470 MB)
 *   node tools/fetch-model.mjs --check            # report state, exit 1 when incomplete
 *   node tools/fetch-model.mjs --force            # re-download even when complete
 *   node tools/fetch-model.mjs --models-dir D:\models --mirror https://hf-mirror.com
 *
 * Behaviour:
 *   - idempotent: a file whose size matches the mirror manifest is skipped;
 *   - resumable: a partial transfer is continued with an HTTP Range request and
 *     only renamed into place once the byte count (and, when the mirror exposes
 *     it, the LFS sha256) checks out;
 *   - serial: one file at a time, which keeps the mirror happy and the progress
 *     readable.
 */
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

/** Repository of the model. `Xenova/*` is the ONNX conversion this layer targets. */
export const MODEL_REPO = 'Xenova/multilingual-e5-small'

/** Default mirror. hf-mirror.com mirrors huggingface.co and is reachable here. */
export const DEFAULT_MIRROR = 'https://hf-mirror.com'

/** Quantized int8 weights: 118 MB and the accuracy/latency sweet spot on CPU. */
export const DEFAULT_DTYPE = 'q8'

/** Metadata files every ONNX conversion needs (tokenizer + model config). */
const COMMON_FILES = Object.freeze([
  'config.json',
  'special_tokens_map.json',
  'tokenizer_config.json',
  'tokenizer.json',
])

/** Weight files, keyed by the dtype names `@huggingface/transformers` uses. */
export const ONNX_FILES = Object.freeze({
  q8: 'onnx/model_quantized.onnx',
  fp32: 'onnx/model.onnx',
  fp16: 'onnx/model_fp16.onnx',
  int8: 'onnx/model_int8.onnx',
  uint8: 'onnx/model_uint8.onnx',
  q4: 'onnx/model_q4.onnx',
  q4f16: 'onnx/model_q4f16.onnx',
  bnb4: 'onnx/model_bnb4.onnx',
})

/** `%USERPROFILE%\.dsh\context-array\models`, the same root the plugin config uses. */
export function defaultModelsDir() {
  return path.join(os.homedir(), '.dsh', 'context-array', 'models')
}

/**
 * The directory `@huggingface/transformers` resolves `Xenova/multilingual-e5-small`
 * to when `env.localModelPath` is the models root.
 *
 * @param {string} modelsDir
 * @returns {string}
 */
export function modelDirFor(modelsDir = defaultModelsDir()) {
  return path.join(modelsDir, ...MODEL_REPO.split('/'))
}

/**
 * File list needed to run the model for a given dtype.
 *
 * @param {string} [dtype]
 * @returns {string[]}
 */
export function filesForDtype(dtype = DEFAULT_DTYPE) {
  const onnx = ONNX_FILES[dtype]
  if (!onnx) {
    throw new Error(
      `unknown dtype "${dtype}"; supported: ${Object.keys(ONNX_FILES).join(', ')}`,
    )
  }
  return [...COMMON_FILES, onnx]
}

/**
 * hf-mirror download URL for one repository file.
 *
 * @param {string} mirror
 * @param {string} file
 * @param {string} [repo]
 * @returns {string}
 */
export function downloadUrlFor(mirror, file, repo = MODEL_REPO) {
  const base = mirror.replace(/\/+$/, '')
  const encoded = file.split('/').map(encodeURIComponent).join('/')
  return `${base}/${repo}/resolve/main/${encoded}`
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/** @param {number} ms */
function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

/**
 * File sizes / sha256 digests advertised by the mirror.
 *
 * @param {string} mirror
 * @param {string} [repo]
 * @returns {Promise<Map<string, { size: number, sha256: string | null }>>}
 */
async function fetchManifest(mirror, repo = MODEL_REPO) {
  const url = `${mirror.replace(/\/+$/, '')}/api/models/${repo}/tree/main?recursive=true`
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  const rows = await response.json()
  /** @type {Map<string, { size: number, sha256: string | null }>} */
  const manifest = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.type !== 'file' || typeof row.path !== 'string') continue
    manifest.set(row.path, {
      size: Number(row.size) || 0,
      sha256: typeof row.lfs?.oid === 'string' ? row.lfs.oid : null,
    })
  }
  return manifest
}

/** Size of `file`, or 0 when it does not exist. */
async function sizeOf(file) {
  try {
    return (await fsp.stat(file)).size
  } catch {
    return 0
  }
}

/** sha256 of a file, streamed so a 118 MB weight file never lands in memory twice. */
async function sha256Of(file) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * One download attempt, resuming from whatever is already in `partPath`.
 *
 * @param {string} url
 * @param {string} partPath
 * @param {{ expectedSize: number, log: (line: string) => void }} options
 * @returns {Promise<number>} bytes written by this attempt
 */
async function downloadAttempt(url, partPath, { expectedSize, log }) {
  const offset = await sizeOf(partPath)
  if (expectedSize > 0 && offset > expectedSize) {
    // A stale oversized partial cannot be trusted: start over.
    await fsp.rm(partPath, { force: true })
    return 0
  }
  if (expectedSize > 0 && offset === expectedSize) return 0

  const headers = offset > 0 ? { range: `bytes=${offset}-` } : {}
  const response = await fetch(url, { headers, redirect: 'follow' })
  if (response.status === 416) {
    // The partial no longer matches the remote file; restart cleanly.
    await fsp.rm(partPath, { force: true })
    throw new Error(`range not satisfiable for ${url}; deleted partial file`)
  }
  if (!response.ok) {
    const hint =
      response.status === 404
        ? ' (file missing on the mirror - check --dtype, or the mirror is stale)'
        : ''
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}${hint}`)
  }
  const resumed = response.status === 206 && offset > 0
  if (!resumed && offset > 0) await fsp.rm(partPath, { force: true })

  const remaining = Number(response.headers.get('content-length')) || 0
  const total = expectedSize > 0 ? expectedSize : (resumed ? offset : 0) + remaining
  const out = fs.createWriteStream(partPath, { flags: resumed ? 'a' : 'w' })
  let written = resumed ? offset : 0
  const startedAt = Date.now()
  let lastReportAt = 0
  let lastReported = written

  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      written += chunk.length
      if (!out.write(chunk)) await once(out, 'drain')
      const now = Date.now()
      if (now - lastReportAt >= 500) {
        const pct = total > 0 ? ((written / total) * 100).toFixed(1) : '?'
        const rate = (written - lastReported) / ((now - lastReportAt) / 1000)
        log(
          `      ${pct}%  ${formatBytes(written)}${total > 0 ? ` / ${formatBytes(total)}` : ''}` +
            `  ${formatBytes(rate)}/s`,
        )
        lastReportAt = now
        lastReported = written
      }
    }
    await new Promise((resolve, reject) => {
      out.end((error) => (error ? reject(error) : resolve()))
    })
  } catch (error) {
    out.destroy()
    throw error
  }

  const elapsed = Math.max(1, Date.now() - startedAt)
  if (expectedSize > 0 && written !== expectedSize) {
    throw new Error(
      `size mismatch for ${url}: got ${written}, expected ${expectedSize}` +
        ' (the partial file is kept so the next run can resume)',
    )
  }
  log(
    `      ${formatBytes(written)} in ${formatDuration(elapsed)}` +
      ` (${formatBytes((written / elapsed) * 1000)}/s)`,
  )
  return written
}

/**
 * Download one file into place, resuming and retrying as needed.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {string} options.dest
 * @param {number} [options.expectedSize]
 * @param {string | null} [options.sha256]
 * @param {boolean} [options.force]
 * @param {number} [options.retries]
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<{ skipped: boolean, size: number, ms: number }>}
 */
export async function downloadFile({
  url,
  dest,
  expectedSize = 0,
  sha256 = null,
  force = false,
  retries = 3,
  log = () => {},
}) {
  const partPath = `${dest}.part`
  await fsp.mkdir(path.dirname(dest), { recursive: true })

  const current = await sizeOf(dest)
  if (!force && current > 0 && (expectedSize === 0 || current === expectedSize)) {
    log(`    exists (${formatBytes(current)}) - skipped`)
    return { skipped: true, size: current, ms: 0 }
  }
  if (force) await fsp.rm(dest, { force: true })

  const startedAt = Date.now()
  let attempt = 0
  for (;;) {
    attempt += 1
    try {
      const offset = await sizeOf(partPath)
      if (offset > 0) log(`    resuming at ${formatBytes(offset)}`)
      await downloadAttempt(url, partPath, { expectedSize, log })
      break
    } catch (error) {
      if (attempt >= retries) {
        throw new Error(`download failed after ${attempt} attempts: ${error.message}`)
      }
      log(`    retry ${attempt}/${retries - 1} in ${attempt}s: ${error.message}`)
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
    }
  }

  const size = await sizeOf(partPath)
  if (expectedSize > 0 && size !== expectedSize) {
    throw new Error(`size mismatch for ${dest}: ${size} != ${expectedSize}`)
  }
  if (sha256) {
    const actual = await sha256Of(partPath)
    if (actual !== sha256) {
      await fsp.rm(partPath, { force: true })
      throw new Error(`sha256 mismatch for ${dest}: ${actual} != ${sha256}`)
    }
    log('    sha256 ok')
  }
  await fsp.rename(partPath, dest)
  return { skipped: false, size, ms: Date.now() - startedAt }
}

/**
 * Download every file the model needs. Idempotent: call it as often as you like.
 *
 * @param {object} [options]
 * @param {string} [options.modelsDir] models root (default `~/.dsh/context-array/models`)
 * @param {string} [options.mirror]
 * @param {string} [options.repo]
 * @param {string} [options.dtype] q8 | fp32 | fp16 | int8 | uint8 | q4 | q4f16 | bnb4
 * @param {boolean} [options.force]
 * @param {boolean} [options.offlineManifest] skip the mirror manifest (only size-check local files)
 * @param {number} [options.retries]
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<{
 *   modelDir: string, dtype: string, files: Array<{ path: string, size: number, skipped: boolean }>,
 *   downloadedBytes: number, elapsedMs: number,
 * }>}
 */
export async function fetchModel({
  modelsDir = defaultModelsDir(),
  mirror = DEFAULT_MIRROR,
  repo = MODEL_REPO,
  dtype = DEFAULT_DTYPE,
  force = false,
  offlineManifest = false,
  retries = 3,
  log = () => {},
} = {}) {
  const files = filesForDtype(dtype)
  const modelDir = path.join(modelsDir, ...repo.split('/'))

  /** @type {Map<string, { size: number, sha256: string | null }>} */
  let manifest = new Map()
  if (!offlineManifest) {
    try {
      manifest = await fetchManifest(mirror, repo)
      log(`manifest: ${manifest.size} files from ${mirror}`)
    } catch (error) {
      log(`manifest unavailable (${error.message}); falling back to content-length checks`)
    }
  }

  /** @type {Array<{ path: string, size: number, skipped: boolean }>} */
  const results = []
  let downloadedBytes = 0
  const startedAt = Date.now()

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]
    const dest = path.join(modelDir, ...file.split('/'))
    const entry = manifest.get(file)
    log(`[${index + 1}/${files.length}] ${file}${entry ? ` (${formatBytes(entry.size)})` : ''}`)
    const result = await downloadFile({
      url: downloadUrlFor(mirror, file, repo),
      dest,
      expectedSize: entry?.size ?? 0,
      sha256: entry?.sha256 ?? null,
      force,
      retries,
      log,
    })
    if (!result.skipped) downloadedBytes += result.size
    results.push({ path: file, size: result.size, skipped: result.skipped })
  }

  return { modelDir, dtype, files: results, downloadedBytes, elapsedMs: Date.now() - startedAt }
}

/**
 * Offline-ish completeness check: compares local sizes with the mirror manifest when
 * it is reachable, and otherwise only requires every file to exist and be non-empty.
 *
 * @param {object} [options]
 * @param {string} [options.modelsDir]
 * @param {string} [options.dtype]
 * @param {string} [options.mirror]
 * @returns {Promise<{ complete: boolean, missing: string[], modelDir: string, totalBytes: number }>}
 */
export async function checkModel({
  modelsDir = defaultModelsDir(),
  dtype = DEFAULT_DTYPE,
  mirror = DEFAULT_MIRROR,
} = {}) {
  const files = filesForDtype(dtype)
  const modelDir = modelDirFor(modelsDir)
  let manifest = new Map()
  try {
    manifest = await fetchManifest(mirror)
  } catch {
    manifest = new Map()
  }
  const missing = []
  let totalBytes = 0
  for (const file of files) {
    const actual = await sizeOf(path.join(modelDir, ...file.split('/')))
    const expected = manifest.get(file)?.size ?? 0
    totalBytes += actual
    if (actual === 0 || (expected > 0 && actual !== expected)) missing.push(file)
  }
  return { complete: missing.length === 0, missing, modelDir, totalBytes }
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = {
    modelsDir: defaultModelsDir(),
    mirror: DEFAULT_MIRROR,
    dtype: DEFAULT_DTYPE,
    force: false,
    check: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--models-dir':
        options.modelsDir = path.resolve(argv[++index] ?? '')
        break
      case '--mirror':
        options.mirror = argv[++index] ?? DEFAULT_MIRROR
        break
      case '--dtype':
        options.dtype = argv[++index] ?? DEFAULT_DTYPE
        break
      case '--force':
        options.force = true
        break
      case '--check':
        options.check = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

/**
 * CLI entry point. Returns the process exit code instead of calling exit(), so a
 * test can drive it without killing the runner.
 *
 * @param {string[]} [argv]
 * @param {{ log?: (line: string) => void }} [io]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), { log = console.log } = {}) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    log(`fetch-model: ${error.message}`)
    return 2
  }
  if (options.help) {
    log('usage: node tools/fetch-model.mjs [--models-dir DIR] [--mirror URL] [--dtype q8|fp32|...] [--check] [--force]')
    return 0
  }
  if (!options.dtype || !ONNX_FILES[options.dtype]) {
    log(`fetch-model: unknown dtype "${options.dtype}"; supported: ${Object.keys(ONNX_FILES).join(', ')}`)
    return 2
  }

  if (options.check) {
    const state = await checkModel(options)
    log(`${state.complete ? 'complete' : 'incomplete'}: ${state.modelDir}`)
    log(`  ${state.complete ? 'all files present' : `missing: ${state.missing.join(', ')}`}`)
    log(`  bytes on disk: ${formatBytes(state.totalBytes)}`)
    return state.complete ? 0 : 1
  }

  log(`fetch-model: ${MODEL_REPO} (${options.dtype}) -> ${modelDirFor(options.modelsDir)}`)
  const result = await fetchModel({ ...options, log })
  const skipped = result.files.filter((file) => file.skipped).length
  log('')
  log(
    `done in ${formatDuration(result.elapsedMs)}: ` +
      `${result.files.length - skipped} downloaded (${formatBytes(result.downloadedBytes)}), ${skipped} already present`,
  )
  log(`model dir: ${result.modelDir}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(`fetch-model failed: ${error?.stack ?? error}`)
      process.exitCode = 1
    },
  )
}
