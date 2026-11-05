/**
 * Public API for the deterministic loot discovery engine.
 */

import { tryParseDiscovery, recognizeDiscovery } from './parse.js'
import { resolveDiscoveryEntities } from './resolve.js'
import { planDiscovery } from './queryPlan.js'
import { executeDiscovery } from './fetch.js'
import { renderDiscovery } from './render.js'

export {
  tryParseDiscovery,
  looksLikeDiscovery,
  extractTimeRange,
  normalizeDiscoveryText,
  recognizeDiscovery,
  deriveFamily,
} from './parse.js'
export {
  resolveZoneAlias,
  resolvePhaseAlias,
  resolveBossAlias,
  resolveSlotAlias,
  resolveClassesHint,
  classesMatchRole,
  lookupItemAlias,
  preferAuthoritativeSource,
  itemNamesForPhaseMobs,
  itemNamesForZone,
  itemNamesForBoss,
  P3_MOBS,
  ZONE_ALIASES,
  PHASE_ALIASES,
  SLOT_ALIASES,
  ROLE_CLASS_TOKENS,
  ITEM_ALIASES,
  BOSS_ALIASES,
} from './aliases.js'
export { resolveDiscoveryEntities, authoritativeItemSource } from './resolve.js'
export {
  ELEMENTAL_MOLDS,
  resolveMoldPhrase,
  looksLikeMoldPhrase,
  extractMoldItemQuery,
} from './molds.js'
export { softMatchNames, editDistance } from './fuzzy.js'
export { planDiscovery } from './queryPlan.js'
export { executeDiscovery, resetDiscoveryCache, escapeIlike, getDiscoveryCacheKey } from './fetch.js'
export { discoverySwrKey, fingerprintQuery, DISCOVERY_DEDUPING_MS } from './cacheKey.js'
export { renderDiscovery } from './render.js'

/**
 * Parse + resolve without I/O. Returns null if not a discovery question.
 * @param {string} text
 * @param {{
 *   knownItemSources?: Record<string, object>,
 *   itemCatalog?: object[],
 *   itemStats?: Record<string, object>,
 *   nowIso?: string,
 *   prev?: import('./types.js').StructuredQuery|null,
 *   prevPrimary?: object|null,
 *   recognition?: import('./types.js').Recognition|null,
 * }} [ctx]
 */
export function prepareDiscovery(text, ctx = {}) {
  const recognition =
    ctx.recognition ||
    recognizeDiscovery(text, {
      nowIso: ctx.nowIso,
      prev: ctx.prev || null,
      prevPrimary: ctx.prevPrimary || null,
    })
  if (recognition.status === 'not_discovery') return null
  if (recognition.status === 'unsupported') {
    return { query: null, resolved: null, plan: null, recognition }
  }
  const query = recognition.query || tryParseDiscovery(text, { nowIso: ctx.nowIso, prev: ctx.prev })
  if (!query) {
    return {
      query: null,
      resolved: null,
      plan: null,
      recognition: recognition.status === 'ambiguous'
        ? recognition
        : {
            status: 'unsupported',
            reason: recognition.reason || 'Could not build a discovery query.',
            missing: recognition.missing || [],
          },
    }
  }
  const resolved = resolveDiscoveryEntities(query, ctx)
  const plan = planDiscovery(resolved.query, resolved)
  return { query: resolved.query, resolved, plan, recognition: { ...recognition, query: resolved.query, status: 'recognized' } }
}

/**
 * Full path: prepare → execute → render AnswerFacts.
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 * @param {string} text
 * @param {object} [ctx]
 */
export async function runDiscovery(client, text, ctx = {}) {
  const prepared = prepareDiscovery(text, ctx)
  if (!prepared) return null
  if (prepared.recognition?.status === 'unsupported') {
    return {
      prepared,
      result: null,
      answer: {
        intent: 'loot_discovery',
        category: 'general',
        factText:
          prepared.recognition.reason ||
          'I could not safely interpret that loot question. Try naming a boss, zone, phase, item, or character.',
        requiredClaims: ['loot_discovery'],
        placeholders: {},
        referenced: { characters: [], items: [], raids: [] },
        links: [],
        reasonCode: 'loot_discovery',
        allowFlavor: false,
        templateId: 'LOOT_DISCOVERY',
      },
      recognition: prepared.recognition,
    }
  }
  if (!prepared.query || !prepared.plan) return null
  if (prepared.resolved?.itemAmbiguous) {
    const result = {
      ok: false,
      family: prepared.query.family,
      query: prepared.query,
      ambiguous: {
        kind: 'item',
        candidates: prepared.resolved.itemAmbiguous.candidates.map((c) => c.name),
        message: prepared.resolved.itemAmbiguous.message,
        spelling: Boolean(prepared.resolved.itemAmbiguous.spelling),
      },
      awards: [],
      gaps: prepared.resolved.gaps || [],
    }
    return { prepared, result, answer: renderDiscovery(result), recognition: prepared.recognition }
  }
  const result = await executeDiscovery(client, prepared.plan, {
    knownItemSources: ctx.knownItemSources,
    itemStats: ctx.itemStats,
    resolved: prepared.resolved,
    skipCache: ctx.skipCache,
  })
  if (result && prepared.resolved?.itemCorrection) {
    result.itemCorrection = prepared.resolved.itemCorrection
  }
  return { prepared, result, answer: renderDiscovery(result), recognition: prepared.recognition }
}
