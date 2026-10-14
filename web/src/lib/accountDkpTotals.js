/**
 * Same earned / spent / balance as the account page header.
 * Summary cache can lag live attendance and loot, so the page keeps the higher of the two.
 * @param {{ earned?: number, spent?: number } | null | undefined} summary
 * @param {Array<{ dkpEarned?: number, items?: Array<{ cost?: number | string }> }> | null | undefined} activityByRaid
 */
export function reconcileAccountDkp(summary, activityByRaid) {
  const safeSummary = summary || {}
  const raids = activityByRaid || []
  let pageSpent = 0
  for (const act of raids) {
    for (const it of act.items || []) {
      const c = parseFloat(it.cost)
      if (Number.isFinite(c)) pageSpent += c
    }
  }
  pageSpent = Math.round(pageSpent)
  const pageEarned = Math.round(raids.reduce((s, a) => s + (Number(a.dkpEarned) || 0), 0))
  const summaryEarned = Math.round(Number(safeSummary.earned) || 0)
  const summarySpent = Math.round(Number(safeSummary.spent) || 0)
  const earned = Math.max(summaryEarned, pageEarned)
  const spent = pageSpent > 0 ? Math.max(pageSpent, summarySpent) : summarySpent
  const balance = earned - spent
  const summaryBalance = summaryEarned - summarySpent
  const staleSummary =
    (summaryEarned > 0 || summarySpent > 0) &&
    (Math.abs(spent - summarySpent) > 1 ||
      Math.abs(earned - summaryEarned) > 1 ||
      Math.abs(balance - summaryBalance) > 1)
  return { earned, spent, balance, staleSummary }
}

/** Plain-text line used on Home, the DKP leaderboard, and My Site Profile. */
export function formatMyDkpTotal(totals) {
  const balance = Number(totals?.balance || 0).toFixed(0)
  const earned = Number(totals?.earned || 0)
  const spent = Number(totals?.spent || 0)
  return `Your DKP total is: ${balance} (earned ${earned} \u00B7 spent ${spent})`
}

export const MISSING_DKP_NOTE = 'If you think you are missing dkp, remember to make a Discord post in #dkp_etc channel with details'

/** Attendance credit, not a loot-only row. Explicit `attended: false` stays excluded. */
export function raidWasAttended(act) {
  if (!act) return false
  if (act.attended === false) return false
  if (act.attended === true) return true
  return Number(act.dkpEarned) > 0 || Number(act.ticEarned) > 0
}

/**
 * Newest raid this account attended. Same order as the raids list: date, then raid id.
 * @param {Array<{ raid_id?: string, date?: string, dkpEarned?: number, dkpRaidTotal?: number, attended?: boolean, ticEarned?: number }>} activityByRaid
 */
export function mostRecentAttendedRaid(activityByRaid) {
  const rows = (activityByRaid || []).filter(raidWasAttended)
  rows.sort((a, b) => {
    const byDate = (b.date || '').localeCompare(a.date || '')
    if (byDate !== 0) return byDate
    return String(b.raid_id || '').localeCompare(String(a.raid_id || ''))
  })
  return rows[0] || null
}

/** Earned on that raid versus the full tic total one person could receive. */
export function formatRaidDkpEarned(raid) {
  const earned = Math.round(Number(raid?.dkpEarned) || 0)
  const total = Math.round(Number(raid?.dkpRaidTotal) || 0)
  return `You earned ${earned} DKP out of ${total} DKP`
}
