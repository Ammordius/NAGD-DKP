/** Client-side DKP time series from account activityByRaid + loot rows. */

const MIN_CHAR_SPENT_FOR_CHART = 10
const TOP_CHAR_CHART_COUNT = 5
const DEFAULT_CHART_MONTHS = 12

/** Loot row character key (matches fetchAccountDetail spentByKey). */
export function lootCharacterKey(row) {
  return (
    row.assigned_character_name ||
    row.assigned_char_id ||
    row.character_name ||
    row.char_id ||
    ''
  ).trim()
}

function parseCost(row) {
  const c = parseFloat(row?.cost)
  return Number.isFinite(c) ? c : 0
}

function parseDateIso(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null
  const s = dateStr.trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

/** Raid rows with dates, oldest first. */
export function sortActivityChronological(activityByRaid) {
  return [...(activityByRaid || [])]
    .filter((a) => (a.date || '').trim())
    .sort((a, b) => {
      const d = (a.date || '').localeCompare(b.date || '')
      if (d !== 0) return d
      return String(a.raid_id || '').localeCompare(String(b.raid_id || ''))
    })
}

/** True when this account earned DKP, earned tics, or received loot on this raid. */
export function raidHasAccountActivity(act) {
  return (
    Number(act?.dkpEarned) > 0 ||
    Number(act?.ticEarned) > 0 ||
    (Array.isArray(act?.items) && act.items.length > 0)
  )
}

/** Drop guild-universe absence rows (0 earn, 0 loot) used only for Activity tab. */
export function filterActivityRaids(activityByRaid) {
  return (activityByRaid || []).filter(raidHasAccountActivity)
}

/**
 * Chart X-axis bounds: rolling months clipped to actual account activity span.
 * @param {{ date: string }[]} sortedRaids - chronological activity raids
 * @param {number} months - 0 = all activity dates
 */
export function resolveChartDateBounds(sortedRaids, months) {
  const dates = (sortedRaids || []).map((a) => parseDateIso(a.date)).filter(Boolean)
  if (dates.length === 0) {
    return { start: null, end: null, months: months ?? DEFAULT_CHART_MONTHS }
  }
  const minActivityDate = dates[0]
  const maxActivityDate = dates[dates.length - 1]
  const m = months ?? DEFAULT_CHART_MONTHS
  if (!m || m === 0) {
    return { start: minActivityDate, end: maxActivityDate, months: 0 }
  }
  const endDate = new Date(`${maxActivityDate}T12:00:00`)
  const cutoff = new Date(endDate)
  cutoff.setMonth(cutoff.getMonth() - m)
  const cutoffIso = cutoff.toISOString().slice(0, 10)
  const start = cutoffIso > minActivityDate ? cutoffIso : minActivityDate
  return { start, end: maxActivityDate, months: m }
}

/**
 * Slice cumulative series to [start, end]; anchor at start with last value before window.
 */
export function sliceSeriesToDateWindow(series, start, end, valueKey) {
  if (!series?.length) return []
  if (!start || !end) return [...series]

  const inWindow = []
  let lastBeforeStart = null

  for (const pt of series) {
    const d = parseDateIso(pt.date)
    if (!d) continue
    if (d < start) {
      lastBeforeStart = pt
      continue
    }
    if (d > end) break
    inWindow.push(pt)
  }

  if (inWindow.length === 0) {
    if (lastBeforeStart) {
      return [{ date: start, [valueKey]: Number(lastBeforeStart[valueKey]) || 0 }]
    }
    return []
  }

  const firstDate = parseDateIso(inWindow[0].date)
  if (firstDate && firstDate > start) {
    const anchorVal = lastBeforeStart != null
      ? Number(lastBeforeStart[valueKey]) || 0
      : 0
    return [{ date: start, [valueKey]: anchorVal }, ...inWindow]
  }

  return inWindow
}

/** Per-character invested: keep points only when cumulative value changes (plus first/last). */
export function sparseCharacterSeries(series, valueKey = 'invested') {
  if (!series?.length) return []
  if (series.length <= 2) return [...series]

  const out = [series[0]]
  for (let i = 1; i < series.length - 1; i++) {
    const prev = Number(series[i - 1][valueKey]) || 0
    const cur = Number(series[i][valueKey]) || 0
    if (cur !== prev) out.push(series[i])
  }
  const last = series[series.length - 1]
  if (out[out.length - 1]?.date !== last?.date) out.push(last)
  return out
}

/** Map char_id and name -> canonical series id (char_id preferred). */
export function buildCharacterKeyMap(characters) {
  const byAlias = {}
  const list = []
  for (const c of characters || []) {
    const id = (c.char_id || '').trim()
    const name = (c.name || '').trim()
    const canonical = id || name
    if (!canonical) continue
    list.push({ canonical, id, name, displayName: name || id })
    if (id) byAlias[id] = canonical
    if (name) byAlias[name] = canonical
  }
  return { byAlias, list }
}

function resolveCanonicalKey(rawKey, byAlias) {
  const k = (rawKey || '').trim()
  if (!k) return null
  return byAlias[k] ?? null
}

function lifetimeSpentForCharacter(c, dkpByCharacterKey) {
  const name = c.name || c.char_id
  return Number(
    dkpByCharacterKey?.spent?.[name] ??
      dkpByCharacterKey?.spent?.[c.char_id] ??
      0,
  )
}

/** Top N linked characters with lifetime spent > MIN, by spend desc. */
export function selectTopCharactersForCharts(characterList, dkpByCharacterKey) {
  const withSpent = (characterList || [])
    .map((c) => ({
      canonical: c.canonical,
      displayName: c.displayName,
      lifetimeSpent: lifetimeSpentForCharacter(
        { char_id: c.id || c.canonical, name: c.name },
        dkpByCharacterKey,
      ),
    }))
    .filter((c) => c.lifetimeSpent > MIN_CHAR_SPENT_FOR_CHART)
    .sort((a, b) => b.lifetimeSpent - a.lifetimeSpent)
  return withSpent.slice(0, TOP_CHAR_CHART_COUNT)
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Format YYYY-MM-DD as "Jan 2025" for chart subtitles. */
export function formatChartMonthYear(dateIso) {
  const d = parseDateIso(dateIso)
  if (!d) return ''
  const [y, m] = d.split('-').map(Number)
  return `${MONTH_NAMES[m - 1]} ${y}`
}

/** Activity raids and paid loot rows within chartBounds [start, end]. */
export function countActivityInChartWindow(sortedActivityRaids, chartBounds) {
  const { start, end } = chartBounds || {}
  if (!start || !end) {
    return { raids: 0, lootPurchases: 0, start: null, end: null }
  }
  let raids = 0
  let lootPurchases = 0
  for (const act of sortedActivityRaids || []) {
    const d = parseDateIso(act.date)
    if (!d || d < start || d > end) continue
    raids += 1
    for (const it of act.items || []) {
      if (parseCost(it) > 0) lootPurchases += 1
    }
  }
  return { raids, lootPurchases, start, end }
}

/** Footer line for invested chart: date range, raids, loot purchases. */
export function formatInvestedChartFooter(stats) {
  const { start, end, raids, lootPurchases } = stats || {}
  if (!start || !end) return null
  const range =
    start === end
      ? formatChartMonthYear(start)
      : `${formatChartMonthYear(start)} – ${formatChartMonthYear(end)}`
  const raidLabel = `${raids} raid${raids !== 1 ? 's' : ''}`
  const purchaseLabel = `${lootPurchases} loot purchase${lootPurchases !== 1 ? 's' : ''}`
  return `${range} · ${raidLabel} · ${purchaseLabel}`
}

/**
 * Walk activity raids chronologically; returns bounded chart series.
 * @param {object} [opts]
 * @param {number} [opts.months=12] - rolling window; 0 = all activity dates
 */
export function buildAccountDkpTimeSeries(activityByRaid, characters, dkpByCharacterKey, opts = {}) {
  const months = opts.months ?? DEFAULT_CHART_MONTHS
  const activityRaids = filterActivityRaids(activityByRaid)
  const sorted = sortActivityChronological(activityRaids)
  const { byAlias, list } = buildCharacterKeyMap(characters)
  const chartBounds = resolveChartDateBounds(sorted, months)

  let cumEarned = 0
  let cumSpent = 0
  const netSeriesFull = []
  const investedSeriesFull = []
  const charCum = {}
  for (const { canonical } of list) charCum[canonical] = 0

  const perCharSeries = {}
  const lastCharInvested = {}
  for (const { canonical, displayName } of list) {
    perCharSeries[canonical] = { displayName, series: [] }
    lastCharInvested[canonical] = null
  }

  for (const act of sorted) {
    const date = (act.date || '').slice(0, 10)
    cumEarned += Number(act.dkpEarned) || 0
    for (const it of act.items || []) {
      const cost = parseCost(it)
      cumSpent += cost
      const canonical = resolveCanonicalKey(lootCharacterKey(it), byAlias)
      if (canonical) charCum[canonical] = (charCum[canonical] || 0) + cost
    }
    netSeriesFull.push({ date, net: cumEarned - cumSpent })
    investedSeriesFull.push({ date, invested: cumSpent })
    for (const { canonical } of list) {
      const invested = charCum[canonical] || 0
      if (!perCharSeries[canonical]) continue
      if (lastCharInvested[canonical] !== invested) {
        perCharSeries[canonical].series.push({ date, invested })
        lastCharInvested[canonical] = invested
      }
    }
  }

  const netSeries = sliceSeriesToDateWindow(
    netSeriesFull,
    chartBounds.start,
    chartBounds.end,
    'net',
  )
  const investedSeries = sliceSeriesToDateWindow(
    investedSeriesFull,
    chartBounds.start,
    chartBounds.end,
    'invested',
  )

  const investedWindowStats = countActivityInChartWindow(sorted, chartBounds)

  const topCharacters = selectTopCharactersForCharts(list, dkpByCharacterKey)
  const topCharCharts = topCharacters.map((c) => {
    const raw = perCharSeries[c.canonical]?.series ?? []
    const sparse = sparseCharacterSeries(raw, 'invested')
    let series = sliceSeriesToDateWindow(
      sparse,
      chartBounds.start,
      chartBounds.end,
      'invested',
    )
    if (
      series.length === 0 &&
      chartBounds.start &&
      chartBounds.end
    ) {
      series = [
        { date: chartBounds.start, invested: 0 },
        { date: chartBounds.end, invested: 0 },
      ]
    }
    return {
      canonical: c.canonical,
      displayName: c.displayName,
      lifetimeSpent: c.lifetimeSpent,
      series,
    }
  })

  return {
    hasDatedRaids: sorted.length > 0,
    chartBounds,
    netSeries,
    investedSeries,
    investedWindowStats,
    topCharCharts,
  }
}
