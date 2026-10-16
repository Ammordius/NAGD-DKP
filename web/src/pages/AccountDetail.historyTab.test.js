import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('./AccountDetail.jsx', import.meta.url), 'utf8')

describe('AccountDetail history tab', () => {
  it('imports the history tab component it renders', () => {
    assert.match(
      source,
      /import AccountLootHistoryTab from '\.\.\/components\/AccountLootHistoryTab'/,
    )
    assert.match(source, /\{tab === 'history' && \(\s*<AccountLootHistoryTab/)
  })
})
