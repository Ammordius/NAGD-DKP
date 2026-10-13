import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  cutoffIsoDay,
  preferAttendanceEarned,
  sumAttendanceEarnedByAccount,
  summaryRowsIncludingAttendance,
} from './accountEarned.js'

const now = new Date('2026-10-13T12:00:00Z')

describe('sumAttendanceEarnedByAccount', () => {
  it('sums lifetime earned and splits 30d and 60d on the raid date', () => {
    const totals = sumAttendanceEarnedByAccount(
      [
        { account_id: '22078185', raid_id: 'old', dkp_earned: 400 },
        { account_id: '22078185', raid_id: 'recent', dkp_earned: '512' },
      ],
      { old: '2026-08-01', recent: '2026-10-01T18:00:00Z' },
      now,
    )
    assert.equal(cutoffIsoDay(30, now), '2026-09-13')
    assert.deepEqual(totals['22078185'], {
      earned: 912,
      earned_30d: 512,
      earned_60d: 512,
      last_activity_date: '2026-10-01',
    })
  })
})

describe('leaderboard earned when the summary cache is 0', () => {
  it('uses the attendance sum, so balance matches the account page', () => {
    const live = sumAttendanceEarnedByAccount(
      [
        { account_id: '22078185', raid_id: 'a', dkp_earned: 400 },
        { account_id: '22078185', raid_id: 'b', dkp_earned: 512 },
      ],
      { a: '2026-09-01', b: '2026-10-01' },
      now,
    )['22078185']
    const earned = preferAttendanceEarned(0, live.earned)
    const spent = 778
    assert.equal(earned, 912)
    assert.equal(earned - spent, 134)
    assert.equal(preferAttendanceEarned(0, live.earned_30d), live.earned_30d)
  })

  it('keeps a higher summary earned and adds attendance-only accounts', () => {
    assert.equal(preferAttendanceEarned(1000, 50), 1000)
    const rows = summaryRowsIncludingAttendance(
      [{ account_id: '1', earned: 1000, spent: 10 }],
      { '1': { earned: 50 }, '2': { earned: 80 } },
    )
    assert.deepEqual(rows.map((r) => r.account_id), ['1', '2'])
    assert.equal(rows[1].spent, 0)
  })
})
