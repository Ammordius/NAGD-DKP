/**
 * Keyword / phrase intent matcher for the DKP Inquisitor.
 * Character/class/item entity resolution is separate from intent detection.
 */

export const INTENTS = {
  GREETING: 'greeting',
  GENERAL_ROAST: 'general_roast',
  SPENDING_ROAST: 'spending_roast',
  BALANCE: 'balance',
  WHY_BROKE: 'why_broke',
  PURCHASE_HISTORY: 'purchase_history',
  WORST_PURCHASE: 'worst_purchase',
  CHARACTERS: 'characters',
  CHARACTER_ROAST: 'character_roast',
  /** Total DKP spent on a named character (character_dkp_spent / loot attribution). */
  CHARACTER_DKP_SPENT: 'character_dkp_spent',
  /** Magelo class-coverage viability (officer Raider Activity Quarm-eligible rule). */
  QUARM_ELIGIBILITY: 'quarm_eligibility',
  /** Exact Magelo sheet stats from class_rankings.json. */
  CHARACTER_STATS: 'character_stats',
  ITEM_SEARCH: 'item_search',
  ITEM_PRICE: 'item_price',
  ITEM_SOURCE: 'item_source',
  UPGRADES: 'upgrades',
  /** Item → roster: which linked toons can use / upgrade with a given item. */
  ITEM_FIT: 'item_fit',
  GEAR_ASSESSMENT: 'gear_assessment',
  AFFORDABILITY: 'affordability',
  ATTENDANCE: 'attendance',
  ACCOUNT_COMPARISON: 'account_comparison',
  DKP_EXPLAIN: 'dkp_explain',
  CAPABILITIES: 'capabilities',
  DEFENSE: 'defense',
  FOLLOWUP: 'followup',
  FULL_GEAR_COST: 'full_gear_cost',
  LOOT_DISCOVERY: 'loot_discovery',
  WHO_IS: 'who_is',
  UNKNOWN: 'unknown',
}

/** Phrases that ask which account toons benefit from a sticky/named item (not loot history). */
export const ITEM_FIT_PATTERNS = [
  /which of my (toons|characters|alts) could use/,
  /which (toon|character|alt).{0,40}(could use|needs)/,
  /who (?:of my .{0,40} )?(needs|could use) (this|that|it)/,
  /\bwho needs (this|that|it)\b/,
  /is (this|that|it) an? upgrade/,
  /could (any of )?my (toons|characters|alts) use/,
]

/** @param {string} text already normalized lowercase */
export function isItemFitQuestion(text) {
  const t = String(text || '').toLowerCase()
  return ITEM_FIT_PATTERNS.some((p) => p.test(t))
}

/** Intents that need a specific character when the account has multiple. */
export const CHARACTER_SCOPED_INTENTS = new Set([
  INTENTS.UPGRADES,
  INTENTS.GEAR_ASSESSMENT,
  INTENTS.CHARACTER_ROAST,
  INTENTS.CHARACTER_DKP_SPENT,
  INTENTS.QUARM_ELIGIBILITY,
  INTENTS.CHARACTER_STATS,
])

/** Intents that “what/how about &lt;name&gt;?” may reuse with a new subject. */
export const CHARACTER_SWAP_REPEATABLE_INTENTS = new Set([
  ...CHARACTER_SCOPED_INTENTS,
  INTENTS.WHO_IS,
])

/** @param {string} text already normalized lowercase */
export const CHARACTER_DKP_SPENT_PATTERNS = [
  /how much dkp .{0,40}\bspent\b/,
  /\bdkp (has been |was |been )?spent\b/,
  /\btotal dkp spent\b/,
  /\bspent on\b/,
  /\bhow much .{0,20}\bspent on\b/,
  /\bdkp spent (on|for)\b/,
]

/** @param {string} text already normalized lowercase */
export const QUARM_ELIGIBILITY_PATTERNS = [
  /\bquarm\s+eligib/,
  /\beligib\w*\s+(for\s+)?quarm\b/,
  /\braid[- ]?ready\b/,
  /\braid\s+viable\b/,
  /\bviable\s+geared\b/,
  /\bclass\s+coverage\b/,
  /\bclass\s+ranking\b/,
  /\b(green|display)\s+(raid\s+)?(toon|status|pill)\b/,
  /\bis\s+\w[\w'-]*\s+(quarm\s+)?(eligib\w*|viable|raid[- ]?ready)\b/,
  /\bis\s+(this\s+)?(toon|character|alt)\s+(quarm\s+)?(eligib\w*|raid[- ]?ready|viable)\b/,
]

/** @param {string} text already normalized lowercase */
export const CHARACTER_STATS_PATTERNS = [
  /\bwhat (are|is) .{0,40}\bstats?\b/,
  /\bshow .{0,40}\bstats?\b/,
  /\bstats? (for|of)\b/,
  /\b(hp|mana|ac|str|sta)\b.{0,20}\b(for|of)\b/,
  /\bexact (stats?|attributes?)\b/,
  /\b[\w'-]+'?s?\s+stats?\b/,
]

/** @param {string} text */
export function isCharacterDkpSpentQuestion(text) {
  const t = normalizeMessage(text)
  return CHARACTER_DKP_SPENT_PATTERNS.some((p) => p.test(t))
}

/** @param {string} text */
export function isQuarmEligibilityQuestion(text) {
  const t = normalizeMessage(text)
  return QUARM_ELIGIBILITY_PATTERNS.some((p) => p.test(t))
}

/** @param {string} text */
export function isCharacterStatsQuestion(text) {
  const t = normalizeMessage(text)
  return CHARACTER_STATS_PATTERNS.some((p) => p.test(t))
}

/** @param {string} text */
export function normalizeMessage(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const RULES = [
  { intent: INTENTS.GREETING, patterns: [/^hi\b/, /^hello\b/, /^hey\b/, /^yo\b/, /good (morning|afternoon|evening)/, /^greetings\b/] },
  { intent: INTENTS.DKP_EXPLAIN, patterns: [/how does dkp work/, /what is dkp/, /explain dkp/, /dkp (system|rules|work)/] },
  { intent: INTENTS.CAPABILITIES, patterns: [/what can you (do|ask)/, /what do you (know|do)/, /help me$/, /^help\b/, /your (job|purpose)/] },
  // Identity lookup — before item_search; must not match "who got" (loot discovery).
  {
    intent: INTENTS.WHO_IS,
    patterns: [/^who(?:'s| is)\b(?!\s+(got|won|received|go|gott|looted)\b)/, /^whose (?:account|alt|toon)\b/],
  },
  // Character spend totals — before FULL_GEAR_COST ("total dkp…") and ITEM_PRICE ("how much").
  { intent: INTENTS.CHARACTER_DKP_SPENT, patterns: CHARACTER_DKP_SPENT_PATTERNS },
  { intent: INTENTS.QUARM_ELIGIBILITY, patterns: QUARM_ELIGIBILITY_PATTERNS },
  { intent: INTENTS.CHARACTER_STATS, patterns: CHARACTER_STATS_PATTERNS },
  { intent: INTENTS.FULL_GEAR_COST, patterns: [/fully? (upgrade|gear|equip)/, /how much.*(everything|all|total|complete)/, /total.*(dkp|cost|upgrade)/, /gear(ing)? budget/, /finish(ing)? (my )?gear/, /fully gear/] },
  { intent: INTENTS.WORST_PURCHASE, patterns: [/worst (purchase|buy|bid|loot)/, /biggest mistake/, /most (expensive|questionable)/, /regret/] },
  { intent: INTENTS.WHY_BROKE, patterns: [/why am i broke/, /why.*(broke|poor|empty|no dkp)/, /where did (my|the) dkp go/, /what happened to my dkp/] },
  { intent: INTENTS.BALANCE, patterns: [/\bbalance\b/, /how (much|many) dkp (do i|have|left)/, /dkp (do i|left|have)/, /am i broke/, /what('?s| is) my dkp/] },
  { intent: INTENTS.GEAR_ASSESSMENT, patterns: [/well[- ]?geared/, /how (is|are|good is) .{0,40}gear/, /is .{0,40}geared/, /gear(ed)? (status|score|rating|assessment|check)/, /how('?s| is) my .{0,30}(gear|toon|character)/, /gear check/] },
  { intent: INTENTS.ATTENDANCE, patterns: [/how('?s| is) my raid/, /\braiding\b/, /attendance/, /show(ing)? up/, /been away/, /inactive/, /how often.*(raid|attend)/] },
  // Before UPGRADES/CHARACTERS so "is this an upgrade" / "which of my toons could use" do not steal those lanes.
  { intent: INTENTS.ITEM_FIT, patterns: ITEM_FIT_PATTERNS },
  { intent: INTENTS.UPGRADES, patterns: [/what should i (buy|bid|get)/, /\bupgrades?\b/, /what.*(buy|get) for/, /recommend/, /suggest.*(item|loot|gear)/, /improve (my|the)/, /what.*(need|missing)/] },
  { intent: INTENTS.AFFORDABILITY, patterns: [/can i afford/, /affordable/, /within (my )?budget/, /enough dkp for/] },
  { intent: INTENTS.ITEM_PRICE, patterns: [/how much (is|was|does|did)/, /how much for /, /what.*(cost|price|sell)/, /last sold/, /sale price/, /\bprice\b/] },
  { intent: INTENTS.ITEM_SOURCE, patterns: [/where (does|do|is).*(drop|from)/, /what (mob|zone|raid).*drop/, /source (of|for)/, /drops? (from|in)/] },
  { intent: INTENTS.ITEM_SEARCH, patterns: [/tell me about .+/, /look up .+/, /find .+/, /search .+/] },
  { intent: INTENTS.SPENDING_ROAST, patterns: [/roast (my )?(dkp |)?(spend|purchase|loot|shopping)/, /mock (my )?(spend|purchase)/, /spend(ing)? roast/] },
  { intent: INTENTS.PURCHASE_HISTORY, patterns: [/purchase(s| history)?/, /what did i (buy|spend)/, /loot history/, /my buys/, /auction history/] },
  { intent: INTENTS.CHARACTER_ROAST, patterns: [/roast (my )?(character|toon|alt|main|enchanter|warrior|cleric)/, /mock (my )?(character|toon)/] },
  { intent: INTENTS.CHARACTERS, patterns: [/my (characters|toons|alts)/, /what about my /, /^and my /] },
  { intent: INTENTS.DEFENSE, patterns: [/but i (needed|had|was)/, /it was (worth|good|needed)/, /i had a reason/, /that('?s| is) not fair/, /defend/, /excuse/] },
  { intent: INTENTS.GENERAL_ROAST, patterns: [/roast me/, /insult me/, /make fun/, /be mean/, /judge me/, /roast me anyway/] },
  { intent: INTENTS.ACCOUNT_COMPARISON, patterns: [/compared to/, /vs (the )?guild/, /other (players|accounts)/, /leaderboard/] },
  { intent: INTENTS.FOLLOWUP, patterns: [/^why\??$/, /^and\??$/, /^really\??$/, /^are you serious/, /^what about (it|that|them)/, /^how much\??$/, /^where\??$/, /^is it worth/, /^was it (bad|good|worth)/] },
]

/**
 * @param {string} raw
 * @param {{ lastIntent?: string|null, lastItemId?: string|null, lastUpgradeCandidateId?: string|null, characters?: Array<{ name?: string, class_name?: string }>, pendingIntent?: string|null }} [ctx]
 */
export function classifyIntent(raw, ctx = {}) {
  const text = normalizeMessage(raw)
  if (!text) return { intent: INTENTS.UNKNOWN, confidence: 0, matchedCharacter: null, matchedItemHint: null }

  const matchedCharacter = matchCharacterMention(text, ctx.characters || [])
  const matchedItemHint = extractQuotedOrTrailingItem(text)
  const whoIsName = extractWhoIsCharacterName(raw)
  const bareCharacterPronoun = Boolean(ctx.lastSubject) && isCharacterPronoun(text)

  // Bare character/class name while awaiting clarification is not an intent by itself.
  if (ctx.pendingIntent && isLikelyClarificationReply(text, matchedCharacter)) {
    return { intent: INTENTS.FOLLOWUP, confidence: 0.95, matchedCharacter, matchedItemHint, clarificationReply: true }
  }

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        return {
          intent: rule.intent,
          confidence: 0.9,
          matchedCharacter,
          matchedItemHint,
          ...(rule.intent === INTENTS.WHO_IS ? { whoIsName } : {}),
        }
      }
    }
  }

  // Bare pronoun with sticky subject → rematch prior intent (before sticky-item short-text hijack).
  if (bareCharacterPronoun) {
    return {
      intent: INTENTS.FOLLOWUP,
      confidence: 0.85,
      matchedCharacter,
      matchedItemHint,
      bareCharacterPronoun: true,
    }
  }

  if (matchedCharacter && /\b(buy|upgrade|gear|loot|for)\b/.test(text)) {
    return { intent: INTENTS.UPGRADES, confidence: 0.7, matchedCharacter, matchedItemHint }
  }

  if (matchedCharacter && /gear|geared|score|viable/.test(text)) {
    return { intent: INTENTS.GEAR_ASSESSMENT, confidence: 0.7, matchedCharacter, matchedItemHint }
  }

  if (ctx.lastIntent && /^(why|how much|where|and|what about|is it|was it|are you)/.test(text)) {
    return { intent: INTENTS.FOLLOWUP, confidence: 0.8, matchedCharacter, matchedItemHint }
  }

  if (ctx.lastItemId || ctx.lastUpgradeCandidateId || ctx.lastItemName) {
    if (/^(how much|where|worth|price|cost)/.test(text) || text.length < 24) {
      return { intent: INTENTS.FOLLOWUP, confidence: 0.6, matchedCharacter, matchedItemHint }
    }
  }

  // Bare exact character name with no other intent → treat as clarification/selection follow-up
  if (matchedCharacter && !matchedCharacter.ambiguous && isBareCharacterName(text, matchedCharacter)) {
    return { intent: INTENTS.FOLLOWUP, confidence: 0.85, matchedCharacter, matchedItemHint, bareCharacterName: true }
  }

  if (/roast|mock|insult|terrible|bad decision/.test(text)) {
    return { intent: INTENTS.GENERAL_ROAST, confidence: 0.5, matchedCharacter, matchedItemHint }
  }

  return { intent: INTENTS.UNKNOWN, confidence: 0.2, matchedCharacter, matchedItemHint }
}

function isLikelyClarificationReply(text, matchedCharacter) {
  if (!matchedCharacter) return false
  if (matchedCharacter.ambiguous) return false
  return isBareCharacterName(text, matchedCharacter) || text.split(' ').length <= 4
}

function isBareCharacterName(text, matchedCharacter) {
  const name = normalizeMessage(matchedCharacter.name || matchedCharacter.displayName || '')
  if (!name) return false
  return text === name || text === `my ${name}`
}

/**
 * @param {string} text
 * @param {Array<{ char_id?: string, name?: string, class_name?: string, displayName?: string }>} characters
 */
export function matchCharacterMention(text, characters) {
  const normalized = normalizeMessage(text)
  // Prefer longer exact name matches first
  const byNameLen = [...(characters || [])].sort(
    (a, b) => normalizeMessage(b.name || '').length - normalizeMessage(a.name || '').length,
  )
  for (const ch of byNameLen) {
    const name = normalizeMessage(ch.name || ch.displayName || '')
    if (name && (normalized === name || new RegExp(`\\b${escapeRegExp(name)}\\b`).test(normalized))) {
      return ch
    }
  }
  const classMap = {
    warrior: 'Warrior',
    cleric: 'Cleric',
    wizard: 'Wizard',
    shaman: 'Shaman',
    bard: 'Bard',
    druid: 'Druid',
    enchanter: 'Enchanter',
    magician: 'Magician',
    necromancer: 'Necromancer',
    monk: 'Monk',
    rogue: 'Rogue',
    ranger: 'Ranger',
    paladin: 'Paladin',
    beastlord: 'Beastlord',
    'shadow knight': 'Shadow Knight',
    shadowknight: 'Shadow Knight',
  }
  for (const [key, className] of Object.entries(classMap)) {
    if (new RegExp(`\\b(my )?${key}\\b`).test(normalized)) {
      const matches = (characters || []).filter(
        (c) => normalizeMessage(c.class_name || '') === normalizeMessage(className),
      )
      if (matches.length === 1) return matches[0]
      if (matches.length > 1) return { ambiguous: true, className, candidates: matches }
    }
  }
  return null
}

const PRONOUN_ITEMS = new Set(['it', 'that', 'this', 'them', 'one', 'those', 'these'])

/** Subject/object pronouns that corefer to the sticky character subject (not literal names). */
const CHARACTER_PRONOUNS = new Set(['he', 'she', 'him', 'his', 'her', 'they', 'them', 'their'])

/**
 * True when the token is a character pronoun (he/she/him/…).
 * @param {string|null|undefined} token
 */
export function isCharacterPronoun(token) {
  const t = String(token || '')
    .trim()
    .toLowerCase()
    .replace(/[?!.]+$/g, '')
  return CHARACTER_PRONOUNS.has(t)
}

/**
 * True when the message uses a character pronoun as a word.
 * @param {string|null|undefined} raw
 */
export function messageUsesCharacterPronoun(raw) {
  const text = normalizeMessage(raw)
  if (!text) return false
  return /\b(he|she|him|his|her|they|them|their)\b/.test(text)
}

const WHO_IS_PREFIX = /^(?:who(?:'s| is)|whose (?:account|alt|toon)(?: is)?)\s+/i

/**
 * Character name from a who-is question (raw casing preserved when possible).
 * Pronoun-only subjects return null (resolve via sticky lastSubject).
 * @param {string} raw
 * @returns {string|null}
 */
export function extractWhoIsCharacterName(raw) {
  const original = String(raw || '').trim()
  if (!original) return null
  const text = normalizeMessage(original)
  if (/\bwho (got|won|received|go|gott|looted)\b/.test(text)) return null
  if (!/^(?:who(?:'s| is)\b|whose (?:account|alt|toon)\b)/.test(text)) return null
  let rest = original.replace(WHO_IS_PREFIX, '').trim()
  rest = rest.replace(/^is\s+/i, '').trim()
  rest = rest.replace(/[?!.]+$/, '').trim()
  rest = rest.replace(/\s+'s\s*$/i, '').trim()
  rest = rest.replace(/\b(account|alt|toon|character)\s*$/i, '').trim()
  if (!rest || rest.length < 2) return null
  if (isCharacterPronoun(rest)) return null
  if (/\b(got|won|received|drop|loot|raid)\b/i.test(rest)) return null
  return rest
}

const STOP_SUBJECT = new Set([
  'my',
  'the',
  'a',
  'an',
  'this',
  'that',
  'he',
  'she',
  'him',
  'his',
  'her',
  'they',
  'them',
  'their',
  'our',
  'your',
  'me',
  'i',
  'it',
  'toon',
  'character',
  'alt',
  'main',
  'dkp',
  'raid',
  'quarm',
  'stats',
  'stat',
  'gear',
  'eligible',
  'viability',
  'viable',
  'coverage',
  'class',
  'shoulder',
  'shoulders',
  'arms',
  'legs',
  'ring',
  'rings',
  'wrist',
  'wrists',
  'head',
  'chest',
  'feet',
  'hands',
  'neck',
  'waist',
  'face',
  'cloak',
  'cape',
  'plate',
  'silk',
  'chain',
  'leather',
  'cloth',
])

/**
 * Bare “what/how about &lt;Name&gt;?” character-swap candidate (single token).
 * @param {string} raw
 * @returns {string|null}
 */
export function extractCharacterSwapFollowUp(raw) {
  const original = String(raw || '').trim()
  const m = original.match(/^(?:what|how)\s+about\s+([A-Za-z][\w']{1,24})\s*\??$/i)
  if (!m?.[1]) return null
  const name = String(m[1]).replace(/[?!.]+$/g, '').trim()
  if (!name || name.length < 2) return null
  if (STOP_SUBJECT.has(name.toLowerCase())) return null
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** @param {string|null|undefined} intent */
export function isRepeatableCharacterSwapIntent(intent) {
  return Boolean(intent && CHARACTER_SWAP_REPEATABLE_INTENTS.has(intent))
}

/**
 * Best-effort subject character name for spend / viability / stats asks (guild-wide).
 * Prefers roster match when provided; otherwise extracts from phrasing.
 * @param {string} raw
 * @param {{ characters?: Array<{ name?: string }>, intent?: string|null }} [opts]
 * @returns {string|null}
 */
export function extractSubjectCharacterName(raw, opts = {}) {
  const text = normalizeMessage(raw)
  if (!text) return null

  const rosterHit = matchCharacterMention(text, opts.characters || [])
  if (rosterHit?.name && !rosterHit.ambiguous) return rosterHit.name

  const original = String(raw || '').trim()
  const tryCapture = (re) => {
    const m = original.match(re) || text.match(re)
    if (!m?.[1]) return null
    let name = String(m[1]).replace(/[?!.]+$/g, '').replace(/'s$/i, '').trim()
    if (!name || name.length < 2) return null
    if (STOP_SUBJECT.has(name.toLowerCase())) return null
    if (/\s/.test(name) && !opts.characters?.some((c) => normalizeMessage(c.name) === normalizeMessage(name))) {
      // Multi-word only when it matches a known roster name
      return null
    }
    return name
  }

  const intent = opts.intent || null
  if (!intent || intent === INTENTS.CHARACTER_DKP_SPENT) {
    const spent =
      tryCapture(/\bspent\s+on\s+([A-Za-z][\w'-]{1,32})\b/i) ||
      tryCapture(/\bspent\s+for\s+([A-Za-z][\w'-]{1,32})\b/i) ||
      tryCapture(/\bdkp\s+(?:has\s+been\s+|was\s+|been\s+)?spent\s+on\s+([A-Za-z][\w'-]{1,32})\b/i)
    if (spent) return spent
  }
  if (!intent || intent === INTENTS.QUARM_ELIGIBILITY) {
    const elig =
      tryCapture(/\bis\s+([A-Za-z][\w'-]{1,32})\s+(?:quarm\s+)?(?:eligible|viable|raid[- ]?ready)\b/i) ||
      tryCapture(/\b([A-Za-z][\w'-]{1,32})\s+quarm\s+eligib/i) ||
      tryCapture(/\b([A-Za-z][\w'-]{1,32})\s+raid[- ]?ready\b/i) ||
      tryCapture(/\b([A-Za-z][\w'-]{1,32})\s+(?:raid\s+)?viable\b/i) ||
      tryCapture(/\bclass\s+ranking\s+(?:%|percent|percentage)?\s+(?:for|of)\s+([A-Za-z][\w'-]{1,32})\b/i)
    if (elig) return elig
  }
  if (!intent || intent === INTENTS.CHARACTER_STATS) {
    const stats =
      tryCapture(/\b(?:what\s+are|what\s+is|show)\s+([A-Za-z][\w'-]{1,32})(?:'s)?\s+stats?\b/i) ||
      tryCapture(/\bstats?\s+(?:for|of)\s+([A-Za-z][\w'-]{1,32})\b/i) ||
      tryCapture(/\b([A-Za-z][\w'-]{1,32})(?:'s)?\s+stats?\b/i)
    if (stats) return stats
  }
  return null
}

function extractQuotedOrTrailingItem(text) {
  const quoted = text.match(/["']([^"']{2,80})["']/)
  if (quoted) return quoted[1].trim()
  const howMuch = text.match(
    /(?:how much (?:is|was|does|did|for)|what(?:'s| is) the (?:price|cost) of|price of|cost of)\s+(.+?)(?:\s+cost|\s+worth|\s+sold)?$/i,
  )
  if (howMuch) {
    const hint = howMuch[1].replace(/\?+$/, '').trim()
    if (hint && !PRONOUN_ITEMS.has(hint.toLowerCase())) return hint
    return null
  }
  const afford = text.match(
    /(?:can i afford|enough dkp for|within (?:my )?budget for|affordable)\s+(.+?)$/i,
  )
  if (afford) {
    const hint = afford[1].replace(/\?+$/, '').trim()
    if (hint && !PRONOUN_ITEMS.has(hint.toLowerCase())) return hint
  }
  const about = text.match(/(?:about|find|lookup|look up|search|for)\s+(.{3,80})$/i)
  if (about) {
    const hint = about[1].trim()
    if (hint && !PRONOUN_ITEMS.has(hint.toLowerCase())) return hint
  }
  const where = text.match(/(?:where does|where do|source (?:of|for))\s+(.+?)(?:\s+drop|\s+come)?$/i)
  if (where) {
    const hint = where[1].replace(/\?+$/, '').trim()
    if (hint && !PRONOUN_ITEMS.has(hint.toLowerCase())) return hint
  }
  return null
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
