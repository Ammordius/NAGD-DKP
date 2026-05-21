import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAccountDkpTimeSeries,
  lootCharacterKey,
  selectTopCharactersForCharts,
  buildCharacterKeyMap,
} from './accountDkpTimeSeries.js'

describe('lootCharacterKey', () => {
  it('prefers assignment fields', () => {
    assert.equal(
      lootCharacterKey({ assigned_character_name: 'Bob', character_name: 'Alice' }),
      'Bob',
    )
  })
})

describe('buildAccountDkpTimeSeries', () => {
  const characters = [{ char_id: 'c1', name: 'Alice' }, { char_id: 'c2', name: 'Bob' }]
  const dkpByCharacterKey = {
    earned: { c1: 100, Alice: 100, c2: 50, Bob: 50 },
    spent: { c1: 25, Alice: 25, c2: 5, Bob: 5 },
  }

  it('builds cumulative net and invested series', () => {
    const activityByRaid = [
      {
        raid_id: 'r1',
        date: '2024-01-10',
        dkpEarned: 10,
        items: [{ cost: 5, assigned_char_id: 'c1' }],
      },
      {
        raid_id: 'r2',
        date: '2024-02-01',
        dkpEarned: 20,
        items: [{ cost: 10, assigned_character_name: 'Bob' }],
      },
    ]
    const { netSeries, investedSeries, hasDatedRaids } = buildAccountDkpTimeSeries(
      activityByRaid,
      characters,
      dkpByCharacterKey,
    )
    assert.equal(hasDatedRaids, true)
    assert.equal(netSeries.length, 2)
    assert.equal(netSeries[0].net, 5)
    assert.equal(netSeries[1].net, 15)
    assert.equal(investedSeries[1].invested, 15)
  })
})

describe('selectTopCharactersForCharts', () => {
  it('excludes characters with spent <= 10', () => {
    const { list } = buildCharacterKeyMap([
      { char_id: 'a', name: 'High' },
      { char_id: 'b', name: 'Low' },
    ])
    const dkpByCharacterKey = { spent: { a: 50, High: 50, b: 8, Low: 8 } }
    const top = selectTopCharactersForCharts(list, dkpByCharacterKey)
    assert.equal(top.length, 1)
    assert.equal(top[0].displayName, 'High')
  })
})
