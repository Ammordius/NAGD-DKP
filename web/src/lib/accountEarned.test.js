import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isoDay } from './accountEarned.js'

describe('isoDay', () => {
  it('keeps the first calendar day in a raid timestamp', () => {
    assert.equal(isoDay('2026-10-01T18:00:00Z'), '2026-10-01')
    assert.equal(isoDay(' 2026-08-01 '), '2026-08-01')
    assert.equal(isoDay(''), null)
    assert.equal(isoDay(null), null)
  })
})
