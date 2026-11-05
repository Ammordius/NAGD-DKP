/**
 * Execute a QueryPlan against Supabase with narrow, parameterized reads.
 * Module-level TTL cache (SWR-compatible key) — no per-message rebuild of indexes.
 *
 * Zone / phase / boss raid nights: join static item_sources (item→mob/zone) to
 * raid_loot_history. Does not query raid_classifications.
 *
 * Benchmark note: item award paths use idx_raid_loot_item_name_trgm + idx_raid_loot_raid.
 */

import { discoverySwrKey, DISCOVERY_DEDUPING_MS, fingerprintQuery } from './cacheKey.js'
import { LOOT_SELECT, RAID_LOOT_SELECT } from './queryPlan.js'
import {
  preferAuthoritativeSource,
  itemNamesForPhaseMobs,
  itemNamesForZone,
  itemNamesForBoss,
  P3_MOBS,
  SLOT_NAME_FALLBACK_PATTERNS,
  normAliasKey,
  isPhaseMob,
} from './aliases.js'
import { authoritativeItemSource } from './resolve.js'

/** @type {Map<string, { at: number, data: import('./types.js').DiscoveryResult }>} */
const memoryCache = new Map()

/**
 * @param {string} value
 */
export function escapeIlike(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/**
 * Clear in-memory discovery cache (tests).
 */
export function resetDiscoveryCache() {
  memoryCache.clear()
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 * @param {import('./types.js').QueryPlan} plan
 * @param {{
 *   knownItemSources?: Record<string, object>,
 *   itemStats?: Record<string, { name?: string, slot?: string, classes?: string }>,
 *   resolved?: import('./resolve.js').ResolvedDiscovery|null,
 *   skipCache?: boolean,
 * }} [opts]
 * @returns {Promise<import('./types.js').DiscoveryResult>}
 */
export async function executeDiscovery(client, plan, opts = {}) {
  const query = plan.query
  const key = fingerprintQuery(query)
  if (!opts.skipCache) {
    const hit = memoryCache.get(key)
    if (hit && Date.now() - hit.at < DISCOVERY_DEDUPING_MS) {
      return hit.data
    }
  }

  if (opts.resolved?.itemAmbiguous) {
    const result = {
      ok: false,
      family: query.family,
      query,
      ambiguous: {
        kind: 'item',
        candidates: opts.resolved.itemAmbiguous.candidates.map((c) => c.name),
        message: opts.resolved.itemAmbiguous.message,
      },
      gaps: opts.resolved.gaps || [],
      notes: plan.notes || [],
      awards: [],
    }
    cachePut(key, result)
    return result
  }

  /** @type {import('./types.js').DiscoveryResult} */
  const result = {
    ok: true,
    family: query.family,
    query,
    raid: null,
    awards: [],
    totalCount: null,
    truncated: false,
    catalogItems: [],
    // Methodology notes stay in `notes`; `gaps` is only for missing-data / failure messages.
    gaps: [...(opts.resolved?.gaps || [])],
    notes: [...(plan.notes || [])],
    ambiguous: null,
    error: null,
  }

  /** @type {{ raidId: string, raidName?: string|null, dateIso?: string|null }|null} */
  let currentRaid = null
  const known = opts.knownItemSources || {}
  const itemStats = opts.itemStats || {}
  const phaseNames = opts.resolved?.phaseItemNames || itemNamesForPhaseMobs(known, P3_MOBS)

  try {
    for (const step of plan.ops) {
      if (step.op === 'noop') continue

      if (step.op === 'catalog_boss_drops') {
        result.catalogItems = catalogBossDrops(known, step.params.boss, step.params.limit || 40)
        if (!result.catalogItems.length) {
          result.gaps.push(
            `No authoritative item_sources entries for boss "${step.params.boss}". Catalog answer unavailable without guessing from conflicting mob-loot tables.`,
          )
        }
        continue
      }

      if (step.op === 'latest_raid_by_catalog') {
        const catalogNames = resolveCatalogItemNames(known, step.params, phaseNames)
        currentRaid = await fetchLatestRaidByItemNames(client, catalogNames)
        result.raid = currentRaid
        if (!currentRaid) {
          const label =
            step.params.match === 'phase'
              ? step.params.phase || 'phase'
              : step.params.match === 'boss'
                ? prettyMob(step.params.boss)
                : step.params.zone || 'catalog'
          result.gaps.push(
            catalogNames.size
              ? `No recorded awards found for the ${catalogNames.size} catalog item(s) matching ${label}.`
              : `No catalog items mapped to ${label} in item_sources.`,
          )
        }
        continue
      }

      if (step.op === 'loot_for_raid') {
        if (!currentRaid?.raidId) {
          result.awards = []
          continue
        }
        let awards = await fetchLootForRaid(client, currentRaid.raidId, step.params.select || RAID_LOOT_SELECT)
        awards = awards.map((a) => enrichAward(a, currentRaid, known))

        if (step.params.filterPhaseMobs?.length) {
          const want = new Set(
            [...phaseNames].map((n) => normAliasKey(n)),
          )
          // Also include items whose authoritative source mob is in filterPhaseMobs
          const mobWant = new Set(step.params.filterPhaseMobs.map((m) => normAliasKey(m)))
          awards = awards.filter((a) => {
            if (want.has(normAliasKey(a.itemName))) return true
            const auth = authoritativeItemSource(known, a.itemName)
            return auth?.mob && mobWant.has(normAliasKey(auth.mob))
          })
          result.notes = [
            ...(result.notes || []),
            'Showing identifiable phase-labeled awards only for this raid night.',
          ]
        }

        if (step.params.filterBoss) {
          const bossKey = normAliasKey(String(step.params.filterBoss).replace(/_/g, ' '))
          const filtered = awards.filter((a) => {
            const auth = authoritativeItemSource(known, a.itemName)
            if (!auth?.mob) return false
            if (auth.ambiguousBoss) return false
            return normAliasKey(String(auth.mob).replace(/_/g, ' ')) === bossKey
          })
          // If classification selected the raid but item filter empties everything,
          // keep awards but mark boss attribution unqualified
          if (filtered.length) {
            awards = filtered.map((a) => ({ ...a, bossQualified: true, bossMob: step.params.filterBoss }))
          } else {
            awards = awards.map((a) => ({
              ...a,
              bossQualified: false,
              bossMob: null,
            }))
            result.notes = [
              ...(result.notes || []),
              'Raid night chosen via boss-labeled catalog items; item→boss attribution was ambiguous for other awards on that night, so boss claims are omitted for them.',
            ]
          }
        }

        if (step.params.filterSlot) {
          const before = awards.length
          awards = filterAwardsBySlot(awards, step.params.filterSlot, itemStats)
          if (before && !awards.length) {
            result.notes = [
              ...(result.notes || []),
              `No ${String(step.params.filterSlot).toLowerCase()} awards on this raid night (slot filter applied).`,
            ]
          }
        }

        const limit = step.params.limit || 40
        result.truncated = awards.length > limit
        result.totalCount = awards.length
        result.awards = awards.slice(0, limit)
        continue
      }

      if (step.op === 'awards_for_item') {
        const { rows, truncated } = await fetchAwardsForItem(client, step.params)
        result.awards = rows.map((a) => enrichAward(a, null, known))
        result.truncated = truncated
        if (step.params.character) {
          const want = normAliasKey(step.params.character)
          result.awards = result.awards.filter(
            (a) =>
              normAliasKey(a.characterName) === want ||
              normAliasKey(a.assignedCharacterName) === want,
          )
        }
        continue
      }

      if (step.op === 'count_awards_for_item') {
        result.totalCount = await countAwardsForItem(client, step.params)
        continue
      }

      if (step.op === 'awards_for_character') {
        const { rows, truncated } = await fetchAwardsForCharacter(client, step.params)
        result.awards = rows.map((a) => enrichAward(a, null, known))
        result.truncated = truncated
        result.totalCount = rows.length
        continue
      }

      if (step.op === 'awards_for_catalog_window') {
        let catalogNames = resolveCatalogItemNames(known, step.params, phaseNames)
        if (step.params.filterSlot) {
          catalogNames = filterItemNamesBySlot(catalogNames, step.params.filterSlot, itemStats)
        }
        const packed = await fetchAwardsForItemNamesWindow(client, {
          itemNames: catalogNames,
          fromIso: step.params.fromIso,
          toIso: step.params.toIso,
          select: step.params.select || LOOT_SELECT,
          limit: step.params.limit || 40,
        })
        result.awards = packed.rows.map((a) => enrichAward(a, null, known))
        result.truncated = packed.truncated
        result.totalCount = packed.rows.length
        if (!catalogNames.size) {
          result.gaps.push(
            step.params.filterSlot
              ? `No catalog items mapped for that zone/phase filter in slot ${step.params.filterSlot}.`
              : 'No catalog items mapped for that zone/phase filter.',
          )
        }
        continue
      }
    }
  } catch (err) {
    result.ok = false
    result.error = err?.message || String(err)
  }

  cachePut(key, result)
  return result
}

/**
 * SWR key helper for UI wiring.
 * @param {import('./types.js').StructuredQuery} query
 */
export function getDiscoveryCacheKey(query) {
  return discoverySwrKey(query)
}

function cachePut(key, data) {
  memoryCache.set(key, { at: Date.now(), data })
}

/**
 * @param {object} row
 * @param {{ raidId: string, raidName?: string|null, dateIso?: string|null }|null} raid
 * @param {Record<string, object>} known
 * @returns {import('./types.js').LedgerAward}
 */
function enrichAward(row, raid, known) {
  const itemName = row.item_name || row.itemName || ''
  const auth = authoritativeItemSource(known, itemName)
  const phaseMob = auth?.mob && isPhaseMob(auth.mob) ? auth.mob : null
  return {
    id: row.id ?? null,
    raidId: String(row.raid_id || raid?.raidId || ''),
    raidName: row.raid_name || raid?.raidName || null,
    dateIso: row.date_iso || raid?.dateIso || null,
    itemName,
    characterName: row.character_name || null,
    charId: row.char_id || null,
    assignedCharacterName: row.assigned_character_name || null,
    cost: row.cost ?? null,
    phaseMob,
    bossMob: auth && !auth.ambiguousBoss ? auth.mob || null : null,
    bossQualified: Boolean(auth && !auth.ambiguousBoss && auth.mob),
  }
}

/**
 * @param {Record<string, object>} known
 * @param {string} boss
 * @param {number} limit
 */
function catalogBossDrops(known, boss, limit) {
  if (!boss) return []
  const bossKey = normAliasKey(String(boss).replace(/_/g, ' '))
  /** @type {Array<{ name: string, itemId?: string|number|null }>} */
  const out = []
  for (const entry of Object.values(known || {})) {
    const auth = preferAuthoritativeSource(entry.sources || [])
    if (!auth?.mob) continue
    if (normAliasKey(String(auth.mob).replace(/_/g, ' ')) !== bossKey) continue
    out.push({ name: entry.displayName, itemId: entry.itemId ?? null })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out.slice(0, limit)
}

/**
 * @param {import('./types.js').LedgerAward[]} awards
 * @param {string} slot
 * @param {Record<string, { name?: string, slot?: string }>} itemStats
 */
function filterAwardsBySlot(awards, slot, itemStats) {
  const want = String(slot || '').toUpperCase()
  if (!want) return awards
  const byName = slotItemNameSet(want, itemStats)
  const namePat = SLOT_NAME_FALLBACK_PATTERNS[want]
  return awards.filter((a) => {
    const key = normAliasKey(a.itemName)
    if (byName.has(key)) return true
    if (!byName.size && namePat && namePat.test(String(a.itemName || ''))) return true
    return false
  })
}

/**
 * @param {Set<string>} names
 * @param {string} slot
 * @param {Record<string, { name?: string, slot?: string }>} itemStats
 * @returns {Set<string>}
 */
function filterItemNamesBySlot(names, slot, itemStats) {
  const want = String(slot || '').toUpperCase()
  if (!want || !names?.size) return names || new Set()
  const byName = slotItemNameSet(want, itemStats)
  const namePat = SLOT_NAME_FALLBACK_PATTERNS[want]
  /** @type {Set<string>} */
  const out = new Set()
  for (const name of names) {
    const key = normAliasKey(name)
    if (byName.has(key)) {
      out.add(name)
      continue
    }
    if (!byName.size && namePat && namePat.test(String(name || ''))) out.add(name)
  }
  return out
}

/**
 * @param {string} slotWant
 * @param {Record<string, { name?: string, slot?: string }>} itemStats
 * @returns {Set<string>} normalized item name keys
 */
function slotItemNameSet(slotWant, itemStats) {
  /** @type {Set<string>} */
  const out = new Set()
  for (const row of Object.values(itemStats || {})) {
    if (!row?.name) continue
    const have = String(row.slot || '').toUpperCase()
    if (!have) continue
    const match =
      have === slotWant ||
      (slotWant === 'SHOULDERS' && (have === 'SHOULDER' || have === 'SHOULDERS')) ||
      (slotWant === 'FINGER' && (have === 'FINGER' || have === 'FINGERS' || have === 'RING')) ||
      (slotWant === 'WRIST' && (have === 'WRIST' || have === 'WRISTS' || have === 'BRACER'))
    if (match) out.add(normAliasKey(row.name))
  }
  return out
}

/**
 * Resolve catalog item names for a zone / phase / boss match (static join keys).
 * @param {Record<string, object>} known
 * @param {object} params
 * @param {Set<string>} phaseNames
 * @returns {Set<string>}
 */
function resolveCatalogItemNames(known, params, phaseNames) {
  if (params.match === 'phase' || params.mobs?.length) {
    if (phaseNames?.size) return phaseNames
    return itemNamesForPhaseMobs(known, params.mobs || P3_MOBS)
  }
  if (params.match === 'boss' || params.boss) {
    return itemNamesForBoss(known, params.boss)
  }
  if (params.zone) return itemNamesForZone(known, params.zone)
  return new Set()
}

/**
 * Most recent raid that awarded any of the catalog item names.
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 * @param {Set<string>|string[]} itemNames
 * @returns {Promise<{ raidId: string, raidName?: string|null, dateIso?: string|null }|null>}
 */
async function fetchLatestRaidByItemNames(client, itemNames) {
  const names = [...(itemNames || [])].map((n) => String(n || '').trim()).filter(Boolean)
  if (!names.length) return null

  const samples = await Promise.all(
    names.map(async (name) => {
      const { data, error } = await client
        .from('raid_loot_history')
        .select('raid_id, raid_name, date_iso, item_name')
        .ilike('item_name', escapeIlike(name))
        .order('date_iso', { ascending: false, nullsFirst: false })
        .order('id', { ascending: false })
        .limit(1)
      if (error) throw new Error(error.message)
      return data?.[0] || null
    }),
  )

  /** @type {Array<{ raid_id: string, raid_name?: string, date_iso?: string }>} */
  const hits = samples.filter(Boolean)
  if (!hits.length) return null

  hits.sort((a, b) => String(b.date_iso || '').localeCompare(String(a.date_iso || '')))
  const top = hits[0]
  return {
    raidId: String(top.raid_id),
    raidName: top.raid_name || null,
    dateIso: top.date_iso || null,
  }
}

/**
 * Awards in a date window for any of the catalog item names.
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 * @param {{
 *   itemNames: Set<string>|string[],
 *   fromIso?: string|null,
 *   toIso?: string|null,
 *   select?: string,
 *   limit?: number,
 * }} params
 */
async function fetchAwardsForItemNamesWindow(client, params) {
  const names = [...(params.itemNames || [])].map((n) => String(n || '').trim()).filter(Boolean)
  const limit = params.limit || 40
  if (!names.length) return { rows: [], truncated: false }

  const batches = await Promise.all(
    names.map(async (name) => {
      let q = client
        .from('raid_loot_history')
        .select(params.select || LOOT_SELECT)
        .ilike('item_name', escapeIlike(name))
        .order('date_iso', { ascending: false, nullsFirst: false })
        .limit(limit)
      if (params.fromIso) q = q.gte('date_iso', params.fromIso)
      if (params.toIso) q = q.lte('date_iso', params.toIso)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return data || []
    }),
  )

  /** @type {object[]} */
  const merged = []
  const seen = new Set()
  for (const rows of batches) {
    for (const row of rows) {
      const key = row.id != null ? `id:${row.id}` : `${row.raid_id}|${row.item_name}|${row.character_name}|${row.date_iso}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(row)
    }
  }
  merged.sort((a, b) => String(b.date_iso || '').localeCompare(String(a.date_iso || '')))
  return { rows: merged.slice(0, limit), truncated: merged.length > limit }
}

function prettyMob(boss) {
  return String(boss || '').replace(/_/g, ' ') || 'boss'
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 * @param {string} raidId
 * @param {string} select
 */
async function fetchLootForRaid(client, raidId, select) {
  const { data, error } = await client
    .from('raid_loot_with_assignment')
    .select(select || RAID_LOOT_SELECT)
    .eq('raid_id', raidId)
    .limit(500)
  if (error) throw new Error(error.message)
  return data || []
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 * @param {object} params
 */
async function fetchAwardsForItem(client, params) {
  if (!params.itemName) return { rows: [], truncated: false }
  const limit = params.limit || 10
  let q = client
    .from('raid_loot_history')
    .select(params.select || LOOT_SELECT)
    .ilike('item_name', escapeIlike(params.itemName))
    .order('date_iso', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .limit(limit + 1)
  if (params.fromIso) q = q.gte('date_iso', params.fromIso)
  if (params.toIso) q = q.lte('date_iso', params.toIso)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  const rows = data || []
  return { rows: rows.slice(0, limit), truncated: rows.length > limit }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 * @param {object} params
 */
async function countAwardsForItem(client, params) {
  if (!params.itemName) return 0
  let q = client
    .from('raid_loot')
    .select('id', { count: 'exact', head: true })
    .ilike('item_name', escapeIlike(params.itemName))
  if (params.fromIso) q = q.gte('date_iso', params.fromIso)
  // date_iso is on raids, not raid_loot — for count use history view when date filtered
  if (params.fromIso || params.toIso) {
    let hq = client
      .from('raid_loot_history')
      .select('id', { count: 'exact', head: true })
      .ilike('item_name', escapeIlike(params.itemName))
    if (params.fromIso) hq = hq.gte('date_iso', params.fromIso)
    if (params.toIso) hq = hq.lte('date_iso', params.toIso)
    const { count, error } = await hq
    if (error) throw new Error(error.message)
    return count ?? 0
  }
  const { count, error } = await q
  if (error) throw new Error(error.message)
  return count ?? 0
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 * @param {object} params
 */
async function fetchAwardsForCharacter(client, params) {
  if (!params.character) return { rows: [], truncated: false }
  const limit = params.limit || 40
  let q = client
    .from('raid_loot_history')
    .select(params.select || LOOT_SELECT)
    .ilike('character_name', escapeIlike(params.character))
    .order('date_iso', { ascending: false, nullsFirst: false })
    .limit(limit + 1)
  if (params.fromIso) q = q.gte('date_iso', params.fromIso)
  if (params.toIso) q = q.lte('date_iso', params.toIso)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  const rows = data || []
  return { rows: rows.slice(0, limit), truncated: rows.length > limit }
}

