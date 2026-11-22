/**
 * Embedding client — the main-thread face of the worker in `./worker.js`.
 *
 * Contract (what `index.js` wires against):
 *   const client = createEmbeddingClient({ modelsDir, onError })
 *   await client.ready()                   // -> { model, dimensions, loadMs }
 *   await client.embedPassage(text)        // -> Float32Array(384), unit length
 *   await client.embedQuery(text)          // -> Float32Array(384), unit length
 *   client.stats()                         // -> { requests, failures, lastMs }
 *   await client.close()                   // idempotent
 *
 * Guarantees:
 *   - one worker, one request in flight: concurrent calls queue instead of fighting
 *     over the ONNX session;
 *   - every call is bounded by `timeoutMs` (default 30 s); a timed-out worker is
 *     killed, because one that cannot answer is not worth keeping;
 *   - a crash never leaks out of this module: queued callers get a rejected
 *     promise, `onError` hears about it, and the next call starts a fresh worker
 *     (bounded by `maxRestarts`, default 1 consecutive crash).
 *
 * The client deliberately does not import `@huggingface/transformers`; importing
 * this file costs nothing and loads no native code.
 */
import { Worker } from 'node:worker_threads'

import {
  DEFAULT_DTYPE,
  DIMENSIONS,
  MODEL_ID,
  l2Norm,
  normalizeL2,
  prefixedText,
} from './worker.js'

/** Default per-request budget. A 384-d embedding normally takes tens of milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Model load is slower than inference: first run reads and parses 118 MB of weights. */
export const DEFAULT_INIT_TIMEOUT_MS = 120_000

/** Unit-length tolerance. The worker asserts tighter than this; this is the client's check. */
const NORM_TOLERANCE = 1e-3

/** Consecutive crashes tolerated before the client fails closed. */
const DEFAULT_MAX_RESTARTS = 1

const DEFAULT_WORKER_URL = new URL('./worker.js', import.meta.url)

/**
 * @typedef {object} EmbeddingClient
 * @property {() => Promise<{ model: string, dimensions: number, loadMs: number }>} ready
 * @property {(text: string) => Promise<Float32Array>} embedPassage
 * @property {(text: string) => Promise<Float32Array>} embedQuery
 * @property {() => { requests: number, failures: number, lastMs: number }} stats
 * @property {() => Promise<void>} close
 */

/**
 * Create the main-thread embedding client. No worker is spawned until the first
 * `ready()` / `embed*()` call, so wiring this into `apply()` costs nothing.
 *
 * @param {object} options
 * @param {string} options.modelsDir Models root; the model lives at `<modelsDir>/Xenova/multilingual-e5-small`.
 * @param {(error: Error) => void} [options.onError] Diagnostics sink; must never throw.
 * @param {number} [options.timeoutMs] Per-embedding budget (default 30 s).
 * @param {number} [options.initTimeoutMs] Model-load budget (default 120 s).
 * @param {string} [options.dtype] Weight file kind (default q8).
 * @param {URL | string} [options.workerUrl] Worker entry; only tests override this.
 * @param {number} [options.maxRestarts] Consecutive crashes tolerated (default 1).
 * @returns {EmbeddingClient}
 */
export function createEmbeddingClient({
  modelsDir,
  onError,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  initTimeoutMs = DEFAULT_INIT_TIMEOUT_MS,
  dtype = DEFAULT_DTYPE,
  workerUrl = DEFAULT_WORKER_URL,
  maxRestarts = DEFAULT_MAX_RESTARTS,
} = {}) {
  if (typeof modelsDir !== 'string' || modelsDir.trim() === '') {
    throw new TypeError('createEmbeddingClient: modelsDir must be a non-empty string')
  }
  if (typeof timeoutMs !== 'number' || !(timeoutMs > 0)) {
    throw new TypeError('createEmbeddingClient: timeoutMs must be a positive number')
  }

  const modelsRoot = modelsDir.trim()
  const stats = { requests: 0, failures: 0, lastMs: 0 }

  /** @type {Worker | null} */
  let worker = null
  /** @type {Promise<{ model: string, dimensions: number, loadMs: number }> | null} */
  let readyPromise = null
  /** @type {{ model: string, dimensions: number, loadMs: number } | null} */
  let readyInfo = null
  let closed = false
  /** @type {Error | null} */
  let fatalError = null
  let consecutiveCrashes = 0
  let spawnCount = 0
  let nextId = 1

  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }>} */
  const pending = new Map()
  let queueTail = Promise.resolve()

  const reportError = (error) => {
    try {
      onError?.(error)
    } catch {
      // An error sink must never take the embedding path down with it.
    }
  }

  const closedError = () => {
    const error = new Error('embedding client is closed')
    error.code = 'EMBEDDING_CLOSED'
    return error
  }

  const timeoutError = (what, budget) => {
    const error = new Error(`embedding ${what} exceeded ${budget} ms`)
    error.code = 'EMBEDDING_TIMEOUT'
    return error
  }

  const unstableError = () => {
    const error = new Error(
      `embedding worker crashed ${consecutiveCrashes} times without a successful request; ` +
        'refusing further calls until close()',
    )
    error.code = 'EMBEDDING_WORKER_UNSTABLE'
    return error
  }

  /** Reject everything in flight with `error`; nothing is left dangling. */
  function rejectPending(error) {
    const entries = [...pending.values()]
    pending.clear()
    for (const entry of entries) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }

  /** Drop the current worker (if any) and fail every request it owed. */
  function abortWorker(error) {
    const current = worker
    worker = null
    readyPromise = null
    readyInfo = null
    rejectPending(error)
    if (current) {
      current.removeAllListeners('message')
      current.removeAllListeners('error')
      current.removeAllListeners('exit')
      current.terminate().catch(() => {
        // Already gone; nothing to clean up.
      })
    }
  }

  function spawn() {
    const spawned = new Worker(workerUrl, { name: 'context-array-embedding' })
    spawnCount += 1
    spawned.on('message', (message) => handleMessage(spawned, message))
    spawned.on('error', (error) => {
      if (worker !== spawned) return
      // `exit` always follows; that handler owns the bookkeeping.
      reportError(error)
    })
    spawned.on('exit', (code) => handleExit(spawned, code))
    return spawned
  }

  function ensureWorker() {
    if (closed) throw closedError()
    if (fatalError) throw fatalError
    if (!worker) worker = spawn()
    return worker
  }

  /**
   * @param {Worker} source
   * @param {any} message
   */
  function handleMessage(source, message) {
    if (worker !== source) return
    const { id, type } = message ?? {}
    if (typeof id !== 'number' || typeof type !== 'string') {
      reportError(new Error('embedding worker sent a malformed message'))
      return
    }
    const entry = pending.get(id)
    // No entry means the request timed out and was already rejected: drop the
    // late reply instead of resolving a promise nobody is waiting for.
    if (!entry) return
    pending.delete(id)
    clearTimeout(entry.timer)
    if (type === 'error') {
      const error = new Error(message.message ?? 'embedding worker error')
      error.code = 'EMBEDDING_WORKER_ERROR'
      entry.reject(error)
      return
    }
    entry.resolve(message)
  }

  /**
   * @param {Worker} source
   * @param {number} code
   */
  function handleExit(source, code) {
    if (worker !== source) return
    worker = null
    readyPromise = null
    readyInfo = null
    consecutiveCrashes += 1
    const error = new Error(`embedding worker exited unexpectedly (code ${code})`)
    error.code = 'EMBEDDING_WORKER_EXITED'
    reportError(error)
    rejectPending(error)
    if (consecutiveCrashes > maxRestarts) {
      fatalError = unstableError()
      reportError(fatalError)
    }
  }

  /**
   * Post one request and wait for its reply, bounded by `budget`.
   *
   * @param {Record<string, unknown>} request
   * @param {number} budget
   * @returns {Promise<any>}
   */
  function send(request, budget) {
    return new Promise((resolve, reject) => {
      let target
      try {
        target = ensureWorker()
      } catch (error) {
        reject(error)
        return
      }
      const { id } = request
      if (typeof id !== 'number') {
        reject(new Error('embedding request is missing its id'))
        return
      }
      const timer = setTimeout(() => {
        const entry = pending.get(id)
        if (!entry) return
        pending.delete(id)
        consecutiveCrashes += 1
        const error = timeoutError(request.type === 'init' ? 'model load' : 'request', budget)
        reportError(error)
        // A worker that missed its budget is stuck, not slow. Kill it so the next
        // call can start clean; the crash budget still applies.
        abortWorker(error)
        if (consecutiveCrashes > maxRestarts) {
          fatalError = unstableError()
          reportError(fatalError)
        }
        entry.reject(error)
      }, budget)
      timer.unref?.()
      pending.set(id, { resolve, reject, timer })
      try {
        target.postMessage(request)
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error)
      }
    })
  }

  /**
   * The worker reports the vector only after pooling and normalization, so the
   * only remaining job here is to hold it to the wire contract.
   *
   * @param {unknown} vector
   * @returns {Float32Array}
   */
  function assertUnitVector(vector) {
    if (!(vector instanceof Float32Array)) {
      throw new Error('embedding worker returned a non-Float32Array result')
    }
    if (vector.length !== DIMENSIONS) {
      throw new Error(
        `embedding worker returned ${vector.length} components, expected ${DIMENSIONS}`,
      )
    }
    const norm = l2Norm(vector)
    if (!Number.isFinite(norm) || norm <= 0) {
      throw new Error(`embedding worker returned a vector with norm ${norm}`)
    }
    if (Math.abs(norm - 1) > NORM_TOLERANCE) {
      // The worker is supposed to normalize. Rather than hand a caller a vector
      // that breaks cosine similarity, repair it and say so loudly.
      normalizeL2(vector)
      reportError(
        Object.assign(
          new Error(`embedding worker returned |v|=${norm.toFixed(6)}; renormalized on the client`),
          { code: 'EMBEDDING_UNNORMALIZED' },
        ),
      )
    }
    return vector
  }

  function init() {
    return send(
      { id: nextId++, type: 'init', modelsDir: modelsRoot, dtype },
      initTimeoutMs,
    ).then((message) => {
      const info = {
        model: typeof message.model === 'string' ? message.model : MODEL_ID,
        dimensions: Number(message.dimensions),
        loadMs: Math.round(Number(message.loadMs) || 0),
      }
      if (info.dimensions !== DIMENSIONS) {
        throw new Error(
          `embedding model reported ${info.dimensions} dimensions, expected ${DIMENSIONS}`,
        )
      }
      readyInfo = info
      return info
    })
  }

  function ready() {
    if (closed) return Promise.reject(closedError())
    if (fatalError) return Promise.reject(fatalError)
    if (readyInfo) return Promise.resolve(readyInfo)
    if (!readyPromise) {
      readyPromise = init().catch((error) => {
        // Allow a retry: the usual failure is "model not downloaded yet", which
        // the operator can fix without restarting the Host.
        readyPromise = null
        reportError(error)
        throw error
      })
    }
    return readyPromise
  }

  /**
   * Serialize work: one embedding at a time, in call order.
   *
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function enqueue(task) {
    const next = queueTail.then(task, task)
    queueTail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * @param {'passage' | 'query'} kind
   * @param {string} text
   * @returns {Promise<Float32Array>}
   */
  function embed(kind, text) {
    if (closed) return Promise.reject(closedError())
    stats.requests += 1
    let payload
    try {
      payload = prefixedText(kind, text)
    } catch (error) {
      stats.failures += 1
      reportError(error)
      return Promise.reject(error)
    }

    return enqueue(async () => {
      if (closed) throw closedError()
      if (fatalError) throw fatalError
      await ready()
      const startedAt = performance.now()
      let message
      try {
        message = await send({ id: nextId++, type: 'embed', text: payload }, timeoutMs)
      } catch (error) {
        stats.failures += 1
        reportError(error)
        throw error
      }
      stats.lastMs = Math.round(performance.now() - startedAt)
      consecutiveCrashes = 0
      return assertUnitVector(message.vector)
    })
  }

  async function close() {
    if (closed) return
    closed = true
    const error = closedError()
    const current = worker
    worker = null
    readyPromise = null
    readyInfo = null
    rejectPending(error)
    if (current) {
      current.removeAllListeners('message')
      current.removeAllListeners('error')
      current.removeAllListeners('exit')
      try {
        await current.terminate()
      } catch {
        // Already gone.
      }
    }
  }

  return {
    ready,
    embedPassage: (text) => embed('passage', text),
    embedQuery: (text) => embed('query', text),
    stats: () => ({ ...stats }),
    close,
    // Test seam only: the contract above is the public surface. Tests use this to
    // prove crash recovery without reaching into module state.
    __debug: {
      get worker() {
        return worker
      },
      get restarts() {
        return Math.max(0, spawnCount - 1)
      },
      get fatalError() {
        return fatalError
      },
      get pending() {
        return pending.size
      },
    },
  }
}
