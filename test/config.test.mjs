/**
 * Tests for src/config.js — pure, no filesystem writes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
  resolveConfig,
  SCHEMA_VERSION,
  DEFAULT_DATA_DIR,
  DEFAULT_SPACE_ID,
  DEFAULT_SPACE_NAME,
  DEFAULT_SPACE_RULES,
} from '../src/config.js';

test('resolveConfig() returns the documented defaults when raw is undefined', () => {
  const cfg = resolveConfig(undefined);

  assert.equal(cfg.dataDir, path.join(os.homedir(), '.dsh', 'context-array'));
  assert.equal(cfg.dbPath, path.join(cfg.dataDir, 'context-array.db'));
  assert.equal(cfg.usageLogPath, path.join(cfg.dataDir, 'usage.jsonl'));
  assert.equal(cfg.spaceId, 'space-default');
  assert.equal(cfg.spaceName, 'Default space');
  assert.equal(cfg.spaceRules, DEFAULT_SPACE_RULES);
  assert.equal(cfg.observeUsage, true);
  assert.equal(cfg.bootstrapMessages, true);
  assert.equal(cfg.schemaVersion, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 5);
  assert.equal(cfg.updateCheck, true);
  assert.equal(cfg.updatePolicy, 'notify');
  assert.equal(cfg.updateCheckIntervalHours, 6);
  assert.equal(DEFAULT_SPACE_ID, 'space-default');
  assert.equal(DEFAULT_SPACE_NAME, 'Default space');
  assert.equal(DEFAULT_DATA_DIR, path.join(os.homedir(), '.dsh', 'context-array'));
  assert.equal(typeof DEFAULT_SPACE_RULES, 'string');
  assert.ok(DEFAULT_SPACE_RULES.length > 0);
});

test('resolveConfig() keeps a custom absolute dataDir and derives the file paths', () => {
  const cfg = resolveConfig({ dataDir: 'D:\\dsh-data\\ctx-array' });

  assert.ok(path.isAbsolute(cfg.dataDir));
  assert.equal(cfg.dataDir, path.resolve('D:\\dsh-data\\ctx-array'));
  assert.equal(cfg.dbPath, path.join(cfg.dataDir, 'context-array.db'));
  assert.equal(cfg.usageLogPath, path.join(cfg.dataDir, 'usage.jsonl'));
});

test('resolveConfig() resolves a relative dataDir against the working directory', () => {
  const cfg = resolveConfig({ dataDir: path.join('relative', 'nested') });

  assert.ok(path.isAbsolute(cfg.dataDir));
  assert.equal(cfg.dataDir, path.resolve('relative', 'nested'));
});

test('resolveConfig() falls back to the default directory for empty or non-string dataDir', () => {
  const expected = path.join(os.homedir(), '.dsh', 'context-array');

  for (const dataDir of ['', '   ', 42, null, false, {}, []]) {
    assert.equal(resolveConfig({ dataDir }).dataDir, expected, `dataDir=${JSON.stringify(dataDir)}`);
  }
});

test('resolveConfig() validates the space fields by type and falls back on blanks', () => {
  const custom = resolveConfig({
    spaceId: 'space-work',
    spaceName: 'Work',
    spaceRules: '  rules with surrounding spaces  ',
  });
  assert.equal(custom.spaceId, 'space-work');
  assert.equal(custom.spaceName, 'Work');
  assert.equal(custom.spaceRules, '  rules with surrounding spaces  ', 'content is kept verbatim');

  const invalid = resolveConfig({ spaceId: '', spaceName: 7, spaceRules: '  ' });
  assert.equal(invalid.spaceId, DEFAULT_SPACE_ID);
  assert.equal(invalid.spaceName, DEFAULT_SPACE_NAME);
  assert.equal(invalid.spaceRules, DEFAULT_SPACE_RULES);
});

test('resolveConfig() honours boolean false and rejects non-boolean values', () => {
  const off = resolveConfig({ observeUsage: false, bootstrapMessages: false });
  assert.equal(off.observeUsage, false);
  assert.equal(off.bootstrapMessages, false);

  for (const value of ['yes', 1, 0, null, {}]) {
    const cfg = resolveConfig({ observeUsage: value, bootstrapMessages: value });
    assert.equal(cfg.observeUsage, true, `observeUsage=${JSON.stringify(value)}`);
    assert.equal(cfg.bootstrapMessages, true, `bootstrapMessages=${JSON.stringify(value)}`);
  }
});

test('resolveConfig() preserves unknown keys but forces schemaVersion', () => {
  const cfg = resolveConfig({ extraKey: { nested: true }, schemaVersion: 99 });

  assert.deepEqual(cfg.extraKey, { nested: true });
  assert.equal(cfg.schemaVersion, SCHEMA_VERSION);
});

test('resolveConfig() is frozen, does not mutate its input and never throws on garbage', () => {
  const input = { spaceId: 'space-a' };
  const cfg = resolveConfig(input);

  assert.ok(Object.isFrozen(cfg));
  assert.throws(() => {
    cfg.dataDir = 'somewhere-else';
  }, TypeError);

  input.spaceId = 'mutated-after-resolve';
  assert.equal(cfg.spaceId, 'space-a', 'resolved config is a snapshot of the input');

  for (const raw of [null, undefined, 'nonsense', 42, [], { dataDir: { weird: true } }]) {
    const garbage = resolveConfig(raw);
    assert.ok(Object.isFrozen(garbage));
    assert.ok(path.isAbsolute(garbage.dataDir));
    assert.equal(garbage.schemaVersion, SCHEMA_VERSION);
  }
});
