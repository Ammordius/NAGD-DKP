/**
 * Resolve raid loot rows to a display mob/source using raid_item_sources.json (by item_id)
 * and dkp_mob_loot.json (name fallback). Used only for display grouping under each DKP event.
 */

/** @param {string|null|undefined} raw */
export function formatMobSourceLabel(raw) {
  if (raw == null || typeof raw !== 'string') return ''
  let s = raw.trim()
  if (s.startsWith('#')) s = s.slice(1)
  s = s.replace(/_/g, ' ').trim()
  return s
}

/**
 * item name (lowercase) -> item_id from dkp_mob_loot values (first occurrence wins).
 * @param {object|null|undefined} mobLoot
 * @returns {Record<string, number|string>}
 */
export function buildItemNameToIdMap(mobLoot) {
  const map = {}
  if (!mobLoot || typeof mobLoot !== 'object') return map
  for (const entry of Object.values(mobLoot)) {
    for (const item of entry?.loot || []) {
      if (item?.name == null || item?.item_id == null) continue
      const key = String(item.name).trim().toLowerCase()
      if (!key || map[key] != null) continue
      map[key] = item.item_id
    }
  }
  return map
}

/**
 * @param {object|null|undefined} mobLoot
 * @param {object|null|undefined} raidItemSources
 * @returns {{ itemIdToMobLabel: Record<string, string>, nameToMobLabel: Record<string, string> }|null}
 */
export function buildLootMobLookups(mobLoot, raidItemSources) {
  if (mobLoot == null && raidItemSources == null) return null

  const itemIdToMobLabel = {}
  if (raidItemSources && typeof raidItemSources === 'object') {
    for (const [id, row] of Object.entries(raidItemSources)) {
      if (row?.mob) {
        const label = formatMobSourceLabel(row.mob)
        if (label) itemIdToMobLabel[String(id)] = label
      }
    }
  }

  const nameToMobLabel = {}
  if (mobLoot && typeof mobLoot === 'object') {
    for (const entry of Object.values(mobLoot)) {
      const rawMob = entry?.mob || (Array.isArray(entry?.mobs) ? entry.mobs[0] : null)
      const mobLabel = formatMobSourceLabel(rawMob)
      if (!mobLabel) continue
      for (const it of entry?.loot || []) {
        const name = String(it?.name ?? '').trim().toLowerCase()
        if (!name || nameToMobLabel[name] != null) continue
        nameToMobLabel[name] = mobLabel
      }
    }
  }

  return { itemIdToMobLabel, nameToMobLabel }
}

/**
 * @param {{ item_name?: string|null }} row
 * @param {Record<string, number|string>} itemNameToId
 * @param {{ itemIdToMobLabel: Record<string, string>, nameToMobLabel: Record<string, string> }} lookups
 * @returns {string|null}
 */
export function resolveRowMobLabel(row, itemNameToId, lookups) {
  if (!lookups) return null
  const nameKey = String(row?.item_name ?? '').trim().toLowerCase()
  if (!nameKey) return null
  const itemId = itemNameToId[nameKey]
  if (itemId != null) {
    const byId = lookups.itemIdToMobLabel[String(itemId)]
    if (byId) return byId
  }
  return lookups.nameToMobLabel[nameKey] ?? null
}

const sortRowsById = (rows) =>
  [...rows].sort((a, b) => {
    const na = Number(a?.id)
    const nb = Number(b?.id)
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
    return String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
  })

/**
 * @param {Array<object>} rows
 * @param {Record<string, number|string>} itemNameToId
 * @param {ReturnType<typeof buildLootMobLookups>} lookups
 * @returns {Array<{ key: string, title: string|null, rows: typeof rows }>}
 */
export function subgroupLootRowsByMob(rows, itemNameToId, lookups) {
  if (!rows?.length) return []
  if (!lookups) {
    return [{ key: '_flat', title: null, rows: sortRowsById(rows) }]
  }

  // Same item name can appear on multiple mobs in dkp_mob_loot (first key wins in lookups).
  // Within one event, reuse the mob from the first line for that item so duplicates stay grouped.
  const sorted = sortRowsById(rows)
  const firstMobByItemName = new Map()
  const byMob = new Map()
  for (const row of sorted) {
    const nameKey = String(row?.item_name ?? '').trim().toLowerCase()
    let label = resolveRowMobLabel(row, itemNameToId, lookups)
    if (nameKey) {
      if (firstMobByItemName.has(nameKey)) {
        label = firstMobByItemName.get(nameKey)
      } else {
        firstMobByItemName.set(nameKey, label)
      }
    }
    const gkey = label ?? '__unknown__'
    if (!byMob.has(gkey)) byMob.set(gkey, { label, list: [] })
    byMob.get(gkey).list.push(row)
  }

  const entries = [...byMob.entries()]
  entries.sort((a, b) => {
    if (a[0] === '__unknown__') return 1
    if (b[0] === '__unknown__') return -1
    return String(a[1].label).localeCompare(String(b[1].label))
  })

  return entries.map(([key, { label, list }]) => ({
    key,
    title: label ?? 'Other / unknown mob',
    rows: list,
  }))
}
