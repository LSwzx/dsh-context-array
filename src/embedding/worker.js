/**
 * Embedding worker — the only place that touches the ONNX model.
 *
 * The Host main process runs the UI and the agent loop; loading a 118 MB ONNX
 * graph and running CPU inference there would stall every timer, stream and IPC
 * reply. This module is therefore a `worker_threads` entry point only: it loads
 * `Xenova/multilingual-e5-small` once, then turns `embed` requests into unit-length
 * 384-dimensional `Float32Array` vectors.
 *
 * Protocol (structured clone; the vector's buffer is transferred, not copied):
 *   main -> worker  { id, type: 'init', modelsDir, dtype }
 *                   { id, type: 'embed', text }          // text already carries 'passage: '/'query: '
 *                   { type: 'close' }                    // optional courtesy shutdown
 *   worker -> main  { id, type: 'ready', model, dimensions, loadMs, warmMs, dtype }
 *                   { id, type: 'result', vector: Float32Array, ms }
 *                   { id, type: 'error', message, name }
 *
 * A request that cannot be served gets an `error` reply; the worker never throws
 * out of its message handler, because an uncaught throw would kill the worker and
 * every request queued behind it.
 */
import path from 'node:path'
import { parentPort } from 'node:worker_threads'

/** The one model this layer supports. e5 requires the instruction prefixes below. */
export const MODEL_ID = 'Xenova/multilingual-e5-small'

/** `multilingual-e5-small` hidden size. Every vector crossing the wire has this length. */
export const DIMENSIONS = 384

/** Quantized int8 weights: 118 MB, and by far the best latency on this CPU. */
export const DEFAULT_DTYPE = 'q8'

/** e5-family instruction prefixes. Both must be present; they are not interchangeable. */
export const PREFIX = Object.freeze({
  passage: 'passage: ',
  query: 'query: ',
})

/** How far the norm may drift from 1 before the worker treats it as a contract violation. */
const NORM_TOLERANCE = 1e-4

/**
 * Apply the e5 instruction prefix for `kind`.
 *
 * Texts that already carry the prefix are left alone, so a caller that pre-formats
 * its input cannot end up with `passage: passage: ...` (which measurably changes
 * the embedding).
 *
 * @param {'passage' | 'query'} kind
 * @param {string} text
 * @returns {string}
 */
export function prefixedText(kind, text) {
  if (kind !== 'passage' && kind !== 'query') {
    throw new TypeError(`unsupported embedding kind: ${String(kind)}`)
  }
  if (typeof text !== 'string') throw new TypeError('embedding text must be a string')
  if (text.trim() === '') throw new TypeError('embedding text must not be blank')
  const prefix = PREFIX[kind]
  return text.startsWith(prefix) ? text : prefix + text
}

/**
 * Euclidean length of a vector.
 *
 * @param {ArrayLike<number>} vector
 * @returns {number}
 */
export function l2Norm(vector) {
  let sum = 0
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index]
    sum += value * value
  }
  return Math.sqrt(sum)
}

/**
 * Scale `vector` to unit length in place and return it. Throws on a zero or
 * non-finite norm: a normalized zero vector does not exist.
 *
 * @param {Float32Array} vector
 * @returns {Float32Array}
 */
export function normalizeL2(vector) {
  const norm = l2Norm(vector)
  if (!Number.isFinite(norm) || norm <= 0) {
    throw new Error(`cannot normalize a vector with norm ${norm}`)
  }
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm
  return vector
}

/** @type {null | { model: string, dimensions: number, dtype: string, loadMs: number, warmMs: number }} */
let loadInfo = null

let extractor = null
/** Deduplicates concurrent inits; cleared on failure so a retry can re-load. */
let loadPromise = null

/**
 * Load the ONNX model with remote access hard-disabled.
 *
 * `localModelPath` is the models root and `MODEL_ID` the repository-shaped
 * subdirectory, so the files on disk are exactly what a plain
 * `huggingface-cli download` would produce (see `tools/fetch-model.mjs`).
 *
 * @param {{ modelsDir: string, dtype?: string }} options
 * @returns {Promise<NonNullable<typeof loadInfo>>}
 */
function load({ modelsDir, dtype = DEFAULT_DTYPE }) {
  if (loadInfo) return Promise.resolve(loadInfo)
  if (loadPromise) return loadPromise

  loadPromise = (async () => {
    if (typeof modelsDir !== 'string' || modelsDir.trim() === '') {
      throw new Error('embedding worker: modelsDir is required')
    }
    const startedAt = Date.now()

    // Keep the heavy import out of the main thread: `client.js` imports this
    // module for its constants, and must not pay for onnxruntime there.
    const { env, pipeline } = await import('@huggingface/transformers')

    // The Host must never reach the network: a missing file is a local error with
    // a local path in it, not a 30 s hang on a blocked host.
    env.allowRemoteModels = false
    env.allowLocalModels = true
    env.localModelPath = path.resolve(modelsDir)
    env.useFSCache = false

    extractor = await pipeline('feature-extraction', MODEL_ID, {
      dtype,
      device: 'cpu',
      local_files_only: true,
    })

    // Warm-up: the first inference pays graph allocation and arena growth. Doing
    // it here keeps the first real passage latency representative.
    const warmStartedAt = Date.now()
    const warm = await extractor(PREFIX.passage + 'warmup', {
      pooling: 'mean',
      normalize: true,
    })
    if (!(warm?.data instanceof Float32Array) || warm.data.length !== DIMENSIONS) {
      throw new Error(
        `embedding worker: warm-up returned ${warm?.data?.length ?? 'no'} components, expected ${DIMENSIONS}`,
      )
    }

    loadInfo = {
      model: MODEL_ID,
      dimensions: DIMENSIONS,
      dtype,
      loadMs: warmStartedAt - startedAt,
      warmMs: Date.now() - warmStartedAt,
    }
    return loadInfo
  })().catch((error) => {
    loadPromise = null
    extractor = null
    throw error
  })

  return loadPromise
}

/**
 * Embed one already-prefixed text.
 *
 * @param {string} text
 * @returns {Promise<{ vector: Float32Array, ms: number }>}
 */
async function embed(text) {
  if (!extractor) throw new Error('embedding worker: model is not loaded yet')
  if (typeof text !== 'string' || text.trim() === '') {
    throw new TypeError('embedding worker: text must be a non-blank string')
  }
  const startedAt = performance.now()
  const output = await extractor(text, { pooling: 'mean', normalize: true })
  const data = output?.data
  if (!(data instanceof Float32Array)) {
    throw new Error(
      `embedding worker: unexpected output type ${data?.constructor?.name ?? typeof data}`,
    )
  }
  if (data.length !== DIMENSIONS) {
    throw new Error(
      `embedding worker: model returned ${data.length} components, expected ${DIMENSIONS}`,
    )
  }

  // `normalize: true` already scaled the vector; normalizing again is idempotent
  // up to float rounding and turns the "is it unit length" claim into an assertion.
  const vector = normalizeL2(data)
  const drift = Math.abs(l2Norm(vector) - 1)
  if (drift > NORM_TOLERANCE) {
    throw new Error(`embedding worker: vector norm drifted by ${drift} after normalization`)
  }
  return { vector, ms: performance.now() - startedAt }
}

/**
 * Serialize every request through one promise chain. The client already queues,
 * but a second line of defence means two messages can never share the ONNX arena
 * state and a failed request cannot wedge the ones behind it.
 *
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
let tail = Promise.resolve()
function enqueue(task) {
  const next = tail.then(task, task)
  tail = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

/**
 * @param {Record<string, unknown>} message
 * @param {Transferable[]} [transfer]
 */
function post(message, transfer) {
  parentPort?.postMessage(message, transfer)
}

if (parentPort) {
  parentPort.on('message', (request) => {
    const { id, type } = request ?? {}
    if (type === 'close') {
      parentPort.close()
      return
    }
    enqueue(async () => {
      try {
        if (type === 'init') {
          const info = await load(request)
          post({ id, type: 'ready', ...info })
          return
        }
        if (type === 'embed') {
          const { vector, ms } = await embed(request.text)
          post({ id, type: 'result', vector, ms }, [vector.buffer])
          return
        }
        throw new Error(`embedding worker: unknown request type ${String(type)}`)
      } catch (error) {
        try {
          post({
            id,
            type: 'error',
            message: error?.message ?? String(error),
            name: error?.name ?? 'Error',
          })
        } catch {
          // The parent port is already gone; there is nobody left to tell.
        }
      }
    })
  })
}
