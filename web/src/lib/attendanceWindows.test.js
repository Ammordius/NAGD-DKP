import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyLeaderboardAttendanceWindows, computeAttendanceWindows, windowCutoff } from './attendanceWindows.js'

const NOW = '2026-10-26T12:00:00Z'

function tic(raidId, eventId, order, name, dkp, id) {
  return {
    id,
    raid_id: raidId,
    event_id: eventId,
    event_order: order,
    event_name: name,
    dkp_value: String(dkp),
  }
}

describe('attendance windows', () => {
  it('counts a 2 DKP tic as one raid tic and includes the boundary day', () => {
    assert.equal(windowCutoff('2026-10-26', 30), '2026-09-26')
    assert.equal(windowCutoff('2026-10-26', 60), '2026-08-27')
    const windows = computeAttendanceWindows({
      now: new Date(NOW),
      raids: [
        { raid_id: 'boundary', date_iso: '2026-09-26' },
        { raid_id: 'outside30', date_iso: '2026-09-25' },
        { raid_id: 'boundary60', date_iso: '2026-08-27T21:00:00-04:00' },
        { raid_id: 'old', date_iso: '2026-08-26' },
      ],
      events: [
        tic('boundary', 'e1', 1, '1 Hour Single/Double Boxing', 2, 1),
        tic('boundary', 'e0', 0, 'On-Time attendance', 0, 2),
        tic('outside30', 'e1', 1, 'DKP tic', 1, 3),
        tic('boundary60', 'on', 0, '9:00pm on-time', 1, 4),
        tic('boundary60', 'dkp', 1, '10:00pm DKP tic', 1, 5),
        tic('boundary60', 'dkp', 1, '10:00pm DKP tic', 99, 6),
        tic('old', 'e1', 1, 'DKP tic', 1, 7),
      ],
      attendance: [
        { raid_id: 'boundary', event_id: 'e1', char_id: 'c1', character_name: 'Ada', account_id: 'a' },
        { raid_id: 'boundary60', event_id: 'on', char_id: 'c1', character_name: 'Ada', account_id: null },
        { raid_id: 'boundary60', event_id: 'dkp', char_id: 'c2', character_name: 'Alt', account_id: null },
        { raid_id: 'boundary60', event_id: 'dkp', char_id: 'c1', character_name: 'Ada', account_id: 'a' },
      ],
      characterAccounts: [
        { char_id: 'c1', account_id: 'a' },
        { char_id: 'c2', account_id: 'a' },
      ],
      characters: [
        { char_id: 'c1', name: 'Ada' },
        { char_id: 'c2', name: 'Alt' },
      ],
    })
    assert.deepEqual(windows.periodTotals, { '30d': 1, '60d': 4 })
    assert.deepEqual(windows.byAccount.a, { earned_30d: 1, earned_60d: 3 })
  })

  it('keeps a missed tic inside both windows missing from both', () => {
    const windows = computeAttendanceWindows({
      now: new Date(NOW),
      raids: [
        { raid_id: 'recent', date_iso: '2026-10-22' },
        { raid_id: 'missed', date_iso: '2026-10-01' },
        { raid_id: 'older', date_iso: '2026-09-01' },
      ],
      events: [
        tic('recent', 'e1', 1, 'DKP tic', 1, 1),
        tic('recent', 'e2', 2, 'DKP tic', 2, 2),
        tic('missed', 'e1', 0, 'On-Time attendance', 1, 3),
        tic('missed', 'e2', 1, 'DKP tic', 1, 4),
        tic('missed', 'e3', 2, 'DKP tic', 1, 5),
        tic('older', 'e1', 1, 'DKP tic', 1, 6),
      ],
      attendance: [
        { raid_id: 'recent', event_id: 'e1', account_id: 'a' },
        { raid_id: 'recent', event_id: 'e2', account_id: 'a' },
        { raid_id: 'older', event_id: 'e1', account_id: 'a' },
      ],
    })
    const pool30 = windows.periodTotals['30d']
    const pool60 = windows.periodTotals['60d']
    const got = windows.byAccount.a
    assert.equal(pool30, 5)
    assert.equal(pool60, 6)
    assert.equal(got.earned_30d, 2)
    assert.equal(got.earned_60d, 3)
    assert.ok(got.earned_30d < pool30)
    assert.ok(got.earned_60d < pool60)
    assert.ok(got.earned_60d <= pool60 - (pool30 - got.earned_30d))
  })

  it('credits a linked character id and skips an ambiguous name', () => {
    const windows = computeAttendanceWindows({
      now: new Date(NOW),
      raids: [{ raid_id: 'r', date_iso: '2026-10-20' }],
      events: [tic('r', 'e1', 1, 'DKP tic', 1, 1)],
      attendance: [
        { raid_id: 'r', event_id: 'e1', char_id: null, character_name: 'Shared' },
        { raid_id: 'r', event_id: 'e1', char_id: 'known', character_name: 'Shared' },
      ],
      characterAccounts: [
        { char_id: 'one', account_id: 'a' },
        { char_id: 'two', account_id: 'b' },
        { char_id: 'known', account_id: 'a' },
      ],
      characters: [
        { char_id: 'one', name: 'Shared' },
        { char_id: 'two', name: 'Shared' },
        { char_id: 'known', name: 'Real' },
      ],
    })
    assert.equal(windows.periodTotals['30d'], 1)
    assert.deepEqual(windows.byAccount.a, { earned_30d: 1, earned_60d: 1 })
    assert.equal(windows.byAccount.b, undefined)
  })

  it('replaces stale DKP window totals and leaves balance alone', () => {
    const processed = applyLeaderboardAttendanceWindows({
      periodTotals: { '30d': 40, '60d': 76 },
      accountList: [{ account_id: '21701536', earned_30d: 37, earned_60d: 76, balance: 60 }],
      fullAccountTotals: {
        '21701536': { earned: 100, spent: 40, balance: 60, earned_30d: 37, earned_60d: 76 },
      },
    }, {
      attendance_as_of: NOW,
      attendance_window_rows: {
        raids: [
          { raid_id: 'recent', date_iso: '2026-10-22' },
          { raid_id: 'missed', date_iso: '2026-09-24' },
        ],
        events: [
          tic('recent', 'e1', 1, 'DKP tic', 2, 1),
          tic('missed', 'e1', 1, 'DKP tic', 1, 2),
          tic('missed', 'e2', 2, 'DKP tic', 1, 3),
          tic('missed', 'e3', 3, 'DKP tic', 1, 4),
        ],
        attendance: [
          { raid_id: 'recent', event_id: 'e1', account_id: '21701536' },
        ],
      },
      account_dkp_summary: [{
        account_id: '21701536',
        display_name: 'Inacht',
        earned: 100,
        spent: 40,
        earned_30d: 37,
        earned_60d: 76,
        last_activity_date: '2026-10-22',
      }],
      dkp_period_totals: [
        { period: '30d', total_dkp: 40 },
        { period: '60d', total_dkp: 76 },
      ],
      accounts: [{ account_id: '21701536', display_name: 'Inacht', inactive: false }],
      active_accounts: [{ account_id: '21701536' }],
    })
    assert.deepEqual(processed.periodTotals, { '30d': 1, '60d': 4 })
    assert.equal(processed.fullAccountTotals['21701536'].earned_30d, 1)
    assert.equal(processed.fullAccountTotals['21701536'].earned_60d, 1)
    assert.equal(processed.fullAccountTotals['21701536'].balance, 60)
    assert.equal(processed.accountList[0].earned_30d, 1)
    assert.equal(processed.accountList[0].earned_60d, 1)
  })
})
