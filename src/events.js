/**
 * Append-only JSONL event log for lifecycle facts that are not per-request
 * usage: compaction takeover, detected history replacements, pressure samples.
 *
 * Every write is guarded; a failing log must never disturb a turn.
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * @param {{ logPath?: string, now?: () => number, onError?: (error: unknown) => void }} [config]
 * @returns {{ append: (record: object) => void }}
 */
export function createEventLog({ logPath, now = () => Date.now(), onError = () => {} } = {}) {
  const enabled = typeof logPath === 'string' && logPath.length > 0
  let directoryReady = false
  let reported = false

  function report(error) {
    try {
      onError(error)
    } catch {
      // An error sink that throws must not break the caller either.
    }
  }

  function append(record) {
    if (!enabled) {
      if (!reported) {
        reported = true
        report(new TypeError('createEventLog: logPath must be a non-empty string; event logging is disabled'))
      }
      return
    }
    try {
      if (!directoryReady) {
        fs.mkdirSync(path.dirname(logPath), { recursive: true })
        directoryReady = true
      }
      const at = new Date(now()).toISOString()
      fs.appendFileSync(logPath, `${JSON.stringify({ at, ...record })}\n`, 'utf8')
    } catch (error) {
      report(error)
    }
  }

  return { append }
}
