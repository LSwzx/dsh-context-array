/**
 * Update detection and auto-update (npm release).
 *
 * The plugin manager service already owns installation: `listBundles()` says which
 * source this copy came from, `listVersions(name)` lists newer published versions, and
 * `updateBundle(name, version)` replaces the bundle through pnpm (HMR applies it live or
 * reports `restart-required`). This module only decides *when* to call them and records
 * the outcome.
 *
 * A path-installed copy (local checkout, the common development setup) is not a registry
 * bundle, so auto-update skips it and the panel shows "local install" instead of
 * pretending an update is possible.
 */

import fs from 'node:fs'

/** This package's version, read from its own manifest. */
export const PACKAGE_VERSION = (() => {
  try {
    const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** Compare two semver-ish versions; returns -1, 0 or 1. */
export function compareVersions(left, right) {
  const parse = (value) => {
    const [core, ...rest] = String(value ?? '').split('-')
    const numbers = core.split('.').map((part) => Number.parseInt(part, 10) || 0)
    while (numbers.length < 3) numbers.push(0)
    return { numbers, prerelease: rest.join('-') }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1
  }
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === '') return 1
  if (b.prerelease === '') return -1
  return a.prerelease > b.prerelease ? 1 : -1
}

/** Options a registry list can never offer: auto-update only runs for registry copies. */
export const UPDATE_POLICIES = Object.freeze(['off', 'notify', 'auto'])

/**
 * @param {{ ctx: any, config: object, events?: { append: Function } | null,
 *           warn?: (error: unknown) => void, now?: () => number }} input
 */
export function createUpdateChecker({ ctx, config, events = null, warn = () => {}, now = () => Date.now() }) {
  const name = 'dsh-context-array'
  const policy = UPDATE_POLICIES.includes(config?.updatePolicy) ? config.updatePolicy : 'notify'

  let state = {
    name,
    current: PACKAGE_VERSION,
    latest: null,
    available: false,
    source: null,
    policy,
    checkedAt: null,
    error: null,
    lastResult: null,
  }

  const record = (type, extra = {}) => {
    try {
      events?.append({ type, at: new Date(now()).toISOString(), ...extra })
    } catch {
      // Observability only.
    }
  }

  async function listBundle() {
    try {
      const list = await ctx.get?.('pluginManager')?.listBundles?.()
      return Array.isArray(list) ? list.find((bundle) => bundle.name === name) ?? null : null
    } catch {
      return null
    }
  }

  /**
   * Ask the registry for newer versions.
   *
   * @param {{ auto?: boolean }} [options] auto=true applies the update when policy allows
   * @returns {Promise<object>} the public status
   */
  async function check({ auto = false } = {}) {
    if (policy === 'off' || config?.updateCheck === false) return state
    const manager = ctx.get?.('pluginManager')
    if (!manager || typeof manager.listVersions !== 'function') {
      state = { ...state, error: 'plugin-manager-unavailable' }
      return state
    }
    const bundle = await listBundle()
    const source = bundle?.update ?? null
    try {
      const listed = await manager.listVersions(name)
      state = { ...state, source, checkedAt: new Date(now()).toISOString(), error: null }
      if (listed?.status !== 'listed') {
        state = { ...state, available: false, error: listed?.problem ?? 'not-listed' }
        return state
      }
      const candidates = (listed.versions ?? []).filter((version) => !version.deprecated && !version.prerelease)
      const latest = candidates[0]?.version ?? listed.installed ?? state.current
      const available = compareVersions(latest, state.current) > 0
      state = { ...state, latest, available }
      record('update/checked', { current: state.current, latest, available, source })
      if (available && auto && policy === 'auto' && source === 'registry') {
        return install(latest)
      }
      return state
    } catch (error) {
      warn(error)
      state = { ...state, error: String(error?.message ?? error) }
      return state
    }
  }

  /**
   * Install one exact version through the plugin manager.
   *
   * @param {string} version
   * @returns {Promise<object>} the public status
   */
  async function install(version = state.latest) {
    const manager = ctx.get?.('pluginManager')
    if (!manager || typeof manager.updateBundle !== 'function' || !version) {
      state = { ...state, error: 'update-unavailable' }
      return state
    }
    if (compareVersions(version, state.current) <= 0) {
      state = { ...state, available: false }
      return state
    }
    try {
      const result = await manager.updateBundle(name, version)
      state = {
        ...state,
        available: false,
        lastResult: result
          ? {
              version,
              step: result.step ?? null,
              application: result.result?.application ?? null,
              changed: result.result?.changed ?? null,
              error: result.result?.error?.code ?? null,
            }
          : null,
        error: result?.result?.application === 'failed' ? result?.result?.error?.code ?? 'update-failed' : null,
      }
      record('update/applied', {
        version,
        step: state.lastResult?.step ?? null,
        application: state.lastResult?.application ?? null,
      })
    } catch (error) {
      warn(error)
      state = { ...state, error: String(error?.message ?? error) }
      record('update/failed', { version, message: state.error })
    }
    return state
  }

  return {
    status: () => state,
    check,
    install,
    policy,
  }
}
