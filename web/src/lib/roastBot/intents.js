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
  ITEM_SEARCH: 'item_search',
  ITEM_PRICE: 'item_price',
  ITEM_SOURCE: 'item_source',
  UPGRADES: 'upgrades',
  GEAR_ASSESSMENT: 'gear_assessment',
  AFFORDABILITY: 'affordability',
  ATTENDANCE: 'attendance',
  ACCOUNT_COMPARISON: 'account_comparison',
  DKP_EXPLAIN: 'dkp_explain',
  CAPABILITIES: 'capabilities',
  DEFENSE: 'defense',
  FOLLOWUP: 'followup',
  FULL_GEAR_COST: 'full_gear_cost',
  UNKNOWN: 'unknown',
}

/** Intents that need a specific character when the account has multiple. */
export const CHARACTER_SCOPED_INTENTS = new Set([
  INTENTS.UPGRADES,
  INTENTS.GEAR_ASSESSMENT,
  INTENTS.CHARACTER_ROAST,
])

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
  { intent: INTENTS.CAPABILITIES, patterns: [/what can you do/, /what do you (know|do)/, /help me$/, /^help\b/, /your (job|purpose)/] },
  { intent: INTENTS.FULL_GEAR_COST, patterns: [/fully? (upgrade|gear|equip)/, /how much.*(everything|all|total|complete)/, /total.*(dkp|cost|upgrade)/, /gear(ing)? budget/, /finish(ing)? (my )?gear/, /fully gear/] },
  { intent: INTENTS.WORST_PURCHASE, patterns: [/worst (purchase|buy|bid|loot)/, /biggest mistake/, /most (expensive|questionable)/, /regret/] },
  { intent: INTENTS.WHY_BROKE, patterns: [/why am i broke/, /why.*(broke|poor|empty|no dkp)/, /where did (my|the) dkp go/, /what happened to my dkp/] },
  { intent: INTENTS.BALANCE, patterns: [/\bbalance\b/, /how (much|many) dkp (do i|have|left)/, /dkp (do i|left|have)/, /am i broke/, /what('?s| is) my dkp/] },
  { intent: INTENTS.GEAR_ASSESSMENT, patterns: [/well[- ]?geared/, /how (is|are|good is) .{0,40}gear/, /is .{0,40}geared/, /gear(ed)? (status|score|rating|assessment|check)/, /how('?s| is) my .{0,30}(gear|toon|character)/, /gear check/] },
  { intent: INTENTS.ATTENDANCE, patterns: [/how('?s| is) my raid/, /\braiding\b/, /attendance/, /show(ing)? up/, /been away/, /inactive/, /how often.*(raid|attend)/] },
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

  // Bare character/class name while awaiting clarification is not an intent by itself.
  if (ctx.pendingIntent && isLikelyClarificationReply(text, matchedCharacter)) {
    return { intent: INTENTS.FOLLOWUP, confidence: 0.95, matchedCharacter, matchedItemHint, clarificationReply: true }
  }

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        return { intent: rule.intent, confidence: 0.9, matchedCharacter, matchedItemHint }
      }
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
