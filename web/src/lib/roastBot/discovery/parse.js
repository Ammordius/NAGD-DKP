/**
 * Compositional natural-language parser → StructuredQuery.
 * Deterministic; no I/O. Returns null when the message is not a discovery question.
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

const DEFAULT_LIMIT = 40
const RECIPIENT_LIMIT = 10

/** Matches when's / whens / when is / when was the last time */
const WHEN_LAST_TIME_RE = /\bwhen('?s| is| was) the last time\b/

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
 * @param {string} text
 */
export function looksLikeDiscovery(text) {
  const t = normalizeDiscoveryText(text)
  if (!t || t.length < 6) return false

  // Personal purchase / roast phrasing stays with existing handlers
  if (/\b(roast|my buys|my spending|why am i broke|what should i buy)\b/.test(t)) return false
  if (/\bwhat did i (buy|spend|get)\b/.test(t)) return false

  if (/\bwhat dropped\b/.test(t)) return true
  if (/\bwho got\b|\bwho won\b|\bwho received\b/.test(t)) return true
  if (/\bhow many times\b.*\b(drop|dropped|won|awarded)\b/.test(t)) return true
  if (/\bhow many times did\b/.test(t)) return true
  if (/\bhas \w+ ever (won|got|gotten|received)\b/.test(t)) return true
  if (WHEN_LAST_TIME_RE.test(t)) return true
  if (/\blast time\b.*\b(drop|dropped|in |pof|potime|p3|fire|time)\b/.test(t)) return true
  if (/\bwhat did \w+ get\b/.test(t)) return true
  if (/\bwhat can \w+ drop\b/.test(t)) return true
  if (/\bwhat dropped off\b/.test(t)) return true
  if (/\bdropped (last time|in p3|in potime|in time|in pof|in fire)\b/.test(t)) return true
  return false
}

/**
 * @param {string} raw
 * @param {{ nowIso?: string }} [opts]
 * @returns {import('./types.js').StructuredQuery|null}
 */
export function tryParseDiscovery(raw, opts = {}) {
  const text = normalizeDiscoveryText(raw)
  if (!looksLikeDiscovery(text)) return null

  const timeRange = extractTimeRange(text, opts.nowIso)
  const phase = resolvePhaseAlias(text)
  // Zone: avoid treating bare "time" inside "last time" as Plane of Time when no other zone cue
  let zone = extractZone(text, phase)
  const boss = extractBoss(text)
  const character = extractCharacter(text)
  const itemAlias = lookupItemAlias(text)
  // Named item aliases (Cloak of Wishes) must not inherit a slot from tokens inside the name.
  // Constrained aliases (caster shoulders) keep their slot.
  let slot =
    itemAlias?.name && !itemAlias.slot ? null : itemAlias?.slot || resolveSlotAlias(text)
  const classesHint =
    itemAlias?.classesHint || resolveClassesHint(text) || null
  let itemQuery = extractItemQuery(text, { phase, zone, boss, character, slot, classesHint })

  // Slot/role constrained phrases (e.g. "p3 priest shoulders") still need an itemQuery for resolve
  if (!itemQuery && (slot || classesHint)) {
    itemQuery = buildSlotConstrainedQuery(text, { phase, slot, classesHint })
  }

  /** @type {import('./types.js').StructuredQuery} */
  const base = {
    family: 'raid_loot',
    zone: zone || null,
    phase: phase || null,
    boss: boss || null,
    itemQuery: itemQuery || null,
    slot: slot || null,
    classesHint: classesHint || null,
    character: character || null,
    timeRange: timeRange || null,
    mostRecentRaidFirst: false,
    sort: 'date_desc',
    limit: DEFAULT_LIMIT,
    raw: String(raw || '').trim(),
  }

  // Catalog: what can BOSS drop?
  if (/\bwhat can\b/.test(text) && /\bdrop\b/.test(text) && boss) {
    return { ...base, family: 'boss_catalog', zone: zone || null, limit: DEFAULT_LIMIT }
  }

  // Historical boss: what dropped off BOSS?
  if (/\bdropped off\b|\bdrop(?:ped)? off\b/.test(text) && boss) {
    return {
      ...base,
      family: 'boss_raid_loot',
      mostRecentRaidFirst: true,
      limit: DEFAULT_LIMIT,
    }
  }

  // Has CHARACTER ever won ITEM?
  if (/\bhas\b.+\bever\b.+\b(won|got|gotten|received)\b/.test(text) && character && itemQuery) {
    return { ...base, family: 'has_won', limit: RECIPIENT_LIMIT }
  }

  // How many times did ITEM drop?
  if (/\bhow many times\b/.test(text) && (itemQuery || /\bdrop/.test(text))) {
    const fromTimes = text.match(/\bhow many times (?:did|has|have)\s+(.+?)\s+drop/)
    return {
      ...base,
      family: 'item_count',
      itemQuery: itemQuery || (fromTimes ? cleanItemFragment(fromTimes[1], {}) : null),
      limit: 1,
    }
  }

  // Who got (the last) ITEM?
  if (/\bwho (got|won|received)\b/.test(text)) {
    const last = /\bthe last\b|\blast\b/.test(text)
    return {
      ...base,
      family: last ? 'item_last' : 'item_recipients',
      itemQuery: itemQuery || extractAfterWhoGot(text),
      limit: RECIPIENT_LIMIT,
    }
  }

  // When's the last time ITEM dropped? (slot/role-qualified → item_last, never bare phase raid_loot)
  if (WHEN_LAST_TIME_RE.test(text) && (itemQuery || slot || classesHint)) {
    return {
      ...base,
      family: 'item_last',
      itemQuery: itemQuery || buildSlotConstrainedQuery(text, { phase, slot, classesHint }),
      limit: RECIPIENT_LIMIT,
    }
  }

  // What did CHARACTER get [time]?
  if (/\bwhat did\b/.test(text) && character && /\bget\b/.test(text)) {
    return { ...base, family: 'character_awards', limit: DEFAULT_LIMIT }
  }

  // What dropped last time in ZONE / in P3 / in Time?
  // Slot on the same utterance is a hard constraint → item award path, not full raid dump.
  if (/\bwhat dropped\b/.test(text) || /\bdropped last time\b/.test(text)) {
    if ((slot || classesHint) && (itemQuery || phase || zone || slot)) {
      return {
        ...base,
        family: 'item_last',
        itemQuery: itemQuery || buildSlotConstrainedQuery(text, { phase, slot, classesHint }),
        limit: RECIPIENT_LIMIT,
      }
    }
    if (boss && !phase && !zone) {
      return {
        ...base,
        family: 'boss_raid_loot',
        mostRecentRaidFirst: true,
        limit: DEFAULT_LIMIT,
      }
    }
    if (phase || zone) {
      // Explicit calendar window → all awards in range; else most recent qualifying raid night
      const lastTimeCue = /\blast time\b/.test(text)
      return {
        ...base,
        family: 'raid_loot',
        mostRecentRaidFirst: lastTimeCue || !timeRange,
        limit: DEFAULT_LIMIT,
      }
    }
  }

  // Fallback: if we have enough entities, treat as raid_loot / item_recipients
  if (itemQuery && character) return { ...base, family: 'has_won', limit: RECIPIENT_LIMIT }
  if (itemQuery || slot || classesHint) {
    return {
      ...base,
      family: 'item_recipients',
      itemQuery: itemQuery || buildSlotConstrainedQuery(text, { phase, slot, classesHint }),
      limit: RECIPIENT_LIMIT,
    }
  }
  // Never dump full phase/zone raid loot when a gear slot/role was specified
  if ((zone || phase) && /\bdrop/.test(text) && !slot && !classesHint) {
    return { ...base, family: 'raid_loot', mostRecentRaidFirst: !timeRange, limit: DEFAULT_LIMIT }
  }

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
  return resolveBossAlias(t)
}

/**
 * @param {string} text
 */
function extractCharacter(text) {
  const t = normalizeDiscoveryText(text)
  const has = t.match(/\bhas\s+([a-z][a-z0-9']{2,24})\s+ever\b/)
  if (has) return capitalizeName(has[1])
  const did = t.match(/\bwhat did\s+([a-z][a-z0-9']{2,24})\s+get\b/)
  if (did) return capitalizeName(did[1])
  return null
}

/**
 * @param {string} text
 * @param {{ phase?: string|null, zone?: string|null, boss?: string|null, character?: string|null, slot?: string|null }} ctx
 */
function extractItemQuery(text, ctx) {
  const t = normalizeDiscoveryText(text)
  const alias = lookupItemAlias(t)
  if (alias?.name) return alias.name
  if (alias?.alias && (alias.slot || alias.classesHint)) {
    // Leave constrained phrase for resolve.js
    return alias.alias
  }

  const who = t.match(/\bwho (?:got|won|received)(?:\s+the\s+last)?\s+(.+?)(?:\s*\?|$)/)
  if (who) return cleanItemFragment(who[1], ctx)

  const when = t.match(/\bwhen(?:'?s| is| was)? the last time\s+(.+?)\s+dropped\b/)
  if (when) return cleanItemFragment(when[1], ctx)

  const times = t.match(/\bhow many times (?:did|has|have)\s+(.+?)\s+drop/)
  if (times) return cleanItemFragment(times[1], ctx)

  const ever = t.match(/\bever (?:won|got|gotten|received)\s+(.+?)(?:\s*\?|$)/)
  if (ever) return cleanItemFragment(ever[1], ctx)

  return null
}

/**
 * @param {string} frag
 * @param {{ phase?: string|null, zone?: string|null, boss?: string|null, character?: string|null }} ctx
 */
function cleanItemFragment(frag, ctx) {
  let s = normalizeDiscoveryText(frag)
  s = s.replace(/\b(the last|last)\b/g, ' ')
  s = s.replace(/\b(drop|dropped|award|awarded)\b/g, ' ')
  if (ctx.character) {
    s = s.replace(new RegExp(`\\b${escapeRe(normAliasKey(ctx.character))}\\b`, 'g'), ' ')
  }
  s = s.replace(/\s+/g, ' ').trim()
  return s || null
}

function extractAfterWhoGot(text) {
  const m = normalizeDiscoveryText(text).match(/\bwho (?:got|won|received)(?:\s+the\s+last)?\s+(.+)/)
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
