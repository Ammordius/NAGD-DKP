/**
 * Unified item → mob/zone lookup from item_sources, dkp_mob_loot, and raid_item_sources.
 * Pure merge helpers for RoastBot upgrade cards and conversational drop answers.
 */

/**
 * @typedef {{ mob?: string, zone?: string }} SourcePair
 * @typedef {{
 *   displayName: string,
 *   mob?: string,
 *   zone?: string,
 *   itemId?: number|string|null,
 *   sources: SourcePair[],
 * }} KnownItemSource
 */

/**
 * @param {string|null|undefined} name
 */
function normKey(name) {
  return String(name || '').trim().toLowerCase()
}

/**
 * @param {string|null|undefined} s
 */
function cleanStr(s) {
  const t = String(s || '').trim()
  return t || ''
}

/**
 * @param {string} mob
 * @param {string} zone
 */
function sourceKey(mob, zone) {
  return `${normKey(mob)}|${normKey(zone)}`
}

/**
 * Prefer sources with a populated zone; drop empty-zone twins of the same mob.
 * @param {SourcePair[]} sources
 * @returns {SourcePair[]}
 */
export function dedupePreferZone(sources) {
  /** @type {Map<string, SourcePair>} */
  const byKey = new Map()
  for (const row of sources || []) {
    const mob = cleanStr(row?.mob)
    const zone = cleanStr(row?.zone)
    if (!mob && !zone) continue
    const key = sourceKey(mob, zone)
    if (!byKey.has(key)) byKey.set(key, { mob: mob || undefined, zone: zone || undefined })
  }

  const list = [...byKey.values()]
  const mobsWithZone = new Set(list.filter((s) => s.zone).map((s) => normKey(s.mob)))
  const filtered = list.filter((s) => {
    if (s.zone) return true
    // Drop empty-zone duplicate when same mob has a populated zone
    return !mobsWithZone.has(normKey(s.mob))
  })

  filtered.sort((a, b) => {
    const az = a.zone ? 1 : 0
    const bz = b.zone ? 1 : 0
    if (bz !== az) return bz - az
    return `${a.mob || ''}|${a.zone || ''}`.localeCompare(`${b.mob || ''}|${b.zone || ''}`)
  })
  return filtered
}

/**
 * @param {Record<string, KnownItemSource>} out
 * @param {string} name
 * @param {string} [mob]
 * @param {string} [zone]
 * @param {number|string|null} [itemId]
 */
function addSource(out, name, mob, zone, itemId = null) {
  const key = normKey(name)
  if (!key) return
  const displayName = cleanStr(name) || key
  if (!out[key]) {
    out[key] = { displayName, sources: [], itemId: itemId ?? null }
  } else {
    // Prefer casing from a proper name field over a lowercased key
    if (displayName !== key && (out[key].displayName === key || !out[key].displayName)) {
      out[key].displayName = displayName
    }
    if (out[key].itemId == null && itemId != null) out[key].itemId = itemId
  }
  const m = cleanStr(mob)
  const z = cleanStr(zone)
  if (!m && !z) return
  out[key].sources.push({ mob: m || undefined, zone: z || undefined })
}

/**
 * Parse mob from dkp_mob_loot map key like "Quarm|Plane of Time".
 * @param {string} mapKey
 * @param {object} entry
 */
function mobFromEntry(mapKey, entry) {
  const fromEntry = cleanStr(entry?.mob)
  if (fromEntry) return fromEntry
  const key = String(mapKey || '')
  const pipe = key.indexOf('|')
  if (pipe >= 0) return cleanStr(key.slice(0, pipe))
  return cleanStr(key)
}

/**
 * Build unified known-item sources map.
 * @param {{
 *   itemSources?: object|null,
 *   mobLoot?: object|null,
 *   raidItemSources?: object|null,
 * }} [input]
 * @returns {Record<string, KnownItemSource>}
 */
export function buildKnownItemSources(input = {}) {
  /** @type {Record<string, KnownItemSource>} */
  const out = {}
  const { itemSources, mobLoot, raidItemSources } = input

  if (itemSources && typeof itemSources === 'object') {
    for (const [name, info] of Object.entries(itemSources)) {
      if (Array.isArray(info)) {
        for (const row of info) {
          addSource(out, name, row?.mob || row?.npc, row?.zone || row?.raid || row?.source)
        }
      } else if (info && typeof info === 'object') {
        addSource(out, name, info.mob || info.npc, info.zone || info.raid || info.source)
      }
    }
  }

  if (mobLoot && typeof mobLoot === 'object') {
    for (const [mapKey, entry] of Object.entries(mobLoot)) {
      if (!entry || typeof entry !== 'object') continue
      // Live shape uses `.loot`; ignore mistaken `.items` only blobs
      const list = Array.isArray(entry.loot) ? entry.loot : []
      const mob = mobFromEntry(mapKey, entry)
      const zone = cleanStr(entry.zone)
      for (const it of list) {
        const name = typeof it === 'string' ? it : it?.name || it?.item_name
        const itemId = typeof it === 'object' ? it?.item_id ?? it?.itemId ?? null : null
        addSource(out, name, mob, zone, itemId)
      }
    }
  }

  if (raidItemSources && typeof raidItemSources === 'object') {
    for (const [id, info] of Object.entries(raidItemSources)) {
      if (!info || typeof info !== 'object') continue
      const name = info.name
      if (!name || /^\(item\s+\d+\)$/i.test(String(name).trim())) continue
      addSource(out, name, info.mob, info.zone, info.item_id ?? info.itemId ?? id)
    }
  }

  for (const entry of Object.values(out)) {
    entry.sources = dedupePreferZone(entry.sources)
    const preferred = entry.sources[0]
    entry.mob = preferred?.mob
    entry.zone = preferred?.zone
  }

  return out
}

/**
 * @param {Record<string, KnownItemSource>|null|undefined} knownItemSources
 * @param {string|null|undefined} itemName
 * @returns {KnownItemSource|null}
 */
export function lookupItemSource(knownItemSources, itemName) {
  if (!itemName || !knownItemSources) return null
  return knownItemSources[normKey(itemName)] || null
}

/**
 * Catalog entries for name matching (display casing + optional itemId).
 * @param {Record<string, KnownItemSource>|null|undefined} knownItemSources
 * @returns {Array<{ name: string, itemId?: number|string|null }>}
 */
export function catalogEntriesFromKnownSources(knownItemSources) {
  const out = []
  for (const entry of Object.values(knownItemSources || {})) {
    if (!entry?.displayName) continue
    out.push({ name: entry.displayName, itemId: entry.itemId ?? null })
  }
  return out
}
