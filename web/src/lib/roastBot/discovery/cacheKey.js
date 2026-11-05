/**
 * Stable SWR / memory cache keys for discovery queries.
 */

/**
 * @param {import('./types.js').StructuredQuery} query
 * @returns {[string, string]}
 */
export function discoverySwrKey(query) {
  return ['loot-discovery', fingerprintQuery(query)]
}

/**
 * @param {import('./types.js').StructuredQuery} query
 */
export function fingerprintQuery(query) {
  const parts = [
    query.family || '',
    query.zone || '',
    query.phase || '',
    query.boss || '',
    String(query.itemQuery || '').toLowerCase(),
    String(query.slot || '').toUpperCase(),
    String(query.classesHint || '').toLowerCase(),
    String(query.character || '').toLowerCase(),
    query.timeRange?.fromIso || '',
    query.timeRange?.toIso || '',
    query.timeRange?.label || '',
    query.mostRecentRaidFirst === false ? '0' : '1',
    String(query.limit ?? ''),
    query.sort || 'date_desc',
  ]
  return parts.join('|')
}

/** Deduping interval aligned with raid-detail / account-detail SWR. */
export const DISCOVERY_DEDUPING_MS = 60_000
