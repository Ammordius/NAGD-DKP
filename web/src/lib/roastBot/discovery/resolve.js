/**
 * Entity resolution for discovery queries against static catalogs.
 * Prefer exact names / aliases / molds, then constrained tokens, then JSON typo soft-match.
 */

import { matchItemName } from '../formatting.js'
import {
  lookupItemAlias,
  resolveSlotAlias,
  resolveClassesHint,
  classesMatchRole,
  SLOT_NAME_FALLBACK_PATTERNS,
  preferAuthoritativeSource,
  itemNamesForPhaseMobs,
  itemNamesForBoss,
  itemNamesForZone,
  P3_MOBS,
  normAliasKey,
  isPhaseMob,
} from './aliases.js'
import { catalogEntriesFromKnownSources } from '../../itemSourceLookup.js'
import { ELEMENTAL_MOLDS, looksLikeMoldPhrase, resolveMoldPhrase } from './molds.js'
import { softMatchNames } from './fuzzy.js'

/**
 * @typedef {{
 *   query: import('./types.js').StructuredQuery,
 *   item?: { name: string, itemId?: string|number|null }|null,
 *   itemAmbiguous?: { candidates: Array<{ name: string }>, message: string }|null,
 *   itemUnmatched?: boolean,
 *   itemCorrection?: { from: string, to: string }|null,
 *   phaseItemNames?: Set<string>,
 *   itemSelector?: { names: Set<string>, match: 'boss'|'zone'|'phase'|'item'|null }|null,
 *   gaps?: string[],
 * }} ResolvedDiscovery
 */

/**
 * @param {import('./types.js').StructuredQuery} query
 * @param {{
 *   knownItemSources?: Record<string, object>,
 *   itemCatalog?: Array<{ name: string, itemId?: string|number|null }>,
 *   itemStats?: Record<string, { name?: string, slot?: string, classes?: string }>,
 * }} ctx
 * @returns {ResolvedDiscovery}
 */
export function resolveDiscoveryEntities(query, ctx = {}) {
  /** @type {string[]} */
  const gaps = []
  const known = ctx.knownItemSources || {}
  const phaseItemNames = itemNamesForPhaseMobs(known, phaseMobsFor(query.phase))

  if (query.phase && phaseItemNames.size === 0) {
    gaps.push(
      `No items in the static catalog are labeled ${query.phase}; phase filtering cannot be applied authoritatively.`,
    )
  }

  let item = null
  let itemAmbiguous = null
  let itemUnmatched = false
  /** @type {{ from: string, to: string }|null} */
  let itemCorrection = null
  /** @type {{ names: Set<string>, match: 'item' }|null} */
  let moldSelector = null

  // Boss + slot/role history uses a multi-item catalog selector (skip single-item resolve).
  // Phase/zone + slot without boss still tries constrained single-item resolution (P3 shoulders).
  // Mold phrases always resolve via mold catalog (single or multi), never boss multi-catalog.
  const moldHint = looksLikeMoldPhrase(query.itemQuery || '') || looksLikeMoldPhrase(query.raw || '')
  const multiCatalog =
    Boolean(query.boss) &&
    Boolean(query.slot || query.classesHint) &&
    (query.intent === 'last_award' ||
      query.intent === 'recipients' ||
      query.family === 'item_last') &&
    !lookupItemAlias(query.itemQuery || '')?.name &&
    !looksLikeNamedItem(query.itemQuery) &&
    !moldHint

  if (query.itemQuery && !multiCatalog) {
    const resolved = resolveItemQuery(query.itemQuery, query, ctx, phaseItemNames)
    if (resolved.ambiguous) {
      itemAmbiguous = {
        candidates: resolved.candidates,
        message: resolved.message || 'Which item did you mean?',
        spelling: Boolean(resolved.spelling),
      }
    } else if (resolved.moldNames) {
      moldSelector = { names: resolved.moldNames, match: /** @type {const} */ ('item') }
    } else if (resolved.unmatched) {
      itemUnmatched = true
      gaps.push(`Could not resolve item "${query.itemQuery}" against the loot catalog.`)
    } else {
      item = resolved.item
      if (resolved.correctedFrom && item?.name) {
        itemCorrection = { from: resolved.correctedFrom, to: item.name }
      }
    }
  }

  if (
    query.family === 'boss_raid_loot' ||
    query.family === 'boss_catalog' ||
    query.intent === 'catalog' ||
    (query.boss && query.intent === 'last_award')
  ) {
    if (!query.boss) {
      gaps.push('Boss name was not recognized; cannot attribute encounters without a known boss.')
    }
  }

  const itemSelector =
    moldSelector || composeItemSelector(query, known, phaseItemNames, ctx, item)

  if (multiCatalog && itemSelector?.names && itemSelector.names.size === 0) {
    const where = query.boss
      ? `boss ${query.boss}`
      : query.phase
        ? `phase ${query.phase}`
        : query.zone || 'that filter'
    const slotBit = query.slot ? ` in slot ${query.slot}` : ''
    gaps.push(
      `No catalog items mapped for ${where}${slotBit} (item_sources classification incomplete or empty).`,
    )
  }

  return {
    query: {
      ...query,
      itemQuery: item?.name || (multiCatalog || moldSelector ? null : query.itemQuery),
    },
    item,
    itemAmbiguous,
    itemUnmatched,
    itemCorrection,
    phaseItemNames,
    itemSelector,
    gaps,
  }
}

/**
 * Intersect catalog name sets for boss/zone/phase/slot filters.
 * @param {import('./types.js').StructuredQuery} query
 * @param {Record<string, object>} known
 * @param {Set<string>} phaseItemNames
 * @param {object} ctx
 * @param {{ name: string }|null} item
 */
function composeItemSelector(query, known, phaseItemNames, ctx, item) {
  if (item?.name) {
    return { names: new Set([item.name]), match: /** @type {const} */ ('item') }
  }

  /** @type {Set<string>|null} */
  let names = null
  /** @type {'boss'|'zone'|'phase'|null} */
  let match = null

  if (query.boss) {
    names = itemNamesForBoss(known, query.boss)
    match = 'boss'
  } else if (query.phase) {
    names = phaseItemNames?.size ? new Set(phaseItemNames) : itemNamesForPhaseMobs(known, phaseMobsFor(query.phase))
    match = 'phase'
  } else if (query.zone) {
    names = itemNamesForZone(known, query.zone)
    match = 'zone'
  }

  if (!names) return null

  if (query.slot) {
    names = filterNamesBySlot(names, query.slot, ctx.itemStats || {})
  }

  return { names, match }
}

/**
 * @param {Set<string>} names
 * @param {string} slot
 * @param {Record<string, object>} itemStats
 */
function filterNamesBySlot(names, slot, itemStats) {
  const slotWant = String(slot || '').toUpperCase()
  /** @type {Set<string>} */
  const out = new Set()
  const byNorm = new Map()
  for (const [id, row] of Object.entries(itemStats || {})) {
    if (row?.name) byNorm.set(normAliasKey(row.name), { ...row, id })
  }
  for (const name of names) {
    const row = byNorm.get(normAliasKey(name))
    if (row && slotMatches(row.slot, slotWant)) {
      out.add(String(name).trim())
      continue
    }
    // Name-token fallback when stats missing
    const fallback = SLOT_NAME_FALLBACK_PATTERNS[slotWant]
    if (!row && fallback && fallback.test(name)) out.add(String(name).trim())
  }
  return out
}

function looksLikeNamedItem(itemQuery) {
  const q = String(itemQuery || '').trim()
  if (!q) return false
  // Constrained phrases like "p3 shoulders" / "finger" are not named items
  if (resolveSlotAlias(q) && q.split(/\s+/).length <= 3) return false
  if (/^(p\d+|priest|caster|tank|melee)\b/i.test(q) && resolveSlotAlias(q)) return false
  return q.split(/\s+/).length >= 2 && !resolveSlotAlias(q)
}

/**
 * @param {string|null|undefined} phase
 */
function phaseMobsFor(phase) {
  if (!phase) return P3_MOBS
  const p = String(phase)
  if (p === 'P3' || p === 'P3 Guardian') return P3_MOBS
  if (p === 'P1') return ['P1']
  return [p]
}

/**
 * @param {string} hint
 * @param {import('./types.js').StructuredQuery} query
 * @param {object} ctx
 * @param {Set<string>} phaseItemNames
 */
function resolveItemQuery(hint, query, ctx, phaseItemNames) {
  const alias = lookupItemAlias(hint)
  const catalog = buildCatalog(ctx)
  const slotFromHint = resolveSlotAlias(hint) || query.slot || null

  if (alias?.name) {
    const exact = matchItemName(alias.name, catalog)
    if (exact && !exact.ambiguous) return { item: { name: exact.name, itemId: exact.itemId ?? exact.id ?? null } }
    return { item: { name: alias.name, itemId: null } }
  }

  // Elemental / Timeless molds (colloquial + canonical) before wear-slot constrained resolve
  const mold = resolveMoldPhrase(hint) || resolveMoldPhrase(query.raw || '')
  if (mold?.name) {
    return {
      item: { name: mold.name, itemId: mold.itemId ?? null },
      correctedFrom: mold.correctedFrom || undefined,
    }
  }
  if (mold?.names?.size) {
    return { moldNames: mold.names }
  }
  if (mold?.ambiguous) {
    return {
      ambiguous: true,
      spelling: Boolean(mold.spelling),
      candidates: mold.candidates,
      message: mold.message || `Which mold? Candidates: ${(mold.candidates || []).map((c) => c.name).slice(0, 5).join(', ')}.`,
    }
  }

  const roleHint = alias?.classesHint || query.classesHint || resolveClassesHint(hint)

  // Constrained: slot (+ optional role/phase) e.g. "p3 priest shoulders" / "tank shoulders"
  // Skip for mold phrases — molds have no wear slot in item_stats.
  // Only short-circuit on a hit or ambiguity — unmatched falls through so names like
  // "Cloak of Wishes" / "Mask of Conceptual Energy" still exact-match despite slot tokens.
  if ((alias?.slot || slotFromHint) && !looksLikeMoldPhrase(hint)) {
    const constrained = resolveConstrainedItem(hint, alias, query, ctx, phaseItemNames, slotFromHint, roleHint)
    if (constrained && !constrained.unmatched) return constrained
  }

  const match = matchItemName(hint, catalog)
  if (match?.ambiguous) {
    return {
      ambiguous: true,
      candidates: match.candidates.map((c) => ({ name: c.name })),
      message: `Which item? Candidates: ${match.candidates.map((c) => c.name).slice(0, 5).join(', ')}.`,
    }
  }
  if (match) {
    return { item: { name: match.name, itemId: match.itemId ?? match.id ?? null } }
  }

  // JSON-catalog typo soft-match (1–2 char); suggest correction; never fuzz Supabase
  const softPool = [
    ...catalog,
    ...ELEMENTAL_MOLDS.map((m) => ({ name: m.name, itemId: m.id })),
  ]
  const soft = softMatchNames(hint, softPool)
  if (soft?.unique) {
    return {
      item: { name: soft.unique.name, itemId: soft.unique.itemId ?? null },
      correctedFrom: String(hint).trim(),
    }
  }
  if (soft?.ambiguous?.length) {
    return {
      ambiguous: true,
      spelling: true,
      candidates: soft.ambiguous.map((c) => ({ name: c.name })),
      message: `Did you mean ${soft.ambiguous
        .map((c) => c.name)
        .slice(0, 5)
        .join(', or ')}? Your spelling left a few possibilities.`,
    }
  }

  return { unmatched: true, hint }
}

/**
 * @param {string} hint
 * @param {object|null} alias
 * @param {import('./types.js').StructuredQuery} query
 * @param {object} ctx
 * @param {Set<string>} phaseItemNames
 * @param {string|null} [slotHint]
 * @param {string|null} [roleHint]
 */
function resolveConstrainedItem(hint, alias, query, ctx, phaseItemNames, slotHint = null, roleHint = null) {
  const stats = ctx.itemStats || {}
  const slotWant = String(alias?.slot || slotHint || query.slot || '').toUpperCase()
  if (!slotWant) return { unmatched: true, hint }
  const role =
    roleHint ||
    alias?.classesHint ||
    query.classesHint ||
    resolveClassesHint(hint) ||
    null
  const phase = alias?.phase || query.phase
  const nameFallback = SLOT_NAME_FALLBACK_PATTERNS[slotWant] || null

  /** @type {Array<{ name: string, itemId: string|null }>} */
  const hits = []
  for (const [id, row] of Object.entries(stats)) {
    if (!row?.name) continue
    if (!slotMatches(row.slot, slotWant)) continue
    if (role && !classesMatchRole(row.classes, role)) continue
    if (phase) {
      const inPhase = phaseItemNames.has(String(row.name).trim())
      // Also accept authoritative source on knownItemSources
      const auth = preferAuthoritativeSource(ctx.knownItemSources?.[normAliasKey(row.name)]?.sources || [])
      const phaseOk =
        inPhase ||
        (auth && isPhaseMob(auth.mob) && phaseMobsFor(phase).some((m) => normAliasKey(m) === normAliasKey(auth.mob)))
      if (!phaseOk) continue
    }
    hits.push({ name: row.name, itemId: id })
  }

  // Fall back: phase item names intersecting slot-like name tokens from catalog
  if (!hits.length && phaseItemNames.size && nameFallback) {
    for (const name of phaseItemNames) {
      if (!nameFallback.test(name)) continue
      if (role) {
        const entry = Object.values(stats).find((r) => normAliasKey(r?.name) === normAliasKey(name))
        if (entry && !classesMatchRole(entry.classes, role)) continue
      }
      hits.push({ name, itemId: null })
    }
  }

  if (hits.length === 1) return { item: hits[0] }
  if (hits.length > 1) {
    return {
      ambiguous: true,
      candidates: hits.slice(0, 8).map((h) => ({ name: h.name })),
      message: `Ambiguous item match for "${hint}". Candidates: ${hits
        .slice(0, 5)
        .map((h) => h.name)
        .join(', ')}.`,
    }
  }

  // Soft P3 shoulders known item when role overlaps caster/priest and stats were sparse
  if (phase && (role === 'caster' || role === 'priest') && slotWant === 'SHOULDERS') {
    const purity = [...phaseItemNames].find((n) => /pauldrons of purity/i.test(n))
    if (purity) return { item: { name: purity, itemId: null } }
  }

  return { unmatched: true, hint }
}

/**
 * item_stats may use SHOULDER or SHOULDERS (and similar singular/plural).
 * @param {string|null|undefined} rowSlot
 * @param {string} want
 */
function slotMatches(rowSlot, want) {
  const have = String(rowSlot || '').toUpperCase()
  if (!have || !want) return false
  if (have === want) return true
  if (want === 'SHOULDERS' && (have === 'SHOULDER' || have === 'SHOULDERS')) return true
  if (want === 'SHOULDER' && (have === 'SHOULDER' || have === 'SHOULDERS')) return true
  if (want === 'FINGER' && (have === 'FINGER' || have === 'FINGERS' || have === 'RING')) return true
  if (want === 'WRIST' && (have === 'WRIST' || have === 'WRISTS' || have === 'BRACER')) return true
  return false
}

/**
 * @param {object} ctx
 */
function buildCatalog(ctx) {
  const fromFacts = ctx.itemCatalog || []
  const fromSources = catalogEntriesFromKnownSources(ctx.knownItemSources)
  const fromStats = []
  for (const [id, row] of Object.entries(ctx.itemStats || {})) {
    if (row?.name) fromStats.push({ name: row.name, itemId: id })
  }
  return [...fromFacts, ...fromSources, ...fromStats].filter((i) => i.name)
}

/**
 * Authoritative mob/zone for an item (classification / item_sources preferred).
 * @param {Record<string, object>|null|undefined} knownItemSources
 * @param {string} itemName
 */
export function authoritativeItemSource(knownItemSources, itemName) {
  const entry = knownItemSources?.[normAliasKey(itemName)]
  if (!entry) return null
  const preferred = preferAuthoritativeSource(entry.sources || [])
  if (preferred) return { ...preferred, displayName: entry.displayName, itemId: entry.itemId }
  // Ambiguous / only unreliable — expose gap
  return {
    mob: undefined,
    zone: entry.zone,
    displayName: entry.displayName,
    itemId: entry.itemId,
    ambiguousBoss: true,
    unreliableSources: entry.sources || [],
  }
}
