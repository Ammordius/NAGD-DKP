import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ELEMENTAL_MOLDS,
  resolveMoldPhrase,
  looksLikeMoldPhrase,
  extractMoldItemQuery,
} from './molds.js'

describe('elemental molds', () => {
  it('has 28 catalog entries', () => {
    assert.equal(ELEMENTAL_MOLDS.length, 28)
  })

  it('plate BP → Timeless Breastplate Mold', () => {
    const r = resolveMoldPhrase('plate BP')
    assert.equal(r?.name, 'Timeless Breastplate Mold')
    assert.equal(r?.itemId, '16375')
  })

  it('plate arms → Elemental Vambrace Mold', () => {
    assert.equal(resolveMoldPhrase('plate arms')?.name, 'Elemental Vambrace Mold')
  })

  it('silk arms → Elemental Silk Sleeve Pattern', () => {
    assert.equal(resolveMoldPhrase('silk arms')?.name, 'Elemental Silk Sleeve Pattern')
  })

  it('ele mold → all 28 names', () => {
    const r = resolveMoldPhrase('ele mold')
    assert.ok(r?.names instanceof Set)
    assert.equal(r.names.size, 28)
  })

  it('plate mold → seven plate molds', () => {
    const r = resolveMoldPhrase('plate mold')
    assert.equal(r?.names?.size, 7)
    assert.ok([...r.names].every((n) => /mold$/i.test(n) || /Breastplate/i.test(n)))
  })

  it('looksLikeMoldPhrase detects guild shorthand', () => {
    assert.equal(looksLikeMoldPhrase('silk arms'), true)
    assert.equal(looksLikeMoldPhrase('plate bp'), true)
    assert.equal(looksLikeMoldPhrase('ele mold'), true)
    assert.equal(looksLikeMoldPhrase('p3 arms'), false)
    assert.equal(looksLikeMoldPhrase('arms'), false)
  })

  it('extractMoldItemQuery preserves armor+slot', () => {
    assert.equal(extractMoldItemQuery("When's the last time silk arms dropped?"), 'silk arms')
    assert.equal(extractMoldItemQuery('what about plate BP'), 'plate bp')
    assert.equal(extractMoldItemQuery('ele mold'), 'ele mold')
  })
})
