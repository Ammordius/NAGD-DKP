import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isProductionSite } from './siteTitle.js'

describe('isProductionSite', () => {
  it('treats a blank or unset title as a development site', () => {
    assert.equal(isProductionSite(''), false)
    assert.equal(isProductionSite('   '), false)
    assert.equal(isProductionSite(null), false)
  })

  it('treats development and staging titles as development sites', () => {
    assert.equal(isProductionSite('NAGD DKP - Development'), false)
    assert.equal(isProductionSite('NAGD DKP - Staging Site'), false)
    assert.equal(isProductionSite('dev'), false)
  })

  it('treats a title that contains production as the live site', () => {
    assert.equal(isProductionSite('NAGD DKP - Production'), true)
    assert.equal(isProductionSite('production'), true)
    assert.equal(isProductionSite('  NAGD PRODUCTION site  '), true)
    assert.equal(isProductionSite('NAGD DKP - PRODUCTION'), true)
  })
})
