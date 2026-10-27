/**
 * Intent-specific domain handlers. Each returns AnswerFacts for fact-first rendering.
 */

import { INTENTS } from '../intents.js'
import { deriveEvents, classifyBalance, spendingConcentration } from '../events.js'
import { formatDkp } from '../formatting.js'
import { computeCharacterUpgrades, formatMageloLoadError } from '../upgrades.js'
import { assessCharacterGear } from '../gearAssessment.js'
import { scopedPurchaseFacts, pickSpendPurchase } from '../facts.js'
import { FULL_GEAR_COST_REFUSAL, NO_ACCOUNT_HINT } from '../templates.js'

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
  if (!itemName) return null
  return facts.knownItemSources?.[String(itemName).toLowerCase()] || null
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
  const factText =
    'I can roast your spending, check your balance, diagnose why you look broke, review purchases, assess Magelo gear when the public export has your toon, suggest upgrades when inventory data exists, look up historical item prices and drop sources, and comment on account-level raid participation. I will not invent numbers or accuse individual characters of skipping raids.'
  return {
    intent: INTENTS.CAPABILITIES,
    category: 'general',
    factText,
    requiredClaims: ['capabilities'],
    placeholders: {},
    referenced: emptyReferenced(),
    reasonCode: 'capabilities',
    allowFlavor: true,
    templateId: 'CAPABILITIES',
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
  return {
    intent: INTENTS.GREETING,
    category: 'greeting',
    factText: args.facts?.accountId
      ? "Welcome to the DKP Inquisitor. I've reviewed your loot history, and I'm disappointed already."
      : `Welcome to the DKP Inquisitor. I've reviewed your loot history, and I'm disappointed already. ${NO_ACCOUNT_HINT}`,
    requiredClaims: ['greeting'],
    placeholders: {},
    referenced: emptyReferenced(),
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
  const parts = []
  const claims = []
  const refs = emptyReferenced()

  if (facts.currentDkp != null) {
    parts.push(`Current verified balance: ${formatDkp(facts.currentDkp)} DKP.`)
    claims.push('balance')
  } else {
    parts.push('Current balance is unavailable in the loaded summary.')
    claims.push('balance_unknown')
  }

  const earned = facts.earnedDkp
  const spent = facts.spentDkp
  if (earned != null && spent != null) {
    parts.push(`Account summary shows ${formatDkp(earned)} earned and ${formatDkp(spent)} spent.`)
    claims.push('earned_spent')
  } else if (spent != null) {
    parts.push(`Recorded spent total: ${formatDkp(spent)} DKP.`)
    claims.push('spent')
  } else {
    parts.push('Earned/spent summary totals were not fully available; observations below use purchase history only where verified.')
    claims.push('incomplete_totals')
  }

  const biggest = facts.biggestPurchase
  if (biggest?.itemName && biggest.cost != null) {
    const who = biggest.attributedCharacterName || biggest.buyerName || 'your account'
    parts.push(
      `Largest verified purchase on record: ${biggest.itemName} for ${formatDkp(biggest.cost)} DKP (attributed toward ${who}).`,
    )
    claims.push('largest_purchase')
    refs.items.push(biggest.itemName)
    if (biggest.attributedCharacterName) refs.characters.push(biggest.attributedCharacterName)
  } else if ((facts.totalRecordedPurchases || 0) === 0) {
    parts.push('No verified loot purchases are loaded for this account, so spending is not the obvious culprit in the available history.')
    claims.push('no_purchases')
  }

  parts.push(
    'That is an observation from available records, not proof of a single cause. Incomplete history may hide older spends or adjustments.',
  )
  claims.push('causality_disclaimer')

  return {
    intent: INTENTS.WHY_BROKE,
    category: facts.currentDkp != null && Number(facts.currentDkp) <= 50 ? 'balance_low' : 'purchase_unknown_value',
    factText: parts.join(' '),
    requiredClaims: claims,
    placeholders: {
      balance: facts.currentDkp,
      item: biggest?.itemName || null,
      cost: biggest?.cost ?? null,
      toon: biggest?.attributedCharacterName || null,
    },
    referenced: withRefs(refs.characters, refs.items),
    reasonCode: 'why_broke',
    allowFlavor: true,
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

  const parts = [assessment.summary]
  const cards = []
  if (assessment.upgradeSuggestions?.length) {
    parts.push('Verified Magelo inventory upgrades worth considering:')
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
  } else if (assessment.upgradeReason) {
    parts.push(`Slot upgrade suggestions are unavailable (${assessment.upgradeReason.replace(/_/g, ' ')}).`)
  }

  return {
    intent: INTENTS.GEAR_ASSESSMENT,
    category: 'upgrade_any',
    factText: parts.join(' '),
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
    allowFlavor: true,
    templateId: 'GEAR_ASSESSMENT',
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

  const result = computeCharacterUpgrades({
    character,
    rankings: args.upgradeContext.rankings,
    itemStats: args.upgradeContext.itemStats || {},
    raidItemIds: args.upgradeContext.raidItemIds || new Set(),
    limit: 3,
  })

  if (!result.ok) {
    return {
      intent: INTENTS.UPGRADES,
      category: 'unknown',
      factText: `No verified upgrades for ${character.name}: ${String(result.reason || 'unavailable').replace(/_/g, ' ')}. I will not invent improvement numbers.`,
      requiredClaims: ['upgrades_unavailable'],
      placeholders: { toon: character.name },
      referenced: withRefs([character.name], []),
      reasonCode: 'upgrades_unavailable',
      allowFlavor: false,
      detailReason: result.reason || null,
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

  return {
    intent: INTENTS.UPGRADES,
    category: strength,
    factText: `For ${character.name}, top verified candidates: ${upgrades.map((u) => `${u.itemName} (${u.upgrade})`).join('; ')}.`,
    requiredClaims: ['upgrade_candidates'],
    placeholders: {
      toon: character.name,
      item: top?.itemName || null,
      upgrade: top?.upgrade || null,
      slot: top?.slot || null,
    },
    referenced: withRefs([character.name], upgrades.map((u) => u.itemName)),
    cards,
    reasonCode: strength,
    allowFlavor: true,
    upgrades,
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
