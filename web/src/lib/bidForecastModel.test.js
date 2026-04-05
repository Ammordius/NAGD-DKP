import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  classifyWeaponLane,
  interestScoreRecentToonSpendBonus,
  interestScoreSameSlotCooldownPenalty,
  interestScoreUpgradeComponent,
  lastOnToonSpendQualityNarrative,
} from './bidForecastModel.js'

function isoDaysAgo(n) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

describe('interestScoreSameSlotCooldownPenalty', () => {
  const nameToId = new Map([['cheap ear', '1'], ['big ear', '2'], ['two hander', '3'], ['one hand flex', '4']])
  const itemStats = {
    1: { name: 'Cheap Ear', slot: 'EAR' },
    2: { name: 'Big Ear', slot: 'EAR' },
    3: { name: 'Lance', slot: 'PRIMARY', skill: '2H Piercing', dmg: 40, atkDelay: 45 },
    4: { name: 'Short Sword', slot: 'PRIMARY SECONDARY', skill: '1H Slashing', dmg: 15, atkDelay: 24 },
  }

  it('ignores same-slot purchases at or below filler DKP threshold', () => {
    const purchases = [
      { item_name: 'cheap ear', raid_date: isoDaysAgo(10), char_id: 'c1', cost: 2 },
    ]
    const pen = interestScoreSameSlotCooldownPenalty(purchases, nameToId, itemStats, 'c1', '', 'EAR')
    assert.equal(pen, 0)
  })

  it('applies penalty for meaningful same-slot spend', () => {
    const purchases = [
      { item_name: 'big ear', raid_date: isoDaysAgo(10), char_id: 'c1', cost: 50 },
    ]
    const pen = interestScoreSameSlotCooldownPenalty(purchases, nameToId, itemStats, 'c1', '', 'EAR')
    assert.ok(pen > 0)
  })

  it('WAR/ROG/MNK: no penalty when overlapping PRIMARY but weapon lanes differ (2H vs dual 1H)', () => {
    const purchases = [
      { item_name: 'one hand flex', raid_date: isoDaysAgo(20), char_id: 'c1', cost: 30 },
    ]
    const pen = interestScoreSameSlotCooldownPenalty(purchases, nameToId, itemStats, 'c1', '', 'PRIMARY', {
      classAbbrev: 'WAR',
      currentItemStatsRow: itemStats[3],
    })
    assert.equal(pen, 0)
  })

  it('still penalizes two purchases in the same weapon lane (two 2H)', () => {
    const nameToId2 = new Map([
      ['lance a', '10'],
      ['lance b', '11'],
    ])
    const stats = {
      10: { name: 'Lance A', slot: 'PRIMARY', skill: '2H Piercing', dmg: 40, atkDelay: 45 },
      11: { name: 'Lance B', slot: 'PRIMARY', skill: '2H Blunt', dmg: 35, atkDelay: 40 },
    }
    const purchases = [{ item_name: 'lance a', raid_date: isoDaysAgo(15), char_id: 'c1', cost: 100 }]
    const pen = interestScoreSameSlotCooldownPenalty(purchases, nameToId2, stats, 'c1', '', 'PRIMARY', {
      classAbbrev: 'MNK',
      currentItemStatsRow: stats[11],
    })
    assert.ok(pen > 0)
  })
})

describe('classifyWeaponLane', () => {
  it('classifies 2H primary, shield secondary, and flexible 1H', () => {
    assert.equal(
      classifyWeaponLane({ name: 'Lance', slot: 'PRIMARY', skill: '2H Piercing', dmg: 40 }),
      'two_hand',
    )
    assert.equal(
      classifyWeaponLane({ name: 'Fearsome Shield', slot: 'SECONDARY', ac: 40 }),
      'shield',
    )
    assert.equal(
      classifyWeaponLane({ name: 'Short Sword', slot: 'PRIMARY SECONDARY', skill: '1H Slashing', dmg: 12 }),
      'mh_one_hand',
    )
  })
})

describe('interestScoreRecentToonSpendBonus', () => {
  it('scales down when last on-toon purchase is filler DKP', () => {
    const full = interestScoreRecentToonSpendBonus(
      {
        recent_purchases_desc: [
          { raid_date: isoDaysAgo(5), char_id: 'x', item_name: 'a', cost: 50 },
        ],
      },
      'x',
      '',
    )
    const filler = interestScoreRecentToonSpendBonus(
      {
        recent_purchases_desc: [
          { raid_date: isoDaysAgo(5), char_id: 'x', item_name: 'a', cost: 2 },
        ],
      },
      'x',
      '',
    )
    assert.ok(filler < full)
  })
})

describe('interestScoreUpgradeComponent', () => {
  it('boosts large scoreDelta and trims tiny sidegrades', () => {
    const mid = interestScoreUpgradeComponent(true, 0.015)
    const big = interestScoreUpgradeComponent(true, 0.03)
    const tiny = interestScoreUpgradeComponent(true, 0.008)
    assert.ok(big > mid)
    assert.ok(mid >= tiny)
  })
})

describe('lastOnToonSpendQualityNarrative', () => {
  it('mentions filler and high vs ref when applicable', () => {
    const p1 = [{ raid_date: isoDaysAgo(1), char_id: 'z', cost: 2 }]
    assert.ok(lastOnToonSpendQualityNarrative(p1, 'z', '').includes('filler'))
    const p2 = [{ raid_date: isoDaysAgo(1), char_id: 'z', cost: 80, paid_to_ref_ratio: 1.4 }]
    assert.ok(lastOnToonSpendQualityNarrative(p2, 'z', '').includes('high'))
  })
})
