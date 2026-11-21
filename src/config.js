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
 *   dataDir: string, dbPath: string, usageLogPath: string,
 *   spaceId: string, spaceName: string, spaceRules: string,
 *   observeUsage: boolean, bootstrapMessages: boolean, schemaVersion: number,
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
    spaceId: stringOr(input.spaceId, DEFAULT_SPACE_ID),
    spaceName: stringOr(input.spaceName, DEFAULT_SPACE_NAME),
    spaceRules: stringOr(input.spaceRules, DEFAULT_SPACE_RULES),
    observeUsage: booleanOr(input.observeUsage, true),
    bootstrapMessages: booleanOr(input.bootstrapMessages, true),
    schemaVersion: SCHEMA_VERSION,
  });
}
