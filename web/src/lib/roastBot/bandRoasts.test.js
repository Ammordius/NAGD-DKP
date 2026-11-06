import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  characterSpendRoast,
  characterStatsRoast,
  gearBandRoast,
  raidReadyRoast,
} from './bandRoasts.js'
import { formatDkp } from './formatting.js'

describe('bandRoasts', () => {
  it('strong gear praises then punches', () => {
    const text = gearBandRoast('strong', { name: 'Iaminae', pct: 98 })
    assert.match(text, /98%/)
    assert.match(text, /great|buttons/i)
    assert.ok(text.length <= 200)
  })

  it('high spend still insults', () => {
    const text = characterSpendRoast(5200, 'Iaminae', formatDkp)
    assert.match(text, /5200/)
    assert.match(text, /keys|armor/i)
  })

  it('raid-ready collapses briefing into roast-first status', () => {
    const text = raidReadyRoast({
      name: 'Iaminae',
      pctLabel: '90%',
      classLabel: 'ENC',
      viable: true,
      green: true,
      viabilityCut: 75,
      greenCut: 85,
      sheetBits: '4200 HP. average save 35',
    })
    assert.match(text, /90%/)
    assert.match(text, /Raid-ready >75%/)
    assert.match(text, /buttons|ranking/i)
    assert.match(text, /4200 HP/)
    assert.doesNotMatch(text, /officer Raider Activity/)
  })

  it('stats opener is roast-first with newline body', () => {
    const text = characterStatsRoast('Iaminae', 'Enchanter', ['HP 4200 · Mana 3100', 'INT 140'])
    assert.match(text, /rotation/)
    assert.match(text, /\nHP 4200/)
  })
})
