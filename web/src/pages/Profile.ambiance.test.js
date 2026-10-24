import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { THEME_IDS, THEMES } from '../lib/themeRegistry.js'

const source = readFileSync(new URL('./Profile.jsx', import.meta.url), 'utf8')

describe('Profile ambiance settings', () => {
  it('renders Enable ambiance and Theme controls wired to useAmbianceTheme', () => {
    assert.match(source, /import \{ useAmbianceTheme \} from '\.\.\/lib\/useAmbianceTheme'/)
    assert.match(source, /aria-label="Enable ambiance"/)
    assert.match(source, /aria-label="Ambiance theme"/)
    assert.match(source, /setAmbianceEnabled/)
    assert.match(source, /setSelectedTheme/)
    assert.match(source, /disabled=\{!ambianceEnabled\}/)
    assert.match(source, /themeIds\.map/)
    assert.match(source, /className="card profile-ambiance"/)
  })

  it('exposes gnome among selectable ambiance themes', () => {
    assert.ok(THEME_IDS.includes('gnome'))
    assert.equal(THEMES.gnome?.label, 'Gnome')
    assert.equal(THEMES.gnome?.backgroundImage, '/themes/gnome.jpg')
  })
})
