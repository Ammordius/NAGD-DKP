import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isFunZoneEnabled } from './funZone.js'

describe('isFunZoneEnabled', () => {
  it('treats unset, empty, false, and 0 as disabled', () => {
    assert.equal(isFunZoneEnabled(undefined), false)
    assert.equal(isFunZoneEnabled(null), false)
    assert.equal(isFunZoneEnabled(''), false)
    assert.equal(isFunZoneEnabled('   '), false)
    assert.equal(isFunZoneEnabled('false'), false)
    assert.equal(isFunZoneEnabled('FALSE'), false)
    assert.equal(isFunZoneEnabled('0'), false)
  })

  it('enables only on trimmed case-insensitive true', () => {
    assert.equal(isFunZoneEnabled('true'), true)
    assert.equal(isFunZoneEnabled('TRUE'), true)
    assert.equal(isFunZoneEnabled(' True '), true)
    assert.equal(isFunZoneEnabled(' true '), true)
  })

  it('rejects other truthy-looking or invalid values', () => {
    assert.equal(isFunZoneEnabled('1'), false)
    assert.equal(isFunZoneEnabled('yes'), false)
    assert.equal(isFunZoneEnabled('on'), false)
    assert.equal(isFunZoneEnabled('enabled'), false)
    assert.equal(isFunZoneEnabled('trueish'), false)
    assert.equal(isFunZoneEnabled(true), false)
    assert.equal(isFunZoneEnabled(1), false)
  })
})
