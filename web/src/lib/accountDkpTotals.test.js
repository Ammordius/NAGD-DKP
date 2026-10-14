import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatMyDkpTotal,
  formatRaidDkpEarned,
  mostRecentAttendedRaid,
  reconcileAccountDkp,
} from './accountDkpTotals.js'

describe('reconcileAccountDkp', () => {
  it('matches the account page when the summary is ahead of the loaded raids', () => {
    const totals = reconcileAccountDkp(
      { earned: 4791, spent: 4609 },
      [{ dkpEarned: 100, items: [{ cost: 40 }] }],
    )
    assert.deepEqual(totals, {
      earned: 4791,
      spent: 4609,
      balance: 182,
      staleSummary: false,
    })
    assert.equal(formatMyDkpTotal(totals), 'Your DKP total is: 182 (earned 4791 \u00B7 spent 4609)')
  })

  it('keeps the higher live earned and spent when the summary cache lags', () => {
    const totals = reconcileAccountDkp(
      { earned: 100, spent: 10 },
      [
        { dkpEarned: 80, items: [{ cost: '12' }, { cost: 'bad' }] },
        { dkpEarned: 70, items: [{ cost: 5 }] },
      ],
    )
    assert.equal(totals.earned, 150)
    assert.equal(totals.spent, 17)
    assert.equal(totals.balance, 133)
    assert.equal(totals.staleSummary, true)
  })

  it('uses summary spent when this page has no loot rows', () => {
    const totals = reconcileAccountDkp({ earned: 0, spent: 40 }, [{ dkpEarned: 10, items: [] }])
    assert.equal(totals.earned, 10)
    assert.equal(totals.spent, 40)
    assert.equal(totals.balance, -30)
  })
})

describe('mostRecentAttendedRaid', () => {
  const raids = [
    { raid_id: '10', date: '2026-10-01', raid_name: 'Older', dkpEarned: 4, dkpRaidTotal: 4, attended: true },
    { raid_id: '12', date: '2026-10-12', raid_name: 'Loot only', dkpEarned: 0, dkpRaidTotal: 6, attended: false, items: [{ cost: 20 }] },
    { raid_id: '11', date: '2026-10-12', raid_name: 'Late join', dkpEarned: 3, dkpRaidTotal: 4, attended: true },
    { raid_id: '13', date: '2026-10-12', raid_name: 'Full', dkpEarned: 4, dkpRaidTotal: 4, attended: true },
  ]

  it('picks the newest attended raid and ignores a newer loot-only row', () => {
    const raid = mostRecentAttendedRaid(raids)
    assert.equal(raid.raid_id, '13')
    assert.equal(formatRaidDkpEarned(raid), 'You earned 4 DKP out of 4 DKP')
  })

  it('keeps a same-day raid with a lower id when that is the only attendance', () => {
    const raid = mostRecentAttendedRaid(raids.filter((row) => row.raid_id !== '13'))
    assert.equal(raid.raid_id, '11')
    assert.equal(formatRaidDkpEarned(raid), 'You earned 3 DKP out of 4 DKP')
  })

  it('treats earned DKP as attendance when the flag is omitted, including a missed-tic zero', () => {
    const raid = mostRecentAttendedRaid([
      { raid_id: '2', date: '2026-09-01', dkpEarned: 2, dkpRaidTotal: 2 },
      { raid_id: '3', date: '2026-10-02', dkpEarned: 0, dkpRaidTotal: 4, attended: true },
    ])
    assert.equal(raid.raid_id, '3')
    assert.equal(formatRaidDkpEarned(raid), 'You earned 0 DKP out of 4 DKP')
  })
})
