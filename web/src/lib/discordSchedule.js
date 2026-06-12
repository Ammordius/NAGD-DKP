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

/** @param {string} dateIso @param {number} [week=1] */
export function slotFromDateIso(dateIso, week = 1) {
  const dayName = DAY_NAMES[getDayOfWeek(dateIso)]
  const mmdd = formatMmDd(dateIso)
  return {
    week,
    dateIso,
    dayName,
    mmdd,
    dayLabel: formatDayLabel(dateIso),
  }
}

let rowIdCounter = 0
export function createRowId() {
  rowIdCounter += 1
  return `row-${Date.now()}-${rowIdCounter}`
}

/**
 * @param {string} [anchorDate]
 * @returns {Array<{ id: string, week: number, dateIso: string, eventName: string, time: { hour24: number, minute: number } }>}
 */
export function createDefaultRows(anchorDate = getTodayNyDate()) {
  return computeUpcomingSlots(anchorDate).map((slot) => ({
    id: createRowId(),
    week: slot.week,
    dateIso: slot.dateIso,
    eventName: '',
    time: { ...DEFAULT_TIME },
  }))
}

/** @param {number} hour12 @param {string} ampm @param {number} [minute=0] */
export function parseCompactTime(hour12, ampm, minute = 0) {
  let h = Number(hour12)
  const pm = ampm.toLowerCase() === 'pm'
  if (h === 12) return { hour24: pm ? 12 : 0, minute }
  return { hour24: pm ? h + 12 : h, minute }
}

const RAID_LINE_RE =
  /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+(\d{1,2})\/(\d{1,2})\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(edt|est)\s*:\s*(.+)$/i

const WEEK2_RE = /^week\s*2\b/i
const SCHEDULE_TITLE_RE = /^(\d{1,2}\/\d{1,2})\s*-\s*(\d{1,2}\/\d{1,2})\s+raid schedule/i
const SKIP_LINE_RE = /^-+$|^week\s*1:?$|^raid director/i
const DISCORD_TS_SUFFIX_RE = /\s*-\s*<t:\d+:[fFdDtTR]>$/i

function isWeek2FooterLine(line) {
  return /non\s*dkp\s+targets|are\s+ffa/i.test(line) && !RAID_LINE_RE.test(line)
}

function parseLongDateToIso(str) {
  const d = new Date(String(str || '').trim())
  if (Number.isNaN(d.getTime())) return null
  return formatDateIso({
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
  })
}

/**
 * Strip trailing Discord timestamp suffixes ("hammer times") from an event name.
 * @param {string} eventName
 * @returns {{ eventName: string, dateIso: string | null }}
 */
export function stripEventNameSuffix(eventName) {
  let name = String(eventName || '').trim()
  let dateIso = null

  let prev
  do {
    prev = name
    name = name.replace(DISCORD_TS_SUFFIX_RE, '').trim()
  } while (name !== prev)

  const dashIdx = name.lastIndexOf(' - ')
  if (dashIdx >= 0) {
    const tail = name.slice(dashIdx + 3).trim()
    const parsedIso = parseLongDateToIso(tail)
    if (parsedIso) {
      dateIso = parsedIso
      name = name.slice(0, dashIdx).trim()
    }
  }

  return { eventName: name, dateIso }
}

function inferYearFromIso(dateIso, fallbackYear) {
  const { month } = parseDateIso(dateIso)
  const today = parseDateIso(getTodayNyDate())
  let year = fallbackYear
  if (month < today.month - 6) year += 1
  return year
}

/**
 * The Wednesday after the upcoming Wednesday (NY calendar), used as the
 * default start of the two-week posting window.
 * @param {string} [fromDate] YYYY-MM-DD in NY
 */
export function getNextNextWednesdayNy(fromDate = getTodayNyDate()) {
  const firstWed = nextDateOnOrAfter(addDays(fromDate, 1), 3)
  return addDays(firstWed, 7)
}

/** @param {string} dateIso */
export function snapToWednesdayNy(dateIso) {
  if (getDayOfWeek(dateIso) === 3) return dateIso
  return nextDateOnOrAfter(dateIso, 3)
}

/** @param {string} dateIso */
export function snapToWednesdayOnOrBefore(dateIso) {
  let cursor = dateIso
  for (let i = 0; i < 7; i++) {
    if (getDayOfWeek(cursor) === 3) return cursor
    cursor = addDays(cursor, -1)
  }
  throw new Error(`No Wednesday within 7 days before ${dateIso}`)
}

/**
 * @param {string} scheduleTitle
 * @param {number} fallbackYear
 * @returns {string | null} YYYY-MM-DD
 */
export function parseTitlePeriodStart(scheduleTitle, fallbackYear) {
  const m = String(scheduleTitle || '').match(SCHEDULE_TITLE_RE)
  if (!m) return null
  const [month, day] = m[1].split('/').map(Number)
  const year = inferYearFromIso(formatDateIso({ year: fallbackYear, month, day }), fallbackYear)
  return formatDateIso({ year, month, day })
}

/**
 * @param {Array<{ week?: number, dateIso: string }>} rows
 * @param {string} periodStart YYYY-MM-DD (Wednesday)
 */
export function assignWeeksFromPeriodStart(rows, periodStart) {
  const week1End = addDays(periodStart, 6)
  return rows.map((row) => ({
    ...row,
    week: row.dateIso <= week1End ? 1 : 2,
  }))
}

function inferPeriodStart(rows, scheduleTitle) {
  const fallbackYear = rows.length
    ? parseDateIso(rows[0].dateIso).year
    : new Date().getFullYear()
  const titleStart = parseTitlePeriodStart(scheduleTitle, fallbackYear)
  if (titleStart) return snapToWednesdayOnOrBefore(titleStart)
  if (rows.length) {
    const minDate = rows.reduce(
      (min, row) => (row.dateIso < min ? row.dateIso : min),
      rows[0].dateIso
    )
    return snapToWednesdayOnOrBefore(minDate)
  }
  return null
}

/**
 * Map parsed rows onto a two-week window (Wed–Tue × 2). Preserves week grouping,
 * row order, and weekday from each row's dateIso.
 * @param {Array<{ id?: string, week: number, dateIso: string, eventName: string, time: object }>} rows
 * @param {{ fromDate?: string, periodStart?: string }} [options]
 */
export function projectParsedRowsToUpcoming(rows, { fromDate = getTodayNyDate(), periodStart } = {}) {
  const periodStartWednesday = snapToWednesdayNy(periodStart || getNextNextWednesdayNy(fromDate))
  const week1Start = periodStartWednesday
  const week1End = addDays(periodStartWednesday, 6)
  const week2Start = addDays(periodStartWednesday, 7)
  const week2End = addDays(periodStartWednesday, 13)

  function assignWeekDates(weekRows, windowStart, windowEnd) {
    let cursor = windowStart
    return weekRows.map((row) => {
      const dow = getDayOfWeek(row.dateIso)
      let dateIso = nextDateOnOrAfter(cursor, dow)
      if (dateIso > windowEnd) {
        dateIso = nextDateOnOrAfter(windowStart, dow)
      }
      cursor = addDays(dateIso, 1)
      return { ...row, id: row.id || createRowId(), dateIso }
    })
  }

  const week1 = rows.filter((r) => r.week === 1)
  const week2 = rows.filter((r) => r.week === 2)
  return {
    periodStart: periodStartWednesday,
    rows: [
      ...assignWeekDates(week1, week1Start, week1End),
      ...assignWeekDates(week2, week2Start, week2End),
    ],
  }
}

/** @param {string} periodStart YYYY-MM-DD (Wednesday) */
export function computeScheduleTitle(periodStart) {
  const start = formatMmDd(periodStart)
  const end = formatMmDd(addDays(periodStart, 13))
  return `${start} - ${end} Raid Schedule`
}

/**
 * Extract schedule title and week-2 footer from a pasted Discord block.
 * @param {string} text
 * @returns {{ scheduleTitle: string, week2Footer: string }}
 */
export function parseScheduleMetadata(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  let scheduleTitle = ''
  let week2Footer = ''

  for (const rawLine of lines) {
    const line = rawLine.replace(/^[^\]]+\]\s*/, '').trim()
    if (!line || /^-+$/.test(line)) continue
    if (SCHEDULE_TITLE_RE.test(line)) {
      scheduleTitle = line
      continue
    }
    if (isWeek2FooterLine(line)) {
      week2Footer = line
    }
  }

  return { scheduleTitle, week2Footer }
}

/**
 * Parse a pasted Discord raid schedule. By default keeps original dates; set
 * projectDates true to remap onto a two-week window.
 * @param {string} text
 * @param {{ fromDate?: string, periodStart?: string, projectDates?: boolean }} [options]
 * @returns {{ rows: Array, metadata: { scheduleTitle: string, week2Footer: string }, periodStart: string }}
 */
export function parseSchedulePaste(text, {
  fromDate = getTodayNyDate(),
  periodStart,
  projectDates = false,
} = {}) {
  const rows = parseSchedulePasteRaw(text)
  const metadata = parseScheduleMetadata(text)
  const inferredStart = inferPeriodStart(rows, metadata.scheduleTitle)
  const finalRows = inferredStart
    ? assignWeeksFromPeriodStart(rows, inferredStart)
    : rows
  const resolvedPeriodStart = snapToWednesdayNy(
    periodStart || inferredStart || getNextNextWednesdayNy(fromDate)
  )

  if (projectDates) {
    const projected = projectParsedRowsToUpcoming(finalRows, { fromDate, periodStart })
    return { rows: projected.rows, metadata, periodStart: projected.periodStart }
  }

  return { rows: finalRows, metadata, periodStart: resolvedPeriodStart }
}

/** @deprecated internal – use parseSchedulePaste; exposed for tests */
export function parseSchedulePasteRaw(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  let currentWeek = 1
  let fallbackYear = new Date().getFullYear()
  const rows = []

  for (const rawLine of lines) {
    const line = rawLine.replace(/^[^\]]+\]\s*/, '').trim()
    if (
      !line ||
      SKIP_LINE_RE.test(line) ||
      SCHEDULE_TITLE_RE.test(line) ||
      isWeek2FooterLine(line)
    ) {
      continue
    }
    if (WEEK2_RE.test(line)) {
      currentWeek = 2
      continue
    }
    if (/^\d{1,2}\/\d{1,2}\s*-\s*\d{1,2}\/\d{1,2}/i.test(line)) continue

    const match = line.match(RAID_LINE_RE)
    if (!match) continue

    const [, , monthStr, dayStr, hourStr, minuteStr, ampm, , rest] = match
    const { eventName, dateIso: suffixDateIso } = stripEventNameSuffix(rest.trim())
    let dateIso = suffixDateIso

    if (suffixDateIso) {
      fallbackYear = parseDateIso(suffixDateIso).year
    }

    if (!dateIso) {
      const month = Number(monthStr)
      const day = Number(dayStr)
      const year = inferYearFromIso(formatDateIso({ year: fallbackYear, month, day }), fallbackYear)
      dateIso = formatDateIso({ year, month, day })
    }

    rows.push({
      id: createRowId(),
      week: currentWeek,
      dateIso,
      eventName,
      time: parseCompactTime(hourStr, ampm, minuteStr ? Number(minuteStr) : 0),
    })
  }

  return rows
}

/**
 * @param {{ dateIso: string, dayName: string, mmdd: string }} slot
 * @param {string} eventName
 * @param {{ hour24: number, minute: number }} time
 */
export function formatOutputLine(slot, eventName, time) {
  const { eventName: cleanName } = stripEventNameSuffix(eventName)
  const tz = getNyTzSuffix(slot.dateIso, time.hour24, time.minute)
  const timeStr = formatOutputTime(time.hour24, time.minute, tz)
  const epoch = nyLocalToUnixEpoch(slot.dateIso, time.hour24, time.minute)
  return `${slot.dayName} ${slot.mmdd} ${timeStr}: ${cleanName} - <t:${epoch}:f>`
}

/**
 * @param {Array<{ week: number, dateIso: string, eventName?: string, time?: { hour24: number, minute: number } }>} rows
 * @param {number} week
 */
export function formatWeekRaidLines(rows, week) {
  const weekRows = rows.filter((r) => r.week === week)
  const lines = []
  for (const row of weekRows) {
    const slot = slotFromDateIso(row.dateIso, week)
    lines.push(formatOutputLine(slot, row.eventName ?? '', row.time ?? DEFAULT_TIME))
    lines.push('-------')
  }
  return lines
}

/**
 * @param {Array<{ week: number, dateIso: string, eventName?: string, time?: { hour24: number, minute: number } }>} rows
 * @param {{ scheduleTitle?: string }} [options]
 */
export function buildWeek1Post(rows, { scheduleTitle = '' } = {}) {
  const raidLines = formatWeekRaidLines(rows, 1)
  if (!raidLines.length && !scheduleTitle) return ''
  const lines = []
  if (scheduleTitle) {
    lines.push('-------', scheduleTitle, '-------', 'Week 1:', '-------')
  }
  lines.push(...raidLines)
  return lines.join('\n')
}

/**
 * @param {Array<{ week: number, dateIso: string, eventName?: string, time?: { hour24: number, minute: number } }>} rows
 * @param {{ week2Footer?: string }} [options]
 */
export function buildWeek2Post(rows, { week2Footer = '' } = {}) {
  const week2Rows = rows.filter((r) => r.week === 2)
  if (!week2Rows.length) return ''
  const lines = ['Week 2', '-------', ...formatWeekRaidLines(rows, 2)]
  if (week2Footer) {
    lines.push(week2Footer, '-------')
  }
  return lines.join('\n')
}

/**
 * @param {Array<{ week: number, dateIso: string, eventName?: string, time?: { hour24: number, minute: number } }>} rows
 * @param {{ scheduleTitle?: string, week2Footer?: string }} [options]
 */
export function buildScheduleOutput(rows, { scheduleTitle = '', week2Footer = '' } = {}) {
  const w1 = buildWeek1Post(rows, { scheduleTitle })
  const w2 = buildWeek2Post(rows, { week2Footer })
  if (!w1 && !w2) return ''
  if (!w2) return w1
  if (!w1) return w2
  return `${w1}\n${w2}`
}

/** Back-compat helper for legacy slot/name/time arrays. */
export function buildScheduleOutputFromSlots(slots, eventNames, times) {
  const rows = slots.map((slot, i) => ({
    week: slot.week,
    dateIso: slot.dateIso,
    eventName: eventNames[i] ?? '',
    time: times[i] ?? DEFAULT_TIME,
  }))
  return buildScheduleOutput(rows)
}
