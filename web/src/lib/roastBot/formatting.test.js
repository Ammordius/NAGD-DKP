import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatUpgradeDelta,
  buildLinks,
  suggestionChips,
  CAPABILITIES_EXAMPLE_CHIPS,
} from './formatting.js'
import { extractUpgradeSlotHint } from './upgrades.js'

describe('buildLinks', () => {
  it('builds raid links to /raids/:id without inventing ids', () => {
    const links = buildLinks({ raidId: '1585398', raidName: 'Fire Minis' })
    assert.equal(links.length, 1)
    assert.equal(links[0].type, 'raid')
    assert.equal(links[0].to, '/raids/1585398')
    assert.equal(links[0].label, 'Fire Minis')
  })

  it('builds account links to /accounts/:id', () => {
    const links = buildLinks({ accountId: 'a1', accountName: 'BobAccount' })
    assert.equal(links.length, 1)
    assert.equal(links[0].type, 'account')
    assert.equal(links[0].to, '/accounts/a1')
    assert.equal(links[0].label, 'BobAccount')
  })

  it('builds character and item SPA paths for outbound RoastBot navigation', () => {
    const character = buildLinks({ characterName: 'Badammo' })
    assert.equal(character[0].type, 'character')
    assert.equal(character[0].to, '/characters/Badammo')
    assert.equal(character[0].label, 'Badammo')

    const item = buildLinks({ itemName: 'Heavy Yttrium Chestplate', itemId: 911 })
    assert.equal(item[0].type, 'item')
    assert.equal(item[0].to, `/items/${encodeURIComponent('Heavy Yttrium Chestplate')}`)
    assert.equal(item[0].itemId, 911)
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

describe('suggestionChips base menu', () => {
  it('pins What can you ask? and includes a discovery teacher chip', () => {
    const chips = suggestionChips({ hasAccount: true })
    assert.equal(chips[0], 'What can you ask?')
    assert.ok(chips.includes('What dropped off Quarm?'))
    assert.ok(chips.includes('Roast my DKP spending'))
    assert.equal(chips.length, 6)
  })

  it('surfaces capabilities example chips after help', () => {
    const chips = suggestionChips({ hasAccount: true, lastIntent: 'capabilities' })
    assert.deepEqual(chips, CAPABILITIES_EXAMPLE_CHIPS.slice(0, 6))
  })

  it('no-account menu uses What can you ask?', () => {
    const chips = suggestionChips({ hasAccount: false })
    assert.ok(chips.includes('What can you ask?'))
    assert.ok(chips.includes('Roast me anyway'))
  })
})

describe('suggestionChips upgrade slots', () => {
  it('prepends What about Slot chips from lastUpgradeSlots after upgrades', () => {
    const chips = suggestionChips({
      hasAccount: true,
      lastIntent: 'upgrades',
      lastUpgradeSlots: [
        { slotId: 6, slotLabel: 'Shoulder', chipLabel: 'Shoulder', bestDelta: 0.05, count: 2 },
        { slotId: 2, slotLabel: 'Head', chipLabel: 'Head', bestDelta: 0.02, count: 1 },
      ],
    })
    assert.equal(chips[0], 'What about Shoulder?')
    assert.ok(chips.includes('What about Head?'))
    assert.ok(chips.length <= 6)
  })

  it('surfaces What about Wrist? chips that extractUpgradeSlotHint can resolve', () => {
    const chips = suggestionChips({
      hasAccount: true,
      lastIntent: 'upgrades',
      lastUpgradeSlots: [
        { slotId: 9, slotLabel: 'Wrist', chipLabel: 'Wrist', bestDelta: 0.04, count: 2 },
        { slotId: 17, slotLabel: 'Chest', chipLabel: 'Chest', bestDelta: 0.03, count: 1 },
      ],
    })
    assert.equal(chips[0], 'What about Wrist?')
    assert.ok(chips.includes('What about Chest?'))
    const wrist = extractUpgradeSlotHint(chips[0])
    assert.equal(wrist?.canonical, 'WRIST')
    assert.deepEqual(wrist?.slotIds, [9, 10])
  })
})
