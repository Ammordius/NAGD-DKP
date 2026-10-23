import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('./Accounts.jsx', import.meta.url), 'utf8')

describe('Accounts inactive toggle', () => {
  it('shows inactive accounts only in this viewer’s list', () => {
    assert.match(source, /usePersistedState\('\/accounts:showInactive', false, showInactiveFlag\)/)
    assert.match(source, /showInactive \? accounts : accounts\.filter\(\(acc\) => acc\.inactive !== true\)/)
    assert.match(source, /Show inactive accounts/)
    assert.match(source, /Hide inactive accounts/)
    assert.match(source, /includeInactive: true/)
    assert.match(source, /to=\{`\/accounts\/\$\{acc\.account_id\}`\}/)
    assert.doesNotMatch(source, /\.update\(\s*\{[^}]*inactive/)
  })
})
