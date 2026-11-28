/**
 * Update detection: version comparison, registry checks, auto-update policy.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { PACKAGE_VERSION, compareVersions, createUpdateChecker } from '../src/update.js'

const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'))

function fakeCtx({ bundle = { name: 'dsh-context-array', update: 'registry' }, versions = ['9.9.9'], installed = '1.0.0', onUpdate } = {}) {
  const calls = { updateBundle: [] }
  return {
    calls,
    get(name) {
      if (name !== 'pluginManager') return undefined
      return {
        listBundles: async () => (bundle ? [bundle] : []),
        listVersions: async () => ({
          status: 'listed',
          installed,
          versions: versions.map((version) => ({ version, tags: [], prerelease: false, bundle: true })),
        }),
        updateBundle: async (name, version) => {
          calls.updateBundle.push([name, version])
          return onUpdate ? onUpdate(name, version) : { step: 'install', result: { application: 'applied', changed: true } }
        },
      }
    },
  }
}

function collector() {
  const records = []
  return { records, append: (record) => records.push(record) }
}

test('compareVersions orders releases and prereleases', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1)
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1)
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.2'), 1)
})

test('the reported current version is the package manifest version', () => {
  assert.equal(PACKAGE_VERSION, manifest.version)
})

test('notify policy reports availability without installing', async () => {
  const events = collector()
  const ctx = fakeCtx({ versions: ['9.9.9'] })
  const checker = createUpdateChecker({ ctx, config: { updatePolicy: 'notify', updateCheck: true }, events })
  const status = await checker.check({ auto: true })
  assert.equal(status.available, true)
  assert.equal(status.latest, '9.9.9')
  assert.equal(status.source, 'registry')
  assert.equal(ctx.calls.updateBundle.length, 0, 'notify never installs')
  assert.ok(events.records.some((record) => record.type === 'update/checked'))
})

test('auto policy updates a registry copy only', async () => {
  const events = collector()
  const registryCtx = fakeCtx({ versions: ['9.9.9'] })
  const auto = createUpdateChecker({ ctx: registryCtx, config: { updatePolicy: 'auto', updateCheck: true }, events })
  const status = await auto.check({ auto: true })
  assert.deepEqual(registryCtx.calls.updateBundle, [['dsh-context-array', '9.9.9']])
  assert.equal(status.available, false)
  assert.equal(status.lastResult.application, 'applied')

  const pathCtx = fakeCtx({ bundle: { name: 'dsh-context-array', update: undefined }, versions: ['9.9.9'] })
  const pathChecker = createUpdateChecker({ ctx: pathCtx, config: { updatePolicy: 'auto', updateCheck: true } })
  const pathStatus = await pathChecker.check({ auto: true })
  assert.equal(pathStatus.available, true, 'availability is still reported for a local copy')
  assert.equal(pathCtx.calls.updateBundle.length, 0, 'a path install is never auto-updated')
})

test('off policy and a missing plugin manager are reported, not thrown', async () => {
  const off = createUpdateChecker({ ctx: fakeCtx(), config: { updatePolicy: 'off', updateCheck: true } })
  assert.equal((await off.check({ auto: true })).available, false)

  const missing = createUpdateChecker({ ctx: { get: () => undefined }, config: { updatePolicy: 'notify', updateCheck: true } })
  const status = await missing.check({ auto: true })
  assert.equal(status.error, 'plugin-manager-unavailable')
})

test('install refuses to move backwards and records a failed application', async () => {
  const ctx = fakeCtx({ onUpdate: () => ({ step: 'install', result: { application: 'failed', error: { code: 'permission' } } }) })
  const checker = createUpdateChecker({ ctx, config: { updatePolicy: 'notify', updateCheck: true } })
  await checker.check({ auto: false })
  const old = await checker.install('0.0.1')
  assert.equal(old.error, null)
  assert.equal(ctx.calls.updateBundle.length, 0, 'older versions are ignored')

  const failed = await checker.install('9.9.9')
  assert.equal(failed.error, 'permission')
})
