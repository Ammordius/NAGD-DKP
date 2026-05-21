/**
 * Raider activity metrics (account-level raid attendance %).
 * Consumes officer_raider_activity RPC snapshot; pure functions are unit-tested.
 */

export const STATUS_LABELS = [
  'Returning',
  'Declining',
  'Core',
  'Active',
  'Rotational',
  'At Risk',
]

const STATUS_PRIORITY = {
  Returning: 1,
  Declining: 2,
  Core: 3,
  Active: 4,
  Rotational: 5,
  'At Risk': 6,
}

const RECENT_PATTERN_RAID_COUNT = 10

/** @param {string | null | undefined} dateStr */
export function parseRaidDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null
  const s = dateStr.trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

/** @param {Date} now */
export function cutoffDateForDays(now, days) {
  const d = new Date(now)
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}

/**
 * @param {number | null | undefined} ra30
 * @param {number | null | undefined} ra90
 * @returns {string | null}
 */
export function getActivityStatus(ra30, ra90) {
  if (ra30 == null || ra90 == null) return null
  const r30 = Number(ra30)
  const r90 = Number(ra90)
  if (!Number.isFinite(r30) || !Number.isFinite(r90)) return null
  if (r90 < 50 && r30 >= 70) return 'Returning'
  if (r90 >= 70 && r30 <= 50) return 'Declining'
  if (r30 >= 80) return 'Core'
  if (r30 >= 60) return 'Active'
  if (r30 >= 30) return 'Rotational'
  return 'At Risk'
}

/**
 * @param {number} attended
 * @param {number} eligible
 * @returns {number | null} 0–100
 */
export function computeRaPercent(attended, eligible) {
  if (!eligible || eligible <= 0) return null
  return Math.round((attended / eligible) * 1000) / 10
}

/**
 * @param {string} raidDate YYYY-MM-DD
 * @param {string} cutoff YYYY-MM-DD
 * @param {string} endDate YYYY-MM-DD
 */
export function isRaidInWindow(raidDate, cutoff, endDate) {
  if (!raidDate) return false
  return raidDate >= cutoff && raidDate <= endDate
}

/**
 * Build set of raid_ids attended by account from snapshot attendance rows.
 * @param {Array<{ raid_id: string, account_id: string }>} attendanceRows
 * @param {string} accountId
 */
export function attendedRaidIdsForAccount(attendanceRows, accountId) {
  const set = new Set()
  for (const row of attendanceRows || []) {
    if (String(row.account_id) === String(accountId) && row.raid_id) {
      set.add(String(row.raid_id))
    }
  }
  return set
}

/**
 * @param {{ raid_id: string, raid_date?: string, date_iso?: string }[]} raidsSorted
 * @param {Set<string>} attendedIds
 * @param {number} windowDays
 * @param {Date} now
 */
export function raForWindow(raidsSorted, attendedIds, windowDays, now) {
  const endDate = cutoffDateForDays(now, 0)
  const cutoff = cutoffDateForDays(now, windowDays)
  let eligible = 0
  let attended = 0
  for (const r of raidsSorted) {
    const d = parseRaidDate(r.raid_date || r.date_iso)
    if (!isRaidInWindow(d, cutoff, endDate)) continue
    eligible += 1
    if (attendedIds.has(String(r.raid_id))) attended += 1
  }
  return {
    ra: computeRaPercent(attended, eligible),
    attended,
    eligible,
  }
}

/**
 * @param {object} account
 * @param {Set<string>} attendedIds
 * @param {{ raid_id: string, raid_date?: string, date_iso?: string }[]} raidsSorted
 * @param {{ periodDays: number, now: Date }} options
 */
export function calculateRaiderActivity(account, attendedIds, raidsSorted, options) {
  const { periodDays = 90, now = new Date() } = options || {}
  const w30 = raForWindow(raidsSorted, attendedIds, 30, now)
  const w60 = raForWindow(raidsSorted, attendedIds, 60, now)
  const w90 = raForWindow(raidsSorted, attendedIds, 90, now)
  const period = raForWindow(raidsSorted, attendedIds, periodDays, now)

  const ra30 = w30.ra
  const ra60 = w60.ra
  const ra90 = w90.ra
  const trendDelta =
    ra30 != null && ra90 != null ? Math.round((ra30 - ra90) * 10) / 10 : null

  let lastAttendedRaidDate = null
  for (let i = raidsSorted.length - 1; i >= 0; i -= 1) {
    const r = raidsSorted[i]
    if (attendedIds.has(String(r.raid_id))) {
      lastAttendedRaidDate = parseRaidDate(r.raid_date || r.date_iso)
      break
    }
  }

  const status = getActivityStatus(ra30, ra90)

  const recentRaids = raidsSorted.slice(-RECENT_PATTERN_RAID_COUNT)
  const recentAttendancePattern = recentRaids.map((r) => attendedIds.has(String(r.raid_id)))

  return {
    accountId: account.account_id,
    displayName: (account.display_name || '').trim() || account.account_id,
    toonNames: (account.toon_names || '').trim(),
    inactive: account.inactive === true,
    ra30,
    ra60,
    ra90,
    trendDelta,
    lastAttendedRaidDate,
    attendedCount: period.attended,
    eligibleCount: period.eligible,
    status,
    recentAttendancePattern,
  }
}

/**
 * Normalize RPC snapshot raids to sorted list with raid_date.
 * @param {object} snapshot
 */
export function normalizeSnapshotRaids(snapshot) {
  const raids = (snapshot?.raids || []).map((r) => ({
    raid_id: String(r.raid_id),
    date_iso: r.date_iso,
    raid_date: parseRaidDate(r.raid_date || r.date_iso),
    attendee_count: Number(r.attendee_count) || 0,
  }))
  raids.sort((a, b) => {
    const d = (a.raid_date || '').localeCompare(b.raid_date || '')
    if (d !== 0) return d
    return a.raid_id.localeCompare(b.raid_id)
  })
  return raids
}

/**
 * @param {object} snapshot RPC payload
 * @param {{ periodDays?: number, now?: Date }} options
 */
export function buildRaiderActivityRows(snapshot, options = {}) {
  const { periodDays = 90, now = new Date() } = options
  const raidsSorted = normalizeSnapshotRaids(snapshot)
  const rosterSet = new Set((snapshot?.roster_account_ids || []).map(String))
  const accountById = {}
  for (const a of snapshot?.accounts || []) {
    accountById[String(a.account_id)] = a
  }

  const attendance = snapshot?.attendance || []
  const accountIds = new Set([
    ...Object.keys(accountById),
    ...attendance.map((x) => String(x.account_id)),
  ])

  const rows = []
  for (const accountId of accountIds) {
    const account = accountById[accountId] || {
      account_id: accountId,
      display_name: '',
      toon_names: '',
      inactive: false,
    }
    const attendedIds = attendedRaidIdsForAccount(attendance, accountId)
    if (attendedIds.size === 0 && !rosterSet.has(accountId)) continue
    const row = calculateRaiderActivity(account, attendedIds, raidsSorted, { periodDays, now })
    rows.push({
      ...row,
      isTracked: rosterSet.has(accountId),
    })
  }

  rows.sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }))
  return { rows, raidsSorted }
}

/**
 * @param {ReturnType<buildRaiderActivityRows>['rows']} rows
 * @param {Set<string>} rosterIds
 * @param {{ raid_id: string, raid_date?: string, attendee_count: number }[]} raidsSorted
 * @param {number} periodDays
 * @param {Date} now
 */
export function buildActivitySummary(rows, rosterIds, raidsSorted, periodDays, now = new Date()) {
  const roster = rows.filter((r) => rosterIds.has(String(r.accountId)))
  const endDate = cutoffDateForDays(now, 0)
  const periodCutoff = cutoffDateForDays(now, periodDays)
  const day30Cutoff = cutoffDateForDays(now, 30)

  const periodRaids = raidsSorted.filter((r) => {
    const d = r.raid_date
    return d && isRaidInWindow(d, periodCutoff, endDate)
  })
  const avgRaidSize =
    periodRaids.length > 0
      ? Math.round(
          (periodRaids.reduce((s, r) => s + (r.attendee_count || 0), 0) / periodRaids.length) * 10,
        ) / 10
      : null

  let activeLast30 = 0
  let core = 0
  let rotational = 0
  let atRisk = 0

  for (const r of roster) {
    if (r.ra30 != null && r.ra30 > 0) activeLast30 += 1
    else if (r.lastAttendedRaidDate && r.lastAttendedRaidDate >= day30Cutoff) activeLast30 += 1

    if (r.status === 'Core') core += 1
    else if (r.status === 'Rotational') rotational += 1
    else if (r.status === 'At Risk') atRisk += 1
  }

  return {
    totalTracked: roster.length,
    activeLast30,
    core,
    rotational,
    atRisk,
    avgRaidSize,
    periodRaidCount: periodRaids.length,
  }
}

/**
 * Whether account attended any of the last N guild raids.
 * @param {boolean[]} pattern - aligned to last RECENT_PATTERN_RAID_COUNT raids in raidsSorted
 * @param {object[]} raidsSorted
 * @param {number} n
 */
export function attendedAnyOfLastNRaid(pattern, raidsSorted, n) {
  const total = raidsSorted.length
  const count = Math.min(Math.max(1, n), total)
  if (!pattern?.length || count === 0) return false
  const patternOffset = total - pattern.length
  const needFrom = total - count
  for (let globalIdx = needFrom; globalIdx < total; globalIdx += 1) {
    const patIdx = globalIdx - patternOffset
    if (patIdx >= 0 && patIdx < pattern.length && pattern[patIdx]) return true
  }
  return false
}

/**
 * @param {ReturnType<buildRaiderActivityRows>['rows']} rows
 * @param {{ absentRaids?: number, now?: Date, raidsSorted?: object[] }} options
 */
export function buildWatchlists(rows, options = {}) {
  const { absentRaids = 5, now = new Date(), raidsSorted = [] } = options
  const day30Cutoff = cutoffDateForDays(now, 30)

  const declining = []
  const returning = []
  const recentlyAbsent = []

  for (const r of rows) {
    if (!r.isTracked) continue
    if (r.status === 'Declining') declining.push(r)
    if (r.status === 'Returning') returning.push(r)

    const no30 = !r.lastAttendedRaidDate || r.lastAttendedRaidDate < day30Cutoff
    const noLastN = !attendedAnyOfLastNRaid(r.recentAttendancePattern, raidsSorted, absentRaids)
    if (no30 || noLastN) recentlyAbsent.push(r)
  }

  return {
    declining: declining.sort((a, b) => (a.ra30 ?? 0) - (b.ra30 ?? 0)),
    returning: returning.sort((a, b) => (b.ra30 ?? 0) - (a.ra30 ?? 0)),
    recentlyAbsent: recentlyAbsent.sort((a, b) =>
      (a.lastAttendedRaidDate || '').localeCompare(b.lastAttendedRaidDate || ''),
    ),
  }
}

/**
 * @param {ReturnType<buildRaiderActivityRows>['rows']} rows
 * @param {{ search?: string, statusFilter?: string, sortBy?: string }} opts
 */
export function filterAndSortRows(rows, opts = {}) {
  const search = (opts.search || '').trim().toLowerCase()
  const statusFilter = (opts.statusFilter || '').trim()
  const sortBy = opts.sortBy || 'displayName'

  let list = [...rows]
  if (search) {
    list = list.filter(
      (r) =>
        r.displayName.toLowerCase().includes(search) ||
        String(r.accountId).toLowerCase().includes(search) ||
        (r.toonNames || '').toLowerCase().includes(search),
    )
  }
  if (statusFilter) {
    list = list.filter((r) => r.status === statusFilter)
  }

  const cmp = (a, b) => {
    switch (sortBy) {
      case 'ra30':
        return (b.ra30 ?? -1) - (a.ra30 ?? -1)
      case 'ra60':
        return (b.ra60 ?? -1) - (a.ra60 ?? -1)
      case 'ra90':
        return (b.ra90 ?? -1) - (a.ra90 ?? -1)
      case 'trendDelta':
        return (b.trendDelta ?? -999) - (a.trendDelta ?? -999)
      case 'lastAttended':
        return (b.lastAttendedRaidDate || '').localeCompare(a.lastAttendedRaidDate || '')
      case 'attendedCount':
        return b.attendedCount - a.attendedCount
      case 'status': {
        const pa = STATUS_PRIORITY[a.status] ?? 99
        const pb = STATUS_PRIORITY[b.status] ?? 99
        if (pa !== pb) return pa - pb
        return a.displayName.localeCompare(b.displayName)
      }
      default:
        return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
    }
  }
  list.sort(cmp)
  return list
}

/** @param {number | null} value */
export function formatRaPercent(value) {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value}%`
}

/** @param {number | null} delta */
export function formatTrendDelta(delta) {
  if (delta == null || !Number.isFinite(delta)) return { text: '—', direction: null }
  if (delta > 0) return { text: `+${delta}%`, direction: 'up' }
  if (delta < 0) return { text: `${delta}%`, direction: 'down' }
  return { text: '0%', direction: null }
}

/** @param {boolean[]} pattern */
export function formatAttendancePattern(pattern) {
  if (!pattern?.length) return ''
  return pattern.map((ok) => (ok ? '✓' : '✗')).join('')
}

export const STATUS_COLORS = {
  Returning: { bg: '#14532d', color: '#86efac' },
  Declining: { bg: '#7f1d1d', color: '#fca5a5' },
  Core: { bg: '#1e3a5f', color: '#93c5fd' },
  Active: { bg: '#1e3a2f', color: '#86efac' },
  Rotational: { bg: '#422006', color: '#fcd34d' },
  'At Risk': { bg: '#3f1515', color: '#f87171' },
}
