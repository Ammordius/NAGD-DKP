import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatUpgradeDelta, buildLinks } from './formatting.js'

describe('buildLinks', () => {
  it('builds raid links to /raids/:id without inventing ids', () => {
    const links = buildLinks({ raidId: '1585398', raidName: 'Fire Minis' })
    assert.equal(links.length, 1)
    assert.equal(links[0].type, 'raid')
    assert.equal(links[0].to, '/raids/1585398')
    assert.equal(links[0].label, 'Fire Minis')
  })
})

describe('formatUpgradeDelta', () => {
  it('shows at least two decimals for small positives (not 0 score)', () => {
    const text = formatUpgradeDelta(0.04, 'Wrist')
    assert.equal(text, '+0.04 score Wrist')
    assert.equal(/^\+?0(\.0+)? score/.test(text), false)
  })

  it('uses three significant figures for very small positives', () => {
    const text = formatUpgradeDelta(0.00412, 'Feet')
    assert.match(text, /^\+0\.00412 score Feet$/)
  })

  it('keeps larger deltas readable at two decimal places', () => {
    assert.equal(formatUpgradeDelta(1.5, 'Legs'), '+1.50 score Legs')
    assert.equal(formatUpgradeDelta(15.25, 'Chest'), '+15.25 score Chest')
  })

  it('formats exact zero distinctly from tiny positives', () => {
    assert.equal(formatUpgradeDelta(0, 'Head'), '0.00 score Head')
  })

  it('preserves sign for negative deltas', () => {
    assert.equal(formatUpgradeDelta(-0.04, 'Arms'), '-0.04 score Arms')
  })
})
