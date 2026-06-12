import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  addDays,
  assignWeeksFromPeriodStart,
  buildScheduleOutput,
  buildScheduleOutputFromSlots,
  buildWeek1Post,
  buildWeek2Post,
  computeScheduleTitle,
  computeUpcomingSlots,
  createDefaultRows,
  formatOutputLine,
  getNextNextWednesdayNy,
  getTodayNyDate,
  nextDateOnOrAfter,
  nyLocalToUnixEpoch,
  parseScheduleMetadata,
  parseSchedulePaste,
  parseSchedulePasteRaw,
  parseTitlePeriodStart,
  projectParsedRowsToUpcoming,
  snapToWednesdayNy,
  snapToWednesdayOnOrBefore,
  SCHEDULE_SLOTS,
  slotFromDateIso,
  stripEventNameSuffix,
} from './discordSchedule.js'

const SAMPLE_PASTE = `-------
04/22 - 05/05 Raid Schedule
-------
Week 1:
-------
Thursday 4/23 9pm edt: Fire Minis + Seru/Praes - April 23, 2026 8:00 PM
-------
Monday 04/27 9pm edt: Fire Minis + Recharge - April 27, 2026 8:00 PM
-------
Tuesday 04/28 8pm edt: PoTime Early Start - April 28, 2026 7:00 PM
-------
InachtRole icon, Raid Director — 5/6/2026 12:12 AM
Week 2
-------
Thursday 04/30 9pm edt: PoTime Day 2 - April 30, 2026 8:00 PM
-------
Monday 05/04 9pm edt: Fire Minis + Fennin - May 4, 2026 8:00 PM
-------
Tuesday 05/05 9pm edt: Seru/Praes + Non DKP Shei - May 5, 2026 8:00 PM
-------
AC Burrower and CT Slime Ring are available as non dkp targets.  PoWater and SSRA are FFA
-------`

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

  it('buildScheduleOutput inserts Week 2 after Week 1 block', () => {
    const rows = createDefaultRows('2026-06-01').map((row, i) => ({
      ...row,
      eventName: ['A', 'B', 'C', 'D', 'E', 'F'][i],
    }))
    const out = buildScheduleOutput(rows)
    const lines = out.split('\n')
    const week2Idx = lines.indexOf('Week 2')
    assert.ok(week2Idx > 0)
    assert.equal(lines[week2Idx - 1], '-------')
    assert.equal(lines[week2Idx + 1], '-------')
    assert.equal(lines[week2Idx + 2].startsWith('Thursday'), true)
  })

  it('computeScheduleTitle derives title from period start Wednesday', () => {
    assert.equal(computeScheduleTitle('2026-06-03'), '06/03 - 06/16 Raid Schedule')
  })

  it('parseScheduleMetadata extracts title and week-2 footer from SAMPLE_PASTE', () => {
    const meta = parseScheduleMetadata(SAMPLE_PASTE)
    assert.equal(meta.scheduleTitle, '04/22 - 05/05 Raid Schedule')
    assert.equal(
      meta.week2Footer,
      'AC Burrower and CT Slime Ring are available as non dkp targets.  PoWater and SSRA are FFA'
    )
  })

  it('buildWeek1Post includes title, Week 1 label, and raid lines', () => {
    const rows = createDefaultRows('2026-06-01').map((row, i) => ({
      ...row,
      eventName: ['A', 'B', 'C', 'D', 'E', 'F'][i],
    }))
    const out = buildWeek1Post(rows, { scheduleTitle: '06/03 - 06/16 Raid Schedule' })
    const lines = out.split('\n')
    assert.deepEqual(lines.slice(0, 5), [
      '-------',
      '06/03 - 06/16 Raid Schedule',
      '-------',
      'Week 1:',
      '-------',
    ])
    assert.equal(lines[5].startsWith('Tuesday'), true)
    assert.equal(lines[6], '-------')
    assert.ok(!lines.includes('Week 2'))
    assert.ok(!lines.some((l, i) => l === '-------' && lines[i + 1] === '-------'))
  })

  it('buildWeek2Post includes Week 2 label, raids, and footer', () => {
    const rows = createDefaultRows('2026-06-01').map((row, i) => ({
      ...row,
      eventName: ['A', 'B', 'C', 'D', 'E', 'F'][i],
    }))
    const footer =
      'AC Burrower and CT Slime Ring are available as non dkp targets.  PoWater and SSRA are FFA'
    const out = buildWeek2Post(rows, { week2Footer: footer })
    const lines = out.split('\n')
    assert.equal(lines[0], 'Week 2')
    assert.equal(lines[1], '-------')
    assert.equal(lines[2].startsWith('Thursday'), true)
    assert.equal(lines[lines.length - 2], footer)
    assert.equal(lines[lines.length - 1], '-------')
    assert.ok(!lines.some((l, i) => l === '-------' && lines[i + 1] === '-------'))
  })

  it('buildScheduleOutputFromSlots matches legacy API', () => {
    const slots = computeUpcomingSlots('2026-06-01')
    const names = ['A', 'B', 'C', 'D', 'E', 'F']
    const times = Array(6).fill({ hour24: 21, minute: 0 })
    assert.equal(buildScheduleOutputFromSlots(slots, names, times), buildScheduleOutput(
      slots.map((slot, i) => ({
        week: slot.week,
        dateIso: slot.dateIso,
        eventName: names[i],
        time: times[i],
      }))
    ))
  })

  it('getNextNextWednesdayNy skips the upcoming Wednesday', () => {
    assert.equal(getNextNextWednesdayNy('2026-06-01'), '2026-06-10')
    assert.equal(getNextNextWednesdayNy('2026-06-03'), '2026-06-17') // Wed → next Wed Jun 10, +7
  })

  it('parseSchedulePasteRaw extracts historical dates from a Discord schedule block', () => {
    const rows = parseSchedulePasteRaw(SAMPLE_PASTE)
    assert.equal(rows.length, 6)
    assert.deepEqual(
      rows.map((r) => r.dateIso),
      [
        '2026-04-23',
        '2026-04-27',
        '2026-04-28',
        '2026-04-30',
        '2026-05-04',
        '2026-05-05',
      ]
    )
    assert.equal(rows[0].eventName, 'Fire Minis + Seru/Praes')
    assert.equal(rows[2].time.hour24, 20)
  })

  it('snapToWednesdayNy moves non-Wednesdays forward to the next Wednesday', () => {
    assert.equal(snapToWednesdayNy('2026-06-10'), '2026-06-10')
    assert.equal(snapToWednesdayNy('2026-06-11'), '2026-06-17')
    assert.equal(snapToWednesdayNy('2026-06-09'), '2026-06-10')
  })

  it('projectParsedRowsToUpcoming maps weekdays onto the next-next-Wednesday window', () => {
    const raw = parseSchedulePasteRaw(SAMPLE_PASTE)
    const { rows, periodStart } = projectParsedRowsToUpcoming(raw, { fromDate: '2026-06-01' })
    assert.equal(periodStart, '2026-06-10')
    assert.deepEqual(
      rows.map((r) => r.dateIso),
      [
        '2026-06-11',
        '2026-06-15',
        '2026-06-16',
        '2026-06-18',
        '2026-06-22',
        '2026-06-23',
      ]
    )
    assert.deepEqual(rows.map((r) => r.week), [1, 1, 1, 2, 2, 2])
  })

  it('projectParsedRowsToUpcoming honors a custom period start Wednesday', () => {
    const raw = parseSchedulePasteRaw(SAMPLE_PASTE)
    const { rows, periodStart } = projectParsedRowsToUpcoming(raw, { periodStart: '2026-06-17' })
    assert.equal(periodStart, '2026-06-17')
    assert.deepEqual(
      rows.map((r) => r.dateIso),
      [
        '2026-06-18',
        '2026-06-22',
        '2026-06-23',
        '2026-06-25',
        '2026-06-29',
        '2026-06-30',
      ]
    )
  })

  it('stripEventNameSuffix removes Discord timestamp tokens', () => {
    assert.deepEqual(stripEventNameSuffix('Fire Minis - <t:1234567890:f>'), {
      eventName: 'Fire Minis',
      dateIso: null,
    })
    assert.deepEqual(
      stripEventNameSuffix('Fire Minis - <t:123:f> - <t:456:t>'),
      { eventName: 'Fire Minis', dateIso: null }
    )
  })

  it('stripEventNameSuffix removes human-readable date tails', () => {
    const result = stripEventNameSuffix('Fire Minis + Seru/Praes - April 23, 2026 8:00 PM')
    assert.equal(result.eventName, 'Fire Minis + Seru/Praes')
    assert.equal(result.dateIso, '2026-04-23')
  })

  it('snapToWednesdayOnOrBefore walks back to the containing Wednesday', () => {
    assert.equal(snapToWednesdayOnOrBefore('2026-04-23'), '2026-04-22')
    assert.equal(snapToWednesdayOnOrBefore('2026-04-22'), '2026-04-22')
  })

  it('parseTitlePeriodStart extracts the first date from a schedule title', () => {
    assert.equal(
      parseTitlePeriodStart('04/22 - 05/05 Raid Schedule', 2026),
      '2026-04-22'
    )
  })

  it('assignWeeksFromPeriodStart assigns weeks from Wed-Tue windows', () => {
    const raw = parseSchedulePasteRaw(SAMPLE_PASTE)
    const rows = assignWeeksFromPeriodStart(raw, '2026-04-22')
    assert.deepEqual(rows.map((r) => r.week), [1, 1, 1, 2, 2, 2])
  })

  it('assignWeeksFromPeriodStart works when Week 2 header is missing', () => {
    const withoutWeek2Header = SAMPLE_PASTE.replace(/^Week 2\r?\n/m, '')
    const raw = parseSchedulePasteRaw(withoutWeek2Header)
    const rows = assignWeeksFromPeriodStart(raw, '2026-04-22')
    assert.deepEqual(rows.map((r) => r.week), [1, 1, 1, 2, 2, 2])
  })

  it('parseSchedulePaste keeps original dates by default', () => {
    const { rows, metadata, periodStart } = parseSchedulePaste(SAMPLE_PASTE)
    assert.equal(rows.length, 6)
    assert.deepEqual(
      rows.map((r) => r.dateIso),
      [
        '2026-04-23',
        '2026-04-27',
        '2026-04-28',
        '2026-04-30',
        '2026-05-04',
        '2026-05-05',
      ]
    )
    assert.deepEqual(rows.map((r) => r.week), [1, 1, 1, 2, 2, 2])
    assert.equal(periodStart, '2026-04-22')
    assert.equal(rows[2].eventName, 'PoTime Early Start')
    assert.equal(metadata.scheduleTitle, '04/22 - 05/05 Raid Schedule')
    assert.ok(metadata.week2Footer.includes('non dkp targets'))
  })

  it('parseSchedulePaste projects parsed rows when projectDates is true', () => {
    const { rows, metadata } = parseSchedulePaste(SAMPLE_PASTE, {
      fromDate: '2026-06-01',
      projectDates: true,
    })
    assert.equal(rows.length, 6)
    assert.deepEqual(
      rows.map((r) => r.dateIso),
      [
        '2026-06-11',
        '2026-06-15',
        '2026-06-16',
        '2026-06-18',
        '2026-06-22',
        '2026-06-23',
      ]
    )
    assert.deepEqual(rows.map((r) => r.week), [1, 1, 1, 2, 2, 2])
    assert.equal(rows[2].eventName, 'PoTime Early Start')
    assert.equal(metadata.scheduleTitle, '04/22 - 05/05 Raid Schedule')
    assert.ok(metadata.week2Footer.includes('non dkp targets'))
  })

  it('formatOutputLine does not duplicate old Discord timestamps', () => {
    const line = formatOutputLine(
      { dateIso: '2026-06-04', dayName: 'Thursday', mmdd: '06/04' },
      'Memory Farm - <t:1111111111:f>',
      { hour24: 21, minute: 0 }
    )
    const epoch = nyLocalToUnixEpoch('2026-06-04', 21, 0)
    assert.equal(
      line,
      `Thursday 06/04 9pm edt: Memory Farm - <t:${epoch}:f>`
    )
    assert.equal((line.match(/<t:/g) || []).length, 1)
  })

  it('slotFromDateIso builds display fields from dateIso', () => {
    const slot = slotFromDateIso('2026-04-23', 1)
    assert.equal(slot.dayLabel, 'Thursday 04/23')
    assert.equal(slot.dayName, 'Thursday')
  })

  it('addDays handles month boundaries', () => {
    assert.equal(addDays('2026-06-30', 1), '2026-07-01')
  })
})
