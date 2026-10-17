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

export function distinctTicKey(row) {
  const eventId = String(row?.event_id ?? '')
  const order = row?.event_order == null || row?.event_order === '' ? '' : String(row.event_order)
  const name = String(row?.event_name ?? '').trim().toLowerCase()
  return `${eventId}\0${order}\0${name}`
}

/** @returns {Map<string, Map<string, { eventId: string, dkp: number }>>} */
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
    tics.set(key, { eventId: String(row?.event_id ?? ''), dkp: ticDkp(row) })
  }
  return byRaid
}

/**
 * Denominator is every distinct tic on the raid.
 * Numerator is the distinct positive tics under event ids this account attended.
 * Attendance is once per event id, so On-time and the DKP tic both count.
 */
export function raidTicAttendance(tics, attendedEventIds) {
  const attended = attendedEventIds || new Set()
  let totalDkp = 0
  let ticTotal = 0
  let ticEarned = 0
  for (const tic of tics.values()) {
    totalDkp += tic.dkp
    if (tic.dkp > 0) {
      ticTotal += 1
      if (attended.has(tic.eventId)) ticEarned += 1
    }
  }
  return { totalDkp, ticTotal, ticEarned }
}
