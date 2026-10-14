/**
 * Tic date/time convention: America/New_York for both the controls and new storage.
 *
 * Date and time inputs are zone-naive. Their values are an Eastern calendar date
 * (YYYY-MM-DD) and an Eastern clock (HH:mm:ss), not the browser's timezone.
 * New values are floored to whole seconds.
 *
 * New and changed values are stored as ISO-8601 with the numeric offset
 * America/New_York had at that wall time, e.g. 2026-10-09T09:08:00-04:00.
 * During the fall-back hour the earlier offset is used. A spring-forward gap
 * is invalid and is never replaced with the current time.
 *
 * Legacy text is kept exactly when an edit's controls still match the display
 * of the stored value. Strings that do not parse are left unchanged until the
 * officer supplies a valid date and time.
 */

export const TIC_TIME_ZONE = 'America/New_York'

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

const easternFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIC_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

const EQ_STAMP = /\[((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\]/i

function pad(n) {
  return String(n).padStart(2, '0')
}

function formatDate(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`
}

function formatClock(hour, minute, second) {
  return `${pad(hour)}:${pad(minute)}:${pad(second)}`
}

function isRealCalendarDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const utc = new Date(Date.UTC(year, month - 1, day))
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day
}

function easternParts(epochMs) {
  const parts = easternFormatter.formatToParts(new Date(epochMs))
  const get = (type) => Number(parts.find((p) => p.type === type)?.value)
  let year = get('year')
  let month = get('month')
  let day = get('day')
  let hour = get('hour')
  const minute = get('minute')
  const second = get('second')
  if (hour === 24) hour = 0
  return { year, month, day, hour, minute, second }
}

function offsetMinutesAt(epochMs) {
  const wholeSecond = epochMs - (epochMs % 1000)
  const parts = easternParts(wholeSecond)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return Math.round((asUtc - wholeSecond) / 60000)
}

function formatOffset(epochMs) {
  const minutes = offsetMinutesAt(epochMs)
  const sign = minutes >= 0 ? '+' : '-'
  const abs = Math.abs(minutes)
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/**
 * Resolve an Eastern wall time to epoch ms.
 * Fall-back ambiguous times use the earlier offset. Gaps return null.
 */
function resolveEasternEpochMs(year, month, day, hour, minute, second) {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  let guess = wallAsUtc
  for (let i = 0; i < 4; i++) {
    const next = wallAsUtc - offsetMinutesAt(guess) * 60 * 1000
    if (next === guess) break
    guess = next
  }
  const parts = easternParts(guess)
  if (
    parts.year === year &&
    parts.month === month &&
    parts.day === day &&
    parts.hour === hour &&
    parts.minute === minute &&
    parts.second === second
  ) {
    return guess
  }
  return null
}

function displayEastern(epochMs) {
  const parts = easternParts(epochMs)
  return {
    date: formatDate(parts.year, parts.month, parts.day),
    time: formatClock(parts.hour, parts.minute, parts.second),
  }
}

/** Leading YYYY-MM-DD from a raid date_iso or date, or '' when it is not a real calendar date. */
export function raidCalendarDate(dateIso) {
  const match = String(dateIso ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return ''
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!isRealCalendarDate(year, month, day)) return ''
  return formatDate(year, month, day)
}

/** Current Eastern clock, floored to the whole second. */
export function floorNowEastern(now = new Date()) {
  const epochMs = now instanceof Date ? now.getTime() : Number(now)
  if (!Number.isFinite(epochMs)) return { date: '', time: '' }
  return displayEastern(epochMs)
}

/** New-tic defaults: raid calendar date, and the current Eastern time floored to seconds. */
export function defaultTicFields(raidDateIso, now = new Date()) {
  const clock = floorNowEastern(now)
  return {
    date: raidCalendarDate(raidDateIso),
    time: clock.time,
  }
}

function normalizeTime(time) {
  const match = String(time ?? '').trim().match(/^(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/)
  if (!match) return String(time ?? '').trim()
  const hour = Number(match[1])
  const minute = Number(match[2])
  const second = match[3] != null ? Number(match[3]) : 0
  if (hour > 23 || minute > 59 || second > 59) return String(time ?? '').trim()
  return formatClock(hour, minute, second)
}

/**
 * @returns {{ ok: true, canonical: string, epochMs: number } | { ok: false, error: string }}
 */
export function validateTicDateTime(date, time) {
  const dateStr = String(date ?? '').trim()
  const timeStr = String(time ?? '').trim()
  if (!dateStr || !timeStr) {
    return { ok: false, error: 'Enter a tic date and time.' }
  }
  const dateMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!dateMatch) return { ok: false, error: 'Enter a valid tic date.' }
  const year = Number(dateMatch[1])
  const month = Number(dateMatch[2])
  const day = Number(dateMatch[3])
  if (!isRealCalendarDate(year, month, day)) return { ok: false, error: 'Enter a valid tic date.' }

  const timeMatch = timeStr.match(/^(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/)
  if (!timeMatch) return { ok: false, error: 'Enter a valid tic time.' }
  const hour = Number(timeMatch[1])
  const minute = Number(timeMatch[2])
  const second = timeMatch[3] != null ? Number(timeMatch[3]) : 0
  if (hour > 23 || minute > 59 || second > 59) return { ok: false, error: 'Enter a valid tic time.' }

  const epochMs = resolveEasternEpochMs(year, month, day, hour, minute, second)
  if (epochMs == null) {
    return { ok: false, error: 'That time does not exist in Eastern time.' }
  }
  const canonical = `${formatDate(year, month, day)}T${formatClock(hour, minute, second)}${formatOffset(epochMs)}`
  return { ok: true, canonical, epochMs }
}

export function eventIdFromEpoch(epochMs) {
  return `tic-${epochMs}`
}

const GENERIC_TIC_EVENT_NAMES = new Set(['dkp tic', 'on-time', 'on time', 'tic'])
const GENERATED_TIC_EVENT_NAME = /^\d{1,2}:\d{2}[ap]m dkp tic$/i

/** 24-hour clock to a 12-hour label with minutes, e.g. 21:45 → 9:45pm. */
export function format12HourClock(hour24, minute) {
  const hour = Number(hour24)
  const min = Number(minute)
  if (!Number.isInteger(hour) || !Number.isInteger(min)) return ''
  if (hour < 0 || hour > 23 || min < 0 || min > 59) return ''
  const suffix = hour >= 12 ? 'pm' : 'am'
  let hour12 = hour % 12
  if (hour12 === 0) hour12 = 12
  return `${hour12}:${pad(min)}${suffix}`
}

/** Event name for a tic entered at this clock, e.g. 21:00:00 → "9:00pm DKP tic". */
export function dkpTicEventName(time) {
  const match = String(time ?? '').trim().match(/^(\d{1,2}):(\d{2})/)
  if (!match) return ''
  const clock = format12HourClock(Number(match[1]), Number(match[2]))
  return clock ? `${clock} DKP tic` : ''
}

/** True for placeholder tic names and names this app already generated from a clock. */
export function isGenericTicEventName(name) {
  const text = String(name ?? '').trim()
  if (!text) return true
  if (GENERIC_TIC_EVENT_NAMES.has(text.toLowerCase())) return true
  return GENERATED_TIC_EVENT_NAME.test(text)
}

/**
 * Label shown for a tic. Placeholder names ("DKP tic", "On-time") and earlier
 * clock labels follow the stored event time. Imported names are left as written.
 */
export function displayTicEventName(event, raidDateIso = '') {
  const stored = String(event?.event_name ?? '').trim()
  if (!isGenericTicEventName(stored)) return stored
  const parsed = parseStoredEventTime(event?.event_time, raidDateIso)
  if (parsed.ok) {
    const named = dkpTicEventName(parsed.time)
    if (named) return named
  }
  if (GENERATED_TIC_EVENT_NAME.test(stored)) return stored
  return stored || 'DKP tic'
}

/** Fields to write when an officer changes a tic time. Generic names follow the new clock. */
export function eventFieldsForTimeSave(existingName, storedTime, clockTime) {
  const patch = { event_time: storedTime }
  if (isGenericTicEventName(existingName)) {
    const named = dkpTicEventName(clockTime)
    if (named) patch.event_name = named
  }
  return patch
}

/**
 * Validate controls for a new tic. Does not substitute the current time.
 * @returns {{ ok: true, stored: string, epochMs: number, eventId: string } | { ok: false, error: string }}
 */
export function newTicTimestamp(date, time) {
  const validated = validateTicDateTime(date, time)
  if (!validated.ok) return validated
  return {
    ok: true,
    stored: validated.canonical,
    epochMs: validated.epochMs,
    eventId: eventIdFromEpoch(validated.epochMs),
  }
}

function wallFields(year, month, day, hour, minute, second) {
  if (!isRealCalendarDate(year, month, day)) return null
  if (hour > 23 || minute > 59 || second > 59) return null
  return { date: formatDate(year, month, day), time: formatClock(hour, minute, second) }
}

/**
 * Display fields for a stored event_time. Does not rewrite the original.
 * Zone-less strings are Eastern wall-clock digits. Z and numeric offsets are instants shown in Eastern.
 * Time-only strings use the raid calendar date in the controls.
 */
export function parseStoredEventTime(raw, raidDateIso) {
  const original = raw == null ? '' : String(raw)
  const text = original.trim()
  if (!text) return { ok: false, original, date: '', time: '', kind: 'empty' }

  const eq = text.match(/^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/i)
  if (eq) {
    const month = MONTHS[eq[1].toLowerCase()]
    const fields = wallFields(Number(eq[6]), month, Number(eq[2]), Number(eq[3]), Number(eq[4]), Number(eq[5]))
    if (!fields) return { ok: false, original, date: '', time: '', kind: 'unparsed' }
    return { ok: true, original, ...fields, kind: 'wall' }
  }

  const instant = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/i)
  if (instant) {
    const iso = text.replace(' ', 'T')
    const epochMs = Date.parse(iso)
    if (Number.isNaN(epochMs)) return { ok: false, original, date: '', time: '', kind: 'unparsed' }
    return { ok: true, original, ...displayEastern(epochMs), kind: 'instant' }
  }

  const naive = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/)
  if (naive) {
    const fields = wallFields(
      Number(naive[1]),
      Number(naive[2]),
      Number(naive[3]),
      Number(naive[4]),
      Number(naive[5]),
      naive[6] != null ? Number(naive[6]) : 0,
    )
    if (!fields) return { ok: false, original, date: '', time: '', kind: 'unparsed' }
    return { ok: true, original, ...fields, kind: 'wall' }
  }

  const ampm = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)$/i)
  if (ampm) {
    let hour = Number(ampm[1])
    const minute = Number(ampm[2])
    const second = ampm[3] != null ? Number(ampm[3]) : 0
    const suffix = ampm[4].toLowerCase()
    if (hour < 1 || hour > 12 || minute > 59 || second > 59) {
      return { ok: false, original, date: '', time: '', kind: 'unparsed' }
    }
    if (suffix === 'am') hour = hour === 12 ? 0 : hour
    else hour = hour === 12 ? 12 : hour + 12
    return {
      ok: true,
      original,
      date: raidCalendarDate(raidDateIso),
      time: formatClock(hour, minute, second),
      kind: 'time-only',
    }
  }

  return { ok: false, original, date: '', time: '', kind: 'unparsed' }
}

export function fieldsForEdit(raw, raidDateIso) {
  const parsed = parseStoredEventTime(raw, raidDateIso)
  if (!parsed.ok) return { date: '', time: '', unparsed: true }
  return { date: parsed.date, time: parsed.time, unparsed: false }
}

/**
 * Value to write for an edit. Unchanged controls keep the original string and event id.
 * @returns {{ ok: true, unchanged: boolean, stored: string, eventId: string | undefined, epochMs?: number } | { ok: false, error: string, eventId: string | undefined }}
 */
export function eventTimeToStore({ original, date, time, raidDateIso, eventId }) {
  const parsed = parseStoredEventTime(original, raidDateIso)
  const dateNorm = String(date ?? '').trim()
  const timeNorm = normalizeTime(time)
  const sameDisplay = parsed.ok
    ? parsed.date === dateNorm && parsed.time === timeNorm
    : dateNorm === '' && String(time ?? '').trim() === ''
  if (sameDisplay) {
    return { ok: true, unchanged: true, stored: original == null ? '' : String(original), eventId }
  }
  const validated = validateTicDateTime(dateNorm, timeNorm)
  if (!validated.ok) return { ...validated, eventId }
  return {
    ok: true,
    unchanged: false,
    stored: validated.canonical,
    epochMs: validated.epochMs,
    eventId,
  }
}

/** First EQ channel stamp in a paste, as Eastern wall-clock fields, or null. */
export function firstEqStampInPaste(paste) {
  const match = String(paste ?? '').match(EQ_STAMP)
  if (!match) return null
  const parsed = parseStoredEventTime(match[1], '')
  if (!parsed.ok || parsed.kind !== 'wall') return null
  return { date: parsed.date, time: parsed.time }
}
