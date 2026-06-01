import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  addDays,
  buildScheduleOutput,
  computeUpcomingSlots,
  formatOutputLine,
  getTodayNyDate,
  nextDateOnOrAfter,
  nyLocalToUnixEpoch,
  SCHEDULE_SLOTS,
} from './discordSchedule.js'

describe('discordSchedule', () => {
  it('getTodayNyDate uses America/New_York not local machine date', () => {
    // 2026-06-02 02:30 UTC = 2026-06-01 22:30 EDT (still June 1 in NY)
    const lateUtc = new Date('2026-06-02T02:30:00.000Z')
    assert.equal(getTodayNyDate(lateUtc), '2026-06-01')
    // 2026-06-02 04:00 UTC = 2026-06-02 00:00 EDT
    const afterMidnightNy = new Date('2026-06-02T04:00:00.000Z')
    assert.equal(getTodayNyDate(afterMidnightNy), '2026-06-02')
  })

  it('nextDateOnOrAfter finds same day when weekday matches', () => {
    assert.equal(nextDateOnOrAfter('2026-06-02', 2), '2026-06-02') // Tue
  })

  it('computeUpcomingSlots walks Tue Thu Mon / Thu Mon Tue from anchor', () => {
    const slots = computeUpcomingSlots('2026-06-01') // Monday
    assert.equal(slots.length, 6)
    assert.deepEqual(
      slots.map((s) => s.dateIso),
      ['2026-06-02', '2026-06-04', '2026-06-08', '2026-06-11', '2026-06-15', '2026-06-16']
    )
    assert.deepEqual(
      slots.map((s) => s.week),
      SCHEDULE_SLOTS.map((s) => s.week)
    )
  })

  it('nyLocalToUnixEpoch resolves 9pm Eastern on 2026-06-04 (EDT)', () => {
    const epoch = nyLocalToUnixEpoch('2026-06-04', 21, 0)
    // 9pm EDT Jun 4 = 01:00 UTC Jun 5
    assert.equal(epoch, Math.floor(Date.UTC(2026, 5, 5, 1, 0, 0) / 1000))
  })

  it('nyLocalToUnixEpoch resolves 9pm Eastern on 2026-01-15 (EST)', () => {
    const epoch = nyLocalToUnixEpoch('2026-01-15', 21, 0)
    // 9pm EST Jan 15 = 02:00 UTC Jan 16
    assert.equal(epoch, Math.floor(Date.UTC(2026, 0, 16, 2, 0, 0) / 1000))
  })

  it('formatOutputLine matches exact casing and spacing', () => {
    const line = formatOutputLine(
      { dateIso: '2026-06-04', dayName: 'Thursday', mmdd: '06/04' },
      'Memory Farm Running Through 06/07',
      { hour24: 21, minute: 0 }
    )
    const epoch = nyLocalToUnixEpoch('2026-06-04', 21, 0)
    assert.equal(
      line,
      `Thursday 06/04 9pm edt: Memory Farm Running Through 06/07 - <t:${epoch}:f>`
    )
  })

  it('buildScheduleOutput inserts Week 2 after third row divider', () => {
    const slots = computeUpcomingSlots('2026-06-01')
    const names = ['A', 'B', 'C', 'D', 'E', 'F']
    const times = Array(6).fill({ hour24: 21, minute: 0 })
    const out = buildScheduleOutput(slots, names, times)
    const lines = out.split('\n')
    const week2Idx = lines.indexOf('Week 2')
    assert.ok(week2Idx > 0)
    assert.equal(lines[week2Idx - 1], '-------')
    assert.equal(lines[week2Idx + 1].startsWith('Thursday'), true)
  })

  it('addDays handles month boundaries', () => {
    assert.equal(addDays('2026-06-30', 1), '2026-07-01')
  })
})
