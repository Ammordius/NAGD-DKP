/**
 * Intent-specific domain handlers. Each returns AnswerFacts for fact-first rendering.
 */

import { INTENTS } from '../intents.js'
import { deriveEvents, classifyBalance, spendingConcentration } from '../events.js'
import { formatDkp, CAPABILITIES_FACT_TEXT, GAME_ACCOUNTS_LINK, buildLinks } from '../formatting.js'
import {
  computeCharacterUpgrades,
  evaluateItemFitForAccount,
  formatMageloLoadError,
  findMageloCharacter,
} from '../upgrades.js'
import { assessCharacterGear } from '../gearAssessment.js'
import {
  characterSpendRoast,
  characterStatsRoast,
  raidReadyRoast,
} from '../bandRoasts.js'
import { scopedPurchaseFacts, pickSpendPurchase } from '../facts.js'
import { FULL_GEAR_COST_REFUSAL, INITIAL_GREETING, NO_ACCOUNT_HINT } from '../templates.js'
import { lookupItemSource } from '../../itemSourceLookup.js'
import { renderDiscovery } from '../discovery/render.js'
import { spentFromAccountFacts } from '../characterSpendLookup.js'
import {
  buildMaxRawScoreByClass,
  classNameToAbbrev,
  highlightThresholdForClass,
  isHighlightedGearPct,
  isViableGearPct,
  normalizedGearPct,
  TANK_CLASS_ABBREVS,
  viabilityThresholdForClass,
} from '../../classCoverage.js'

/**
 * @typedef {{
 *   intent: string,
 *   category: string,
 *   factText: string,
 *   requiredClaims: string[],
 *   placeholders: Record<string, string|number|null>,
 *   referenced: { characters: string[], items: string[] },
 *   cards?: object[],
 *   reasonCode: string,
 *   allowFlavor?: boolean,
 *   templateId?: string|null,
 *   needsCharacter?: boolean,
 *   needsItem?: boolean,
 *   clarification?: { slot: 'character'|'item', message: string, pendingIntent: string },
 * }} AnswerFacts
 */

function emptyReferenced() {
  return { characters: [], items: [] }
}

function withRefs(characters = [], items = []) {
  return {
    characters: [...new Set(characters.filter(Boolean))],
    items: [...new Set(items.filter(Boolean))],
  }
}

function lookupPrice(facts, itemName) {
  if (!itemName) return null
  const entry = facts.recentItemPrices?.[String(itemName).toLowerCase()]
  if (!entry?.values?.length) return null
  const n = Number(entry.values[0])
  return Number.isFinite(n) ? n : null
}

function lookupSource(facts, itemName) {
  return lookupItemSource(facts?.knownItemSources, itemName)
}

/**
 * @param {object} args
 * @returns {AnswerFacts}
 */
export function dispatchHandler(args) {
  const { intent } = args
  switch (intent) {
    case INTENTS.DKP_EXPLAIN:
      return handleDkpExplain(args)
    case INTENTS.CAPABILITIES:
      return handleCapabilities(args)
    case INTENTS.FULL_GEAR_COST:
      return handleFullGearCost(args)
    case INTENTS.WHY_BROKE:
      return handleWhyBroke(args)
    case INTENTS.BALANCE:
      return handleBalance(args)
    case INTENTS.GEAR_ASSESSMENT:
      return handleGearAssessment(args)
    case INTENTS.UPGRADES:
      return handleUpgrades(args)
    case INTENTS.ITEM_FIT:
      return handleItemFit(args)
    case INTENTS.WORST_PURCHASE:
      return handleWorstPurchase(args)
    case INTENTS.SPENDING_ROAST:
    case INTENTS.PURCHASE_HISTORY:
      return handlePurchases(args)
    case INTENTS.CHARACTER_ROAST:
    case INTENTS.CHARACTERS:
      return handleCharacterRoast(args)
    case INTENTS.ITEM_PRICE:
      return handleItemPrice(args)
    case INTENTS.ITEM_SOURCE:
      return handleItemSource(args)
    case INTENTS.AFFORDABILITY:
      return handleAffordability(args)
    case INTENTS.ITEM_SEARCH:
      return handleItemSearch(args)
    case INTENTS.ATTENDANCE:
      return handleAttendance(args)
    case INTENTS.ACCOUNT_COMPARISON:
      return handleAccountComparison(args)
    case INTENTS.DEFENSE:
      return handleDefense(args)
    case INTENTS.GENERAL_ROAST:
      return handleGeneralRoast(args)
    case INTENTS.GREETING:
      return handleGreeting(args)
    case INTENTS.LOOT_DISCOVERY:
      return handleLootDiscovery(args)
    case INTENTS.WHO_IS:
      return handleWhoIs(args)
    case INTENTS.CHARACTER_DKP_SPENT:
      return handleCharacterDkpSpent(args)
    case INTENTS.QUARM_ELIGIBILITY:
      return handleQuarmEligibility(args)
    case INTENTS.CHARACTER_STATS:
      return handleCharacterStats(args)
    case INTENTS.UNKNOWN:
    default:
      return handleUnknown(args)
  }
}

function requireAccount(args, intent) {
  if (args.facts?.accountId) return null
  return {
    intent,
    category: 'unknown',
    factText: NO_ACCOUNT_HINT,
    requiredClaims: ['no_account'],
    placeholders: {},
    referenced: emptyReferenced(),
    links: [GAME_ACCOUNTS_LINK],
    reasonCode: 'no_claimed_account',
    allowFlavor: true,
    templateId: 'NO_ACCOUNT',
  }
}

function handleDkpExplain() {
  const factText =
    'DKP here is account-level. You earn DKP by attending recorded raids (tic attendance). You spend DKP when your account buys raid loot. Balance is earned minus spent from the account summary. Historical sale prices are records of past bids, not guarantees of future cost.'
  return {
    intent: INTENTS.DKP_EXPLAIN,
    category: 'general',
    factText,
    requiredClaims: ['dkp_earn', 'dkp_spend', 'dkp_balance_definition'],
    placeholders: {},
    referenced: emptyReferenced(),
    reasonCode: 'dkp_explain',
    allowFlavor: true,
    templateId: 'DKP_EXPLAIN',
  }
}

function handleCapabilities() {
  return {
    intent: INTENTS.CAPABILITIES,
    category: 'general',
    factText: CAPABILITIES_FACT_TEXT,
    requiredClaims: ['capabilities'],
    placeholders: {},
    referenced: emptyReferenced(),
    reasonCode: 'capabilities',
    allowFlavor: true,
    templateId: 'CAPABILITIES',
  }
}

/**
 * Prefetched who-is lookup from RoastBot send path.
 * @param {object} args
 */
/**
 * Prefetched character DKP spent (get_character_dkp_spent) or account-loot fallback.
 * @param {object} args
 */
function handleCharacterDkpSpent(args) {
  const character = args.selectedCharacter
  const pref = args.characterSpendResult
  const name =
    pref?.characterName ||
    character?.name ||
    null

  if (!name) {
    const chars = args.facts.characters || []
    if (chars.length > 1) {
      return clarificationCharacter(INTENTS.CHARACTER_DKP_SPENT, chars, args.ambiguousClass)
    }
    if (chars.length === 1) {
      return handleCharacterDkpSpent({ ...args, selectedCharacter: chars[0] })
    }
    return {
      intent: INTENTS.CHARACTER_DKP_SPENT,
      category: 'general',
      factText:
        'Ask how much DKP has been spent on a character name (for example "how much DKP has been spent on Tandiyen"). I need an actual toon — inventing a spend total would be fraud.',
      requiredClaims: ['need_character'],
      placeholders: {},
      referenced: emptyReferenced(),
      reasonCode: 'need_character',
      allowFlavor: true,
      templateId: 'NEED_CHAR',
    }
  }

  let total = null
  if (pref && pref.status === 'ok' && pref.totalSpent != null && Number.isFinite(Number(pref.totalSpent))) {
    total = Number(pref.totalSpent)
  } else if (pref && pref.status === 'error') {
    const fallback = spentFromAccountFacts(args.facts, character || { name })
    if (fallback != null && (args.facts?.accountId || fallback > 0)) {
      total = fallback
    } else {
      return {
        intent: INTENTS.CHARACTER_DKP_SPENT,
        category: 'general',
        factText: `I could not load the character spend ledger for ${name} (${pref.error || 'lookup failed'}). No spend total was invented.`,
        requiredClaims: ['character_spent_unavailable'],
        placeholders: { toon: name },
        referenced: withRefs([name], []),
        reasonCode: 'character_spent_unavailable',
        allowFlavor: false,
        templateId: 'GEAR_MISSING',
      }
    }
  } else {
    const fallback = spentFromAccountFacts(args.facts, character || { name })
    total = fallback != null ? fallback : 0
  }

  const formatted = formatDkp(total)
  return {
    intent: INTENTS.CHARACTER_DKP_SPENT,
    category: 'general',
    factText: characterSpendRoast(total, name, formatDkp),
    requiredClaims: ['character_dkp_spent'],
    placeholders: { toon: name, cost: formatted },
    referenced: withRefs([name], []),
    links: buildLinks({ characterName: name }),
    reasonCode: 'character_dkp_spent',
    allowFlavor: false,
    templateId: 'CHARACTER_DKP_SPENT',
  }
}

/**
 * Magelo class ranking % + raid-ready / green-display cutoffs (officer Raider Activity rules).
 * Accepts "quarm eligible", "raid ready", class coverage, etc. — answers quantitatively.
 * @param {object} args
 */
function handleQuarmEligibility(args) {
  const character = args.selectedCharacter
  if (!character?.name) {
    const chars = args.facts.characters || []
    if (chars.length > 1) {
      return clarificationCharacter(INTENTS.QUARM_ELIGIBILITY, chars, args.ambiguousClass)
    }
    if (chars.length === 1) {
      return handleQuarmEligibility({ ...args, selectedCharacter: chars[0] })
    }
    return {
      intent: INTENTS.QUARM_ELIGIBILITY,
      category: 'general',
      factText:
        'Ask for a toon\'s Magelo class ranking % / raid-ready status (for example "is Iaminae raid ready?" or "is Tandiyen Quarm eligible?"). Name the toon — I will not invent percentages.',
      requiredClaims: ['need_character'],
      placeholders: {},
      referenced: emptyReferenced(),
      reasonCode: 'need_character',
      allowFlavor: true,
      templateId: 'NEED_CHAR',
    }
  }

  if (!args.upgradeContext?.rankings) {
    const loadErr = formatMageloLoadError(
      args.upgradeContext?.rankingsError
        ? { ok: false, ...args.upgradeContext.rankingsError }
        : null,
    )
    const detail = loadErr || 'Magelo rankings data is not loaded'
    return {
      intent: INTENTS.QUARM_ELIGIBILITY,
      category: 'general',
      factText: `I cannot report Magelo class ranking % for ${character.name} because ${detail}. No percentages were invented.`,
      requiredClaims: ['magelo_unavailable'],
      placeholders: { toon: character.name },
      referenced: withRefs([character.name], []),
      reasonCode: loadErr ? 'magelo_fetch_failed' : 'missing_magelo_export',
      allowFlavor: false,
      templateId: 'GEAR_MISSING',
    }
  }

  const rankings = args.upgradeContext.rankings
  const magelo = findMageloCharacter(rankings, character.name)
  if (!magelo) {
    return {
      intent: INTENTS.QUARM_ELIGIBILITY,
      category: 'general',
      factText: `${character.name} is not in the current Magelo rankings export, so there is no class ranking % to report. I refuse to invent gear percentages.`,
      requiredClaims: ['quarm_not_in_rankings'],
      placeholders: { toon: character.name },
      referenced: withRefs([character.name], []),
      reasonCode: 'quarm_not_in_rankings',
      allowFlavor: false,
      templateId: 'GEAR_MISSING',
    }
  }

  const list = rankings.characters || []
  const maxByClass = buildMaxRawScoreByClass(list)
  const abbrev = classNameToAbbrev(magelo.class || character.class_name)
  const pct = normalizedGearPct(magelo, maxByClass)
  const viabilityCut = viabilityThresholdForClass(abbrev)
  const greenCut = highlightThresholdForClass(abbrev)
  const viable = isViableGearPct(pct, abbrev)
  const green = isHighlightedGearPct(pct, abbrev)
  const isTank = TANK_CLASS_ABBREVS.has(String(abbrev || '').toUpperCase())
  const pctLabel = pct != null && Number.isFinite(pct) ? `${pct}%` : 'unknown %'
  const classLabel = abbrev || magelo.class || character.class_name || 'unknown class'
  const sheetBits = formatRaidReadySheetBits(magelo, { includeAc: isTank })

  const factText = raidReadyRoast({
    name: character.name,
    pctLabel,
    classLabel,
    viable,
    green,
    viabilityCut,
    greenCut,
    sheetBits,
  })

  const claims = [
    'class_ranking_pct',
    'raid_ready_cutoff',
    'green_display_cutoff',
    viable ? 'quarm_eligible' : 'quarm_not_eligible',
  ]
  if (sheetBits) claims.push('raid_ready_sheet')

  return {
    intent: INTENTS.QUARM_ELIGIBILITY,
    category: 'general',
    factText,
    requiredClaims: claims,
    placeholders: {
      toon: character.name,
      upgrade: pctLabel,
    },
    referenced: withRefs([character.name], []),
    links: buildLinks({ characterName: character.name }),
    reasonCode: viable ? 'quarm_eligible' : 'quarm_not_eligible',
    allowFlavor: false,
    templateId: 'QUARM_ELIGIBILITY',
  }
}

const RESIST_LABELS = {
  MR: 'magic resist',
  FR: 'fire resist',
  CR: 'cold resist',
  DR: 'disease resist',
  PR: 'poison resist',
}

/** Only call out a lowest save when average saves are meaningfully high. */
const LOWEST_SAVE_AVG_FLOOR = 150

/**
 * Stylistic Magelo sheet extras for raid-ready answers: HP, avg/lowest save; AC for tanks.
 * Lowest-save roast only when average save is at least 150.
 * @param {object} magelo
 * @param {{ includeAc?: boolean }} [opts]
 * @returns {string|null}
 */
function formatRaidReadySheetBits(magelo, opts = {}) {
  if (!magelo || typeof magelo !== 'object') return null
  const stats = magelo.stats && typeof magelo.stats === 'object' ? magelo.stats : {}
  const scores = magelo.scores && typeof magelo.scores === 'object' ? magelo.scores : {}
  const parts = []

  const hp = Number(stats.hp ?? scores.hp)
  if (Number.isFinite(hp)) parts.push(`${Math.round(hp)} HP`)

  const resistSrc =
    magelo.individual_resists && typeof magelo.individual_resists === 'object'
      ? magelo.individual_resists
      : stats.resists && typeof stats.resists === 'object'
        ? stats.resists
        : null
  const resistKeys = ['MR', 'FR', 'CR', 'DR', 'PR']
  if (resistSrc) {
    const pairs = resistKeys
      .map((k) => ({ key: k, value: Number(resistSrc[k]) }))
      .filter((p) => Number.isFinite(p.value))
    if (pairs.length) {
      const avg = pairs.reduce((sum, p) => sum + p.value, 0) / pairs.length
      const avgRounded = Math.round(avg)
      let lowest = pairs[0]
      for (const p of pairs) {
        if (p.value < lowest.value) lowest = p
      }
      if (avg >= LOWEST_SAVE_AVG_FLOOR && lowest.value < avg) {
        const resistName = RESIST_LABELS[lowest.key] || lowest.key
        parts.push(
          `they forgot to work on ${resistName} at ${Math.round(lowest.value)} despite an average save of ${avgRounded}`,
        )
      } else {
        parts.push(`average save ${avgRounded}`)
      }
    }
  } else {
    const total = Number(stats.resists ?? scores.resists)
    if (Number.isFinite(total) && total > 0) {
      parts.push(`average save ${Math.round(total / 5)}`)
    }
  }

  if (opts.includeAc) {
    const ac = Number(stats.ac ?? scores.ac)
    if (Number.isFinite(ac)) parts.push(`${Math.round(ac)} AC`)
  }

  return parts.length ? parts.join('. ') : null
}

/**
 * Exact Magelo sheet stats from class_rankings.json.
 * @param {object} args
 */
function handleCharacterStats(args) {
  const character = args.selectedCharacter
  if (!character?.name) {
    const chars = args.facts.characters || []
    if (chars.length > 1) {
      return clarificationCharacter(INTENTS.CHARACTER_STATS, chars, args.ambiguousClass)
    }
    if (chars.length === 1) {
      return handleCharacterStats({ ...args, selectedCharacter: chars[0] })
    }
    return {
      intent: INTENTS.CHARACTER_STATS,
      category: 'general',
      factText:
        'Ask for a character\'s Magelo stats by name (for example "what are Iaminae\'s stats"). I will not invent attributes.',
      requiredClaims: ['need_character'],
      placeholders: {},
      referenced: emptyReferenced(),
      reasonCode: 'need_character',
      allowFlavor: true,
      templateId: 'NEED_CHAR',
    }
  }

  if (!args.upgradeContext?.rankings) {
    const loadErr = formatMageloLoadError(
      args.upgradeContext?.rankingsError
        ? { ok: false, ...args.upgradeContext.rankingsError }
        : null,
    )
    const detail = loadErr || 'Magelo rankings data is not loaded'
    return {
      intent: INTENTS.CHARACTER_STATS,
      category: 'general',
      factText: `I cannot show Magelo stats for ${character.name} because ${detail}. No stats were invented.`,
      requiredClaims: ['magelo_unavailable'],
      placeholders: { toon: character.name },
      referenced: withRefs([character.name], []),
      reasonCode: loadErr ? 'magelo_fetch_failed' : 'missing_magelo_export',
      allowFlavor: false,
      templateId: 'GEAR_MISSING',
    }
  }

  const magelo = findMageloCharacter(args.upgradeContext.rankings, character.name)
  if (!magelo) {
    return {
      intent: INTENTS.CHARACTER_STATS,
      category: 'general',
      factText: `${character.name} is not in the current Magelo rankings export. I refuse to invent sheet stats.`,
      requiredClaims: ['stats_not_in_rankings'],
      placeholders: { toon: character.name },
      referenced: withRefs([character.name], []),
      reasonCode: 'stats_not_in_rankings',
      allowFlavor: false,
      templateId: 'GEAR_MISSING',
    }
  }

  const stats = magelo.stats && typeof magelo.stats === 'object' ? magelo.stats : null
  if (!stats) {
    return {
      intent: INTENTS.CHARACTER_STATS,
      category: 'general',
      factText: `${character.name} is in Magelo rankings, but no stats object is present on that export row. No attributes were invented.`,
      requiredClaims: ['stats_missing'],
      placeholders: { toon: character.name },
      referenced: withRefs([character.name], []),
      reasonCode: 'stats_missing',
      allowFlavor: false,
      templateId: 'GEAR_MISSING',
    }
  }

  const factText = formatMageloStatsFact(character.name, magelo, stats)
  return {
    intent: INTENTS.CHARACTER_STATS,
    category: 'general',
    factText,
    requiredClaims: ['character_stats'],
    placeholders: { toon: character.name },
    referenced: withRefs([character.name], []),
    links: buildLinks({ characterName: character.name }),
    reasonCode: 'character_stats',
    allowFlavor: false,
    templateId: 'CHARACTER_STATS',
  }
}

/**
 * @param {string} name
 * @param {object} magelo
 * @param {object} stats
 */
function formatMageloStatsFact(name, magelo, stats) {
  const pick = (key, ...alts) => {
    for (const k of [key, ...alts]) {
      if (stats[k] != null && String(stats[k]).trim() !== '') return String(stats[k])
    }
    return null
  }
  const bodyLines = []
  const combat = [
    ['HP', pick('hp')],
    ['Mana', pick('mana')],
    ['AC', pick('ac')],
    ['ATK', pick('atk_item', 'atk')],
    ['Haste', pick('haste')],
    ['FT', pick('mana_regen_item', 'ft')],
  ]
    .filter(([, v]) => v != null)
    .map(([label, v]) => `${label} ${v}`)
  if (combat.length) bodyLines.push(combat.join(' · '))

  const attrs = ['STR', 'STA', 'AGI', 'DEX', 'WIS', 'INT', 'CHA']
    .map((k) => {
      const v = pick(k)
      return v != null ? `${k} ${v}` : null
    })
    .filter(Boolean)
  if (attrs.length) bodyLines.push(attrs.join(' · '))

  const resistsSrc =
    (magelo.individual_resists && typeof magelo.individual_resists === 'object'
      ? magelo.individual_resists
      : null) ||
    (stats.resists && typeof stats.resists === 'object' ? stats.resists : null)
  if (resistsSrc) {
    const resistBits = ['MR', 'FR', 'CR', 'DR', 'PR']
      .map((k) => (resistsSrc[k] != null ? `${k} ${resistsSrc[k]}` : null))
      .filter(Boolean)
    if (resistBits.length) bodyLines.push(`Resists: ${resistBits.join(' · ')}`)
  } else if (pick('resists')) {
    bodyLines.push(`Resists: ${pick('resists')}`)
  }

  return characterStatsRoast(name, magelo.class || 'unknown class', bodyLines)
}

function handleWhoIs(args) {
  const lookup = args.whoIsResult
  const askedName = args.whoIsName || lookup?.characterName || null

  if (!lookup && !askedName) {
    return {
      intent: INTENTS.WHO_IS,
      category: 'general',
      factText:
        'Ask "who is CharacterName" if you want their account and last raid date. I need an actual character name — psychic services cost extra DKP.',
      requiredClaims: ['need_character'],
      placeholders: {},
      referenced: emptyReferenced(),
      reasonCode: 'need_character',
      allowFlavor: true,
      templateId: 'NEED_CHAR',
    }
  }

  if (!lookup || lookup.status === 'no_name') {
    return {
      intent: INTENTS.WHO_IS,
      category: 'general',
      factText:
        'Ask "who is CharacterName" if you want their account and last raid date. I need an actual character name — psychic services cost extra DKP.',
      requiredClaims: ['need_character'],
      placeholders: {},
      referenced: emptyReferenced(),
      reasonCode: 'need_character',
      allowFlavor: true,
      templateId: 'NEED_CHAR',
    }
  }

  if (lookup.status === 'not_found') {
    const name = lookup.characterName || askedName || 'that character'
    return {
      intent: INTENTS.WHO_IS,
      category: 'general',
      factText: `I don't have a guild character match for ${name}. Inventing an account would be irresponsible, even by auction standards.`,
      requiredClaims: ['who_is_not_found'],
      placeholders: { toon: name },
      referenced: withRefs([name], []),
      reasonCode: 'who_is_not_found',
      allowFlavor: true,
    }
  }

  if (lookup.status === 'unlinked') {
    const name = lookup.characterName || askedName
    return {
      intent: INTENTS.WHO_IS,
      category: 'general',
      factText: `${name} exists in the character roster, but I have no account link for them. No invented owner, no invented raid date.`,
      requiredClaims: ['who_is_unlinked'],
      placeholders: { toon: name },
      referenced: withRefs([name], []),
      reasonCode: 'who_is_unlinked',
      allowFlavor: true,
    }
  }

  const toon = lookup.characterName || askedName
  const account = lookup.accountName
  const accountId = lookup.accountId || null
  const lastRaidDate = lookup.lastRaidDate || null
  const dateClause = lastRaidDate
    ? ` Their account's last recorded raid date is ${lastRaidDate} (account-level activity, not a claim about this specific toon skipping raids).`
    : ` Their account has no recorded last raid date in the summary tables.`

  const referenced = withRefs([toon], [])
  if (accountId) {
    referenced.accounts = [{ id: String(accountId), name: account || String(accountId) }]
  }

  return {
    intent: INTENTS.WHO_IS,
    category: lastRaidDate ? 'who_is' : 'who_is_no_date',
    factText: `${toon} is on account ${account}.${dateClause}`,
    requiredClaims: lastRaidDate
      ? ['who_is_account', 'who_is_last_raid']
      : ['who_is_account'],
    placeholders: {
      toon,
      account,
      lastRaidDate: lastRaidDate || null,
    },
    referenced,
    links: [
      ...buildLinks({ characterName: toon }),
      ...(accountId
        ? buildLinks({ accountId, accountName: account || String(accountId) })
        : []),
    ],
    reasonCode: lastRaidDate ? 'who_is' : 'who_is_no_date',
    allowFlavor: true,
  }
}

/**
 * Prefetched discovery AnswerFacts / DiscoveryResult from RoastBot send path.
 * @param {object} args
 */
function handleLootDiscovery(args) {
  if (args.discoveryAnswer) return args.discoveryAnswer
  if (args.discoveryResult) return renderDiscovery(args.discoveryResult)
  if (args.discoveryRecognition?.status === 'unsupported') {
    return {
      intent: INTENTS.LOOT_DISCOVERY,
      category: 'general',
      factText:
        args.discoveryRecognition.reason ||
        'I could not safely interpret that loot question. Try naming a boss, zone, phase, item, or character.',
      requiredClaims: ['loot_discovery'],
      placeholders: {},
      referenced: emptyReferenced(),
      reasonCode: 'loot_discovery',
      allowFlavor: false,
      templateId: 'LOOT_DISCOVERY',
    }
  }
  // Never claim recognition without an executable query or clarification.
  return {
    intent: INTENTS.UNKNOWN,
    category: 'general',
    factText:
      'Try asking about loot, upgrades, DKP balance, gear assessment, raid attendance, or your purchase history. I did not perform an analysis for that question.',
    requiredClaims: [],
    placeholders: {},
    referenced: emptyReferenced(),
    reasonCode: 'unknown',
    allowFlavor: false,
    templateId: 'UNKNOWN',
  }
}

function handleFullGearCost() {
  return {
    intent: INTENTS.FULL_GEAR_COST,
    category: 'general',
    factText: FULL_GEAR_COST_REFUSAL,
    requiredClaims: ['no_gearing_total'],
    placeholders: {},
    referenced: emptyReferenced(),
    reasonCode: 'no_gearing_total',
    allowFlavor: false,
    templateId: 'FULL_GEAR_COST',
  }
}

function handleGreeting(args) {
  const hasAccount = Boolean(args.facts?.accountId)
  return {
    intent: INTENTS.GREETING,
    category: 'greeting',
    factText: hasAccount ? INITIAL_GREETING : `${INITIAL_GREETING} ${NO_ACCOUNT_HINT}`,
    requiredClaims: ['greeting'],
    placeholders: {},
    referenced: emptyReferenced(),
    links: hasAccount ? [] : [GAME_ACCOUNTS_LINK],
    reasonCode: 'greeting',
    allowFlavor: false,
    templateId: 'GREETING',
  }
}

function handleBalance(args) {
  const blocked = requireAccount(args, INTENTS.BALANCE)
  if (blocked) return blocked
  const { facts } = args
  if (facts.currentDkp == null) {
    return {
      intent: INTENTS.BALANCE,
      category: 'unknown',
      factText: 'I do not have a verified DKP balance for your account right now. No balance was invented.',
      requiredClaims: ['balance_unknown'],
      placeholders: {},
      referenced: emptyReferenced(),
      reasonCode: 'balance_unknown',
      allowFlavor: true,
    }
  }
  const band = classifyBalance(facts.currentDkp, facts.guildBalances) || 'mid'
  const category = band === 'low' ? 'balance_low' : band === 'high' ? 'balance_high' : 'balance_mid'
  const balance = formatDkp(facts.currentDkp)
  return {
    intent: INTENTS.BALANCE,
    category,
    factText: `Your verified account balance is ${balance} DKP.`,
    requiredClaims: ['balance'],
    placeholders: { balance: Number(facts.currentDkp) },
    referenced: emptyReferenced(),
    reasonCode: category,
    allowFlavor: true,
  }
}

function handleWhyBroke(args) {
  const blocked = requireAccount(args, INTENTS.WHY_BROKE)
  if (blocked) return blocked
  const { facts } = args
  const claims = []
  const refs = emptyReferenced()
  const biggest = facts.biggestPurchase
  const balance = facts.currentDkp != null ? formatDkp(facts.currentDkp) : null

  if (facts.currentDkp != null) claims.push('balance')
  else claims.push('balance_unknown')

  let factText
  let category = 'purchase_unknown_value'
  if (biggest?.itemName && biggest.cost != null) {
    const cost = formatDkp(biggest.cost)
    factText =
      balance != null
        ? `You're at ${balance} DKP because ${biggest.itemName} ate ${cost} — among other decisions the ledger refuses to forget.`
        : `${biggest.itemName} for ${cost} DKP is the loudest entry. The rest of the ledger is equally unhelpful to your dignity.`
    claims.push('largest_purchase')
    refs.items.push(biggest.itemName)
    if (biggest.attributedCharacterName) refs.characters.push(biggest.attributedCharacterName)
    category = 'biggest_purchase'
  } else if ((facts.totalRecordedPurchases || 0) === 0) {
    factText =
      balance != null
        ? `Balance ${balance} DKP, zero verified purchases loaded. Broke without a shopping trail — remarkable.`
        : 'No verified purchases and no balance to inspect. Mystery poverty is still poverty.'
    claims.push('no_purchases')
    category = facts.currentDkp != null && Number(facts.currentDkp) <= 50 ? 'balance_low' : 'purchase_unknown_value'
  } else if (balance != null) {
    factText = `You're sitting on ${balance} DKP. The ledger has opinions; none of them are flattering.`
    category = Number(facts.currentDkp) <= 50 ? 'balance_low' : 'balance_mid'
  } else {
    factText = 'Balance unavailable and the purchase history will not invent a scapegoat. Ask something more specific.'
  }
  claims.push('causality_disclaimer')

  return {
    intent: INTENTS.WHY_BROKE,
    category,
    factText,
    requiredClaims: claims,
    placeholders: {
      balance: facts.currentDkp,
      item: biggest?.itemName || null,
      cost: biggest?.cost ?? null,
      toon: biggest?.attributedCharacterName || null,
    },
    referenced: withRefs(refs.characters, refs.items),
    reasonCode: 'why_broke',
    allowFlavor: false,
  }
}

function handleGearAssessment(args) {
  const blocked = requireAccount(args, INTENTS.GEAR_ASSESSMENT)
  if (blocked) return blocked
  const character = args.selectedCharacter
  if (!character) {
    const chars = args.facts.characters || []
    if (chars.length > 1) {
      return clarificationCharacter(INTENTS.GEAR_ASSESSMENT, chars, args.ambiguousClass)
    }
    if (chars.length === 1) {
      return handleGearAssessment({ ...args, selectedCharacter: chars[0] })
    }
    return {
      intent: INTENTS.GEAR_ASSESSMENT,
      category: 'unknown',
      factText: 'You have no linked characters to assess. No gear analysis was performed.',
      requiredClaims: ['no_character'],
      placeholders: {},
      referenced: emptyReferenced(),
      reasonCode: 'no_character',
      allowFlavor: true,
    }
  }

  if (!args.upgradeContext?.rankings) {
    const loadErr = formatMageloLoadError(
      args.upgradeContext?.rankingsError
        ? { ok: false, ...args.upgradeContext.rankingsError }
        : null,
    )
    const detail = loadErr || 'the public Magelo rankings export is unavailable'
    return {
      intent: INTENTS.GEAR_ASSESSMENT,
      category: 'unknown',
      factText: `I cannot assess ${character.name}'s gear right now — ${detail}. No analysis was invented.`,
      requiredClaims: ['magelo_unavailable'],
      placeholders: { toon: character.name },
      referenced: withRefs([character.name], []),
      reasonCode: loadErr ? 'magelo_fetch_failed' : 'missing_magelo_export',
      allowFlavor: false,
      templateId: 'GEAR_MISSING',
    }
  }

  const assessment = assessCharacterGear({
    character,
    rankings: args.upgradeContext.rankings,
    itemStats: args.upgradeContext?.itemStats ?? null,
    raidItemIds: args.upgradeContext?.raidItemIds ?? null,
  })

  if (!assessment.ok) {
    return {
      intent: INTENTS.GEAR_ASSESSMENT,
      category: 'unknown',
      factText: assessment.summary,
      requiredClaims: assessment.claims,
      placeholders: { toon: character.name },
      referenced: withRefs([character.name], []),
      reasonCode: assessment.reason,
      allowFlavor: false,
      templateId: 'GEAR_MISSING',
    }
  }

  let factText = assessment.summary
  const cards = []
  if (assessment.upgradeSuggestions?.length) {
    for (const u of assessment.upgradeSuggestions.slice(0, 3)) {
      cards.push({
        type: 'upgrade',
        itemName: u.itemName,
        itemId: u.itemId,
        slot: u.slot,
        upgrade: u.upgrade,
        lastSale: lookupPrice(args.facts, u.itemName),
        zone: lookupSource(args.facts, u.itemName)?.zone || null,
        to: `/items/${encodeURIComponent(u.itemName)}`,
      })
    }
  } else if (assessment.band === 'strong') {
    factText = `${assessment.summary} Slots look finished — now try finishing the fight.`
  }

  return {
    intent: INTENTS.GEAR_ASSESSMENT,
    category: 'upgrade_any',
    factText,
    requiredClaims: assessment.claims,
    placeholders: {
      toon: character.name,
      item: assessment.upgradeSuggestions?.[0]?.itemName || null,
      upgrade: assessment.upgradeSuggestions?.[0]?.upgrade || null,
      slot: assessment.upgradeSuggestions?.[0]?.slot || null,
    },
    referenced: assessment.referenced,
    cards,
    reasonCode: 'gear_assessment',
    allowFlavor: false,
    templateId: 'GEAR_ASSESSMENT',
  }
}

function reasonLabel(reason) {
  const map = {
    class_mismatch: 'wrong class',
    missing_magelo: 'no Magelo profile',
    missing_inventory: 'no Magelo inventory',
    missing_class: 'missing class',
    no_matching_slot: 'no matching slot',
    no_item_stats: 'missing item stats',
    bad_item_id: 'bad item id',
    not_upgrade: 'not an upgrade vs equipped',
    ineligible: 'ineligible',
  }
  return map[reason] || String(reason || 'unavailable').replace(/_/g, ' ')
}

/**
 * Item → roster: which linked toons could use / upgrade with a sticky or named item.
 */
function handleItemFit(args) {
  const blocked = requireAccount(args, INTENTS.ITEM_FIT)
  if (blocked) return blocked

  const characters = args.facts.characters || []
  if (!characters.length) {
    return {
      intent: INTENTS.ITEM_FIT,
      category: 'unknown',
      factText: 'No linked characters available. No item-fit analysis was performed.',
      requiredClaims: ['no_character'],
      placeholders: {},
      referenced: emptyReferenced(),
      reasonCode: 'no_character',
      allowFlavor: true,
    }
  }

  const itemName = args.itemName || null
  const itemId = args.itemId ?? null
  if (!itemName && (itemId == null || itemId === '')) {
    return {
      intent: INTENTS.ITEM_FIT,
      category: 'unknown',
      factText:
        'Which item? Name it, or ask after a loot answer that mentions a specific piece (for example a Quarm ring award).',
      requiredClaims: ['need_item'],
      placeholders: {},
      referenced: emptyReferenced(),
      reasonCode: 'need_item',
      allowFlavor: false,
      clarification: { slot: 'item', message: 'Which item?', pendingIntent: INTENTS.ITEM_FIT },
      needsItem: true,
    }
  }

  if (args.itemUnmatched) {
    return {
      intent: INTENTS.ITEM_FIT,
      category: 'unknown',
      factText: `I do not recognize "${itemName}" as a known item. Name a raid loot piece I can score.`,
      requiredClaims: ['item_unmatched'],
      placeholders: { item: itemName },
      referenced: withRefs([], [itemName].filter(Boolean)),
      reasonCode: 'item_unmatched',
      allowFlavor: false,
    }
  }

  if (!args.upgradeContext?.rankings) {
    const loadErr = formatMageloLoadError(
      args.upgradeContext?.rankingsError
        ? { ok: false, ...args.upgradeContext.rankingsError }
        : null,
    )
    const detail = loadErr || 'Magelo rankings data is not loaded'
    return {
      intent: INTENTS.ITEM_FIT,
      category: 'unknown',
      factText: `I cannot score ${itemName || 'that item'} across your toons because ${detail}. No fit numbers were invented.`,
      requiredClaims: ['magelo_unavailable'],
      placeholders: { item: itemName },
      referenced: withRefs([], [itemName].filter(Boolean)),
      reasonCode: loadErr ? 'magelo_fetch_failed' : 'magelo_unavailable',
      allowFlavor: false,
    }
  }

  const result = evaluateItemFitForAccount({
    characters,
    itemId,
    itemName,
    rankings: args.upgradeContext.rankings,
    itemStats: args.upgradeContext.itemStats || {},
    raidItemIds: args.upgradeContext.raidItemIds || new Set(),
  })

  if (!result.ok) {
    const reason = result.reason || 'unavailable'
    let factText = `I could not score ${itemName || 'that item'} across your toons (${reasonLabel(reason)}).`
    if (reason === 'item_unresolved') {
      factText = `I could not resolve "${itemName || 'that item'}" to Magelo item stats. Name a known raid loot piece.`
    }
    return {
      intent: INTENTS.ITEM_FIT,
      category: 'unknown',
      factText,
      requiredClaims: ['item_fit_unavailable'],
      placeholders: { item: itemName },
      referenced: withRefs([], [itemName].filter(Boolean)),
      reasonCode: reason,
      allowFlavor: false,
      itemFit: result,
    }
  }

  const upgrades = result.fits.filter((f) => f.isUpgrade)
  const notUpgrades = result.fits.filter((f) => f.eligible && !f.isUpgrade)
  const ineligible = result.fits.filter((f) => !f.eligible)
  const resolvedName = result.itemName || itemName

  const upgradeBits = upgrades.map((f) => `${f.characterName} (${f.upgrade})`)
  const skipBits = [
    ...notUpgrades.map((f) => `${f.characterName} (${reasonLabel('not_upgrade')})`),
    ...ineligible.map((f) => `${f.characterName} (${reasonLabel(f.reason)})`),
  ]

  let factText
  if (upgrades.length) {
    factText = `${resolvedName} is an upgrade for ${upgradeBits.join('; ')}.`
    if (skipBits.length) factText += ` Not for: ${skipBits.join('; ')}.`
  } else {
    factText = `${resolvedName} is not a Magelo upgrade for any of your linked toons.`
    if (skipBits.length) factText += ` Checked: ${skipBits.join('; ')}.`
  }

  const cards = upgrades.slice(0, 5).map((f) => ({
    type: 'upgrade',
    itemName: resolvedName,
    itemId: result.itemId,
    slot: f.slotName,
    upgrade: f.upgrade,
    characterName: f.characterName,
    to: `/items/${encodeURIComponent(resolvedName)}`,
  }))

  return {
    intent: INTENTS.ITEM_FIT,
    category: upgrades.length ? 'upgrade_any' : 'unknown',
    factText,
    requiredClaims: upgrades.length ? ['item_fit_upgrades'] : ['item_fit_none'],
    placeholders: {
      item: resolvedName,
      toon: upgrades[0]?.characterName || null,
      upgrade: upgrades[0]?.upgrade || null,
      slot: upgrades[0]?.slotName || null,
    },
    referenced: withRefs(
      upgrades.map((f) => f.characterName),
      [resolvedName],
    ),
    cards,
    reasonCode: upgrades.length ? 'item_fit_upgrades' : 'item_fit_none',
    allowFlavor: true,
    itemFit: result,
  }
}

function handleUpgrades(args) {
  const blocked = requireAccount(args, INTENTS.UPGRADES)
  if (blocked) return blocked
  const character = args.selectedCharacter
  if (!character) {
    const chars = args.facts.characters || []
    if (chars.length > 1) {
      return clarificationCharacter(INTENTS.UPGRADES, chars, args.ambiguousClass)
    }
    if (chars.length === 1) {
      return handleUpgrades({ ...args, selectedCharacter: chars[0] })
    }
    return {
      intent: INTENTS.UPGRADES,
      category: 'unknown',
      factText: 'No linked characters available. No upgrade analysis was performed.',
      requiredClaims: ['no_character'],
      placeholders: {},
      referenced: emptyReferenced(),
      reasonCode: 'no_character',
      allowFlavor: true,
    }
  }

  if (!args.upgradeContext?.rankings) {
    const loadErr = formatMageloLoadError(
      args.upgradeContext?.rankingsError
        ? { ok: false, ...args.upgradeContext.rankingsError }
        : null,
    )
    const detail = loadErr || 'Magelo rankings data is not loaded'
    return {
      intent: INTENTS.UPGRADES,
      category: 'unknown',
      factText: `I cannot suggest upgrades for ${character.name} because ${detail}. No candidates were invented.`,
      requiredClaims: ['magelo_unavailable'],
      placeholders: { toon: character.name },
      referenced: withRefs([character.name], []),
      reasonCode: loadErr ? 'magelo_fetch_failed' : 'magelo_unavailable',
      allowFlavor: false,
    }
  }

  const slotIds = Array.isArray(args.slotIds) && args.slotIds.length ? args.slotIds : null
  const slotLabel = args.slotLabel || null
  const result = computeCharacterUpgrades({
    character,
    rankings: args.upgradeContext.rankings,
    itemStats: args.upgradeContext.itemStats || {},
    raidItemIds: args.upgradeContext.raidItemIds || new Set(),
    limit: 5,
    slotIds,
  })

  if (!result.ok) {
    const reason = result.reason || 'unavailable'
    const slotScoped = reason === 'no_upgrades_for_slot' && slotLabel
    const factText = slotScoped
      ? `No verified upgrades for ${character.name} in ${slotLabel}: no positive candidates in that slot. I will not invent improvement numbers.`
      : `No verified upgrades for ${character.name}: ${String(reason).replace(/_/g, ' ')}. I will not invent improvement numbers.`
    return {
      intent: INTENTS.UPGRADES,
      category: 'unknown',
      factText,
      requiredClaims: ['upgrades_unavailable'],
      placeholders: { toon: character.name, slot: slotLabel },
      referenced: withRefs([character.name], []),
      reasonCode: 'upgrades_unavailable',
      allowFlavor: false,
      detailReason: reason,
      upgradeSlots: result.upgradeSlots || [],
    }
  }

  const upgrades = result.suggestions.map((u) => ({
    ...u,
    lastSale: lookupPrice(args.facts, u.itemName),
    zone: lookupSource(args.facts, u.itemName)?.zone || null,
  }))
  const top = upgrades[0]
  const strength = top?.strength === 'strong' ? 'upgrade_strong' : top?.strength === 'modest' ? 'upgrade_modest' : 'upgrade_any'
  const cards = upgrades.map((u) => ({
    type: 'upgrade',
    itemName: u.itemName,
    itemId: u.itemId,
    slot: u.slot,
    upgrade: u.upgrade,
    lastSale: u.lastSale,
    zone: u.zone,
    to: `/items/${encodeURIComponent(u.itemName)}`,
  }))
  const scopeLabel = slotLabel || top?.slot || null
  const factText = scopeLabel && slotIds
    ? `For ${character.name} ${scopeLabel}, top verified candidates: ${upgrades.map((u) => `${u.itemName} (${u.upgrade})`).join('; ')}.`
    : `For ${character.name}, top verified candidates: ${upgrades.map((u) => `${u.itemName} (${u.upgrade})`).join('; ')}.`

  return {
    intent: INTENTS.UPGRADES,
    category: strength,
    factText,
    requiredClaims: ['upgrade_candidates'],
    placeholders: {
      toon: character.name,
      item: top?.itemName || null,
      upgrade: top?.upgrade || null,
      slot: scopeLabel,
    },
    referenced: withRefs([character.name], upgrades.map((u) => u.itemName)),
    cards,
    reasonCode: strength,
    allowFlavor: true,
    upgrades,
    upgradeSlots: result.upgradeSlots || [],
  }
}

function clarificationCharacter(pendingIntent, characters, ambiguousClass) {
  const names = (ambiguousClass?.candidates || characters).map((c) => c.name).filter(Boolean)
  const label = ambiguousClass?.className || 'character'
  return {
    intent: pendingIntent,
    category: 'unknown',
    factText: `Which ${label}? Options: ${names.join(', ')}. I need a name before I assess anything.`,
    requiredClaims: ['need_character'],
    placeholders: {},
    referenced: withRefs(names, []),
    reasonCode: 'need_character',
    allowFlavor: false,
    templateId: 'NEED_CHAR',
    clarification: { slot: 'character', message: 'need_character', pendingIntent },
  }
}

function handleWorstPurchase(args) {
  const blocked = requireAccount(args, INTENTS.WORST_PURCHASE)
  if (blocked) return blocked
  const scoped = scopedPurchaseFacts(args.facts, args.selectedCharacter || null)
  if (scoped.scope === 'character' && scoped.totalRecordedPurchases === 0) {
    const name = args.selectedCharacter?.name || 'that character'
    return {
      intent: INTENTS.WORST_PURCHASE,
      category: 'unknown',
      factText: `No reliably attributed purchases for ${name} are loaded, so I cannot identify a worst purchase for that character.`,
      requiredClaims: ['no_purchases', 'character_scoped'],
      placeholders: { toon: name },
      referenced: withRefs([name], []),
      reasonCode: 'no_purchases',
      allowFlavor: false,
    }
  }
  const picked = pickSpendPurchase(scoped)
  const purchase = picked.purchase
  if (!purchase?.itemName || purchase.cost == null) {
    return {
      intent: INTENTS.WORST_PURCHASE,
      category: 'unknown',
      factText: 'No verified purchase with a cost is available, so I cannot identify a worst purchase.',
      requiredClaims: ['no_purchases'],
      placeholders: {},
      referenced: emptyReferenced(),
      reasonCode: 'no_purchases',
      allowFlavor: true,
    }
  }
  // Only use price_outlier when the selected purchase itself carries medianPrice
  const category =
    purchase.medianPrice != null && Number.isFinite(Number(purchase.medianPrice))
      ? 'price_outlier'
      : 'biggest_purchase'
  const who =
    args.selectedCharacter?.name ||
    purchase.attributedCharacterName ||
    null
  const medianBit =
    category === 'price_outlier'
      ? ` Comparable sales median for that same purchase: ${formatDkp(purchase.medianPrice)} DKP.`
      : ''
  return {
    intent: INTENTS.WORST_PURCHASE,
    category,
    factText: `By sheer DKP spent${scoped.scope === 'character' ? ` for ${who}` : ''}, your most expensive verified purchase was ${purchase.itemName} for ${formatDkp(purchase.cost)} DKP${who && scoped.scope === 'account' ? ` (toward ${who})` : ''}.${medianBit} That is an expense metric, not a scientific waste score.`,
    requiredClaims: ['largest_purchase', 'metric_disclaimer'],
    placeholders: {
      item: purchase.itemName,
      cost: purchase.cost,
      toon: who,
      medianPrice: category === 'price_outlier' ? purchase.medianPrice : null,
    },
    referenced: withRefs(who ? [who] : [], [purchase.itemName]),
    reasonCode: category,
    allowFlavor: true,
    purchase,
  }
}

function handlePurchases(args) {
  const blocked = requireAccount(args, args.intent)
  if (blocked) return blocked
  const scoped = scopedPurchaseFacts(args.facts, args.selectedCharacter || null)
  if (scoped.scope === 'character' && scoped.totalRecordedPurchases === 0) {
    const name = args.selectedCharacter?.name || 'that character'
    return {
      intent: args.intent,
      category: 'unknown',
      factText: `No reliably attributed purchases for ${name} are loaded.`,
      requiredClaims: ['no_purchases', 'character_scoped'],
      placeholders: { toon: name },
      referenced: withRefs([name], []),
      reasonCode: 'no_purchases',
      allowFlavor: false,
    }
  }
  const picked = pickSpendPurchase(scoped)
  const purchase = picked.purchase
  if (!purchase?.itemName) {
    return {
      intent: args.intent,
      category: 'unknown',
      factText: 'No verified purchases are loaded for your account.',
      requiredClaims: ['no_purchases'],
      placeholders: {},
      referenced: emptyReferenced(),
      reasonCode: 'no_purchases',
      allowFlavor: true,
    }
  }
  const slotPat = (scoped.slotRepeatPatterns || [])[0]
  let category = picked.category || 'recent_purchase'
  if (
    purchase.medianPrice != null &&
    Number.isFinite(Number(purchase.medianPrice)) &&
    category === 'price_outlier'
  ) {
    category = 'price_outlier'
  } else if (category === 'price_outlier') {
    category = scoped.biggestPurchase ? 'biggest_purchase' : 'recent_purchase'
  } else if (slotPat && category !== 'biggest_purchase') {
    category = category === 'slot_repeat' ? 'slot_repeat' : category
  } else if (!category || category === 'recent_purchase') {
    if (scoped.biggestPurchase && purchase.purchaseId === scoped.biggestPurchase.purchaseId) {
      category = 'biggest_purchase'
    } else if ((scoped.totalRecordedPurchases || 0) >= 3) {
      category = 'purchase_volume'
    }
  }

  const who =
    args.selectedCharacter?.name ||
    slotPat?.toon ||
    purchase.attributedCharacterName ||
    null
  const scopeLabel =
    scoped.scope === 'character'
      ? ` for ${who}`
      : ''

  return {
    intent: args.intent,
    category,
    factText: `Verified purchase evidence${scopeLabel} includes ${purchase.itemName}${purchase.cost != null ? ` for ${formatDkp(purchase.cost)} DKP` : ''} across ${scoped.totalRecordedPurchases} recorded purchases${scoped.scope === 'character' ? ' attributed to that character' : ''}.`,
    requiredClaims: ['purchase_history'],
    placeholders: {
      item: purchase.itemName,
      cost: purchase.cost,
      purchaseCount: scoped.totalRecordedPurchases,
      toon: who,
      slot: slotPat?.slot || null,
      medianPrice:
        category === 'price_outlier' && purchase.medianPrice != null ? purchase.medianPrice : null,
    },
    referenced: withRefs(who ? [who] : [], [purchase.itemName]),
    reasonCode: category,
    allowFlavor: true,
    purchase,
  }
}

function handleCharacterRoast(args) {
  const blocked = requireAccount(args, args.intent)
  if (blocked) return blocked
  const chars = args.facts.characters || []
  if (chars.length < 1) {
    return {
      intent: args.intent,
      category: 'unknown',
      factText: 'No linked characters to roast.',
      requiredClaims: ['no_character'],
      placeholders: {},
      referenced: emptyReferenced(),
      reasonCode: 'no_character',
      allowFlavor: true,
    }
  }
  const conc = spendingConcentration(args.facts.purchasesByCharacterSpent || {}, chars)
  const selected = args.selectedCharacter
  let category = chars.length >= 2 ? 'multi_char' : 'general'
  if (conc) category = 'spend_concentration'
  else if (chars.length >= 2) category = 'two_chars'

  const toon = selected?.name || conc?.character?.name || chars[0]?.name
  const other = chars.find((c) => c.name && c.name !== toon)?.name || null

  return {
    intent: args.intent,
    category,
    factText: `You have ${chars.length} linked character(s)${toon ? `, including ${toon}` : ''}${conc ? ` with ${conc.sharePct}% of attributable spend on ${conc.character?.name}` : ''}.`,
    requiredClaims: ['characters'],
    placeholders: {
      charCount: chars.length,
      toon,
      otherToon: other,
      sharePct: conc?.sharePct ?? null,
    },
    referenced: withRefs([toon, other].filter(Boolean), []),
    reasonCode: category,
    allowFlavor: true,
  }
}

function handleItemPrice(args) {
  const itemName = args.itemName
  if (!itemName) {
    return {
      intent: INTENTS.ITEM_PRICE,
      category: 'unknown',
      factText: "Which item? You've made enough purchases that I can't identify the price target without a name.",
      requiredClaims: ['need_item'],
      placeholders: {},
      referenced: emptyReferenced(),
      reasonCode: 'need_item',
      allowFlavor: false,
      templateId: 'NEED_ITEM',
      clarification: { slot: 'item', message: 'need_item', pendingIntent: INTENTS.ITEM_PRICE },
    }
  }
  if (args.itemUnmatched) {
    return {
      intent: INTENTS.ITEM_PRICE,
      category: 'item_unmatched',
      factText: `I can't identify ${itemName} in the available item data.`,
      requiredClaims: ['item_unmatched'],
      placeholders: { item: itemName },
      referenced: emptyReferenced(),
      reasonCode: 'item_unmatched',
      allowFlavor: true,
    }
  }
  const lastSale = args.lastSale
  if (lastSale == null) {
    return {
      intent: INTENTS.ITEM_PRICE,
      category: 'afford_unknown',
      factText: `No reliable recorded sale price for ${itemName}. I will not invent one.`,
      requiredClaims: ['price_unknown'],
      placeholders: { item: itemName },
      referenced: withRefs([], [itemName]),
      reasonCode: 'price_unknown',
      allowFlavor: true,
    }
  }
  return {
    intent: INTENTS.ITEM_PRICE,
    category: 'item_sale',
    factText: `${itemName} last sold for ${formatDkp(lastSale)} DKP (historical record, not a future guarantee).`,
    requiredClaims: ['last_sale'],
    placeholders: { item: itemName, lastSale },
    referenced: withRefs([], [itemName]),
    reasonCode: 'item_sale',
    allowFlavor: true,
  }
}

function handleItemSource(args) {
  const itemName = args.itemName
  if (!itemName) {
    return {
      intent: INTENTS.ITEM_SOURCE,
      category: 'unknown',
      factText: 'Which item drop are you asking about?',
      requiredClaims: ['need_item'],
      placeholders: {},
      referenced: emptyReferenced(),
      reasonCode: 'need_item',
      allowFlavor: false,
      clarification: { slot: 'item', message: 'need_item', pendingIntent: INTENTS.ITEM_SOURCE },
    }
  }
  if (args.itemUnmatched) {
    return {
      intent: INTENTS.ITEM_SOURCE,
      category: 'item_unmatched',
      factText: `No trustworthy item match for ${itemName}.`,
      requiredClaims: ['item_unmatched'],
      placeholders: { item: itemName },
      referenced: emptyReferenced(),
      reasonCode: 'item_unmatched',
      allowFlavor: true,
    }
  }
  const src = args.itemSource
  if (!src?.zone && !src?.mob) {
    return {
      intent: INTENTS.ITEM_SOURCE,
      category: 'item_unmatched',
      factText: `I don't have a verified drop source for ${itemName}.`,
      requiredClaims: ['source_unknown'],
      placeholders: { item: itemName },
      referenced: withRefs([], [itemName]),
      reasonCode: 'source_unknown',
      allowFlavor: true,
    }
  }
  const detail = src.mob && src.zone ? `${src.mob} in ${src.zone}` : src.mob || src.zone
  return {
    intent: INTENTS.ITEM_SOURCE,
    category: 'item_source',
    factText: `${itemName} is recorded from ${detail}.`,
    requiredClaims: ['item_source'],
    placeholders: { item: itemName, zone: src.zone || null, mob: src.mob || null },
    referenced: withRefs([], [itemName]),
    reasonCode: 'item_source',
    allowFlavor: true,
  }
}

function handleAffordability(args) {
  const itemName = args.itemName
  if (!itemName) {
    return {
      intent: INTENTS.AFFORDABILITY,
      category: 'unknown',
      factText: 'Affordability of what item?',
      requiredClaims: ['need_item'],
      placeholders: {},
      referenced: emptyReferenced(),
      reasonCode: 'need_item',
      allowFlavor: false,
      clarification: { slot: 'item', message: 'need_item', pendingIntent: INTENTS.AFFORDABILITY },
    }
  }
  const lastSale = args.lastSale
  if (lastSale == null) {
    return {
      intent: INTENTS.AFFORDABILITY,
      category: 'afford_unknown',
      factText: `No reliable historical price for ${itemName}, so affordability cannot be judged.`,
      requiredClaims: ['price_unknown'],
      placeholders: { item: itemName },
      referenced: withRefs([], [itemName]),
      reasonCode: 'afford_unknown',
      allowFlavor: true,
    }
  }
  const bal = args.facts.currentDkp
  const yes = bal != null && bal >= lastSale
  return {
    intent: INTENTS.AFFORDABILITY,
    category: yes ? 'afford_yes' : 'afford_no',
    factText:
      bal == null
        ? `${itemName} last sold for ${formatDkp(lastSale)} DKP; your balance is unavailable for comparison.`
        : yes
          ? `${itemName} last sold for ${formatDkp(lastSale)} DKP; your balance of ${formatDkp(bal)} can cover that historical price.`
          : `${itemName} last sold for ${formatDkp(lastSale)} DKP; your balance of ${formatDkp(bal)} is below that reference.`,
    requiredClaims: ['affordability'],
    placeholders: { item: itemName, lastSale, balance: bal },
    referenced: withRefs([], [itemName]),
    reasonCode: yes ? 'afford_yes' : 'afford_no',
    allowFlavor: true,
  }
}

function handleItemSearch(args) {
  if (args.itemUnmatched || !args.itemName) {
    return handleItemPrice({ ...args, itemUnmatched: true, itemName: args.itemName || 'that' })
  }
  if (args.itemSource?.zone || args.itemSource?.mob) return handleItemSource(args)
  if (args.lastSale != null) return handleItemPrice(args)
  return {
    intent: INTENTS.ITEM_SEARCH,
    category: 'item_unmatched',
    factText: `I matched ${args.itemName} by name but have no verified price or source details loaded.`,
    requiredClaims: ['item_matched_sparse'],
    placeholders: { item: args.itemName },
    referenced: withRefs([], [args.itemName]),
    reasonCode: 'item_sparse',
    allowFlavor: true,
  }
}

function handleAttendance(args) {
  const blocked = requireAccount(args, INTENTS.ATTENDANCE)
  if (blocked) return blocked
  const { facts } = args
  const elig = facts.attendanceEligibility || {}
  let category = 'general'
  let factText = 'Account attendance data is insufficient for a definitive participation roast. Missing rows are not proof of absence.'
  let claims = ['attendance_insufficient']

  if (elig.canRoastReturn) {
    category = 'attendance_return'
    factText = `Your account returned after a verified ${facts.returnGapDays}-day gap between recorded raids.`
    claims = ['attendance_return']
  } else if (elig.canRoastSparse) {
    category = 'attendance_sparse'
    factText =
      facts.daysSince != null
        ? `It has been ${facts.daysSince} days since your account's last recorded raid (${facts.lastAccountRaid?.raidName || 'unknown raid'}). Account-level only — not a claim about any specific character.`
        : `Your account has recorded ${facts.accountRaidCount ?? 0} raids in the comparison window. Account-level only.`
    claims = ['attendance_sparse']
  } else if (elig.canRoastFrequent) {
    category = 'attendance_frequent'
    factText = `Your account has appeared in ${facts.accountRaidCount} recorded raids in the observation window. Account-level participation only.`
    claims = ['attendance_frequent']
  }

  return {
    intent: INTENTS.ATTENDANCE,
    category,
    factText,
    requiredClaims: claims,
    placeholders: {
      raidCount: facts.accountRaidCount,
      daysSince: elig.canRoastReturn ? facts.returnGapDays : facts.daysSince,
      lastRaid: facts.lastAccountRaid?.raidName || null,
    },
    referenced: emptyReferenced(),
    reasonCode: category,
    allowFlavor: true,
  }
}

function handleAccountComparison(args) {
  const blocked = requireAccount(args, INTENTS.ACCOUNT_COMPARISON)
  if (blocked) return blocked
  return handleBalance(args)
}

function handleDefense() {
  return {
    intent: INTENTS.DEFENSE,
    category: 'defense',
    factText: "I'm sure you had a perfectly good reason. I'm equally sure it sounded better in your head.",
    requiredClaims: ['defense'],
    placeholders: {},
    referenced: emptyReferenced(),
    reasonCode: 'defense',
    allowFlavor: false,
  }
}

function handleGeneralRoast(args) {
  const events = deriveEvents(args.facts || {})
  if (args.facts?.biggestPurchase) {
    return handlePurchases({ ...args, intent: INTENTS.SPENDING_ROAST })
  }
  if ((args.facts?.characters || []).length >= 2) {
    return handleCharacterRoast({ ...args, intent: INTENTS.CHARACTER_ROAST })
  }
  if (args.facts?.currentDkp != null) {
    return handleBalance(args)
  }
  return {
    intent: INTENTS.GENERAL_ROAST,
    category: 'general',
    factText: "I've examined your decisions. I would like to speak to whoever authorized them.",
    requiredClaims: ['general_roast'],
    placeholders: {},
    referenced: emptyReferenced(),
    reasonCode: 'general',
    allowFlavor: false,
  }
}

function handleUnknown() {
  return {
    intent: INTENTS.UNKNOWN,
    category: 'unknown',
    factText:
      'Try asking about loot, upgrades, DKP balance, gear assessment, raid attendance, or your purchase history. I did not perform an analysis for that question.',
    requiredClaims: ['unknown_no_analysis'],
    placeholders: {},
    referenced: emptyReferenced(),
    reasonCode: 'unknown',
    allowFlavor: false,
    templateId: 'UNKNOWN',
  }
}
