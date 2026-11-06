/**
 * Typed shapes for the deterministic loot discovery engine.
 * JSDoc only — no runtime classes.
 */

/**
 * What kind of answer to produce.
 * @typedef {'last_award'|'recipients'|'list_awards'|'count'|'has_won'|'catalog'} DiscoveryIntent
 */

/**
 * Whether to pin to the most recent qualifying raid night or search award history.
 * @typedef {'last_raid_night'|'history'} DiscoveryScope
 */

/**
 * Legacy family label derived from intent+scope+filters (render/cache compatibility).
 * @typedef {'raid_loot'|'item_recipients'|'item_count'|'character_awards'|'boss_catalog'|'boss_raid_loot'|'has_won'|'item_last'} DiscoveryFamily
 */

/**
 * @typedef {'recognized'|'ambiguous'|'unsupported'|'not_discovery'} RecognitionStatus
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
 *   intent: DiscoveryIntent,
 *   scope: DiscoveryScope,
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
 *   refs?: { pronoun?: 'it'|'that'|'them'|null }|null,
 * }} StructuredQuery
 */

/**
 * @typedef {{
 *   status: RecognitionStatus,
 *   query?: StructuredQuery|null,
 *   reason?: string|null,
 *   missing?: string[],
 * }} Recognition
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
 *   assignedCharId?: string|null,
 *   assignedCharacterName?: string|null,
 *   className?: string|null,
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
