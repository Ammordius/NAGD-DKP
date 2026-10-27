import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appSource = readFileSync(path.join(root, 'App.jsx'), 'utf8')
const roastSource = readFileSync(path.join(root, 'components', 'RoastBot.jsx'), 'utf8')

describe('App RoastBot wiring', () => {
  it('lazy-loads RoastBot for authenticated users with profile', () => {
    assert.match(appSource, /lazy\(\(\)\s*=>\s*import\('\.\/components\/RoastBot\.jsx'\)\)/)
    assert.match(appSource, /session && profile/)
    assert.match(appSource, /<RoastBot profile=\{profile\} session=\{session\}/)
    assert.match(appSource, /Suspense/)
  })

  it('RoastBot hides on login/auth routes and has no personality settings UI', () => {
    assert.match(roastSource, /pathname === '\/login'/)
    assert.match(roastSource, /DKP Inquisitor/)
    assert.doesNotMatch(roastSource, /sarcasmLevel|personalitySettings|roastPreferences/)
  })
})
