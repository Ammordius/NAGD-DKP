/**
 * Pure StructuredQuery (+ resolved entities) → QueryPlan. No I/O.
 *
 * Plans from intent + composed item selector onto existing fetch ops.
 * Zone / phase / boss raid nights join static item_sources to raid_loot_history.
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

  const itemName = resolved?.item?.name || null
  const limit = query.limit || 40
  const phaseMobs = phaseMobsForFilter(query.phase)
  const intent = query.intent || intentFromFamily(query.family)
  const scope = query.scope || (query.mostRecentRaidFirst ? 'last_raid_night' : 'history')
  const selector = resolved?.itemSelector || null
  const multiNames = selector?.names && selector.names.size > 0 ? selector.names : null
  // Multi-name historical window: boss/zone/phase + slot (or boss+slot without single item).
  // Never divert last_raid_night dumps onto catalog-window awards.
  const useMulti =
    scope !== 'last_raid_night' &&
    Boolean(multiNames) &&
    !itemName &&
    (Boolean(query.boss) || ((query.zone || query.phase) && query.slot)) &&
    (intent === 'last_award' || intent === 'recipients')

  // Slot on a phase/zone raid dump → prefer historical awards for resolved single item
  if (
    (query.family === 'raid_loot' || intent === 'list_awards') &&
    query.slot &&
    itemName &&
    scope !== 'last_raid_night'
  ) {
    ops.push({
      op: 'awards_for_item',
      params: {
        itemName,
        fromIso: query.timeRange?.fromIso || null,
        toIso: query.timeRange?.toIso || null,
        select: LOOT_SELECT,
        limit: Math.min(limit, 10),
        countExact: false,
      },
    })
    return {
      ops,
      query: { ...query, family: 'item_last', intent: 'last_award', itemQuery: itemName },
      notes,
    }
  }

  if (intent === 'catalog') {
    ops.push({
      op: 'catalog_boss_drops',
      params: { boss: query.boss, limit },
    })
    return { ops, query, notes }
  }

  if (intent === 'count') {
    ops.push({
      op: 'count_awards_for_item',
      params: {
        itemName: itemName || query.itemQuery,
        fromIso: query.timeRange?.fromIso || null,
        toIso: query.timeRange?.toIso || null,
      },
    })
    ops.push({
      op: 'awards_for_item',
      params: {
        itemName: itemName || query.itemQuery,
        select: LOOT_SELECT,
        limit: 5,
        countExact: false,
      },
    })
    return { ops, query, notes }
  }

  if (intent === 'has_won' || ((intent === 'recipients' || intent === 'last_award') && itemName && !useMulti)) {
    ops.push({
      op: 'awards_for_item',
      params: {
        itemName: itemName || query.itemQuery,
        character: intent === 'has_won' ? query.character : null,
        fromIso: query.timeRange?.fromIso || null,
        toIso: query.timeRange?.toIso || null,
        select: LOOT_SELECT,
        limit: intent === 'last_award' ? Math.min(limit, 10) : limit,
        countExact: false,
      },
    })
    return { ops, query, notes }
  }

  // Multi-name catalog window: boss/zone/phase (+ optional slot) historical awards
  if (useMulti || (intent === 'last_award' && query.boss && (query.slot || query.classesHint) && !itemName)) {
    const match = query.boss ? 'boss' : query.phase ? 'phase' : 'zone'
    ops.push({
      op: 'awards_for_catalog_window',
      params: {
        match,
        boss: query.boss || null,
        zone: query.zone || null,
        phase: query.phase || null,
        mobs: query.phase ? phaseMobs : null,
        fromIso: query.timeRange?.fromIso || null,
        toIso: query.timeRange?.toIso || null,
        select: LOOT_SELECT,
        limit: Math.min(limit, intent === 'last_award' ? 10 : limit),
        filterSlot: query.slot || null,
      },
    })
    if (query.boss && query.slot) {
      notes.push(
        'Boss+slot answers join item_sources mob labels to recorded awards, then filter by equipment slot.',
      )
    }
    return { ops, query: { ...query, family: 'item_last', intent: intent === 'recipients' ? 'recipients' : 'last_award' }, notes }
  }

  if (intent === 'list_awards' && query.character && scope === 'history' && !query.boss && familyIsCharacter(query)) {
    ops.push({
      op: 'awards_for_character',
      params: {
        character: query.character,
        fromIso: query.timeRange?.fromIso || null,
        toIso: query.timeRange?.toIso || null,
        select: LOOT_SELECT,
        limit,
        filterZone: query.zone || null,
        filterPhase: query.phase || null,
        filterSlot: query.slot || null,
      },
    })
    return { ops, query, notes }
  }

  // Last raid night (zone / phase / boss)
  if (scope === 'last_raid_night' || query.family === 'boss_raid_loot' || query.family === 'raid_loot') {
    if (query.family === 'boss_raid_loot' || (query.boss && scope === 'last_raid_night' && !query.slot)) {
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
          filterSlot: query.slot || null,
        },
      })
      notes.push(
        'Boss-night selection joins authoritative item_sources mob labels to recorded awards (not raid_classifications).',
      )
      return { ops, query, notes }
    }

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
          filterSlot: query.slot || null,
          select: RAID_LOOT_SELECT,
          limit,
        },
      })
      notes.push(
        'Phase answers list only awards whose items are labeled in item_sources / raid_loot_classification; other loot on the same night is excluded.',
      )
      return { ops, query, notes }
    }

    if (query.zone && scope === 'last_raid_night' && !query.timeRange) {
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
      return { ops, query, notes }
    }

    if (query.zone || query.timeRange || query.phase) {
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
      return { ops, query, notes }
    }

    notes.push('Raid/zone discovery requires a recognized zone or phase.')
    ops.push({ op: 'noop', params: {} })
    return { ops, query, notes }
  }

  // Fallback character awards
  if (query.character) {
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
    return { ops, query, notes }
  }

  // Single-item recipients fallback
  if (itemName || query.itemQuery) {
    ops.push({
      op: 'awards_for_item',
      params: {
        itemName: itemName || query.itemQuery,
        fromIso: query.timeRange?.fromIso || null,
        toIso: query.timeRange?.toIso || null,
        select: LOOT_SELECT,
        limit,
        countExact: false,
      },
    })
    return { ops, query, notes }
  }

  ops.push({ op: 'noop', params: {} })
  notes.push(`Unsupported discovery combination: intent=${intent}`)
  return { ops, query, notes }
}

/**
 * @param {string|null|undefined} family
 */
function intentFromFamily(family) {
  switch (family) {
    case 'boss_catalog':
      return 'catalog'
    case 'item_count':
      return 'count'
    case 'has_won':
      return 'has_won'
    case 'item_recipients':
      return 'recipients'
    case 'item_last':
      return 'last_award'
    case 'character_awards':
      return 'list_awards'
    case 'boss_raid_loot':
    case 'raid_loot':
      return 'list_awards'
    default:
      return 'list_awards'
  }
}

function familyIsCharacter(query) {
  return query.family === 'character_awards' || (query.intent === 'list_awards' && query.character && !query.boss)
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
