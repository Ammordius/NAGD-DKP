import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getActivityStatus,
  computeRaPercent,
  raForWindow,
  buildRaiderActivityRows,
  buildActivitySummary,
  buildWatchlists,
  filterAndSortRows,
  attendedAnyOfLastNRaid,
  formatTrendDelta,
  parseRaidDate,
} from './raiderActivity.js'

const NOW = new Date('2026-05-21T12:00:00Z')

function makeSnapshot({ raids, attendance, roster = ['a1', 'a2'] }) {
  return {
    raids: raids.map((r) => ({
      raid_id: r.id,
      date_iso: r.date,
      raid_date: r.date,
      attendee_count: r.attendees ?? 2,
    })),
    roster_account_ids: roster,
    accounts: roster.map((id) => ({
      account_id: id,
      display_name: id.toUpperCase(),
      toon_names: '',
      inactive: false,
    })),
    attendance,
  }
}

describe('getActivityStatus', () => {
  it('prioritizes Returning over Core', () => {
    assert.equal(getActivityStatus(75, 40), 'Returning')
  })
  it('prioritizes Declining over Active', () => {
    assert.equal(getActivityStatus(45, 80), 'Declining')
  })
  it('labels Core Active Rotational At Risk', () => {
    assert.equal(getActivityStatus(85, 85), 'Core')
    assert.equal(getActivityStatus(65, 65), 'Active')
    assert.equal(getActivityStatus(40, 40), 'Rotational')
    assert.equal(getActivityStatus(10, 10), 'At Risk')
  })
  it('returns null when RA missing', () => {
    assert.equal(getActivityStatus(null, 50), null)
  })
})

describe('computeRaPercent', () => {
  it('returns null for zero eligible', () => {
    assert.equal(computeRaPercent(0, 0), null)
  })
  it('rounds to one decimal', () => {
    assert.equal(computeRaPercent(2, 3), 66.7)
  })
})

describe('raForWindow', () => {
  const raids = [
    { raid_id: 'r1', raid_date: '2026-04-01' },
    { raid_id: 'r2', raid_date: '2026-04-15' },
    { raid_id: 'r3', raid_date: '2026-05-10' },
    { raid_id: 'r4', raid_date: '2026-05-18' },
  ]
  const attended = new Set(['r2', 'r4'])

  it('counts eligible raids in 30d window', () => {
    const w = raForWindow(raids, attended, 30, NOW)
    assert.equal(w.eligible, 2)
    assert.equal(w.attended, 1)
    assert.equal(w.ra, 50)
  })
})

describe('buildRaiderActivityRows', () => {
  const snapshot = makeSnapshot({
    raids: [
      { id: 'r1', date: '2026-02-01' },
      { id: 'r2', date: '2026-03-01' },
      { id: 'r3', date: '2026-04-01' },
      { id: 'r4', date: '2026-05-01' },
      { id: 'r5', date: '2026-05-15' },
    ],
    attendance: [
      { raid_id: 'r1', account_id: 'a1' },
      { raid_id: 'r2', account_id: 'a1' },
      { raid_id: 'r3', account_id: 'a1' },
      { raid_id: 'r4', account_id: 'a1' },
      { raid_id: 'r5', account_id: 'a1' },
      { raid_id: 'r5', account_id: 'a2' },
    ],
    roster: ['a1', 'a2'],
  })

  it('computes trend delta ra30 - ra90', () => {
    const { rows } = buildRaiderActivityRows(snapshot, { periodDays: 90, now: NOW })
    const a1 = rows.find((r) => r.accountId === 'a1')
    assert.ok(a1)
    if (a1.ra30 != null && a1.ra90 != null) {
      assert.equal(a1.trendDelta, Math.round((a1.ra30 - a1.ra90) * 10) / 10)
    }
  })

  it('marks roster members isTracked', () => {
    const { rows } = buildRaiderActivityRows(snapshot, { now: NOW })
    assert.equal(rows.find((r) => r.accountId === 'a1')?.isTracked, true)
    assert.equal(rows.find((r) => r.accountId === 'a2')?.isTracked, true)
  })
})

describe('buildActivitySummary', () => {
  it('counts status buckets on roster only', () => {
    const rows = [
      { accountId: 'a1', isTracked: true, status: 'Core', ra30: 90, lastAttendedRaidDate: '2026-05-01' },
      { accountId: 'a2', isTracked: true, status: 'At Risk', ra30: 0, lastAttendedRaidDate: null },
      { accountId: 'x', isTracked: false, status: 'Core', ra30: 100, lastAttendedRaidDate: '2026-05-01' },
    ]
    const rosterIds = new Set(['a1', 'a2'])
    const raids = [{ raid_id: 'r1', raid_date: '2026-05-01', attendee_count: 25 }]
    const s = buildActivitySummary(rows, rosterIds, raids, 90, NOW)
    assert.equal(s.totalTracked, 2)
    assert.equal(s.core, 1)
    assert.equal(s.atRisk, 1)
  })
})

describe('buildWatchlists', () => {
  it('lists declining and returning by status', () => {
    const rows = [
      {
        accountId: 'd1',
        isTracked: true,
        status: 'Declining',
        ra30: 40,
        lastAttendedRaidDate: '2026-05-01',
        recentAttendancePattern: [true, true],
      },
      {
        accountId: 'r1',
        isTracked: true,
        status: 'Returning',
        ra30: 80,
        lastAttendedRaidDate: '2026-05-10',
        recentAttendancePattern: [false, true, true],
      },
    ]
    const raids = [
      { raid_id: 'x1', raid_date: '2026-05-01' },
      { raid_id: 'x2', raid_date: '2026-05-10' },
      { raid_id: 'x3', raid_date: '2026-05-18' },
    ]
    const w = buildWatchlists(rows, { now: NOW, raidsSorted: raids, absentRaids: 2 })
    assert.equal(w.declining.length, 1)
    assert.equal(w.returning.length, 1)
  })

  it('flags recently absent when no last 30d attendance', () => {
    const rows = [
      {
        accountId: 'absent',
        isTracked: true,
        status: 'Rotational',
        ra30: 20,
        lastAttendedRaidDate: '2026-01-01',
        recentAttendancePattern: [false, false],
      },
    ]
    const raids = [
      { raid_id: 'x1', raid_date: '2026-05-01' },
      { raid_id: 'x2', raid_date: '2026-05-18' },
    ]
    const w = buildWatchlists(rows, { now: NOW, raidsSorted: raids, absentRaids: 2 })
    assert.equal(w.recentlyAbsent.length, 1)
  })
})

describe('attendedAnyOfLastNRaid', () => {
  it('true when any of last N pattern slots attended', () => {
    const raids = [{ raid_id: 'a' }, { raid_id: 'b' }, { raid_id: 'c' }]
    assert.equal(attendedAnyOfLastNRaid([false, true], raids, 2), true)
    assert.equal(attendedAnyOfLastNRaid([false, false], raids, 2), false)
  })
})

describe('filterAndSortRows', () => {
  const rows = [
    { accountId: 'z', displayName: 'Zed', toonNames: '', status: 'Core', ra30: 80, trendDelta: 5, lastAttendedRaidDate: '2026-05-01', attendedCount: 5 },
    { accountId: 'a', displayName: 'Alpha', toonNames: '', status: 'At Risk', ra30: 10, trendDelta: -20, lastAttendedRaidDate: '2026-04-01', attendedCount: 1 },
  ]

  it('filters by search and status', () => {
    const f = filterAndSortRows(rows, { search: 'alp', statusFilter: 'At Risk' })
    assert.equal(f.length, 1)
    assert.equal(f[0].accountId, 'a')
  })

  it('sorts by trendDelta', () => {
    const f = filterAndSortRows(rows, { sortBy: 'trendDelta' })
    assert.equal(f[0].accountId, 'z')
  })
})

describe('formatTrendDelta', () => {
  it('formats signed percent', () => {
    assert.deepEqual(formatTrendDelta(12), { text: '+12%', direction: 'up' })
    assert.deepEqual(formatTrendDelta(-8), { text: '-8%', direction: 'down' })
  })
})

describe('parseRaidDate', () => {
  it('parses ISO prefix', () => {
    assert.equal(parseRaidDate('2026-05-21 19:00:00'), '2026-05-21')
  })
})
