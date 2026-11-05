/**
 * Pure StructuredQuery (+ resolved entities) → QueryPlan. No I/O.
 */

import { P3_MOBS } from './aliases.js'

const LOOT_SELECT =
  'id, raid_id, item_name, character_name, char_id, cost, assigned_char_id, assigned_character_name, raid_name, date_iso, date'

const RAID_LOOT_SELECT =
  'id, raid_id, event_id, item_name, char_id, character_name, cost, assigned_char_id, assigned_character_name'

/**
 * @param {import('./types.js').StructuredQuery} query
 * @param {import('./resolve.js').ResolvedDiscovery} [resolved]
 * @returns {import('./types.js').QueryPlan}
 */
export function planDiscovery(query, resolved = null) {
  /** @type {import('./types.js').QueryOp[]} */
  const ops = []
  /** @type {string[]} */
  const notes = [...(resolved?.gaps || [])]

  const itemName = resolved?.item?.name || query.itemQuery || null
  const limit = query.limit || 40
  const phaseMobs = phaseMobsForFilter(query.phase)

  switch (query.family) {
    case 'boss_catalog':
      ops.push({
        op: 'catalog_boss_drops',
        params: { boss: query.boss, limit },
      })
      break

    case 'raid_loot':
      if (query.phase) {
        ops.push({
          op: 'latest_raid_by_mobs',
          params: { mobs: phaseMobs, zone: query.zone || 'Plane of Time' },
        })
        ops.push({
          op: 'loot_for_raid',
          params: {
            filterPhaseMobs: phaseMobs,
            select: RAID_LOOT_SELECT,
            limit,
          },
        })
        notes.push(
          'P3/phase answers include only awards whose items are labeled in item_sources / raid_loot_classification; other PoTime loot on the same night is excluded.',
        )
      } else if (query.zone && query.mostRecentRaidFirst !== false && !query.timeRange) {
        ops.push({
          op: 'latest_raid_by_zone',
          params: { zone: query.zone },
        })
        ops.push({
          op: 'loot_for_raid',
          params: { select: RAID_LOOT_SELECT, limit },
        })
      } else if (query.zone || query.timeRange) {
        ops.push({
          op: 'awards_in_zone_window',
          params: {
            zone: query.zone || null,
            fromIso: query.timeRange?.fromIso || null,
            toIso: query.timeRange?.toIso || null,
            filterPhaseMobs: query.phase ? phaseMobs : null,
            select: LOOT_SELECT,
            limit,
          },
        })
      } else {
        notes.push('Raid/zone discovery requires a recognized zone or phase.')
        ops.push({ op: 'noop', params: {} })
      }
      break

    case 'boss_raid_loot':
      ops.push({
        op: 'latest_raid_by_mobs',
        params: { mobs: query.boss ? [query.boss] : [], zone: query.zone || null },
      })
      ops.push({
        op: 'loot_for_raid',
        params: {
          select: RAID_LOOT_SELECT,
          limit,
          // Prefer filtering to items authoritatively sourced to this boss when available
          filterBoss: query.boss || null,
        },
      })
      notes.push(
        'Boss-night loot uses raid_classifications for raid selection; item→boss claims prefer item_sources over conflicting dkp_mob_loot rows.',
      )
      break

    case 'item_recipients':
    case 'item_last':
    case 'has_won':
      ops.push({
        op: 'awards_for_item',
        params: {
          itemName,
          character: query.family === 'has_won' ? query.character : null,
          fromIso: query.timeRange?.fromIso || null,
          toIso: query.timeRange?.toIso || null,
          select: LOOT_SELECT,
          limit: query.family === 'item_last' ? Math.min(limit, 10) : limit,
          countExact: false,
        },
      })
      break

    case 'item_count':
      ops.push({
        op: 'count_awards_for_item',
        params: {
          itemName,
          fromIso: query.timeRange?.fromIso || null,
          toIso: query.timeRange?.toIso || null,
        },
      })
      ops.push({
        op: 'awards_for_item',
        params: {
          itemName,
          select: LOOT_SELECT,
          limit: 5,
          countExact: false,
        },
      })
      break

    case 'character_awards':
      ops.push({
        op: 'awards_for_character',
        params: {
          character: query.character,
          fromIso: query.timeRange?.fromIso || null,
          toIso: query.timeRange?.toIso || null,
          select: LOOT_SELECT,
          limit,
        },
      })
      break

    default:
      ops.push({ op: 'noop', params: {} })
      notes.push(`Unsupported discovery family: ${query.family}`)
  }

  return { ops, query, notes }
}

/**
 * @param {string|null|undefined} phase
 */
function phaseMobsForFilter(phase) {
  if (!phase) return [...P3_MOBS]
  if (phase === 'P3' || phase === 'P3 Guardian') return [...P3_MOBS]
  return [phase]
}

export { LOOT_SELECT, RAID_LOOT_SELECT }
