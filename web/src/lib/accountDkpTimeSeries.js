/** Client-side DKP time series from account activityByRaid + loot rows. */

const MIN_CHAR_SPENT_FOR_CHART = 10
const TOP_CHAR_CHART_COUNT = 5

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

/**
 * Walk raids chronologically; returns netSeries, investedSeries, topCharCharts.
 */
export function buildAccountDkpTimeSeries(activityByRaid, characters, dkpByCharacterKey) {
  const sorted = sortActivityChronological(activityByRaid)
  const { byAlias, list } = buildCharacterKeyMap(characters)

  let cumEarned = 0
  let cumSpent = 0
  const netSeries = []
  const investedSeries = []
  const charCum = {}
  for (const { canonical } of list) charCum[canonical] = 0

  const perCharSeries = {}
  for (const { canonical, displayName } of list) {
    perCharSeries[canonical] = { displayName, series: [] }
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
    netSeries.push({ date, net: cumEarned - cumSpent })
    investedSeries.push({ date, invested: cumSpent })
    for (const { canonical } of list) {
      const invested = charCum[canonical] || 0
      if (perCharSeries[canonical]) {
        perCharSeries[canonical].series.push({ date, invested })
      }
    }
  }

  const topCharacters = selectTopCharactersForCharts(list, dkpByCharacterKey)
  const topCharCharts = topCharacters.map((c) => ({
    canonical: c.canonical,
    displayName: c.displayName,
    lifetimeSpent: c.lifetimeSpent,
    series: perCharSeries[c.canonical]?.series ?? [],
  }))

  return {
    hasDatedRaids: sorted.length > 0,
    netSeries,
    investedSeries,
    topCharCharts,
  }
}
