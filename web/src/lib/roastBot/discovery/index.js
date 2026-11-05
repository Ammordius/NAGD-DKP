/**
 * Public API for the deterministic loot discovery engine.
 */

import { tryParseDiscovery } from './parse.js'
import { resolveDiscoveryEntities } from './resolve.js'
import { planDiscovery } from './queryPlan.js'
import { executeDiscovery } from './fetch.js'
import { renderDiscovery } from './render.js'

export { tryParseDiscovery, looksLikeDiscovery, extractTimeRange, normalizeDiscoveryText } from './parse.js'
export {
  resolveZoneAlias,
  resolvePhaseAlias,
  resolveBossAlias,
  lookupItemAlias,
  preferAuthoritativeSource,
  itemNamesForPhaseMobs,
  P3_MOBS,
  ZONE_ALIASES,
  PHASE_ALIASES,
  ITEM_ALIASES,
  BOSS_ALIASES,
} from './aliases.js'
export { resolveDiscoveryEntities, authoritativeItemSource } from './resolve.js'
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
 * }} [ctx]
 */
export function prepareDiscovery(text, ctx = {}) {
  const query = tryParseDiscovery(text, { nowIso: ctx.nowIso })
  if (!query) return null
  const resolved = resolveDiscoveryEntities(query, ctx)
  const plan = planDiscovery(resolved.query, resolved)
  return { query: resolved.query, resolved, plan }
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
  if (prepared.resolved.itemAmbiguous) {
    const result = {
      ok: false,
      family: prepared.query.family,
      query: prepared.query,
      ambiguous: {
        kind: 'item',
        candidates: prepared.resolved.itemAmbiguous.candidates.map((c) => c.name),
        message: prepared.resolved.itemAmbiguous.message,
      },
      awards: [],
      gaps: prepared.resolved.gaps || [],
    }
    return { prepared, result, answer: renderDiscovery(result) }
  }
  const result = await executeDiscovery(client, prepared.plan, {
    knownItemSources: ctx.knownItemSources,
    resolved: prepared.resolved,
    skipCache: ctx.skipCache,
  })
  return { prepared, result, answer: renderDiscovery(result) }
}
