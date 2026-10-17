import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ATTENDANCE_GREEN,
  ATTENDANCE_RED,
  ATTENDANCE_YELLOW,
  attendanceShareColor,
  attendanceShareEarned,
  attendanceSharePercent,
  compareLeaderboardRows,
  nextLeaderboardSort,
} from './dkpLeaderboardSort.js'

const rows = [
  { account_id: '1', name: 'Zed', balance: 10, earned: 100, spent: 90, earned_30d: 1, earned_60d: 5 },
  { account_id: '2', name: 'Amy', balance: 50, earned: 80, spent: 30, earned_30d: 9, earned_60d: 2 },
  { account_id: '3', name: 'bob', balance: 50, earned: 70, spent: 20, earned_30d: 4, earned_60d: 8 },
]

const totals = {
  2: { balance: 40, earned: 200, spent: 160, earned_30d: 3, earned_60d: 7 },
}

function order(column, direction, extraTotals = totals) {
  return [...rows].sort((a, b) => compareLeaderboardRows(a, b, column, direction, extraTotals)).map((row) => row.account_id)
}

describe('leaderboard column sort', () => {
  it('sorts balance high to low and uses the full account total when present', () => {
    assert.deepEqual(order('balance', 'desc'), ['3', '2', '1'])
  })

  it('breaks equal balances by account name A to Z', () => {
    assert.deepEqual(order('balance', 'desc', {}), ['2', '3', '1'])
  })

  it('sorts account names A to Z and Z to A without case sensitivity', () => {
    assert.deepEqual(order('account', 'asc'), ['2', '3', '1'])
    assert.deepEqual(order('account', 'desc'), ['1', '3', '2'])
  })

  it('sorts 30d and 60d by earned amount, including the full total override', () => {
    assert.deepEqual(order('30d', 'desc'), ['3', '2', '1'])
    assert.deepEqual(order('60d', 'asc'), ['1', '2', '3'])
  })

  it('sorts earned and spent with the same full-total numbers the table shows', () => {
    assert.deepEqual(order('earned', 'desc'), ['2', '1', '3'])
    assert.deepEqual(order('spent', 'asc'), ['3', '1', '2'])
  })
})

describe('attendance share colors', () => {
  it('colors the rounded percent: green above 45, yellow from 10 through 45, red below 10', () => {
    assert.equal(attendanceShareColor(46), ATTENDANCE_GREEN)
    assert.equal(attendanceShareColor(100), ATTENDANCE_GREEN)
    assert.equal(attendanceShareColor(45), ATTENDANCE_YELLOW)
    assert.equal(attendanceShareColor(10), ATTENDANCE_YELLOW)
    assert.equal(attendanceShareColor(9), ATTENDANCE_RED)
    assert.equal(attendanceShareColor(0), ATTENDANCE_RED)
    assert.equal(attendanceShareColor(null), null)
  })

  it('rounds before coloring so the color matches the percent in the cell', () => {
    assert.equal(attendanceSharePercent(456, 1000), 46)
    assert.equal(attendanceShareColor(attendanceSharePercent(456, 1000)), ATTENDANCE_GREEN)
    assert.equal(attendanceSharePercent(454, 1000), 45)
    assert.equal(attendanceShareColor(attendanceSharePercent(454, 1000)), ATTENDANCE_YELLOW)
    assert.equal(attendanceSharePercent(96, 1000), 10)
    assert.equal(attendanceShareColor(attendanceSharePercent(96, 1000)), ATTENDANCE_YELLOW)
    assert.equal(attendanceSharePercent(94, 1000), 9)
    assert.equal(attendanceShareColor(attendanceSharePercent(94, 1000)), ATTENDANCE_RED)
    assert.equal(attendanceSharePercent(0, 0), null)
  })

  it('caps the share at 100 when window DKP is above the pool', () => {
    assert.equal(attendanceSharePercent(120, 100), 100)
    assert.equal(attendanceSharePercent(100, 100), 100)
    assert.equal(attendanceSharePercent(456, 1000), 46)
    assert.equal(attendanceSharePercent(0, 100), 0)
    assert.equal(attendanceSharePercent(-5, 100), 0)
    assert.equal(attendanceShareEarned(120, 100), 100)
    assert.equal(attendanceShareEarned(46, 100), 46)
    assert.equal(attendanceShareEarned(0, 100), 0)
  })
})

describe('nextLeaderboardSort', () => {
  it('flips the current column and starts names A to Z, numbers high to low', () => {
    assert.deepEqual(nextLeaderboardSort('balance', 'desc', 'balance'), { key: 'balance', dir: 'asc' })
    assert.deepEqual(nextLeaderboardSort('balance', 'asc', 'balance'), { key: 'balance', dir: 'desc' })
    assert.deepEqual(nextLeaderboardSort('balance', 'desc', 'account'), { key: 'account', dir: 'asc' })
    assert.deepEqual(nextLeaderboardSort('account', 'asc', 'earned'), { key: 'earned', dir: 'desc' })
    assert.deepEqual(nextLeaderboardSort('earned', 'asc', '30d'), { key: '30d', dir: 'desc' })
    assert.deepEqual(nextLeaderboardSort('30d', 'desc', '60d'), { key: '60d', dir: 'desc' })
  })
})
