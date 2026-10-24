import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { encodeStoredValue, readPageState } from './pageState.js'
import {
  AMBIANCE_PAGE_STATE_KEY,
  AMBIANCE_PREFS_DEFAULTS,
  DEFAULT_THEME_ID,
  THEMES,
  THEME_IDS,
  applyThemeCssVars,
  clearThemeCssVars,
  getTheme,
  normalizeAmbiancePrefs,
  resolveActiveTheme,
  themeToCssVars,
} from './themeRegistry.js'

function mockRoot() {
  const props = {}
  const dataset = {}
  return {
    style: {
      setProperty(name, value) {
        props[name] = value
      },
    },
    dataset,
    _props: props,
  }
}

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

describe('gnome theme', () => {
  it('is a known selectable theme with its own accent and background image', () => {
    assert.ok(THEME_IDS.includes('gnome'))
    assert.equal(getTheme('gnome').id, 'gnome')
    assert.equal(getTheme('gnome').label, 'Gnome')
    const prefs = normalizeAmbiancePrefs({
      ambianceEnabled: true,
      selectedTheme: 'gnome',
    })
    const active = resolveActiveTheme(prefs)
    assert.equal(active.id, 'gnome')
    const vars = themeToCssVars(active)
    assert.equal(vars['--dkp-accent'], THEMES.gnome.primary)
    assert.equal(vars['--dkp-bg-image'], 'url(/themes/gnome.jpg)')
  })
})

describe('martial theme', () => {
  it('uses a monastery palette distinct from knight with its own background image', () => {
    assert.ok(THEME_IDS.includes('martial'))
    const martial = getTheme('martial')
    assert.equal(martial.id, 'martial')
    assert.equal(martial.label, 'Martial')
    assert.equal(martial.primary, '#92400e')
    assert.equal(martial.secondary, '#d6b37a')
    assert.equal(martial.border, '#5b4636')
    assert.equal(martial.pageBackground, '#1a1410')
    assert.equal(martial.cardBackground, 'rgba(26, 20, 16, 0.92)')
    assert.equal(martial.overlay.color, '#1a1410')
    assert.notEqual(martial.primary, THEMES.knight.primary)
    assert.notEqual(martial.secondary, THEMES.knight.secondary)
    assert.notEqual(martial.border, THEMES.knight.border)
    const prefs = normalizeAmbiancePrefs({
      ambianceEnabled: true,
      selectedTheme: 'martial',
    })
    const active = resolveActiveTheme(prefs)
    assert.equal(active.id, 'martial')
    const vars = themeToCssVars(active)
    assert.equal(vars['--dkp-accent'], THEMES.martial.primary)
    assert.equal(vars['--dkp-accent-secondary'], THEMES.martial.secondary)
    assert.equal(vars['--dkp-bg-image'], 'url(/themes/martial.jpg)')
  })
})

const ILLUSTRATED_THEME_IDS = ['good', 'evil', 'martial', 'enchanter', 'wizard', 'knight', 'gnome']

function linearChannel(channel) {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function contrastRatio(background, foreground = '#ffffff') {
  const luminance = (hex) => {
    const n = Number.parseInt(hex.slice(1), 16)
    const r = linearChannel((n >> 16) & 255)
    const g = linearChannel((n >> 8) & 255)
    const b = linearChannel(n & 255)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const lighter = Math.max(luminance(background), luminance(foreground))
  const darker = Math.min(luminance(background), luminance(foreground))
  return (lighter + 0.05) / (darker + 0.05)
}

describe('theme artwork', () => {
  it('maps the seven illustrated themes to existing jpgs and emits no image when ambiance is off', () => {
    const themesDir = fileURLToPath(new URL('../../public/themes/', import.meta.url))
    const illustrated = THEME_IDS.filter((id) => id !== DEFAULT_THEME_ID)
    assert.deepEqual(illustrated, ILLUSTRATED_THEME_IDS)
    for (const id of illustrated) {
      assert.equal(THEMES[id].backgroundImage, `/themes/${id}.jpg`)
      assert.equal(existsSync(join(themesDir, `${id}.jpg`)), true)
      const enabled = themeToCssVars(resolveActiveTheme({ ambianceEnabled: true, selectedTheme: id }))
      assert.equal(enabled['--dkp-bg-image'], `url(/themes/${id}.jpg)`)
    }
    const disabled = themeToCssVars(resolveActiveTheme({ ambianceEnabled: false, selectedTheme: 'wizard' }))
    assert.equal(disabled['--dkp-bg-image'], 'none')
    assert.equal(disabled['--dkp-bg-image'].includes('url('), false)
    const defaults = themeToCssVars(THEMES.default)
    assert.equal(defaults['--dkp-bg-image'], 'none')
    assert.equal(defaults['--dkp-bg-image'].includes('url('), false)
    assert.equal(defaults['--dkp-bg-image'].includes('default.jpg'), false)
  })
})

describe('button contrast', () => {
  it('keeps the default purple button and meets AA for white text on every theme', () => {
    const defaults = themeToCssVars(THEMES.default)
    assert.equal(defaults['--dkp-btn-bg'], '#7c3aed')
    assert.equal(defaults['--dkp-btn-hover'], '#6d28d9')
    assert.equal(THEMES.good.primary, '#ca8a04')
    assert.equal(THEMES.knight.primary, '#d97706')
    assert.equal(themeToCssVars(THEMES.good)['--dkp-btn-bg'], '#9a6903')
    assert.equal(themeToCssVars(THEMES.good)['--dkp-btn-hover'], '#7e5602')
    assert.equal(themeToCssVars(THEMES.knight)['--dkp-btn-bg'], '#ae5f05')
    assert.equal(themeToCssVars(THEMES.knight)['--dkp-btn-hover'], '#8f4e04')
    for (const id of THEME_IDS) {
      const vars = themeToCssVars(THEMES[id])
      assert.ok(contrastRatio(vars['--dkp-btn-bg']) >= 4.5, `${id} button fill`)
      assert.ok(contrastRatio(vars['--dkp-btn-hover']) >= 4.5, `${id} button hover`)
      if (id !== 'good' && id !== 'knight') {
        assert.equal(vars['--dkp-btn-bg'], THEMES[id].primary)
        assert.ok(contrastRatio(THEMES[id].primary) >= 4.5, `${id} primary`)
      }
    }
  })
})

describe('default form controls', () => {
  it('does not style every select from the global input rule', () => {
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
    assert.doesNotMatch(css, /input\s*,\s*select\s*\{/)
    assert.match(css, /\.profile-ambiance select\s*\{/)
  })
})

describe('applyThemeCssVars', () => {
  it('writes CSS variables and data-ambiance-theme on the root', () => {
    const root = mockRoot()
    applyThemeCssVars(THEMES.wizard, root)
    assert.equal(root._props['--dkp-accent'], THEMES.wizard.primary)
    assert.equal(root._props['--dkp-bg-image'], 'url(/themes/wizard.jpg)')
    assert.equal(root.dataset.ambianceTheme, 'wizard')
  })

  it('clearThemeCssVars restores default vars and data attribute', () => {
    const root = mockRoot()
    applyThemeCssVars(THEMES.evil, root)
    clearThemeCssVars(root)
    assert.equal(root.dataset.ambianceTheme, DEFAULT_THEME_ID)
    assert.equal(root._props['--dkp-bg-image'], 'none')
    assert.equal(root._props['--dkp-accent'], THEMES.default.primary)
  })
})
