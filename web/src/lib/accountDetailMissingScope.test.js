import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  accountDetailSessionKey,
  accountDetailSwrKey,
  missingTicControlMatrix,
  needsMissingRaidUniverse,
} from './accountDetailMissingScope.js'

describe('needsMissingRaidUniverse', () => {
  it('covers all four control combinations', () => {
    assert.equal(needsMissingRaidUniverse(false, false), false)
    assert.equal(needsMissingRaidUniverse(true, false), true)
    assert.equal(needsMissingRaidUniverse(false, true), true)
    assert.equal(needsMissingRaidUniverse(true, true), true)
  })
})

describe('account detail missing-tic cache keys', () => {
  it('isolates missing and non-missing session/SWR scopes', () => {
    const baseSession = accountDetailSessionKey('acct-a', false)
    const missingSession = accountDetailSessionKey('acct-a', true)
    assert.notEqual(baseSession, missingSession)
    assert.match(missingSession, /:missing$/)
    assert.doesNotMatch(baseSession, /:missing/)

    const baseSwr = accountDetailSwrKey('acct-a', false)
    const missingSwr = accountDetailSwrKey('acct-a', true)
    assert.notEqual(baseSwr, missingSwr)
    assert.match(missingSwr, /:missing$/)
  })

  it('does not reuse another account cache when navigating', () => {
    assert.notEqual(
      accountDetailSessionKey('acct-a', true),
      accountDetailSessionKey('acct-b', true),
    )
    assert.notEqual(
      accountDetailSwrKey('acct-a', false),
      accountDetailSwrKey('acct-b', false),
    )
  })

  it('matrix encodes expected fetch scope for each control pair', () => {
    const rows = missingTicControlMatrix('acct-x')
    assert.equal(rows.length, 4)
    assert.deepEqual(
      rows.map((r) => [r.showMissingDetails, r.onlyMissingRaids, r.includeMissing]),
      [
        [false, false, false],
        [true, false, true],
        [false, true, true],
        [true, true, true],
      ],
    )
    const keys = new Set(rows.map((r) => r.sessionKey))
    // Two distinct scopes for one account: with and without missing
    assert.equal(keys.size, 2)
  })

  it('simulates cache switching: non-missing blob must not satisfy missing', () => {
    const store = new Map()
    const accountId = 'acct-switch'
    store.set(accountDetailSessionKey(accountId, false), { scope: 'base' })
    const missingKey = accountDetailSessionKey(accountId, true)
    assert.equal(store.get(missingKey), undefined)
    store.set(missingKey, { scope: 'missing' })
    assert.equal(store.get(accountDetailSessionKey(accountId, false)).scope, 'base')
    assert.equal(store.get(missingKey).scope, 'missing')
  })
})
