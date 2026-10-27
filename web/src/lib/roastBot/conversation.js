/**
 * Conversation state machine for the DKP Inquisitor.
 */

import { classifyIntent, INTENTS, matchCharacterMention } from './intents.js'
import { buildResponse, greetingMessage } from './responseBuilder.js'
import { matchItemName, suggestionChips, formatDkp } from './formatting.js'
import { computeCharacterUpgrades } from './upgrades.js'

/**
 * @returns {object}
 */
export function createConversationState() {
  return {
    selectedCharacterId: null,
    lastIntent: null,
    lastItemId: null,
    lastItemName: null,
    lastReferencedPurchaseId: null,
    lastUpgradeCandidateId: null,
    recentTemplateIds: [],
    turnCount: 0,
    authUserId: null,
    accountId: null,
  }
}

/**
 * Clear state when auth identity or claimed account changes.
 */
export function resetIfIdentityChanged(state, { userId, accountId }) {
  if (state.authUserId !== userId || state.accountId !== accountId) {
    const next = createConversationState()
    next.authUserId = userId || null
    next.accountId = accountId || null
    return next
  }
  return state
}

function rememberTemplate(state, templateId) {
  const recent = [...(state.recentTemplateIds || []), templateId].filter(Boolean)
  state.recentTemplateIds = recent.slice(-5)
}

function resolveItem(facts, hint, state) {
  if (!hint) {
    if (state.lastItemName) {
      return { name: state.lastItemName, itemId: state.lastItemId }
    }
    return null
  }
  const catalog = facts.itemCatalog || []
  // Also search purchase history names
  const fromPurchases = (facts.purchases || []).map((p) => ({
    name: p.itemName,
    itemId: p.itemId,
  }))
  const merged = [...catalog, ...fromPurchases].filter((i) => i.name)
  const match = matchItemName(hint, merged)
  if (!match) return { unmatched: true, hint }
  if (match.ambiguous) return { ambiguous: true, candidates: match.candidates, hint }
  return { name: match.name, itemId: match.itemId ?? match.id ?? null }
}

function lookupPrice(facts, itemName) {
  if (!itemName) return null
  const key = itemName.toLowerCase()
  const entry = facts.recentItemPrices?.[key]
  if (!entry?.values?.length) return null
  const first = entry.values[0]
  const n = Number(first)
  return Number.isFinite(n) ? n : null
}

function lookupSource(facts, itemName) {
  if (!itemName) return null
  return facts.knownItemSources?.[itemName.toLowerCase()] || null
}

function selectCharacter(facts, matched, state) {
  if (matched?.ambiguous) return { ambiguous: true, candidates: matched.candidates }
  if (matched?.char_id || matched?.name) return matched
  if (state.selectedCharacterId) {
    return (facts.characters || []).find((c) => c.char_id === state.selectedCharacterId) || null
  }
  if ((facts.characters || []).length === 1) return facts.characters[0]
  return null
}

/**
 * Handle one user message.
 *
 * @param {{
 *   text: string,
 *   facts: object,
 *   state: object,
 *   upgradeContext?: { rankings?: object|null, itemStats?: object, raidItemIds?: Set<number> }|null,
 *   rng?: () => number,
 * }} args
 */
export function handleMessage({ text, facts, state, upgradeContext = null, rng = Math.random }) {
  state.turnCount = (state.turnCount || 0) + 1

  const classified = classifyIntent(text, {
    lastIntent: state.lastIntent,
    lastItemId: state.lastItemId,
    lastUpgradeCandidateId: state.lastUpgradeCandidateId,
    characters: facts.characters || [],
  })

  let intent = classified.intent

  // Contextual follow-up remapping
  if (intent === INTENTS.FOLLOWUP) {
    const t = String(text || '').toLowerCase()
    if (/how much|price|cost|sold/.test(t) && (state.lastItemName || state.lastUpgradeCandidateId)) {
      intent = INTENTS.ITEM_PRICE
    } else if (/where|drop|source|zone|mob/.test(t) && state.lastItemName) {
      intent = INTENTS.ITEM_SOURCE
    } else if (/worth|bad|good|serious/.test(t) && state.lastReferencedPurchaseId) {
      intent = INTENTS.WORST_PURCHASE
    } else if (classified.matchedCharacter) {
      intent = INTENTS.UPGRADES
    }
  }

  const charSel = selectCharacter(facts, classified.matchedCharacter, state)
  if (charSel?.ambiguous) {
    const names = charSel.candidates.map((c) => c.name).filter(Boolean).join(', ')
    const response = {
      text: `Which ${charSel.className || 'character'}? You have more than one: ${names}. I refuse to guess which unfinished project you mean.`,
      templateId: 'AMBIGUOUS_CHAR',
      reasonCode: 'ambiguous_character',
      links: [],
      cards: [],
    }
    state.lastIntent = intent
    rememberTemplate(state, response.templateId)
    return { response, state, intent, suggestions: suggestionChips(suggestionState(facts, state)) }
  }

  if (charSel?.char_id) state.selectedCharacterId = charSel.char_id

  const itemHint = classified.matchedItemHint
  // Pronoun / empty follow-ups keep prior item via resolveItem(null, state)
  const itemResolved = resolveItem(facts, itemHint, state)
  if (itemResolved?.ambiguous) {
    const response = {
      text: `Which item? You've named enough loot that I can't identify your latest regret without assistance. Candidates: ${itemResolved.candidates.map((c) => c.name).slice(0, 5).join(', ')}.`,
      templateId: 'AMBIGUOUS_ITEM',
      reasonCode: 'ambiguous_item',
      links: [],
      cards: [],
    }
    state.lastIntent = intent
    rememberTemplate(state, response.templateId)
    return { response, state, intent, suggestions: suggestionChips(suggestionState(facts, state)) }
  }

  let itemName = itemResolved?.name || null
  let itemUnmatched = Boolean(itemResolved?.unmatched)
  if (itemResolved?.unmatched) {
    itemName = itemResolved.hint
  }
  if (!itemName && state.lastItemName && [INTENTS.ITEM_PRICE, INTENTS.ITEM_SOURCE, INTENTS.AFFORDABILITY, INTENTS.FOLLOWUP].includes(intent)) {
    itemName = state.lastItemName
  }

  const lastSale = itemName ? lookupPrice(facts, itemName) : null
  const itemSource = itemName ? lookupSource(facts, itemName) : null
  let affordability = null
  if (itemName) {
    if (lastSale == null) affordability = 'unknown'
    else if (facts.currentDkp != null && facts.currentDkp >= lastSale) affordability = 'yes'
    else if (facts.currentDkp != null) affordability = 'no'
    else affordability = 'unknown'
  }

  /** @type {object[]} */
  let upgrades = []
  if (intent === INTENTS.UPGRADES) {
    if (!charSel && (facts.characters || []).length > 1) {
      const response = {
        text: 'Which character? You have enough unfinished gearing projects that I need a name before I enable further financial damage.',
        templateId: 'NEED_CHAR',
        reasonCode: 'need_character',
        links: [],
        cards: [],
      }
      state.lastIntent = intent
      rememberTemplate(state, response.templateId)
      return { response, state, intent, suggestions: suggestionChips(suggestionState(facts, state)) }
    }
    const character = charSel || (facts.characters || [])[0]
    if (character && upgradeContext) {
      const result = computeCharacterUpgrades({
        character,
        rankings: upgradeContext.rankings,
        itemStats: upgradeContext.itemStats,
        raidItemIds: upgradeContext.raidItemIds,
        limit: 3,
      })
      if (result.ok) {
        upgrades = result.suggestions.map((u) => ({
          ...u,
          lastSale: lookupPrice(facts, u.itemName),
          zone: lookupSource(facts, u.itemName)?.zone || null,
        }))
        if (upgrades[0]) {
          state.lastUpgradeCandidateId = String(upgrades[0].itemId)
          state.lastItemName = upgrades[0].itemName
          state.lastItemId = String(upgrades[0].itemId)
        }
      }
    }
  }

  if (intent === INTENTS.ITEM_SEARCH && itemUnmatched) {
    // keep unmatched path
  } else if (itemName && !itemUnmatched) {
    state.lastItemName = itemName
    if (itemResolved?.itemId != null) state.lastItemId = String(itemResolved.itemId)
  }

  let purchase = null
  if (intent === INTENTS.WORST_PURCHASE || intent === INTENTS.SPENDING_ROAST || intent === INTENTS.PURCHASE_HISTORY) {
    purchase = facts.biggestPurchase || facts.recentPurchase
    if (purchase?.purchaseId) state.lastReferencedPurchaseId = purchase.purchaseId
    if (purchase?.itemName) {
      state.lastItemName = purchase.itemName
      state.lastItemId = purchase.itemId != null ? String(purchase.itemId) : state.lastItemId
    }
  }

  if (intent === INTENTS.ITEM_PRICE && !itemName && !state.lastItemName) {
    const response = {
      text: "Which item? You've made enough purchases that I can't identify your latest regret without assistance.",
      templateId: 'NEED_ITEM',
      reasonCode: 'need_item',
      links: [],
      cards: [],
    }
    state.lastIntent = intent
    rememberTemplate(state, response.templateId)
    return { response, state, intent, suggestions: suggestionChips(suggestionState(facts, state)) }
  }

  // Remap unmatched item searches
  if ((intent === INTENTS.ITEM_SEARCH || intent === INTENTS.ITEM_PRICE || intent === INTENTS.ITEM_SOURCE) && itemUnmatched) {
    // force unmatched templates via flag
  }

  const preferReturnGap = intent === INTENTS.ATTENDANCE && facts.attendanceEligibility?.canRoastReturn

  const response = buildResponse({
    intent,
    facts,
    state,
    upgrades,
    itemName: itemName || state.lastItemName,
    itemSource,
    lastSale: lastSale != null ? Number(formatDkp(lastSale)) || lastSale : null,
    affordability,
    itemUnmatched,
    followupItem: state.lastItemName,
    selectedCharacter: charSel,
    purchase,
    preferReturnGap,
    rng,
  })

  // Attach numeric lastSale for cards when known
  if (response.cards?.length) {
    for (const card of response.cards) {
      if (card.lastSale == null && card.itemName) {
        card.lastSale = lookupPrice(facts, card.itemName)
      }
    }
  }

  state.lastIntent = intent
  rememberTemplate(state, response.templateId)

  return {
    response,
    state,
    intent,
    suggestions: suggestionChips(suggestionState(facts, state)),
  }
}

function suggestionState(facts, state) {
  return {
    hasAccount: Boolean(facts.accountId),
    selectedCharacterId: state.selectedCharacterId,
    lastItemName: state.lastItemName,
    characters: facts.characters || [],
  }
}

export function startConversation(facts) {
  const state = createConversationState()
  state.accountId = facts.accountId || null
  const response = greetingMessage(Boolean(facts.accountId))
  rememberTemplate(state, response.templateId)
  return {
    response,
    state,
    suggestions: suggestionChips(suggestionState(facts, state)),
  }
}

export { INTENTS, matchCharacterMention }
