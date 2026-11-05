/**
 * Pure StructuredQuery (+ resolved entities) → QueryPlan. No I/O.
 *
 * Zone / phase / boss raid nights are resolved by joining static item_sources
 * (item → mob/zone) to raid_loot_history — not via raid_classifications.
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

  // Slot is a hard constraint: never dump a full phase/zone raid night when we can
  // answer via historical awards for the resolved item (last drop may be an older raid).
  if (query.family === 'raid_loot' && query.slot && itemName && resolved?.item?.name) {
    ops.push({
      op: 'awards_for_item',
      params: {
        itemName: resolved.item.name,
        fromIso: query.timeRange?.fromIso || null,
        toIso: query.timeRange?.toIso || null,
        select: LOOT_SELECT,
        limit: Math.min(limit, 10),
        countExact: false,
      },
    })
    return {
      ops,
      query: { ...query, family: 'item_last', itemQuery: resolved.item.name },
      notes,
    }
  }

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
          op: 'latest_raid_by_catalog',
          params: {
            match: 'phase',
            phase: query.phase,
            mobs: phaseMobs,
            zone: query.zone || 'Plane of Time',
          },
        })
        ops.push({
          op: 'loot_for_raid',
          params: {
            filterPhaseMobs: phaseMobs,
            // If slot somehow survived without a resolved item, still narrow awards client-side
            filterSlot: query.slot || null,
            select: RAID_LOOT_SELECT,
            limit,
          },
        })
        notes.push(
          'Phase answers list only awards whose items are labeled in item_sources / raid_loot_classification; other loot on the same night is excluded.',
        )
      } else if (query.zone && query.mostRecentRaidFirst !== false && !query.timeRange) {
        ops.push({
          op: 'latest_raid_by_catalog',
          params: { match: 'zone', zone: query.zone },
        })
        ops.push({
          op: 'loot_for_raid',
          params: {
            select: RAID_LOOT_SELECT,
            limit,
            filterSlot: query.slot || null,
          },
        })
      } else if (query.zone || query.timeRange) {
        ops.push({
          op: 'awards_for_catalog_window',
          params: {
            match: query.phase ? 'phase' : 'zone',
            zone: query.zone || null,
            phase: query.phase || null,
            mobs: query.phase ? phaseMobs : null,
            fromIso: query.timeRange?.fromIso || null,
            toIso: query.timeRange?.toIso || null,
            select: LOOT_SELECT,
            limit,
            filterSlot: query.slot || null,
          },
        })
      } else {
        notes.push('Raid/zone discovery requires a recognized zone or phase.')
        ops.push({ op: 'noop', params: {} })
      }
      break

    case 'boss_raid_loot':
      ops.push({
        op: 'latest_raid_by_catalog',
        params: { match: 'boss', boss: query.boss || null, zone: query.zone || null },
      })
      ops.push({
        op: 'loot_for_raid',
        params: {
          select: RAID_LOOT_SELECT,
          limit,
          filterBoss: query.boss || null,
        },
      })
      notes.push(
        'Boss-night selection joins authoritative item_sources mob labels to recorded awards (not raid_classifications).',
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
