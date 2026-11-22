/**
 * Configuration resolution for dsh-context-array.
 *
 * `resolveConfig(raw)` turns the Loader row's (possibly partial) config object
 * into the frozen, fully populated config both the storage layer and the plugin
 * entry point use. Invalid values never throw: they fall back to the default.
 */
import os from 'node:os';
import path from 'node:path';

/** Bumped together with the SQLite schema in src/db.js. */
export const SCHEMA_VERSION = 1;

export const DEFAULT_SPACE_ID = 'space-default';
export const DEFAULT_SPACE_NAME = 'Default space';
export const DEFAULT_SPACE_RULES =
  'Shared workspace facts stay in this space unless a more specific space is bound.';

/** `<home>/.dsh/context-array`, used when `dataDir` is empty. */
export const DEFAULT_DATA_DIR = path.join(os.homedir(), '.dsh', 'context-array');

/** How compaction is handled: `off` leaves the deployment alone, `observe` claims the seam but never folds. */
export const COMPACTION_MODES = Object.freeze(['off', 'observe']);

/** Default pressure at which `observe` mode records a sample (tokens). */
export const DEFAULT_COMPACTION_WARN_TOKENS = 400_000;

/** Default share of the context window at which `observe` mode raises an alarm. */
export const DEFAULT_COMPACTION_ALARM_RATIO = 0.8;

/**
 * Return `value` when it is a non-blank string, otherwise `fallback`.
 *
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

/**
 * Return `value` when it is a boolean, otherwise `fallback`.
 *
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function booleanOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Resolve the loader config into the frozen config object.
 *
 * Unknown keys are preserved verbatim; known keys are type-validated and fall
 * back to their default when invalid. `schemaVersion` is always the running
 * code's version.
 *
 * @param {unknown} raw Loader row config object; may be undefined or partial.
 * @returns {Readonly<{
 *   dataDir: string, dbPath: string, usageLogPath: string, eventsLogPath: string,
 *   spaceId: string, spaceName: string, spaceRules: string,
 *   observeUsage: boolean, bootstrapMessages: boolean,
 *   compactionMode: string, compactionWarnTokens: number,
 *   schemaVersion: number,
 * }>}
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  const dataDir =
    typeof input.dataDir === 'string' && input.dataDir.trim() !== ''
      ? path.resolve(input.dataDir.trim())
      : DEFAULT_DATA_DIR;

  return Object.freeze({
    ...input,
    dataDir,
    dbPath: path.join(dataDir, 'context-array.db'),
    usageLogPath: path.join(dataDir, 'usage.jsonl'),
    eventsLogPath: path.join(dataDir, 'events.jsonl'),
    // Diagnostic knob for the controlled cache experiment: editing this file
    // changes L1 (node 0) with the observer still running.
    promptSaltFile:
      typeof input.promptSaltFile === 'string' && input.promptSaltFile.trim() !== ''
        ? path.resolve(input.promptSaltFile.trim())
        : path.join(dataDir, 'prompt-salt.txt'),
    // M2: local embedding model directory and kill switch. The worker loads the
    // model lazily on the first query, so activation never blocks on it.
    modelsDir:
      typeof input.modelsDir === 'string' && input.modelsDir.trim() !== ''
        ? path.resolve(input.modelsDir.trim())
        : path.join(dataDir, 'models'),
    enableEmbedding: booleanOr(input.enableEmbedding, true),
    spaceId: stringOr(input.spaceId, DEFAULT_SPACE_ID),
    spaceName: stringOr(input.spaceName, DEFAULT_SPACE_NAME),
    spaceRules: stringOr(input.spaceRules, DEFAULT_SPACE_RULES),
    observeUsage: booleanOr(input.observeUsage, true),
    bootstrapMessages: booleanOr(input.bootstrapMessages, true),
    compactionMode:
      typeof input.compactionMode === 'string' && COMPACTION_MODES.includes(input.compactionMode)
        ? input.compactionMode
        : 'off',
    compactionWarnTokens:
      Number.isSafeInteger(input.compactionWarnTokens) && input.compactionWarnTokens > 0
        ? input.compactionWarnTokens
        : DEFAULT_COMPACTION_WARN_TOKENS,
    compactionAlarmRatio:
      typeof input.compactionAlarmRatio === 'number' &&
      Number.isFinite(input.compactionAlarmRatio) &&
      input.compactionAlarmRatio > 0 &&
      input.compactionAlarmRatio <= 1
        ? input.compactionAlarmRatio
        : DEFAULT_COMPACTION_ALARM_RATIO,
    schemaVersion: SCHEMA_VERSION,
  });
}
