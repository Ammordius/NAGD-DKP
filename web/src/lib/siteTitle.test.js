import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { documentTitleForPath, isProductionSite } from './siteTitle.js'

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

  it('names the browser tab from the route and keeps the site title', () => {
    const title = 'NAGD DKP - Staging Site'
    assert.equal(documentTitleForPath('/', title), 'Home · NAGD DKP - Staging Site')
    assert.equal(documentTitleForPath('/dkp', title), 'DKP · NAGD DKP - Staging Site')
    assert.equal(documentTitleForPath('/raids/abc/', title), 'Raid · NAGD DKP - Staging Site')
    assert.equal(documentTitleForPath('/accounts/x', title), 'Account · NAGD DKP - Staging Site')
    assert.equal(documentTitleForPath('/items/Cloak', title), 'Item · NAGD DKP - Staging Site')
    assert.equal(documentTitleForPath('/characters/bob', title), 'Character · NAGD DKP - Staging Site')
    assert.equal(documentTitleForPath('/officer/SiteAdmin', title), 'Site Admin · NAGD DKP - Staging Site')
    assert.equal(documentTitleForPath('/this-page-does-not-exist', title), 'Page not found · NAGD DKP - Staging Site')
  })

  it('treats a title that contains production as the live site', () => {
    assert.equal(isProductionSite('NAGD DKP - Production'), true)
    assert.equal(isProductionSite('production'), true)
    assert.equal(isProductionSite('  NAGD PRODUCTION site  '), true)
    assert.equal(isProductionSite('NAGD DKP - PRODUCTION'), true)
  })
})
