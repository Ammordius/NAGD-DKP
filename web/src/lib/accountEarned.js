/** First YYYY-MM-DD in a raid date string. Matches raid_date_parsed. */
export function isoDay(value) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? '').trim())
  return match ? match[1] : null
}

/** UTC calendar day `days` before `now`, as YYYY-MM-DD. Inclusive bound for 30d/60d windows. */
export function cutoffIsoDay(days, now = new Date()) {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  day.setUTCDate(day.getUTCDate() - days)
  return day.toISOString().slice(0, 10)
}

/**
 * Earned per account from raid_attendance_dkp_by_account, the same rows the account page sums.
 * account_dkp_summary.earned is rebuilt with dkp_one_tic_value and can be 0 while these rows are not.
 *
 * @param {Array<{ account_id?: string, raid_id?: string, dkp_earned?: string | number }>} rows
 * @param {Record<string, string | null | undefined>} raidDateById
 * @param {Date} [now]
 * @returns {Record<string, { earned: number, earned_30d: number, earned_60d: number, last_activity_date: string | null }>}
 */
export function sumAttendanceEarnedByAccount(rows, raidDateById, now = new Date()) {
  const day30 = cutoffIsoDay(30, now)
  const day60 = cutoffIsoDay(60, now)
  /** @type {Record<string, { earned: number, earned_30d: number, earned_60d: number, last_activity_date: string | null }>} */
  const byAccount = {}
  for (const row of rows || []) {
    const id = String(row.account_id ?? '').trim()
    if (!id) continue
    const earned = Math.round(Number(row.dkp_earned) || 0)
    if (!byAccount[id]) byAccount[id] = { earned: 0, earned_30d: 0, earned_60d: 0, last_activity_date: null }
    const totals = byAccount[id]
    totals.earned += earned
    const day = isoDay(raidDateById?.[String(row.raid_id)])
    if (day && day >= day30) totals.earned_30d += earned
    if (day && day >= day60) totals.earned_60d += earned
    if (day && (!totals.last_activity_date || day > totals.last_activity_date)) totals.last_activity_date = day
  }
  return byAccount
}

/** Keep the larger of the summary cache and the attendance sum. The cache earned column is often 0. */
export function preferAttendanceEarned(summaryValue, attendanceValue) {
  return Math.max(Math.round(Number(summaryValue) || 0), Math.round(Number(attendanceValue) || 0))
}

/**
 * Summary rows plus any account that has attendance but no summary row.
 *
 * @param {Array<{ account_id?: string }> | null | undefined} accountSummary
 * @param {Record<string, unknown> | null | undefined} attendanceEarned
 */
export function summaryRowsIncludingAttendance(accountSummary, attendanceEarned) {
  const knownAccounts = new Set((accountSummary || []).map((r) => String(r.account_id)))
  const summaryRows = [...(accountSummary || [])]
  Object.keys(attendanceEarned || {}).forEach((id) => {
    if (knownAccounts.has(id)) return
    summaryRows.push({
      account_id: id,
      earned: 0,
      spent: 0,
      earned_30d: 0,
      earned_60d: 0,
      last_activity_date: null,
    })
  })
  return summaryRows
}
