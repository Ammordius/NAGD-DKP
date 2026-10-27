/** Max X-axis date labels on the cumulative DKP chart (fits ~464px plot). */
export const MAX_X_TICKS = 8

/** Plot width matching DkpLineChart: 520 - left(44) - right(12). */
export const CHART_PLOT_WIDTH = 464

/** Min px between adjacent centered "Mon YYYY" labels at fontSize 10. */
export const MIN_TICK_LABEL_PX = 48

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function formatTickLabel(ts) {
  const d = new Date(ts)
  return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`
}

export function monthlyTicks(minTs, maxTs, maxCount = MAX_X_TICKS) {
  if (!Number.isFinite(minTs) || !Number.isFinite(maxTs) || maxTs <= minTs) return []
  const min = new Date(minTs)
  const max = new Date(maxTs)
  const rangeMonths = (max.getFullYear() - min.getFullYear()) * 12 + (max.getMonth() - min.getMonth())
  const step = Math.max(1, Math.ceil((rangeMonths + 1) / maxCount))
  const ticks = []
  let y = min.getFullYear()
  let m = min.getMonth()
  const seen = new Set()
  for (;;) {
    const d = new Date(y, m, 1)
    const ts = d.getTime()
    if (ts > maxTs) break
    if (ts >= minTs) {
      const label = formatTickLabel(ts)
      if (!seen.has(label)) {
        seen.add(label)
        ticks.push({ ts, label })
      }
    }
    m += step
    while (m >= 12) { m -= 12; y += 1 }
    if (y > max.getFullYear() + 1) break
  }
  if (ticks.length === 0) ticks.push({ ts: minTs, label: formatTickLabel(minTs) })
  return ticks
}

export function quarterlyTicks(minTs, maxTs) {
  return monthlyTicks(minTs, maxTs, 8).filter((_, i, arr) => {
    if (arr.length <= 6) return true
    return i % 2 === 0 || i === arr.length - 1
  })
}

/**
 * Adaptive X ticks from span: monthly (≤90d), quarterly (≤2y),
 * else capped monthly so multi-year "All activity" labels do not overlap.
 */
export function adaptiveDateTicks(minTs, maxTs) {
  if (!Number.isFinite(minTs) || !Number.isFinite(maxTs) || maxTs <= minTs) return []
  const dayMs = 86400000
  const rangeDays = (maxTs - minTs) / dayMs
  if (rangeDays <= 90) return monthlyTicks(minTs, maxTs, 6)
  if (rangeDays <= 730) return quarterlyTicks(minTs, maxTs)
  return monthlyTicks(minTs, maxTs, MAX_X_TICKS)
}

/** Linear X positions for ticks over CHART_PLOT_WIDTH (acceptance helper). */
export function tickXsOnPlot(ticks, minTs, maxTs, plotWidth = CHART_PLOT_WIDTH) {
  const timeRange = maxTs - minTs || 1
  return ticks.map(({ ts }) => ((ts - minTs) / timeRange) * plotWidth)
}
