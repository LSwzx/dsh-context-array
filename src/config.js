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
export const SCHEMA_VERSION = 2;

export const DEFAULT_SPACE_ID = 'space-default';
export const DEFAULT_SPACE_NAME = 'Default space';
export const DEFAULT_SPACE_RULES =
  'Shared workspace facts stay in this space unless a more specific space is bound.';

/** `<home>/.dsh/context-array`, used when `dataDir` is empty. */
export const DEFAULT_DATA_DIR = path.join(os.homedir(), '.dsh', 'context-array');

/** How compaction is handled: `off` leaves the deployment alone, `observe` claims the seam but never folds, `fold` really folds. */
export const COMPACTION_MODES = Object.freeze(['off', 'observe', 'fold']);

/** Defaults for the folding policy (`fold` mode only). */
export const FOLD_CONFIG_DEFAULTS = Object.freeze({
  foldRatio: 0.85,
  retainRatio: 0.3,
  minFoldTokens: 8_000,
  summaryMaxTokens: 600,
});

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

/** Return `value` when it is a finite number in (0, 1], otherwise `fallback`. */
function ratioOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
}

/** Return `value` when it is a positive safe integer, otherwise `fallback`. */
function positiveIntOr(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
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
    // M3: sessions bootstrapped as central memory managers. M4's UI will bind roles
    // into session_space_links; until then this list is the only way to designate an
    // admin, and it is deployment config (never model-writable).
    adminSessionIds: Array.isArray(input.adminSessionIds)
      ? input.adminSessionIds.filter((value) => typeof value === 'string' && value.trim() !== '')
      : [],
    // M3 queue policy.
    queueStaleMinutes:
      Number.isSafeInteger(input.queueStaleMinutes) && input.queueStaleMinutes > 0
        ? input.queueStaleMinutes
        : 10,
    queueMaxRetries:
      Number.isSafeInteger(input.queueMaxRetries) && input.queueMaxRetries > 0
        ? input.queueMaxRetries
        : 3,
    // M4: how many wake-ups one target session may receive per trailing hour.
    wakeMaxPerHour:
      Number.isSafeInteger(input.wakeMaxPerHour) && input.wakeMaxPerHour > 0
        ? input.wakeMaxPerHour
        : 10,
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
    compactionFoldRatio: ratioOr(input.compactionFoldRatio, FOLD_CONFIG_DEFAULTS.foldRatio),
    compactionRetainRatio: ratioOr(input.compactionRetainRatio, FOLD_CONFIG_DEFAULTS.retainRatio),
    compactionMinFoldTokens: positiveIntOr(input.compactionMinFoldTokens, FOLD_CONFIG_DEFAULTS.minFoldTokens),
    compactionSummaryMaxTokens: positiveIntOr(
      input.compactionSummaryMaxTokens,
      FOLD_CONFIG_DEFAULTS.summaryMaxTokens,
    ),
    schemaVersion: SCHEMA_VERSION,
  });
}
