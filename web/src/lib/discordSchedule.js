const NY_TZ = 'America/New_York'

export const SCHEDULE_SLOTS = [
  { week: 1, dow: 2 }, // Tuesday
  { week: 1, dow: 4 }, // Thursday
  { week: 1, dow: 1 }, // Monday
  { week: 2, dow: 4 }, // Thursday
  { week: 2, dow: 1 }, // Monday
  { week: 2, dow: 2 }, // Tuesday
]

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const nyDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: NY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const nyPartsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: NY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: 'numeric',
  minute: '2-digit',
  hour12: false,
})

/** @returns {string} YYYY-MM-DD in America/New_York */
export function getTodayNyDate(now = new Date()) {
  return nyDateFormatter.format(now)
}

/** @param {string} dateIso YYYY-MM-DD */
export function parseDateIso(dateIso) {
  const [y, m, d] = dateIso.split('-').map(Number)
  return { year: y, month: m, day: d }
}

/** @param {{ year: number, month: number, day: number }} parts */
export function formatDateIso(parts) {
  const { year, month, day } = parts
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** @param {string} dateIso */
export function addDays(dateIso, days) {
  const { year, month, day } = parseDateIso(dateIso)
  const utc = new Date(Date.UTC(year, month - 1, day + days))
  return formatDateIso({
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  })
}

/** @param {string} dateIso */
export function getDayOfWeek(dateIso) {
  const { year, month, day } = parseDateIso(dateIso)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/**
 * Earliest date >= startDate matching targetDow (JS: Sun=0).
 * @param {string} startDate YYYY-MM-DD
 * @param {number} targetDow
 */
export function nextDateOnOrAfter(startDate, targetDow) {
  let cursor = startDate
  for (let i = 0; i < 7; i++) {
    if (getDayOfWeek(cursor) === targetDow) return cursor
    cursor = addDays(cursor, 1)
  }
  throw new Error(`No matching weekday within 7 days from ${startDate}`)
}

/** @param {string} dateIso */
export function formatDayLabel(dateIso) {
  const dow = getDayOfWeek(dateIso)
  const { month, day } = parseDateIso(dateIso)
  return `${DAY_NAMES[dow]} ${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`
}

/** @param {string} dateIso */
export function formatMmDd(dateIso) {
  const { month, day } = parseDateIso(dateIso)
  return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`
}

/**
 * @param {string} [anchorDate] YYYY-MM-DD in NY; defaults to today NY
 * @returns {Array<{ week: number, dateIso: string, dayName: string, mmdd: string, dayLabel: string }>}
 */
export function computeUpcomingSlots(anchorDate = getTodayNyDate()) {
  let cursor = anchorDate
  return SCHEDULE_SLOTS.map((slot) => {
    const dateIso = nextDateOnOrAfter(cursor, slot.dow)
    cursor = addDays(dateIso, 1)
    const dayName = DAY_NAMES[getDayOfWeek(dateIso)]
    const mmdd = formatMmDd(dateIso)
    return {
      week: slot.week,
      dateIso,
      dayName,
      mmdd,
      dayLabel: formatDayLabel(dateIso),
    }
  })
}

function readNyParts(epochMs) {
  const parts = nyPartsFormatter.formatToParts(new Date(epochMs))
  const get = (type) => Number(parts.find((p) => p.type === type)?.value)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') === 24 ? 0 : get('hour'),
    minute: get('minute'),
  }
}

/**
 * Convert NY local datetime to Unix epoch seconds.
 * @param {string} dateIso YYYY-MM-DD
 * @param {number} hour24 0-23
 * @param {number} [minute=0]
 */
export function nyLocalToUnixEpoch(dateIso, hour24, minute = 0) {
  const target = parseDateIso(dateIso)
  const targetMinutes = hour24 * 60 + minute

  // Start near noon UTC on the calendar day, scan ±18h in one-minute steps.
  const noonUtcMs = Date.UTC(target.year, target.month - 1, target.day, 12, 0, 0)
  const windowMs = 18 * 60 * 60 * 1000
  for (let ms = noonUtcMs - windowMs; ms <= noonUtcMs + windowMs; ms += 60 * 1000) {
    const parts = readNyParts(ms)
    if (
      parts.year === target.year &&
      parts.month === target.month &&
      parts.day === target.day &&
      parts.hour * 60 + parts.minute === targetMinutes
    ) {
      return Math.floor(ms / 1000)
    }
  }

  throw new Error(`Could not resolve NY local time for ${dateIso} ${hour24}:${minute}`)
}

/** @param {string} dateIso @param {number} hour24 @param {number} [minute=0] */
export function getNyTzSuffix(dateIso, hour24, minute = 0) {
  const epoch = nyLocalToUnixEpoch(dateIso, hour24, minute)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    timeZoneName: 'short',
  }).formatToParts(new Date(epoch * 1000))
  const tzName = parts.find((p) => p.type === 'timeZoneName')?.value || ''
  if (/EDT/i.test(tzName)) return 'edt'
  if (/EST/i.test(tzName)) return 'est'
  return tzName.toLowerCase() || 'et'
}

/** @param {number} hour24 @param {number} [minute=0] */
export function formatTimeDropdownLabel(hour24, minute = 0) {
  const h12 = hour24 % 12 || 12
  const ampm = hour24 < 12 ? 'AM' : 'PM'
  const minStr = minute === 0 ? '00' : String(minute).padStart(2, '0')
  return `${h12}:${minStr} ${ampm} Eastern`
}

/** @param {number} hour24 @param {number} [minute=0] @param {string} [tzSuffix='edt'] */
export function formatOutputTime(hour24, minute = 0, tzSuffix = 'edt') {
  const h12 = hour24 % 12 || 12
  if (minute === 0) return `${h12}pm ${tzSuffix}`
  const minStr = String(minute).padStart(2, '0')
  return `${h12}:${minStr}pm ${tzSuffix}`
}

export const DEFAULT_TIME = { hour24: 21, minute: 0 }

/** Evening Eastern time options for dropdown (6:00 PM – 11:00 PM, 30-min steps). */
export const TIME_OPTIONS = (() => {
  const out = []
  for (let hour = 18; hour <= 23; hour++) {
    for (const minute of [0, 30]) {
      if (hour === 23 && minute === 30) continue
      out.push({ hour24: hour, minute })
    }
  }
  return out
})()

export function timeOptionKey({ hour24, minute }) {
  return `${hour24}:${minute}`
}

export function parseTimeOptionKey(key) {
  const [h, m] = key.split(':').map(Number)
  return { hour24: h, minute: m }
}

/**
 * @param {{ dateIso: string, dayName: string, mmdd: string }} slot
 * @param {string} eventName
 * @param {{ hour24: number, minute: number }} time
 */
export function formatOutputLine(slot, eventName, time) {
  const tz = getNyTzSuffix(slot.dateIso, time.hour24, time.minute)
  const timeStr = formatOutputTime(time.hour24, time.minute, tz)
  const epoch = nyLocalToUnixEpoch(slot.dateIso, time.hour24, time.minute)
  return `${slot.dayName} ${slot.mmdd} ${timeStr}: ${eventName} - <t:${epoch}:f>`
}

/**
 * @param {Array<{ week: number, dateIso: string, dayName: string, mmdd: string }>} slots
 * @param {string[]} eventNames
 * @param {Array<{ hour24: number, minute: number }>} times
 */
export function buildScheduleOutput(slots, eventNames, times) {
  const lines = []
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    const name = eventNames[i] ?? ''
    const time = times[i] ?? DEFAULT_TIME
    lines.push(formatOutputLine(slot, name, time))
    lines.push('-------')
    if (i === 2) {
      lines.push('Week 2')
    }
  }
  return lines.join('\n')
}
