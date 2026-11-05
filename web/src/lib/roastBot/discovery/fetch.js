/**
 * Execute a QueryPlan against Supabase with narrow, parameterized reads.
 * Module-level TTL cache (SWR-compatible key) — no per-message rebuild of indexes.
 *
 * Benchmark note (indexes deferred): existing idx_raid_loot_raid, idx_raid_loot_item_name_trgm,
 * idx_raids_date_iso, and idx_raid_classifications_mob cover the primary paths. Zone filters
 * currently scan raid_classifications by zone without a dedicated index; add
 * idx_raid_classifications_zone only if measured latency exceeds ~500ms on production-sized data.
 */

import { discoverySwrKey, DISCOVERY_DEDUPING_MS, fingerprintQuery } from './cacheKey.js'
import { LOOT_SELECT, RAID_LOOT_SELECT } from './queryPlan.js'
import {
  preferAuthoritativeSource,
  itemNamesForPhaseMobs,
  P3_MOBS,
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
    gaps: [...(plan.notes || []), ...(opts.resolved?.gaps || [])],
    notes: plan.notes || [],
    ambiguous: null,
    error: null,
  }

  /** @type {{ raidId: string, raidName?: string|null, dateIso?: string|null }|null} */
  let currentRaid = null
  const known = opts.knownItemSources || {}
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

      if (step.op === 'latest_raid_by_zone') {
        currentRaid = await fetchLatestRaidByZone(client, step.params.zone)
        result.raid = currentRaid
        if (!currentRaid) {
          result.gaps.push(`No classified raids found for zone "${step.params.zone}".`)
        }
        continue
      }

      if (step.op === 'latest_raid_by_mobs') {
        currentRaid = await fetchLatestRaidByMobs(client, step.params.mobs, step.params.zone)
        result.raid = currentRaid
        if (!currentRaid) {
          result.gaps.push(
            `No raid_classifications rows for mob(s) ${(step.params.mobs || []).join(', ')}.`,
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
              'Raid was selected via raid_classifications; item→boss attribution was ambiguous for awards, so boss claims are omitted.',
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

      if (step.op === 'awards_in_zone_window') {
        const packed = await fetchAwardsInZoneWindow(client, step.params, known, phaseNames)
        result.awards = packed.rows
        result.truncated = packed.truncated
        result.totalCount = packed.rows.length
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
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 * @param {string} zone
 */
async function fetchLatestRaidByZone(client, zone) {
  const { data: classRows, error } = await client
    .from('raid_classifications')
    .select('raid_id')
    .eq('zone', zone)
    .limit(2000)
  if (error) throw new Error(error.message)
  const ids = uniqueIds(classRows)
  if (!ids.length) return null
  return fetchLatestRaidAmong(client, ids)
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 * @param {string[]} mobs
 * @param {string|null} zone
 */
async function fetchLatestRaidByMobs(client, mobs, zone) {
  if (!mobs?.length) return null
  let q = client.from('raid_classifications').select('raid_id, mob, zone').in('mob', mobs).limit(2000)
  if (zone) q = q.eq('zone', zone)
  const { data: classRows, error } = await q
  if (error) throw new Error(error.message)
  const ids = uniqueIds(classRows)
  if (!ids.length) return null
  return fetchLatestRaidAmong(client, ids)
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 * @param {string[]} ids
 */
async function fetchLatestRaidAmong(client, ids) {
  // Chunk .in() to stay within PostgREST URL limits
  /** @type {Array<{ raid_id: string, raid_name?: string, date_iso?: string }>} */
  let best = []
  const chunkSize = 150
  for (let i = 0; i < ids.length; i += chunkSize) {
    const slice = ids.slice(i, i + chunkSize)
    const { data, error } = await client
      .from('raids')
      .select('raid_id, raid_name, date_iso, date')
      .in('raid_id', slice)
      .order('date_iso', { ascending: false, nullsFirst: false })
      .limit(1)
    if (error) throw new Error(error.message)
    if (data?.[0]) best.push(data[0])
  }
  best.sort((a, b) => String(b.date_iso || '').localeCompare(String(a.date_iso || '')))
  const top = best[0]
  if (!top) return null
  return { raidId: String(top.raid_id), raidName: top.raid_name || null, dateIso: top.date_iso || null }
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

/**
 * Zone window: classify raid ids for zone, then history for those raids in date window.
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 * @param {object} params
 * @param {Record<string, object>} known
 * @param {Set<string>} phaseNames
 */
async function fetchAwardsInZoneWindow(client, params, known, phaseNames) {
  if (!params.zone) return { rows: [], truncated: false }
  const { data: classRows, error } = await client
    .from('raid_classifications')
    .select('raid_id')
    .eq('zone', params.zone)
    .limit(2000)
  if (error) throw new Error(error.message)
  const ids = uniqueIds(classRows)
  if (!ids.length) return { rows: [], truncated: false }

  /** @type {object[]} */
  const all = []
  const chunkSize = 100
  const limit = params.limit || 40
  for (let i = 0; i < ids.length && all.length <= limit; i += chunkSize) {
    const slice = ids.slice(i, i + chunkSize)
    let q = client
      .from('raid_loot_history')
      .select(params.select || LOOT_SELECT)
      .in('raid_id', slice)
      .order('date_iso', { ascending: false, nullsFirst: false })
      .limit(limit + 1 - all.length)
    if (params.fromIso) q = q.gte('date_iso', params.fromIso)
    if (params.toIso) q = q.lte('date_iso', params.toIso)
    const { data, error: err } = await q
    if (err) throw new Error(err.message)
    all.push(...(data || []))
  }

  let rows = all.map((a) => enrichAward(a, null, known))
  if (params.filterPhaseMobs?.length) {
    const want = new Set([...phaseNames].map((n) => normAliasKey(n)))
    const mobWant = new Set(params.filterPhaseMobs.map((m) => normAliasKey(m)))
    rows = rows.filter((a) => {
      if (want.has(normAliasKey(a.itemName))) return true
      const auth = authoritativeItemSource(known, a.itemName)
      return auth?.mob && mobWant.has(normAliasKey(auth.mob))
    })
  }
  return { rows: rows.slice(0, limit), truncated: all.length > limit }
}

function uniqueIds(rows) {
  const set = new Set()
  for (const r of rows || []) {
    if (r?.raid_id != null) set.add(String(r.raid_id))
  }
  return [...set]
}
