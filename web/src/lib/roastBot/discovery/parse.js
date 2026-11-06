/**
 * Compositional natural-language parser → StructuredQuery + Recognition.
 * Deterministic; no I/O. Intent + entities + filters; family is derived.
 */

import {
  resolveZoneAlias,
  resolvePhaseAlias,
  resolveBossAlias,
  resolveSlotAlias,
  resolveClassesHint,
  lookupItemAlias,
  normAliasKey,
} from './aliases.js'
import { extractMoldItemQuery, looksLikeMoldPhrase } from './molds.js'

const DEFAULT_LIMIT = 40
const RECIPIENT_LIMIT = 10

/** Matches when's / whens / when is / when was the last time */
const WHEN_LAST_TIME_RE = /\bwhen('?s| is| was) the last time\b/
const WHEN_DID_RE = /\bwhen did\b/

/**
 * Normalize for matching (keep words).
 * @param {string} text
 */
export function normalizeDiscoveryText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')
    // Apostrophe-less "whens" must match when's extractors (looksLikeDiscovery already accepted it)
    .replace(/\bwhens\b/g, "when's")
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * @param {string} [nowIso]
 * @returns {{ fromIso: string, toIso: string, label: string }|null}
 */
export function extractTimeRange(text, nowIso) {
  const t = normalizeDiscoveryText(text)
  const now = nowIso ? new Date(nowIso) : new Date()
  if (Number.isNaN(now.getTime())) return null
  const toIso = now.toISOString().slice(0, 10)

  if (/\byesterday\b/.test(t)) {
    const from = new Date(now)
    from.setUTCDate(from.getUTCDate() - 1)
    const day = from.toISOString().slice(0, 10)
    return { fromIso: day, toIso: day, label: 'yesterday' }
  }
  if (/\blast week\b|\bpast week\b|\bthis past week\b/.test(t)) {
    const from = new Date(now)
    from.setUTCDate(from.getUTCDate() - 7)
    return { fromIso: from.toISOString().slice(0, 10), toIso, label: 'last week' }
  }
  if (/\blast month\b|\bpast month\b|\bthis past month\b/.test(t)) {
    const from = new Date(now)
    from.setUTCDate(from.getUTCDate() - 31)
    return { fromIso: from.toISOString().slice(0, 10), toIso, label: 'last month' }
  }
  if (/\blast year\b|\bpast year\b/.test(t)) {
    const from = new Date(now)
    from.setUTCFullYear(from.getUTCFullYear() - 1)
    return { fromIso: from.toISOString().slice(0, 10), toIso, label: 'last year' }
  }
  return null
}

/**
 * True when the utterance looks like guild loot/history discovery (not personal roast).
 * Prefer recognizeDiscovery for new call sites — this remains a thin compatibility shim.
 * @param {string} text
 * @param {{ prev?: import('./types.js').StructuredQuery|null }} [opts]
 */
export function looksLikeDiscovery(text, opts = {}) {
  const r = recognizeDiscovery(text, opts)
  return r.status === 'recognized' || r.status === 'ambiguous' || r.status === 'unsupported'
}

/**
 * Unified recognition outcome.
 * @param {string} raw
 * @param {{
 *   nowIso?: string,
 *   prev?: import('./types.js').StructuredQuery|null,
 *   prevPrimary?: { itemName?: string|null, characterName?: string|null, raidId?: string|null, dateIso?: string|null }|null,
 * }} [opts]
 * @returns {import('./types.js').Recognition}
 */
export function recognizeDiscovery(raw, opts = {}) {
  const text = normalizeDiscoveryText(raw)
  if (!text || text.length < 2) return { status: 'not_discovery' }

  if (isPersonalRoast(text)) return { status: 'not_discovery' }

  // Follow-up delta against prior discovery query
  if (opts.prev) {
    const merged = tryMergeFollowUp(text, opts.prev, opts.prevPrimary || null, opts.nowIso)
    if (merged?.status) return merged
  }

  const entities = extractEntities(text, opts.nowIso)
  const intentCue = detectIntentCue(text)
  const hasEntity =
    Boolean(entities.boss || entities.zone || entities.phase || entities.slot || entities.character) ||
    Boolean(entities.itemQuery) ||
    Boolean(entities.classesHint)

  // Fragment with no prior and no intent cue → not discovery (unless boss+slot / last+entity)
  const fragmentOk =
    hasEntity &&
    (/\b(last|latest|most recent|drop|dropped|looted|won|got|received|loot|award|awarded|ring|rings)\b/.test(
      text,
    ) ||
      Boolean(entities.boss && entities.slot) ||
      Boolean(entities.phase && entities.slot) ||
      /^\s*last\b/.test(text) ||
      /\bwhat about\b|\bhow about\b/.test(text))

  if (!intentCue && !fragmentOk) {
    return { status: 'not_discovery' }
  }

  // Item-source phrasing stays with the non-discovery ITEM_SOURCE handler
  if (/\bwhere\b.+\bdrop/.test(text) || /\bdrops?\s+(from|in|off)\b/.test(text)) {
    if (!/\bwhat (dropped|can)\b/.test(text) && !WHEN_LAST_TIME_RE.test(text) && !WHEN_DID_RE.test(text)) {
      return { status: 'not_discovery' }
    }
  }

  const built = buildQueryFromEntities(text, entities, intentCue)
  if (!built) {
    if (intentCue || fragmentOk) {
      return {
        status: 'unsupported',
        reason: 'I recognized a loot question but could not build a safe query from that phrasing.',
        missing: ['filters'],
      }
    }
    return { status: 'not_discovery' }
  }

  return { status: 'recognized', query: built }
}

/**
 * @param {string} raw
 * @param {{ nowIso?: string, prev?: import('./types.js').StructuredQuery|null, prevPrimary?: object|null }} [opts]
 * @returns {import('./types.js').StructuredQuery|null}
 */
export function tryParseDiscovery(raw, opts = {}) {
  const r = recognizeDiscovery(raw, opts)
  if (r.status === 'recognized' && r.query) return r.query
  return null
}

/**
 * @param {string} text
 */
function isPersonalRoast(text) {
  if (/\b(roast|my buys|my spending|why am i broke|what should i buy)\b/.test(text)) return true
  if (/\bwhat did i (buy|spend|get)\b/.test(text)) return true
  // Item→roster fit questions must not merge onto prior loot discovery (e.g. Quarm rings).
  if (isItemFitUtterance(text)) return true
  return false
}

/** Keep in sync with intents.ITEM_FIT_PATTERNS (discovery must not import conversation cycle). */
function isItemFitUtterance(text) {
  const t = String(text || '').toLowerCase()
  if (/which of my (toons|characters|alts) could use/.test(t)) return true
  if (/which (toon|character|alt).{0,40}(could use|needs)/.test(t)) return true
  if (/who (?:of my .{0,40} )?(needs|could use) (this|that|it)/.test(t)) return true
  if (/\bwho needs (this|that|it)\b/.test(t)) return true
  if (/is (this|that|it) an? upgrade/.test(t)) return true
  if (/could (any of )?my (toons|characters|alts) use/.test(t)) return true
  return false
}

/**
 * @param {string} text
 * @returns {string|null} cue tag
 */
/** Conservative verb-typo set for recipient cues only (not item fuzzy match). */
const WHO_GOT_RE = /\bwho (got|won|received|go|gott|looted)\b/

function hasLastTemporalCue(text) {
  return /\bthe last\b|\blast\b|\bmost recent\b|\blatest\b/.test(text)
}

function detectIntentCue(text) {
  if (/\bwhat can\b/.test(text) && /\bdrop\b/.test(text)) return 'catalog'
  if (/\bhow many times\b/.test(text) || /\bhow many times was\b.+\bawarded\b/.test(text)) return 'count'
  if (/^\s*show\b.+\b(raid|loot)\b/.test(text) || /\blast\b.+\braid\b/.test(text)) return 'what_dropped'
  if (/\bhas\b.+\bever\b.+\b(won|got|gotten|received)\b/.test(text)) return 'has_won'
  if (/\bdid\s+\w+\s+ever\s+(get|got|win|won|receive)\b/.test(text)) return 'has_won'
  if (WHO_GOT_RE.test(text)) return 'who_got'
  if (WHEN_LAST_TIME_RE.test(text) || WHEN_DID_RE.test(text)) return 'when_last'
  // "what did Quarm drop last time" — boss drop, not character awards
  if (/\bwhat did\b.+\bdrop\b/.test(text)) return 'what_dropped'
  if (/\blast time\b.*\b(drop|dropped|in |pof|potime|p3|fire|time)\b/.test(text)) return 'what_dropped'
  if (/\bdrop(?:ped)?\b.*\blast time\b/.test(text)) return 'what_dropped'
  if (/\bwhat (?:was |were )?(?:dropped|looted)\b/.test(text) || /\b(?:dropped|looted) (last time|in p3|in potime|in time|in pof|in fire)\b/.test(text)) {
    return 'what_dropped'
  }
  if (/\bdropped off\b|\bdrop(?:ped)? off\b/.test(text)) return 'dropped_off'
  if (/\bwhat did\b.+\bget\b/.test(text) || /\bwhat has\b.+\bwon\b/.test(text)) return 'character_awards'
  // "last Quarm loot" / "last PoF loot" — raid-night style
  if (/^\s*last\b/.test(text) && /\bloot\b/.test(text)) return 'what_dropped'
  if (/\blast (drop|award|time)\b/.test(text)) return 'when_last'
  // "most recent X" / "latest X" / "last plate bp" item fragments
  if (
    (/^\s*(most recent|latest|last)\b/.test(text) || /\b(most recent|latest)\b/.test(text)) &&
    (looksLikeMoldPhrase(text) ||
      lookupItemAlias(text)?.name ||
      /\b(drop|ring|award|shoulder|arm|leg|boot|wrist|neck|ear|face|back|waist|hand|finger|bp|robe|mold|pattern|cloak)\b/.test(
        text,
      ))
  ) {
    return 'when_last'
  }
  if (/^\s*last\b/.test(text) && /\b(drop|ring|award|shoulder|arm|leg|boot|wrist|neck|ear|face|back|waist|hand|finger|bp|robe|mold|pattern)\b/.test(text)) {
    return 'when_last'
  }
  if (/\bdid\b.+\bdrop(?:ped)?\s+recently\b|\bdrop(?:ped)?\s+recently\b/.test(text)) return 'when_last'
  if (/\bwhat about\b|\bhow about\b/.test(text)) return 'what_about'
  return null
}

/**
 * @param {string} text
 * @param {string} [nowIso]
 */
function extractEntities(text, nowIso) {
  const timeRange = extractTimeRange(text, nowIso)
  const phase = resolvePhaseAlias(text)
  const zone = extractZone(text, phase)
  const boss = extractBoss(text)
  const character = extractCharacter(text)
  const itemAlias = lookupItemAlias(text)
  const moldQuery = extractMoldItemQuery(text)
  let slot =
    itemAlias?.name && !itemAlias.slot ? null : itemAlias?.slot || resolveSlotAlias(text)
  const classesHint = itemAlias?.classesHint || resolveClassesHint(text) || null
  let itemQuery =
    moldQuery ||
    extractItemQuery(text, { phase, zone, boss, character, slot, classesHint })

  // Strip boss name tokens from itemQuery when boss was also extracted (avoid "quarm" as item)
  if (itemQuery && boss && !looksLikeMoldPhrase(itemQuery)) {
    const bossKey = normAliasKey(boss)
    itemQuery = itemQuery
      .split(/\s+/)
      .filter((w) => normAliasKey(w) !== bossKey && w !== 'a' && w !== 'an' && w !== 'the')
      .join(' ')
      .trim() || null
  }

  // Slot-only fragment left in itemQuery (e.g. "ring") — prefer slot filter, clear itemQuery
  // Keep mold phrases ("silk arms", "plate bp") intact for mold resolution.
  if (itemQuery && slot && !looksLikeMoldPhrase(itemQuery) && !moldQuery) {
    const onlySlot = resolveSlotAlias(itemQuery) === slot && !lookupItemAlias(itemQuery)?.name
    if (onlySlot || normAliasKey(itemQuery) === normAliasKey(String(slot))) {
      itemQuery = null
    }
  }

  // "finger" / "ring" alone after clean → slot
  if (!slot && itemQuery && !looksLikeMoldPhrase(itemQuery)) {
    const asSlot = resolveSlotAlias(itemQuery)
    if (asSlot && !lookupItemAlias(itemQuery)?.name && itemQuery.split(/\s+/).length <= 2) {
      slot = asSlot
      itemQuery = null
    }
  }

  if (!itemQuery && (slot || classesHint) && !boss) {
    // Keep constrained phrase for phase+slot resolve path
    itemQuery = buildSlotConstrainedQuery(text, { phase, slot, classesHint })
  }

  return {
    timeRange,
    phase: phase || null,
    zone: zone || null,
    boss: boss || null,
    character: character || null,
    slot: slot || null,
    classesHint,
    itemQuery: itemQuery || null,
    itemAlias,
  }
}

/**
 * @param {string} text
 * @param {ReturnType<typeof extractEntities>} entities
 * @param {string|null} cue
 * @returns {import('./types.js').StructuredQuery|null}
 */
function buildQueryFromEntities(text, entities, cue) {
  const {
    timeRange,
    phase,
    zone,
    boss,
    character,
    slot,
    classesHint,
    itemQuery,
  } = entities

  const base = {
    zone,
    phase,
    boss,
    itemQuery,
    slot,
    classesHint,
    character,
    timeRange: timeRange || null,
    mostRecentRaidFirst: false,
    sort: /** @type {const} */ ('date_desc'),
    limit: DEFAULT_LIMIT,
    raw: String(text || '').trim(),
    refs: null,
  }

  // Catalog: what can BOSS drop?
  if (cue === 'catalog' && boss) {
    return finalizeQuery({
      ...base,
      intent: 'catalog',
      scope: 'history',
      limit: DEFAULT_LIMIT,
    })
  }

  // Has CHARACTER ever won ITEM? / did CHAR ever get ITEM?
  if (cue === 'has_won' && character && (itemQuery || slot)) {
    return finalizeQuery({
      ...base,
      intent: 'has_won',
      scope: 'history',
      itemQuery: itemQuery || buildSlotConstrainedQuery(text, { phase, slot, classesHint }),
      limit: RECIPIENT_LIMIT,
    })
  }

  // How many times did ITEM drop?
  if (cue === 'count' && (itemQuery || slot)) {
    const fromTimes = text.match(/\bhow many times (?:did|has|have)\s+(.+?)\s+drop/)
    return finalizeQuery({
      ...base,
      intent: 'count',
      scope: 'history',
      itemQuery: itemQuery || (fromTimes ? cleanItemFragment(fromTimes[1], {}) : null),
      limit: 1,
    })
  }

  // Who got (the last / most recent) ITEM?
  if (cue === 'who_got') {
    const last = hasLastTemporalCue(text)
    // Boss+slot without named item → last_award over catalog selector
    if (boss && (slot || classesHint) && !lookupItemAlias(text)?.name && !looksLikeMoldPhrase(text)) {
      return finalizeQuery({
        ...base,
        intent: last ? 'last_award' : 'recipients',
        scope: 'history',
        itemQuery: null,
        limit: RECIPIENT_LIMIT,
      })
    }
    return finalizeQuery({
      ...base,
      intent: last ? 'last_award' : 'recipients',
      scope: 'history',
      itemQuery: itemQuery || extractAfterWhoGot(text),
      limit: RECIPIENT_LIMIT,
    })
  }

  // When's the last time / when did … last drop
  if (cue === 'when_last') {
    // Boss + slot/role → historical awards for catalog intersection (not single fuzzy item)
    if (boss && (slot || classesHint) && !lookupItemAlias(text)?.name) {
      return finalizeQuery({
        ...base,
        intent: 'last_award',
        scope: 'history',
        itemQuery: null,
        limit: RECIPIENT_LIMIT,
      })
    }
    if (itemQuery || slot || classesHint || phase) {
      return finalizeQuery({
        ...base,
        intent: 'last_award',
        scope: 'history',
        itemQuery: itemQuery || buildSlotConstrainedQuery(text, { phase, slot, classesHint }),
        limit: RECIPIENT_LIMIT,
      })
    }
  }

  // What did CHARACTER get / what has CHARACTER won
  if (cue === 'character_awards' && character) {
    return finalizeQuery({
      ...base,
      intent: 'list_awards',
      scope: 'history',
      limit: DEFAULT_LIMIT,
    })
  }

  // Dropped off BOSS / what dropped … boss / last BOSS loot
  if ((cue === 'dropped_off' || cue === 'what_dropped') && boss && !slot && !classesHint) {
    return finalizeQuery({
      ...base,
      intent: 'list_awards',
      scope: 'last_raid_night',
      mostRecentRaidFirst: true,
      limit: DEFAULT_LIMIT,
    })
  }

  // What dropped last time in ZONE / P3 — with optional slot constraint
  if (cue === 'what_dropped' || cue === 'dropped_off') {
    if ((slot || classesHint) && (itemQuery || phase || zone || slot || boss)) {
      // Boss+slot history, or phase+slot last award
      if (boss && !phase) {
        return finalizeQuery({
          ...base,
          intent: 'last_award',
          scope: 'history',
          itemQuery: null,
          limit: RECIPIENT_LIMIT,
        })
      }
      return finalizeQuery({
        ...base,
        intent: 'last_award',
        scope: 'history',
        itemQuery: itemQuery || buildSlotConstrainedQuery(text, { phase, slot, classesHint }),
        limit: RECIPIENT_LIMIT,
      })
    }
    if (phase || zone) {
      const lastTimeCue = /\blast time\b/.test(text) || /^\s*last\b/.test(text)
      return finalizeQuery({
        ...base,
        intent: 'list_awards',
        scope: timeRange ? 'history' : 'last_raid_night',
        mostRecentRaidFirst: lastTimeCue || !timeRange,
        limit: DEFAULT_LIMIT,
      })
    }
  }

  // what about / fragmentary boss+slot / last quarm ring
  if (boss && (slot || classesHint) && !character) {
    return finalizeQuery({
      ...base,
      intent: 'last_award',
      scope: 'history',
      itemQuery: null,
      limit: RECIPIENT_LIMIT,
    })
  }

  // Fallback entity combinations
  if (itemQuery && character) {
    return finalizeQuery({
      ...base,
      intent: 'has_won',
      scope: 'history',
      limit: RECIPIENT_LIMIT,
    })
  }
  if (itemQuery || slot || classesHint) {
    return finalizeQuery({
      ...base,
      intent: 'recipients',
      scope: 'history',
      itemQuery: itemQuery || buildSlotConstrainedQuery(text, { phase, slot, classesHint }),
      limit: RECIPIENT_LIMIT,
    })
  }
  if ((zone || phase) && /\bdrop/.test(text) && !slot && !classesHint) {
    return finalizeQuery({
      ...base,
      intent: 'list_awards',
      scope: timeRange ? 'history' : 'last_raid_night',
      mostRecentRaidFirst: !timeRange,
      limit: DEFAULT_LIMIT,
    })
  }

  return null
}

/**
 * @param {object} partial
 * @returns {import('./types.js').StructuredQuery}
 */
function finalizeQuery(partial) {
  const intent = partial.intent
  const scope = partial.scope || 'history'
  const family = deriveFamily(intent, scope, partial)
  return {
    intent,
    scope,
    family,
    zone: partial.zone || null,
    phase: partial.phase || null,
    boss: partial.boss || null,
    itemQuery: partial.itemQuery || null,
    slot: partial.slot || null,
    classesHint: partial.classesHint || null,
    character: partial.character || null,
    timeRange: partial.timeRange || null,
    mostRecentRaidFirst: Boolean(partial.mostRecentRaidFirst),
    sort: 'date_desc',
    limit: partial.limit || DEFAULT_LIMIT,
    raw: partial.raw || '',
    refs: partial.refs || null,
  }
}

/**
 * @param {import('./types.js').DiscoveryIntent} intent
 * @param {import('./types.js').DiscoveryScope} scope
 * @param {object} filters
 * @returns {import('./types.js').DiscoveryFamily}
 */
export function deriveFamily(intent, scope, filters) {
  if (intent === 'catalog') return 'boss_catalog'
  if (intent === 'count') return 'item_count'
  if (intent === 'has_won') return 'has_won'
  if (intent === 'recipients') return 'item_recipients'
  if (intent === 'last_award') return 'item_last'
  // Character award history (optional zone/phase/slot filters applied later)
  if (intent === 'list_awards' && filters.character && scope === 'history' && !filters.boss) {
    return 'character_awards'
  }
  if (scope === 'last_raid_night' && filters.boss && !filters.slot) return 'boss_raid_loot'
  if (scope === 'last_raid_night' || ((filters.zone || filters.phase) && intent === 'list_awards')) return 'raid_loot'
  if (filters.character && scope === 'history') return 'character_awards'
  return 'item_recipients'
}

/**
 * Merge a fragment follow-up onto a previous StructuredQuery.
 * Parses the new utterance independently first; inherits only non-conflicting prior filters.
 * @param {string} text
 * @param {import('./types.js').StructuredQuery} prev
 * @param {object|null} primary
 * @param {string} [nowIso]
 * @returns {import('./types.js').Recognition|null}
 */
function tryMergeFollowUp(text, prev, primary, nowIso) {
  const t = normalizeDiscoveryText(text)
  if (isPersonalRoast(t)) return { status: 'not_discovery' }

  // Parse new text independently so molds/items are not invisible to merge.
  const entities = extractEntities(t, nowIso)
  const timeRange = entities.timeRange
  const phase = entities.phase
  const boss = entities.boss
  const slot = entities.slot
  const classesHint = entities.classesHint
  const character = entities.character || extractBareCharacterFollowUp(t)
  // Short follow-ups like "Actually, PoF." may not match "in PoF" extractors.
  const zone =
    entities.zone ||
    resolveZoneAlias(
      t
        .replace(/^(actually|how about|what about|and)\s+/i, '')
        .replace(/[?.!]+$/g, '')
        .trim(),
    )
  const pronoun = /\b(it|that|them)\b/.test(t)
  const whoGot = WHO_GOT_RE.test(t)
  const howMany = /\bhow many times\b/.test(t)
  const whatAbout = /\bwhat about\b|\bhow about\b|^and\b|\bactually\b/.test(t)
  const lastCue = hasLastTemporalCue(t)

  // Explicit item = mold phrase or named alias — not pronouns, not slot-only "finger"/"rings".
  const moldQ = extractMoldItemQuery(t)
  const aliasName = lookupItemAlias(t)?.name || entities.itemAlias?.name || null
  const rawItem = entities.itemQuery
  const isPronounItem = Boolean(rawItem && /^(it|that|them)$/i.test(String(rawItem).trim()))
  const explicitNewItem = Boolean(
    !isPronounItem &&
      (moldQ ||
        aliasName ||
        (rawItem && looksLikeMoldPhrase(rawItem)) ||
        (rawItem &&
          !resolveSlotAlias(rawItem) &&
          String(rawItem).trim().split(/\s+/).length >= 2 &&
          !/^(it|that|them)$/i.test(rawItem))),
  )
  const newItemQuery = aliasName || moldQ || (explicitNewItem ? rawItem : null)

  // Bare "Actually, PoF." / zone-only follow-ups — resolveZoneAlias on short replies
  const zoneOnlyFollowUp =
    !boss &&
    !slot &&
    !phase &&
    !character &&
    !explicitNewItem &&
    !whoGot &&
    !howMany &&
    Boolean(zone || resolveZoneAlias(t.replace(/^(actually|how about|what about)\s+/i, '').trim()))

  const onlyTime =
    Boolean(timeRange) &&
    !boss &&
    !slot &&
    !phase &&
    !zone &&
    !character &&
    !explicitNewItem &&
    !whoGot &&
    !howMany
  const onlySlot =
    Boolean(slot) &&
    !boss &&
    !phase &&
    !zone &&
    !character &&
    !explicitNewItem &&
    !whoGot &&
    !howMany
  const fragment =
    whatAbout ||
    onlyTime ||
    onlySlot ||
    whoGot ||
    howMany ||
    zoneOnlyFollowUp ||
    Boolean(character && /^and\b|\bwhat about\b|\bhow about\b/.test(t)) ||
    (pronoun && (whoGot || howMany || whatAbout))

  if (!fragment && !whoGot && !howMany) return null

  /** @type {import('./types.js').StructuredQuery} */
  let next = {
    ...prev,
    raw: String(text || '').trim(),
    timeRange: timeRange || prev.timeRange || null,
  }

  if (boss) {
    next.boss = boss
    if (!explicitNewItem) next.itemQuery = null
  }
  if (zone) {
    next.zone = zone
    if (!explicitNewItem) next.itemQuery = null
  }
  if (phase) {
    next.phase = phase
    next.zone = next.zone || 'Plane of Time'
    if (!explicitNewItem) next.itemQuery = null
  }

  // Explicit new item/mold replaces prior item identity (never silently keep old item).
  if (explicitNewItem) {
    next.itemQuery = newItemQuery
    next.slot = slot || null
    next.classesHint = classesHint || null
    // Named/mold item questions are about that item, not inherited boss raid scope.
    if (whoGot || whatAbout || looksLikeMoldPhrase(newItemQuery) || lookupItemAlias(newItemQuery)?.name) {
      next.boss = boss || null
      if (!boss) {
        // Keep zone/phase only when the new utterance restated them.
        if (!zone) next.zone = null
        if (!phase) next.phase = null
      }
    }
  } else if (slot) {
    next.slot = slot
    // Changing slot clears prior single-item binding
    next.itemQuery = null
  }

  if (classesHint && !explicitNewItem) next.classesHint = classesHint
  if (character) next.character = character
  if (timeRange) next.timeRange = timeRange

  if (whoGot) {
    next.intent = lastCue ? 'last_award' : 'recipients'
    next.scope = 'history'
    if (explicitNewItem) {
      // already set itemQuery above
    } else if (pronoun && primary?.itemName) {
      next.itemQuery = primary.itemName
      next.slot = null
    } else if (pronoun && prev.itemQuery) {
      next.itemQuery = prev.itemQuery
    }
    // who got without pronoun or new item: keep inherited itemQuery from prev
    next.limit = RECIPIENT_LIMIT
  } else if (howMany) {
    next.intent = 'count'
    next.scope = 'history'
    if (explicitNewItem) {
      // keep new item
    } else if (pronoun && primary?.itemName) next.itemQuery = primary.itemName
    else if (pronoun && prev.itemQuery) next.itemQuery = prev.itemQuery
    next.limit = 1
  } else if (onlyTime) {
    // Keep prior intent; widen to history window
    next.scope = 'history'
    next.mostRecentRaidFirst = false
  } else if (explicitNewItem && (whatAbout || looksLikeMoldPhrase(newItemQuery))) {
    next.intent = 'last_award'
    next.scope = 'history'
    next.limit = RECIPIENT_LIMIT
    next.mostRecentRaidFirst = false
  } else if (onlySlot || (whatAbout && slot && !explicitNewItem)) {
    next.intent = 'last_award'
    next.scope = 'history'
    next.limit = RECIPIENT_LIMIT
  } else if (character && prev.intent === 'list_awards') {
    next.intent = 'list_awards'
    next.scope = 'history'
  } else if (whatAbout && (boss || slot || phase || zone)) {
    if (zone && !boss && !slot && !phase && !explicitNewItem) {
      next.boss = null
      next.itemQuery = null
      next.intent = 'list_awards'
      next.scope = 'last_raid_night'
      next.mostRecentRaidFirst = true
    } else {
      next.intent = next.boss && next.slot ? 'last_award' : prev.intent
      next.scope = next.boss && next.slot ? 'history' : prev.scope
    }
  } else if (zoneOnlyFollowUp && zone) {
    next.zone = zone
    next.boss = null
    next.itemQuery = null
    next.intent = 'list_awards'
    next.scope = 'last_raid_night'
    next.mostRecentRaidFirst = true
  }

  next.family = deriveFamily(next.intent, next.scope, next)
  next.mostRecentRaidFirst = next.scope === 'last_raid_night'

  // User tried to name something (what about X) but we could not extract a replacement entity.
  if (
    whatAbout &&
    !explicitNewItem &&
    !boss &&
    !slot &&
    !phase &&
    !zone &&
    !character &&
    !timeRange &&
    !pronoun
  ) {
    return {
      status: 'unsupported',
      reason:
        'I could not tell which item, boss, zone, phase, slot, or character you meant. Name one explicitly.',
      missing: ['filters'],
    }
  }

  if (!next.boss && !next.zone && !next.phase && !next.slot && !next.itemQuery && !next.character) {
    return {
      status: 'unsupported',
      reason: 'I need a boss, zone, phase, item, slot, or character to continue that loot question.',
      missing: ['filters'],
    }
  }

  return { status: 'recognized', query: next }
}

function extractBareCharacterFollowUp(text) {
  const m = text.match(/^(?:and|what about|how about)\s+([a-z][a-z0-9']{2,24})\s*\??$/)
  if (m) return capitalizeName(m[1])
  return null
}

/**
 * @param {string} text
 * @param {{ phase?: string|null, slot?: string|null, classesHint?: string|null }} ctx
 */
function buildSlotConstrainedQuery(text, ctx) {
  const parts = []
  if (ctx.phase) parts.push(String(ctx.phase).toLowerCase())
  const role = ctx.classesHint || resolveClassesHint(text)
  if (role) parts.push(role)
  if (ctx.slot) parts.push(String(ctx.slot).toLowerCase())
  return parts.length ? parts.join(' ') : null
}

/**
 * @param {string} text
 * @param {string|null} phase
 */
function extractZone(text, phase) {
  const t = normalizeDiscoveryText(text)
  // "last Time loot" means Plane of Time raid loot — not the temporal idiom "last time"
  if (/\blast\s+time\s+loot\b/.test(t) || /\blast\s+plane of time\b/.test(t)) {
    return 'Plane of Time'
  }
  // Strip "last time" so bare "time" alias is not false-triggered by that phrase alone
  const stripped = t.replace(/\blast time\b/g, ' ').replace(/\s+/g, ' ').trim()

  // Explicit zone phrases
  const explicit = stripped.match(
    /\b(?:in|for)\s+(pof|potime|po time|po fire|plane of fire|plane of time|fire|time|vt|vex thal)\b/,
  )
  if (explicit) {
    const z = resolveZoneAlias(explicit[1])
    if (z) return z
  }

  // Phase implies Plane of Time zone context but phase is the filter — still set zone
  if (phase) return 'Plane of Time'

  // Broader alias scan on stripped text (avoid matching "time" only inside "last time")
  const z = resolveZoneAlias(stripped)
  if (z === 'Plane of Time' && !/\b(potime|po time|plane of time|\btime\b|pot)\b/.test(stripped)) {
    return null
  }
  // "fire" alone is risky; require cue
  if (z === 'Plane of Fire' && !/\b(pof|po fire|plane of fire|fire)\b/.test(stripped)) {
    return null
  }
  if (z) return z
  return null
}

/**
 * @param {string} text
 */
function extractBoss(text) {
  const t = normalizeDiscoveryText(text)
  const off = t.match(/\b(?:dropped off|drop(?:ped)? off|off)\s+([a-z][a-z0-9_ ']+?)(?:\s*\?|$)/)
  if (off) {
    const b = resolveBossAlias(off[1].trim())
    if (b) return b
  }
  const can = t.match(/\bwhat can\s+([a-z][a-z0-9_ ']+?)\s+drop\b/)
  if (can) {
    const b = resolveBossAlias(can[1].trim())
    if (b) return b
  }
  const whatDidDrop = t.match(/\bwhat did\s+([a-z][a-z0-9_ ']+?)\s+drop\b/)
  if (whatDidDrop) {
    const b = resolveBossAlias(whatDidDrop[1].trim())
    if (b) return b
  }
  const whenDid = t.match(/\bwhen did\s+([a-z][a-z0-9_ ']+?)\s+last\s+drop\b/)
  if (whenDid) {
    const b = resolveBossAlias(whenDid[1].trim())
    if (b) return b
  }
  return resolveBossAlias(t)
}

/**
 * @param {string} text
 */
function extractCharacter(text) {
  const t = normalizeDiscoveryText(text)
  const has = t.match(/\bhas\s+([a-z][a-z0-9']{2,24})\s+ever\b/)
  if (has) return capitalizeName(has[1])
  const didEver = t.match(/\bdid\s+([a-z][a-z0-9']{2,24})\s+ever\b/)
  if (didEver) return capitalizeName(didEver[1])
  const did = t.match(/\bwhat did\s+([a-z][a-z0-9']{2,24})\s+get\b/)
  if (did) return capitalizeName(did[1])
  const whatHas = t.match(/\bwhat has\s+([a-z][a-z0-9']{2,24})\s+won\b/)
  if (whatHas) return capitalizeName(whatHas[1])
  return null
}

/**
 * @param {string} text
 * @param {{ phase?: string|null, zone?: string|null, boss?: string|null, character?: string|null, slot?: string|null, classesHint?: string|null }} ctx
 */
function extractItemQuery(text, ctx) {
  const t = normalizeDiscoveryText(text)
  const alias = lookupItemAlias(t)
  if (alias?.name) return alias.name
  if (alias?.alias && (alias.slot || alias.classesHint)) {
    // Leave constrained phrase for resolve.js
    return alias.alias
  }

  const moldQ = extractMoldItemQuery(t)
  if (moldQ) return moldQ

  const who = t.match(
    /\bwho (?:got|won|received|go|gott|looted)(?:\s+the)?(?:\s+(?:last|most recent|latest))?\s+(.+?)(?:\s*\?|$)/,
  )
  if (who) return cleanItemFragment(who[1], ctx)

  const whoMostRecently = t.match(
    /\bwho (?:got|won|received|looted)\s+(.+?)\s+most recently\b/,
  )
  if (whoMostRecently) return cleanItemFragment(whoMostRecently[1], ctx)

  const latestRecipient = t.match(/^\s*(?:latest|most recent)\s+(.+?)\s+recipient\b/)
  if (latestRecipient) return cleanItemFragment(latestRecipient[1], ctx)

  const timesAwarded = t.match(/\bhow many times was\s+(.+?)\s+awarded\b/)
  if (timesAwarded) return cleanItemFragment(timesAwarded[1], ctx)

  const when = t.match(/\bwhen(?:'?s| is| was)? the last time\s+(.+?)\s+dropped\b/)
  if (when) return cleanItemFragment(when[1], ctx)

  // "when did silk arms last drop" — item before last drop (boss pattern already tried)
  const whenDidItemLast = t.match(/\bwhen did\s+(.+?)\s+last\s+drop\b/)
  if (whenDidItemLast && !ctx.boss) {
    const frag = cleanItemFragment(whenDidItemLast[1], ctx)
    if (frag && (looksLikeMoldPhrase(frag) || frag.split(/\s+/).length >= 2)) return frag
  }

  const whenDidDrop = t.match(/\bwhen did\s+.+?\s+last\s+drop\s+(.+?)(?:\s*\?|$)/)
  if (whenDidDrop) return cleanItemFragment(whenDidDrop[1], ctx)

  const times = t.match(/\bhow many times (?:did|has|have)\s+(.+?)\s+drop/)
  if (times) return cleanItemFragment(times[1], ctx)

  const ever = t.match(/\bever (?:won|got|gotten|received|get)\s+(.+?)(?:\s*\?|$)/)
  if (ever) return cleanItemFragment(ever[1], ctx)

  const whatAbout = t.match(/\bwhat about\s+(.+?)(?:\s*\?|$)/)
  if (whatAbout) {
    const frag = cleanItemFragment(whatAbout[1], ctx)
    if (frag && looksLikeMoldPhrase(frag)) return frag
  }

  // "last quarm ring" / "what about quarm ring" — leave itemQuery null; boss+slot handle it
  if (ctx.boss && ctx.slot) return null

  return null
}

/**
 * @param {string} frag
 * @param {{ phase?: string|null, zone?: string|null, boss?: string|null, character?: string|null }} ctx
 */
function cleanItemFragment(frag, ctx) {
  let s = normalizeDiscoveryText(frag)
  s = s.replace(/\b(the last|last|most recent|latest)\b/g, ' ')
  s = s.replace(/\b(drop|dropped|award|awarded)\b/g, ' ')
  if (ctx.character) {
    s = s.replace(new RegExp(`\\b${escapeRe(normAliasKey(ctx.character))}\\b`, 'g'), ' ')
  }
  if (ctx.boss) {
    s = s.replace(new RegExp(`\\b${escapeRe(normAliasKey(ctx.boss))}\\b`, 'g'), ' ')
  }
  s = s.replace(/\s+/g, ' ').trim()
  return s || null
}

function extractAfterWhoGot(text) {
  const t = normalizeDiscoveryText(text)
  const mostRecently = t.match(/\bwho (?:got|won|received|looted)\s+(.+?)\s+most recently\b/)
  if (mostRecently) return cleanItemFragment(mostRecently[1], {})
  const m = t.match(
    /\bwho (?:got|won|received|go|gott|looted)(?:\s+the)?(?:\s+(?:last|most recent|latest))?\s+(.+)/,
  )
  return m ? cleanItemFragment(m[1], {}) : null
}

function capitalizeName(name) {
  const s = String(name || '')
  if (!s) return null
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
