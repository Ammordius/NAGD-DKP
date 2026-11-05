/**
 * Typed shapes for the deterministic loot discovery engine.
 * JSDoc only — no runtime classes.
 */

/**
 * @typedef {'raid_loot'|'item_recipients'|'item_count'|'character_awards'|'boss_catalog'|'boss_raid_loot'|'has_won'|'item_last'} DiscoveryFamily
 */

/**
 * @typedef {{
 *   fromIso?: string|null,
 *   toIso?: string|null,
 *   label?: string|null,
 * }} DiscoveryTimeRange
 */

/**
 * @typedef {{
 *   family: DiscoveryFamily,
 *   zone?: string|null,
 *   phase?: string|null,
 *   boss?: string|null,
 *   itemQuery?: string|null,
 *   slot?: string|null,
 *   classesHint?: 'caster'|'priest'|'tank'|'melee'|string|null,
 *   character?: string|null,
 *   timeRange?: DiscoveryTimeRange|null,
 *   mostRecentRaidFirst?: boolean,
 *   sort?: 'date_desc',
 *   limit?: number,
 *   raw: string,
 * }} StructuredQuery
 */

/**
 * @typedef {{
 *   op: string,
 *   params: Record<string, unknown>,
 * }} QueryOp
 */

/**
 * @typedef {{
 *   ops: QueryOp[],
 *   query: StructuredQuery,
 *   notes?: string[],
 * }} QueryPlan
 */

/**
 * @typedef {{
 *   id?: string|number|null,
 *   raidId: string,
 *   raidName?: string|null,
 *   dateIso?: string|null,
 *   itemName: string,
 *   characterName?: string|null,
 *   charId?: string|null,
 *   assignedCharacterName?: string|null,
 *   cost?: string|number|null,
 *   phaseMob?: string|null,
 *   bossMob?: string|null,
 *   bossQualified?: boolean,
 * }} LedgerAward
 */

/**
 * @typedef {{
 *   ok: boolean,
 *   family: DiscoveryFamily|string,
 *   query: StructuredQuery,
 *   raid?: { raidId: string, raidName?: string|null, dateIso?: string|null }|null,
 *   awards?: LedgerAward[],
 *   totalCount?: number|null,
 *   truncated?: boolean,
 *   catalogItems?: Array<{ name: string, itemId?: string|number|null }>,
 *   gaps?: string[],
 *   notes?: string[],
 *   ambiguous?: { kind: string, candidates: string[], message: string }|null,
 *   error?: string|null,
 * }} DiscoveryResult
 */

export {}
