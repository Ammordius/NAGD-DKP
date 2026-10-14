/** Leaderboard columns that can be sorted from the header. */
export const LEADERBOARD_SORT_COLUMNS = ['account', 'balance', 'earned', 'spent', '30d', '60d']

export const ATTENDANCE_GREEN = '#22c55e'
export const ATTENDANCE_YELLOW = '#fbbf24'
export const ATTENDANCE_RED = '#f87171'

/** Rounded share of period DKP, matching the percent shown in the 30d and 60d cells. */
export function attendanceSharePercent(earned, total) {
  const pool = Number(total) || 0
  if (pool <= 0) return null
  return Math.round(((Number(earned) || 0) / pool) * 100)
}

/** Above 45% green, 10% through 45% yellow, below 10% red. */
export function attendanceShareColor(percent) {
  if (percent == null || !Number.isFinite(percent)) return null
  if (percent > 45) return ATTENDANCE_GREEN
  if (percent >= 10) return ATTENDANCE_YELLOW
  return ATTENDANCE_RED
}

const COLUMN_SET = new Set(LEADERBOARD_SORT_COLUMNS)

export function normalizeLeaderboardSort(key, dir) {
  return {
    key: COLUMN_SET.has(key) ? key : 'balance',
    dir: dir === 'asc' ? 'asc' : 'desc',
  }
}

/** First click on Account is A–Z. First click on a number column is highest first. Same column flips. */
export function nextLeaderboardSort(currentKey, currentDir, clickedKey) {
  const current = normalizeLeaderboardSort(currentKey, currentDir)
  const nextKey = COLUMN_SET.has(clickedKey) ? clickedKey : current.key
  if (nextKey === current.key) {
    return { key: nextKey, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  }
  return { key: nextKey, dir: nextKey === 'account' ? 'asc' : 'desc' }
}

/** Numbers shown in the table. Full account totals win over the active-raider row. */
export function leaderboardRowMetrics(row, totalsByAccountId) {
  const full = totalsByAccountId?.[row?.account_id]
  const num = (value, fallback) => {
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
  }
  return {
    name: (row?.name || '').trim(),
    balance: full != null ? num(full.balance, 0) : num(row?.balance, 0),
    earned: full != null ? num(full.earned, 0) : num(row?.earned, 0),
    spent: full != null ? num(full.spent, 0) : num(row?.spent, 0),
    earned30: full != null ? num(full.earned_30d, 0) : (row?.earned_30d != null ? Math.round(num(row.earned_30d, 0)) : 0),
    earned60: full != null ? num(full.earned_60d, 0) : (row?.earned_60d != null ? Math.round(num(row.earned_60d, 0)) : 0),
  }
}

function metricValue(metrics, column) {
  if (column === 'account') return metrics.name
  if (column === 'balance') return metrics.balance
  if (column === 'earned') return metrics.earned
  if (column === 'spent') return metrics.spent
  if (column === '30d') return metrics.earned30
  if (column === '60d') return metrics.earned60
  return 0
}

export function compareLeaderboardRows(a, b, column, direction, totalsByAccountId) {
  const { key, dir } = normalizeLeaderboardSort(column, direction)
  const am = leaderboardRowMetrics(a, totalsByAccountId)
  const bm = leaderboardRowMetrics(b, totalsByAccountId)
  const av = metricValue(am, key)
  const bv = metricValue(bm, key)
  let cmp = 0
  if (key === 'account') {
    cmp = String(av).localeCompare(String(bv), undefined, { sensitivity: 'base', numeric: true })
  } else {
    cmp = av - bv
  }
  if (dir === 'desc') cmp = -cmp
  if (cmp === 0 && key !== 'account') {
    cmp = am.name.localeCompare(bm.name, undefined, { sensitivity: 'base' })
  }
  if (cmp === 0) {
    cmp = String(a?.account_id || '').localeCompare(String(b?.account_id || ''))
  }
  return cmp
}
