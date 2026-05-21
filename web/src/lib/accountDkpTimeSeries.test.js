import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAccountDkpTimeSeries,
  lootCharacterKey,
  selectTopCharactersForCharts,
  buildCharacterKeyMap,
  raidHasAccountActivity,
  filterActivityRaids,
  resolveChartDateBounds,
  sliceSeriesToDateWindow,
  sparseCharacterSeries,
} from './accountDkpTimeSeries.js'

describe('lootCharacterKey', () => {
  it('prefers assignment fields', () => {
    assert.equal(
      lootCharacterKey({ assigned_character_name: 'Bob', character_name: 'Alice' }),
      'Bob',
    )
  })
})

describe('raidHasAccountActivity', () => {
  it('is false for guild absence rows', () => {
    assert.equal(raidHasAccountActivity({ dkpEarned: 0, ticEarned: 0, items: [] }), false)
  })
  it('is true when loot or earn present', () => {
    assert.equal(raidHasAccountActivity({ dkpEarned: 5, items: [] }), true)
    assert.equal(raidHasAccountActivity({ dkpEarned: 0, items: [{ cost: 1 }] }), true)
  })
})

describe('filterActivityRaids', () => {
  it('drops absence-only raids', () => {
    const raids = [
      { date: '2020-01-01', dkpEarned: 0, items: [] },
      { date: '2024-06-01', dkpEarned: 10, items: [] },
    ]
    assert.equal(filterActivityRaids(raids).length, 1)
  })
})

describe('resolveChartDateBounds', () => {
  const sorted = [
    { date: '2024-10-01' },
    { date: '2025-05-01' },
  ]

  it('clips 12-month window to first activity when account is newer', () => {
    const b = resolveChartDateBounds(sorted, 12)
    assert.equal(b.start, '2024-10-01')
    assert.equal(b.end, '2025-05-01')
  })

  it('uses rolling cutoff when history exceeds window', () => {
    const long = [
      { date: '2020-01-01' },
      { date: '2025-05-01' },
    ]
    const b = resolveChartDateBounds(long, 12)
    assert.equal(b.end, '2025-05-01')
    assert.ok(b.start > '2020-01-01')
    assert.ok(b.start <= '2025-05-01')
  })

  it('months 0 uses full activity span', () => {
    const b = resolveChartDateBounds(sorted, 0)
    assert.equal(b.start, '2024-10-01')
    assert.equal(b.end, '2025-05-01')
    assert.equal(b.months, 0)
  })
})

describe('sliceSeriesToDateWindow', () => {
  it('prepends anchor with cumulative value before window', () => {
    const series = [
      { date: '2024-01-01', invested: 10 },
      { date: '2024-06-01', invested: 50 },
      { date: '2025-01-01', invested: 80 },
    ]
    const sliced = sliceSeriesToDateWindow(series, '2024-12-01', '2025-06-01', 'invested')
    assert.equal(sliced[0].date, '2024-12-01')
    assert.equal(sliced[0].invested, 50)
    assert.equal(sliced[1].date, '2025-01-01')
    assert.equal(sliced[1].invested, 80)
  })
})

describe('sparseCharacterSeries', () => {
  it('drops flat intermediate points', () => {
    const series = [
      { date: '2024-01-01', invested: 0 },
      { date: '2024-02-01', invested: 0 },
      { date: '2024-03-01', invested: 10 },
      { date: '2024-04-01', invested: 10 },
      { date: '2024-05-01', invested: 20 },
    ]
    const sparse = sparseCharacterSeries(series)
    assert.equal(sparse.length, 3)
    assert.deepEqual(
      sparse.map((p) => p.date),
      ['2024-01-01', '2024-03-01', '2024-05-01'],
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
      { months: 0 },
    )
    assert.equal(hasDatedRaids, true)
    assert.equal(netSeries.length, 2)
    assert.equal(netSeries[0].net, 5)
    assert.equal(netSeries[1].net, 15)
    assert.equal(investedSeries[1].invested, 15)
  })

  it('excludes universe absence raids from chart walk', () => {
    const activityByRaid = [
      { raid_id: 'abs1', date: '2020-01-01', dkpEarned: 0, items: [] },
      { raid_id: 'abs2', date: '2021-06-01', dkpEarned: 0, ticEarned: 0, items: [] },
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
        items: [],
      },
    ]
    const { netSeries } = buildAccountDkpTimeSeries(
      activityByRaid,
      characters,
      dkpByCharacterKey,
      { months: 0 },
    )
    assert.equal(netSeries.length, 2)
    assert.equal(netSeries[0].date, '2024-01-10')
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
