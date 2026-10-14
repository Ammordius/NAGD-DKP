import { TIC_TIME_ZONE } from './ticDateTime.js'

export const DEFAULT_SITE_TIME_ZONE = TIC_TIME_ZONE

const TIME_ZONE_ID = /^[A-Za-z0-9_+-]{1,40}(?:\/[A-Za-z0-9_+-]{1,40}){0,3}$/

const formatterCache = new Map()

function formatterFor(timeZone) {
  let fmt = formatterCache.get(timeZone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    formatterCache.set(timeZone, fmt)
  }
  return fmt
}

export function isSupportedTimeZone(value) {
  const id = String(value ?? '').trim()
  if (!TIME_ZONE_ID.test(id)) return false
  try {
    formatterFor(id)
    return true
  } catch {
    return false
  }
}

/** Saved profile zone, or Eastern when the profile has none. */
export function profileTimeZone(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const id = typeof src.timeZone === 'string' ? src.timeZone.trim() : ''
  return isSupportedTimeZone(id) ? id : DEFAULT_SITE_TIME_ZONE
}

function zoneParts(timeZone, epochMs) {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs))
  const get = (type) => Number(parts.find((p) => p.type === type)?.value)
  let hour = get('hour')
  if (hour === 24) hour = 0
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  }
}

/** Minutes east of UTC for this zone at this instant. */
export function timeZoneOffsetMinutes(timeZone, epochMs) {
  const wholeSecond = epochMs - (epochMs % 1000)
  const parts = zoneParts(timeZone, wholeSecond)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return Math.round((asUtc - wholeSecond) / 60000)
}

function formatOffset(minutes) {
  const sign = minutes >= 0 ? '+' : '-'
  const abs = Math.abs(minutes)
  const hours = String(Math.floor(abs / 60)).padStart(2, '0')
  const mins = String(abs % 60).padStart(2, '0')
  return `${sign}${hours}:${mins}`
}

function observesDaylightSaving(timeZone, year) {
  const january = Date.UTC(year, 0, 15, 12, 0, 0)
  const july = Date.UTC(year, 6, 15, 12, 0, 0)
  return timeZoneOffsetMinutes(timeZone, january) !== timeZoneOffsetMinutes(timeZone, july)
}

/**
 * One dropdown line, e.g. "-04:00 GMT America, Indiana, Vincennes (DST Observed)".
 * The offset is the zone's offset at `now`. DST Observed is shown when January and July differ.
 */
export function timeZoneOptionLabel(timeZone, now = new Date()) {
  const epochMs = now instanceof Date ? now.getTime() : Number(now)
  const offset = formatOffset(timeZoneOffsetMinutes(timeZone, epochMs))
  const place = String(timeZone)
    .split('/')
    .map((part) => part.replace(/_/g, ' '))
    .join(', ')
  const year = Number.isFinite(epochMs) ? new Date(epochMs).getUTCFullYear() : new Date().getUTCFullYear()
  const dst = observesDaylightSaving(timeZone, year) ? ' (DST Observed)' : ''
  return `${offset} GMT ${place}${dst}`
}

/** IANA zones sorted by current offset, then by the dropdown label. */
export function listTimeZoneOptions(now = new Date()) {
  const zones = Intl.supportedValuesOf('timeZone').filter((id) => isSupportedTimeZone(id))
  const options = zones.map((id) => ({
    id,
    label: timeZoneOptionLabel(id, now),
    offset: timeZoneOffsetMinutes(id, now instanceof Date ? now.getTime() : Number(now)),
  }))
  options.sort((a, b) => a.offset - b.offset || a.label.localeCompare(b.label))
  return options
}
