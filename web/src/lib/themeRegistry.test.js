import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encodeStoredValue, readPageState } from './pageState.js'
import {
  AMBIANCE_PAGE_STATE_KEY,
  AMBIANCE_PREFS_DEFAULTS,
  DEFAULT_THEME_ID,
  THEMES,
  getTheme,
  normalizeAmbiancePrefs,
  resolveActiveTheme,
  themeToCssVars,
} from './themeRegistry.js'

function memoryStorage(initial = {}) {
  const data = { ...initial }
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null
    },
    setItem(key, value) {
      data[key] = String(value)
    },
    removeItem(key) {
      delete data[key]
    },
  }
}

describe('normalizeAmbiancePrefs', () => {
  it('falls back to defaults for missing or invalid prefs', () => {
    assert.deepEqual(normalizeAmbiancePrefs(null), AMBIANCE_PREFS_DEFAULTS)
    assert.deepEqual(normalizeAmbiancePrefs(undefined), AMBIANCE_PREFS_DEFAULTS)
    assert.deepEqual(normalizeAmbiancePrefs({}), AMBIANCE_PREFS_DEFAULTS)
    assert.deepEqual(normalizeAmbiancePrefs([]), AMBIANCE_PREFS_DEFAULTS)
    assert.deepEqual(normalizeAmbiancePrefs('nope'), AMBIANCE_PREFS_DEFAULTS)
    assert.equal(normalizeAmbiancePrefs({ ambianceEnabled: 'yes' }).ambianceEnabled, false)
    assert.equal(normalizeAmbiancePrefs({ ambianceEnabled: true }).ambianceEnabled, true)
  })

  it('falls back to the default theme for an unknown stored theme id', () => {
    const prefs = normalizeAmbiancePrefs({
      ambianceEnabled: true,
      selectedTheme: 'not-a-real-theme',
    })
    assert.equal(prefs.selectedTheme, DEFAULT_THEME_ID)
    assert.equal(getTheme(prefs.selectedTheme).id, DEFAULT_THEME_ID)
    assert.equal(getTheme('bogus').id, DEFAULT_THEME_ID)
  })
})

describe('persisted ambiance prefs', () => {
  it('loads a saved ambiance preference from page-state storage', () => {
    const userId = 'user-theme-1'
    const stored = {
      ambianceEnabled: true,
      selectedTheme: 'wizard',
    }
    const storage = memoryStorage({
      [`pageState:user:${userId}:${AMBIANCE_PAGE_STATE_KEY}`]: JSON.stringify(
        encodeStoredValue(stored, { version: 1 }),
      ),
    })
    const loaded = readPageState(storage, AMBIANCE_PAGE_STATE_KEY, AMBIANCE_PREFS_DEFAULTS, normalizeAmbiancePrefs, {
      userId,
      version: 1,
    })
    assert.equal(loaded.ambianceEnabled, true)
    assert.equal(loaded.selectedTheme, 'wizard')
    assert.equal(resolveActiveTheme(loaded).id, 'wizard')
    assert.equal(themeToCssVars(resolveActiveTheme(loaded))['--dkp-accent'], THEMES.wizard.primary)
  })
})

describe('resolveActiveTheme', () => {
  it('reverts to default styling when ambiance is disabled', () => {
    const prefs = normalizeAmbiancePrefs({
      ambianceEnabled: false,
      selectedTheme: 'evil',
    })
    assert.equal(prefs.selectedTheme, 'evil')
    const active = resolveActiveTheme(prefs)
    assert.equal(active.id, DEFAULT_THEME_ID)
    assert.deepEqual(themeToCssVars(active), themeToCssVars(THEMES.default))
    assert.equal(themeToCssVars(active)['--dkp-bg-image'], 'none')
    assert.equal(themeToCssVars(active)['--dkp-overlay-opacity'], '0')
  })
})
