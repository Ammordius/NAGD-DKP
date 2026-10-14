import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultTicFields,
  displayTicEventName,
  dkpTicEventName,
  eventFieldsForTimeSave,
  eventTimeToStore,
  firstEqStampInPaste,
  floorNowEastern,
  formatRaidSchedule,
  newTicTimestamp,
  raidCalendarDate,
  validateTicDateTime,
} from './ticDateTime.js'

describe('validateTicDateTime', () => {
  it('stores a same-day Eastern tic with a stable offset and epoch', () => {
    const result = validateTicDateTime('2026-10-09', '09:08:00')
    assert.equal(result.ok, true)
    assert.equal(result.canonical, '2026-10-09T09:08:00-04:00')
    assert.equal(result.epochMs, Date.parse('2026-10-09T09:08:00-04:00'))
  })

  it('accepts a tic after midnight on the next Eastern date', () => {
    const result = validateTicDateTime('2026-10-10', '00:30:00')
    assert.equal(result.ok, true)
    assert.equal(result.canonical, '2026-10-10T00:30:00-04:00')
    assert.equal(result.epochMs, Date.parse('2026-10-10T00:30:00-04:00'))
  })

  it('rejects the spring-forward gap without substituting now', () => {
    const now = new Date('2026-03-08T12:00:00Z')
    const result = validateTicDateTime('2026-03-08', '02:30:00')
    assert.equal(result.ok, false)
    assert.equal(result.canonical, undefined)
    assert.equal(result.epochMs, undefined)
    assert.equal(JSON.stringify(result).includes(now.toISOString()), false)
  })

  it('uses the earlier offset for the fall-back hour', () => {
    const result = validateTicDateTime('2026-11-01', '01:30:00')
    assert.equal(result.ok, true)
    assert.equal(result.canonical, '2026-11-01T01:30:00-04:00')
    assert.equal(result.epochMs, Date.parse('2026-11-01T01:30:00-04:00'))
  })

  it('rejects an impossible date, an impossible clock, and empty fields', () => {
    assert.equal(validateTicDateTime('2026-02-31', '09:08:00').ok, false)
    assert.equal(validateTicDateTime('2026-10-09', '25:99:00').ok, false)
    assert.equal(validateTicDateTime('', '').ok, false)
    assert.equal(validateTicDateTime('2026-10-09', '').ok, false)
    assert.equal(newTicTimestamp('2026-02-31', '09:08:00').epochMs, undefined)
  })
})

describe('profile timezone', () => {
  it('stores a GMT+12 wall time and shows it the previous evening in EST', () => {
    const stored = validateTicDateTime('2026-10-14', '14:00:00', 'Etc/GMT-12')
    assert.equal(stored.ok, true)
    assert.equal(stored.canonical, '2026-10-14T14:00:00+12:00')
    const shown = formatRaidSchedule(stored.canonical, 'Etc/GMT+5')
    assert.equal(shown.dateKey, '2026-10-13')
    assert.equal(shown.label, '2026-10-13 21:00')
  })

  it('shows a New Zealand October afternoon as the previous evening in Eastern time', () => {
    const stored = validateTicDateTime('2026-10-14', '14:00:00', 'Pacific/Auckland')
    assert.equal(stored.ok, true)
    assert.equal(stored.canonical, '2026-10-14T14:00:00+13:00')
    const shown = formatRaidSchedule(stored.canonical, 'America/New_York')
    assert.equal(shown.dateKey, '2026-10-13')
    assert.equal(shown.label, '2026-10-13 21:00')
  })

  it('keeps a date-only raid on that calendar date', () => {
    const shown = formatRaidSchedule('2026-10-14', 'Pacific/Auckland')
    assert.equal(shown.dateKey, '2026-10-14')
    assert.equal(shown.label, '2026-10-14')
  })
})

describe('floorNowEastern', () => {
  it('floors a fractional Eastern second', () => {
    const base = validateTicDateTime('2026-06-15', '12:00:00')
    const floored = floorNowEastern(new Date(base.epochMs + 900))
    assert.equal(floored.date, '2026-06-15')
    assert.equal(floored.time, '12:00:00')
  })
})

describe('defaultTicFields', () => {
  it('uses the raid calendar date and the current Eastern time', () => {
    const now = validateTicDateTime('2026-06-15', '12:00:00')
    const fields = defaultTicFields('2026-10-09 16:46:00', new Date(now.epochMs + 900))
    assert.equal(fields.date, '2026-10-09')
    assert.equal(fields.time, '12:00:00')
    assert.equal(raidCalendarDate('not-a-date'), '')
  })
})

describe('eventTimeToStore', () => {
  it('keeps a legacy EQ stamp when the controls are unchanged', () => {
    const result = eventTimeToStore({
      original: 'Fri Oct 09 09:08:00 2026',
      date: '2026-10-09',
      time: '09:08:00',
      raidDateIso: '2026-10-09',
      eventId: 'tic-existing',
    })
    assert.equal(result.ok, true)
    assert.equal(result.unchanged, true)
    assert.equal(result.stored, 'Fri Oct 09 09:08:00 2026')
    assert.equal(result.eventId, 'tic-existing')
  })

  it('keeps a time-only site clock when the raid date and padded time are unchanged', () => {
    const result = eventTimeToStore({
      original: '1:02 am',
      date: '2026-10-09',
      time: '01:02:00',
      raidDateIso: '2026-10-09',
      eventId: '2389743',
    })
    assert.equal(result.unchanged, true)
    assert.equal(result.stored, '1:02 am')
    assert.equal(result.eventId, '2389743')
  })

  it('keeps a UTC instant when its Eastern display is unchanged', () => {
    const result = eventTimeToStore({
      original: '2026-10-12T14:47:00.123Z',
      date: '2026-10-12',
      time: '10:47:00',
      raidDateIso: '2026-10-12',
      eventId: 'tic-utc',
    })
    assert.equal(result.unchanged, true)
    assert.equal(result.stored, '2026-10-12T14:47:00.123Z')
    assert.equal(result.eventId, 'tic-utc')
  })

  it('writes a canonical offset when the clock changes and keeps the event id', () => {
    const result = eventTimeToStore({
      original: 'Fri Oct 09 09:08:00 2026',
      date: '2026-10-09',
      time: '09:09:00',
      raidDateIso: '2026-10-09',
      eventId: 'tic-existing',
    })
    assert.equal(result.ok, true)
    assert.equal(result.unchanged, false)
    assert.equal(result.stored, '2026-10-09T09:09:00-04:00')
    assert.equal(result.eventId, 'tic-existing')
  })

  it('does not replace an invalid edit with the current time', () => {
    const result = eventTimeToStore({
      original: '1:02 am',
      date: '2026-03-08',
      time: '02:30:00',
      raidDateIso: '2026-10-09',
      eventId: 'tic-existing',
    })
    assert.equal(result.ok, false)
    assert.equal(result.stored, undefined)
    assert.equal(result.eventId, 'tic-existing')
  })

  it('leaves an unparsed string alone when the controls stay empty', () => {
    const result = eventTimeToStore({
      original: 'sometime tomorrow',
      date: '',
      time: '',
      raidDateIso: '2026-10-09',
      eventId: 'tic-existing',
    })
    assert.equal(result.unchanged, true)
    assert.equal(result.stored, 'sometime tomorrow')
  })
})

describe('firstEqStampInPaste', () => {
  it('reads Eastern wall-clock digits from a channel paste', () => {
    const fields = firstEqStampInPaste('[Fri Oct 09 09:08:00 2026] Meldrath, Fridge')
    assert.deepEqual(fields, { date: '2026-10-09', time: '09:08:00' })
  })
})

describe('newTicTimestamp', () => {
  it('builds an event id from the Eastern instant', () => {
    const result = newTicTimestamp('2026-10-10', '00:30:00')
    assert.equal(result.stored, '2026-10-10T00:30:00-04:00')
    assert.equal(result.eventId, `tic-${result.epochMs}`)
  })
})

describe('dkpTicEventName', () => {
  it('turns the entered clock into a 12-hour tic name with minutes', () => {
    assert.equal(dkpTicEventName('21:00:00'), '9:00pm DKP tic')
    assert.equal(dkpTicEventName('21:45'), '9:45pm DKP tic')
    assert.equal(dkpTicEventName('09:05:00'), '9:05am DKP tic')
    assert.equal(dkpTicEventName('00:00:00'), '12:00am DKP tic')
    assert.equal(dkpTicEventName('12:00:00'), '12:00pm DKP tic')
    assert.equal(dkpTicEventName('20:00:00', { onTime: true }), '8:00pm on-time')
  })
})

describe('displayTicEventName', () => {
  it('names a placeholder tic from its stored time', () => {
    assert.equal(
      displayTicEventName({ event_order: 1, event_name: 'DKP tic', event_time: 'Wed Oct 14 20:00:00 2026' }),
      '8:00pm on-time',
    )
    assert.equal(
      displayTicEventName({ event_order: 1, event_name: 'On-time', event_time: 'Wed Oct 14 21:45:32 2026' }),
      '9:45pm on-time',
    )
    assert.equal(
      displayTicEventName({ event_order: 1, event_name: '9:00pm DKP tic', event_time: '2026-10-14T22:30:00-04:00' }),
      '10:30pm on-time',
    )
    assert.equal(
      displayTicEventName({ event_name: 'DKP tic', event_time: 'Wed Oct 14 21:00:00 2026' }),
      '9:00pm DKP tic',
    )
    assert.equal(
      displayTicEventName({ event_order: 2, event_name: 'On-time', event_time: 'Wed Oct 14 21:45:32 2026' }),
      '9:45pm DKP tic',
    )
    assert.equal(
      displayTicEventName({ event_order: 2, event_name: '9:00pm DKP tic', event_time: '2026-10-14T22:30:00-04:00' }),
      '10:30pm DKP tic',
    )
  })

  it('leaves an imported event name alone', () => {
    assert.equal(
      displayTicEventName({ event_name: '1 Hour Single/Double Boxing', event_time: 'Wed Oct 14 21:00:00 2026' }),
      '1 Hour Single/Double Boxing',
    )
  })
})

describe('eventFieldsForTimeSave', () => {
  it('renames a generic tic when the clock changes and keeps a custom name', () => {
    assert.deepEqual(
      eventFieldsForTimeSave('On-time', '2026-10-14T20:00:00-04:00', '20:00:00', 1),
      { event_time: '2026-10-14T20:00:00-04:00', event_name: '8:00pm on-time' },
    )
    assert.deepEqual(
      eventFieldsForTimeSave('On-time', '2026-10-14T21:00:00-04:00', '21:00:00'),
      { event_time: '2026-10-14T21:00:00-04:00', event_name: '9:00pm DKP tic' },
    )
    assert.deepEqual(
      eventFieldsForTimeSave('8:00pm on-time', '2026-10-14T21:00:00-04:00', '21:00:00', 2),
      { event_time: '2026-10-14T21:00:00-04:00', event_name: '9:00pm DKP tic' },
    )
    assert.deepEqual(
      eventFieldsForTimeSave('Fire minis', '2026-10-14T21:00:00-04:00', '21:00:00', 1),
      { event_time: '2026-10-14T21:00:00-04:00' },
    )
  })
})
