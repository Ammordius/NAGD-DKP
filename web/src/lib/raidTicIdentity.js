/**
 * Same tic as dkp_one_tic_value and raid_distinct_tic_totals:
 * one row per (event_id, event_order, trimmed lower name), lowest id kept.
 */

function rowId(row) {
  const n = Number(row?.id)
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY
}

function ticDkp(row) {
  const raw = row?.dkp_value
  if (raw == null || String(raw).trim() === '') return 0
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}

function ticEventOrder(row) {
  const raw = row?.event_order ?? row?.eventOrder
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function ticEventName(row) {
  return String(row?.event_name ?? row?.eventName ?? '').trim()
}

export function ticEventId(row) {
  if (row == null) return ''
  if (typeof row === 'string' || typeof row === 'number') return String(row).trim()
  return String(row.event_id ?? '').trim()
}

export function distinctTicKey(row) {
  const eventId = ticEventId(row)
  const order = row?.event_order == null || row?.event_order === '' ? '' : String(row.event_order)
  const name = String(row?.event_name ?? '').trim().toLowerCase()
  return `${eventId}\0${order}\0${name}`
}

/** @returns {Map<string, Map<string, { eventId: string, dkp: number, eventOrder: number|null, eventName: string }>>} */
export function distinctTicsByRaid(rows) {
  const sorted = [...(rows || [])].sort((a, b) => rowId(a) - rowId(b))
  const byRaid = new Map()
  for (const row of sorted) {
    const raidId = String(row?.raid_id ?? '').trim()
    if (!raidId) continue
    let tics = byRaid.get(raidId)
    if (!tics) {
      tics = new Map()
      byRaid.set(raidId, tics)
    }
    const key = distinctTicKey(row)
    if (tics.has(key)) continue
    tics.set(key, {
      eventId: ticEventId(row),
      dkp: ticDkp(row),
      eventOrder: ticEventOrder(row),
      eventName: ticEventName(row),
    })
  }
  return byRaid
}

/** Event ids this account was present for, one set per raid. */
export function attendanceEventIdsByRaid(rows) {
  const byRaid = new Map()
  for (const row of rows || []) {
    const raidId = String(row?.raid_id ?? '').trim()
    const eventId = ticEventId(row)
    if (!raidId || !eventId) continue
    let attended = byRaid.get(raidId)
    if (!attended) {
      attended = new Set()
      byRaid.set(raidId, attended)
    }
    attended.add(eventId)
  }
  return byRaid
}

/**
 * Tic earned / tic total for each raid.
 * A tic counts as earned only when this account has attendance for its event id.
 */
export function ticFractionsByRaid(eventRows, attendanceRows) {
  const ticsByRaid = distinctTicsByRaid(eventRows)
  const attendedByRaid = attendanceEventIdsByRaid(attendanceRows)
  const raidIds = new Set([...ticsByRaid.keys(), ...attendedByRaid.keys()])
  const out = new Map()
  for (const raidId of raidIds) {
    const tics = ticsByRaid.get(raidId)
    out.set(
      raidId,
      tics
        ? raidTicAttendance(tics, attendedByRaid.get(raidId) || new Set())
        : { totalDkp: 0, ticTotal: 0, ticEarned: 0, missingTics: [] },
    )
  }
  return out
}

/**
 * Denominator is every distinct tic on the raid.
 * Numerator is the distinct positive tics under event ids this account attended.
 * Attendance is once per event id, so On-time and the DKP tic both count.
 */
export function raidTicAttendance(tics, attendedEventIds) {
  const attended = new Set()
  for (const id of attendedEventIds || []) {
    const eventId = ticEventId(id)
    if (eventId) attended.add(eventId)
  }
  let totalDkp = 0
  let ticTotal = 0
  let ticEarned = 0
  const missingTics = []
  for (const tic of tics.values()) {
    totalDkp += tic.dkp
    if (tic.dkp > 0) {
      ticTotal += 1
      const eventId = ticEventId(tic.eventId)
      if (eventId && attended.has(eventId)) {
        ticEarned += 1
      } else {
        missingTics.push({
          eventOrder: ticEventOrder(tic),
          eventName: ticEventName(tic),
        })
      }
    }
  }
  missingTics.sort((a, b) => {
    const ao = a.eventOrder == null ? Number.POSITIVE_INFINITY : a.eventOrder
    const bo = b.eventOrder == null ? Number.POSITIVE_INFINITY : b.eventOrder
    if (ao !== bo) return ao - bo
    return a.eventName.localeCompare(b.eventName)
  })
  return { totalDkp, ticTotal, ticEarned, missingTics }
}

function namedMissingTics(act) {
  if (!Array.isArray(act?.missingTics)) return []
  return act.missingTics
    .map((tic) => ({
      eventOrder: ticEventOrder(tic),
      eventName: ticEventName(tic),
    }))
    .filter((tic) => tic.eventName || tic.eventOrder != null)
}

function paidFullRaid(dkpEarned, dkpRaidTotal) {
  return dkpRaidTotal > 0 && Math.round(Number(dkpEarned) || 0) >= Math.round(Number(dkpRaidTotal) || 0)
}

function hasLootItems(act) {
  return Array.isArray(act?.items) && act.items.length > 0
}

/**
 * Missing attendance is a positive-DKP tic whose event this account was not on.
 * Observed tic counts come only from matched event attendance.
 * Full DKP payment with no matched event rows is inferred credit, not verified
 * full-tic attendance — do not silently rewrite ticEarned to ticTotal.
 */
export function raidMissingTics(act) {
  const ticTotal = Math.max(0, Number(act?.ticTotal ?? 0) || 0)
  const dkpEarned = Number(act?.dkpEarned ?? 0) || 0
  const dkpRaidTotal = Number(act?.dkpRaidTotal ?? 0) || 0
  let ticEarned = Math.max(0, Number(act?.ticEarned ?? 0) || 0)
  if (ticTotal > 0) ticEarned = Math.min(ticEarned, ticTotal)
  const observedTicEarned = ticEarned
  let missingCount = ticTotal > 0
    ? ticTotal - ticEarned
    : (dkpRaidTotal > 0 ? Math.max(0, dkpRaidTotal - dkpEarned) : 0)
  let missingTics = ticTotal > 0 ? namedMissingTics(act) : []
  const inferredFullPayment = (
    ticTotal > 0
    && observedTicEarned === 0
    && missingCount === ticTotal
    && paidFullRaid(dkpEarned, dkpRaidTotal)
  )
  let attendanceSource = 'unknown'
  if (ticTotal > 0 && observedTicEarned > 0) attendanceSource = 'observed'
  else if (inferredFullPayment) attendanceSource = 'inferred-full-payment'
  else if (ticTotal > 0 || dkpRaidTotal > 0) attendanceSource = 'observed'

  // Full payment without event rows is raid-level credit, not a total absence.
  // Keep observed ticEarned; clear the "missing all tics" flag for filters/UI.
  if (inferredFullPayment) {
    missingCount = 0
    missingTics = []
  }
  const hasTrackableAttendance = ticTotal > 0 || dkpRaidTotal > 0
  const isMissingTics = hasTrackableAttendance && missingCount > 0
  if (!isMissingTics) missingTics = []
  return {
    dkpEarned,
    dkpRaidTotal,
    ticEarned: observedTicEarned,
    observedTicEarned,
    ticTotal,
    attendanceSource,
    hasTrackableAttendance,
    missingCount,
    missingTics,
    isMissingTics,
  }
}

/** True when this account received credit on the raid, so a short tic count is a gap rather than a raid they never attended. */
export function accountWasPresent(act) {
  return Number(act?.ticEarned ?? 0) > 0
    || Number(act?.dkpEarned ?? 0) > 0
    || act?.attendanceSource === 'inferred-full-payment'
}

/**
 * Activity rows for the two account-history tic controls.
 * "Only missing" is raids this account attended and still missed at least one tic.
 * Raids they never attended stay in the full list (and can be highlighted there)
 * but are not the missing-tic list — that set is every other guild raid.
 * Loot-only raids stay in normal history even without trackable attendance.
 */
export function visibleMissingTicRows(rows, { showMissingDetails = false, onlyMissingRaids = false } = {}) {
  const historyRows = (rows || []).filter(
    (act) => act.hasTrackableAttendance || hasLootItems(act),
  )
  const detailScoped = showMissingDetails
    ? historyRows
    : historyRows.filter((act) => accountWasPresent(act) || hasLootItems(act))
  if (!onlyMissingRaids) return detailScoped
  return detailScoped.filter((act) => act.isMissingTics && accountWasPresent(act))
}
