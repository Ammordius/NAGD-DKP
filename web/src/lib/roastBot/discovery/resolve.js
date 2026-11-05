/**
 * Entity resolution for discovery queries against static catalogs.
 * Prefer exact names / aliases, then constrained tokens, then cautious fuzzy.
 */

import { matchItemName } from '../formatting.js'
import {
  lookupItemAlias,
  CASTER_CLASS_TOKENS,
  preferAuthoritativeSource,
  itemNamesForPhaseMobs,
  P3_MOBS,
  normAliasKey,
  isPhaseMob,
} from './aliases.js'
import { catalogEntriesFromKnownSources } from '../../itemSourceLookup.js'

/**
 * @typedef {{
 *   query: import('./types.js').StructuredQuery,
 *   item?: { name: string, itemId?: string|number|null }|null,
 *   itemAmbiguous?: { candidates: Array<{ name: string }>, message: string }|null,
 *   itemUnmatched?: boolean,
 *   phaseItemNames?: Set<string>,
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

  if (query.itemQuery) {
    const resolved = resolveItemQuery(query.itemQuery, query, ctx, phaseItemNames)
    if (resolved.ambiguous) {
      itemAmbiguous = {
        candidates: resolved.candidates,
        message: resolved.message || 'Which item did you mean?',
      }
    } else if (resolved.unmatched) {
      itemUnmatched = true
      gaps.push(`Could not resolve item "${query.itemQuery}" against the loot catalog.`)
    } else {
      item = resolved.item
    }
  }

  if (query.family === 'boss_raid_loot' || query.family === 'boss_catalog') {
    if (!query.boss) {
      gaps.push('Boss name was not recognized; cannot attribute encounters without a known boss.')
    }
  }

  return {
    query: {
      ...query,
      itemQuery: item?.name || query.itemQuery,
    },
    item,
    itemAmbiguous,
    itemUnmatched,
    phaseItemNames,
    gaps,
  }
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

  if (alias?.name) {
    const exact = matchItemName(alias.name, catalog)
    if (exact && !exact.ambiguous) return { item: { name: exact.name, itemId: exact.itemId ?? exact.id ?? null } }
    return { item: { name: alias.name, itemId: null } }
  }

  // Constrained: slot + caster + optional phase (e.g. "caster shoulders" / "p3 caster shoulders")
  if (alias?.slot || /\bshoulders?\b/.test(normAliasKey(hint))) {
    const constrained = resolveConstrainedItem(hint, alias, query, ctx, phaseItemNames)
    if (constrained) return constrained
  }

  const match = matchItemName(hint, catalog)
  if (!match) return { unmatched: true, hint }
  if (match.ambiguous) {
    return {
      ambiguous: true,
      candidates: match.candidates.map((c) => ({ name: c.name })),
      message: `Which item? Candidates: ${match.candidates.map((c) => c.name).slice(0, 5).join(', ')}.`,
    }
  }
  return { item: { name: match.name, itemId: match.itemId ?? match.id ?? null } }
}

/**
 * @param {string} hint
 * @param {object|null} alias
 * @param {import('./types.js').StructuredQuery} query
 * @param {object} ctx
 * @param {Set<string>} phaseItemNames
 */
function resolveConstrainedItem(hint, alias, query, ctx, phaseItemNames) {
  const stats = ctx.itemStats || {}
  const slotWant = (alias?.slot || 'SHOULDERS').toUpperCase()
  const wantCaster = Boolean(alias?.classesHint === 'caster' || /\bcaster\b/.test(normAliasKey(hint)))
  const phase = alias?.phase || query.phase

  /** @type {Array<{ name: string, itemId: string }>} */
  const hits = []
  for (const [id, row] of Object.entries(stats)) {
    if (!row?.name) continue
    if (String(row.slot || '').toUpperCase() !== slotWant) continue
    if (wantCaster && !isCasterClasses(row.classes)) continue
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

  // Fall back: phase item names intersecting shoulders-like names from catalog
  if (!hits.length && phaseItemNames.size) {
    for (const name of phaseItemNames) {
      if (!/pauldron|shoulder/i.test(name)) continue
      if (wantCaster) {
        const entry = Object.values(stats).find((r) => normAliasKey(r?.name) === normAliasKey(name))
        if (entry && !isCasterClasses(entry.classes)) continue
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

  // Explicit alias name fallback already handled; if Pauldrons of Purity is the known P3 caster shoulders
  if (phase && wantCaster && slotWant === 'SHOULDERS') {
    const purity = [...phaseItemNames].find((n) => /pauldrons of purity/i.test(n))
    if (purity) return { item: { name: purity, itemId: null } }
  }

  return { unmatched: true, hint }
}

/**
 * @param {string|null|undefined} classes
 */
function isCasterClasses(classes) {
  const parts = String(classes || '')
    .toLowerCase()
    .split(/[\s/,]+/)
    .filter(Boolean)
  if (!parts.length) return false
  return parts.some((p) => CASTER_CLASS_TOKENS.has(p))
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
