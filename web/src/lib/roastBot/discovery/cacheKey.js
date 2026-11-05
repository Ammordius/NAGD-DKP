/**
 * Stable SWR / memory cache keys for discovery queries.
 */

/**
 * @param {import('./types.js').StructuredQuery} query
 * @param {{ item?: { itemId?: string|null, id?: string|null }|null, itemSelector?: { names?: Set<string>|string[] }|null }|null} [resolved]
 * @returns {[string, string]}
 */
export function discoverySwrKey(query, resolved = null) {
  return ['loot-discovery', fingerprintQuery(query, resolved)]
}

/**
 * Fingerprint every result-affecting constraint, including resolved item id / selector names.
 * @param {import('./types.js').StructuredQuery} query
 * @param {{ item?: { itemId?: string|null, id?: string|null }|null, itemSelector?: { names?: Set<string>|string[] }|null }|null} [resolved]
 */
export function fingerprintQuery(query, resolved = null) {
  const itemId = resolved?.item?.itemId || resolved?.item?.id || ''
  const selectorNames = resolved?.itemSelector?.names
    ? [...resolved.itemSelector.names].map((n) => String(n).toLowerCase()).sort().join(',')
    : ''
  const parts = [
    query.intent || query.family || '',
    query.scope || (query.mostRecentRaidFirst ? 'last_raid_night' : 'history'),
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
    String(itemId),
    selectorNames,
  ]
  return parts.join('|')
}

/** Deduping interval aligned with raid-detail / account-detail SWR. */
export const DISCOVERY_DEDUPING_MS = 60_000
