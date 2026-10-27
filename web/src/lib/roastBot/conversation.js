/**
 * Dialogue state machine for the DKP Inquisitor.
 * Clarifications store pendingIntent and resume on the next turn.
 */

import { classifyIntent, INTENTS, matchCharacterMention, CHARACTER_SCOPED_INTENTS } from './intents.js'
import { renderAnswer, greetingMessage } from './responseBuilder.js'
import { matchItemName, suggestionChips, formatDkp } from './formatting.js'
import { dispatchHandler } from './handlers/index.js'

/**
 * @returns {object}
 */
export function createConversationState() {
  return {
    selectedCharacterId: null,
    lastSubject: null,
    lastIntent: null,
    pendingIntent: null,
    pendingSlots: [],
    lastAnswer: null,
    lastItem: null,
    lastItemId: null,
    lastItemName: null,
    lastPurchase: null,
    lastReferencedPurchaseId: null,
    lastUpgradeCandidateId: null,
    recentTemplateIds: [],
    turnCount: 0,
    authUserId: null,
    accountId: null,
  }
}

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
  if (!templateId) return
  const recent = [...(state.recentTemplateIds || []), templateId].filter(Boolean)
  state.recentTemplateIds = recent.slice(-5)
}

function resolveItem(facts, hint, state, useSticky) {
  if (!hint) {
    if (useSticky && state.lastItemName) {
      return { name: state.lastItemName, itemId: state.lastItemId }
    }
    return null
  }
  const catalog = facts.itemCatalog || []
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
  const entry = facts.recentItemPrices?.[String(itemName).toLowerCase()]
  if (!entry?.values?.length) return null
  const n = Number(entry.values[0])
  return Number.isFinite(n) ? n : null
}

function lookupSource(facts, itemName) {
  if (!itemName) return null
  return facts.knownItemSources?.[String(itemName).toLowerCase()] || null
}

function selectCharacter(facts, matched, state) {
  if (matched?.ambiguous) return { ambiguous: true, className: matched.className, candidates: matched.candidates }
  if (matched?.char_id || matched?.name) return matched
  if (state.selectedCharacterId) {
    return (facts.characters || []).find((c) => c.char_id === state.selectedCharacterId) || null
  }
  if ((facts.characters || []).length === 1) return facts.characters[0]
  return null
}

function setPending(state, intent, slots) {
  state.pendingIntent = intent
  state.pendingSlots = slots || []
}

function clearPending(state) {
  state.pendingIntent = null
  state.pendingSlots = []
}

/**
 * @param {{
 *   text: string,
 *   facts: object,
 *   state: object,
 *   upgradeContext?: object|null,
 *   rng?: () => number,
 * }} args
 */
export function handleMessage({ text, facts, state, upgradeContext = null, rng = Math.random }) {
  state.turnCount = (state.turnCount || 0) + 1

  const classified = classifyIntent(text, {
    lastIntent: state.lastIntent,
    lastItemId: state.lastItemId,
    lastItemName: state.lastItemName,
    lastUpgradeCandidateId: state.lastUpgradeCandidateId,
    characters: facts.characters || [],
    pendingIntent: state.pendingIntent,
  })

  let intent = classified.intent
  let ambiguousClass = null

  // Resume pending clarification
  if (state.pendingIntent && state.pendingSlots?.includes('character')) {
    const matched = classified.matchedCharacter
    if (matched?.ambiguous) {
      ambiguousClass = matched
      intent = state.pendingIntent
    } else if (matched?.char_id || matched?.name) {
      state.selectedCharacterId = matched.char_id || state.selectedCharacterId
      intent = state.pendingIntent
      clearPending(state)
    } else if (classified.clarificationReply || classified.bareCharacterName) {
      // name didn't resolve — stay pending
      intent = state.pendingIntent
    }
  } else if (state.pendingIntent && state.pendingSlots?.includes('item')) {
    if (classified.matchedItemHint) {
      intent = state.pendingIntent
      clearPending(state)
    }
  }

  // Follow-up remapping when not resuming pending
  if (intent === INTENTS.FOLLOWUP && !state.pendingIntent) {
    const t = String(text || '').toLowerCase()
    if (/how much|price|cost|sold/.test(t) && (state.lastItemName || state.lastUpgradeCandidateId)) {
      intent = INTENTS.ITEM_PRICE
    } else if (/where|drop|source|zone|mob/.test(t) && state.lastItemName) {
      intent = INTENTS.ITEM_SOURCE
    } else if (/worth|bad|good|serious/.test(t) && state.lastReferencedPurchaseId) {
      intent = INTENTS.WORST_PURCHASE
    } else if (classified.matchedCharacter && !classified.bareCharacterName) {
      intent = state.lastIntent && CHARACTER_SCOPED_INTENTS.has(state.lastIntent)
        ? state.lastIntent
        : INTENTS.UPGRADES
    } else if (classified.bareCharacterName && classified.matchedCharacter) {
      // Selecting a character without a pending op — acknowledge selection, ask what to do
      state.selectedCharacterId = classified.matchedCharacter.char_id
      state.lastSubject = classified.matchedCharacter.name
      const response = {
        text: `${classified.matchedCharacter.name} is selected. Ask about gear, upgrades, or spending — I need an actual question.`,
        templateId: 'CHAR_SELECTED',
        reasonCode: 'character_selected',
        links: [],
        cards: [],
        requiredClaims: ['character_selected'],
        referenced: { characters: [classified.matchedCharacter.name], items: [] },
      }
      state.lastIntent = INTENTS.FOLLOWUP
      state.lastAnswer = { intent: INTENTS.FOLLOWUP, text: response.text, referenced: response.referenced }
      rememberTemplate(state, response.templateId)
      return { response, state, intent: INTENTS.FOLLOWUP, suggestions: suggestionChips(suggestionState(facts, state)) }
    } else {
      intent = state.lastIntent || INTENTS.UNKNOWN
    }
  }

  // WHY_BROKE vs BALANCE: broke chip / why patterns already classified
  if (intent === INTENTS.BALANCE && /why|broke/.test(normalizeLoose(text))) {
    // keep WHY_BROKE if why-broke patterns matched first; otherwise fine
  }

  let charSel = selectCharacter(facts, classified.matchedCharacter, state)
  if (charSel?.ambiguous) {
    ambiguousClass = charSel
    charSel = null
  }
  if (charSel?.char_id) {
    state.selectedCharacterId = charSel.char_id
    state.lastSubject = charSel.name
  }

  const stickyItem = [INTENTS.ITEM_PRICE, INTENTS.ITEM_SOURCE, INTENTS.AFFORDABILITY, INTENTS.FOLLOWUP].includes(intent)
  const itemResolved = resolveItem(facts, classified.matchedItemHint, state, stickyItem)

  if (itemResolved?.ambiguous) {
    const response = {
      text: `Which item? Candidates: ${itemResolved.candidates.map((c) => c.name).slice(0, 5).join(', ')}.`,
      templateId: 'AMBIGUOUS_ITEM',
      reasonCode: 'ambiguous_item',
      links: [],
      cards: [],
      requiredClaims: ['need_item'],
      referenced: { characters: [], items: [] },
    }
    setPending(state, intent === INTENTS.FOLLOWUP ? INTENTS.ITEM_PRICE : intent, ['item'])
    state.lastIntent = intent
    rememberTemplate(state, response.templateId)
    return { response, state, intent, suggestions: suggestionChips(suggestionState(facts, state)) }
  }

  let itemName = itemResolved?.name || null
  let itemUnmatched = Boolean(itemResolved?.unmatched)
  if (itemResolved?.unmatched) itemName = itemResolved.hint
  if (!itemName && stickyItem && state.lastItemName) itemName = state.lastItemName

  const lastSale = itemName && !itemUnmatched ? lookupPrice(facts, itemName) : null
  const itemSource = itemName && !itemUnmatched ? lookupSource(facts, itemName) : null

  const answer = dispatchHandler({
    intent,
    facts,
    selectedCharacter: charSel,
    ambiguousClass,
    itemName,
    itemUnmatched,
    lastSale: lastSale != null ? Number(formatDkp(lastSale)) || lastSale : null,
    itemSource,
    upgradeContext,
  })

  if (answer.clarification?.slot === 'character') {
    setPending(state, answer.clarification.pendingIntent || intent, ['character'])
  } else if (answer.clarification?.slot === 'item') {
    setPending(state, answer.clarification.pendingIntent || intent, ['item'])
  } else if (!answer.clarification) {
    // Successful domain answer clears pending
    if (state.pendingIntent === intent) clearPending(state)
  }

  const response = renderAnswer({ answer, state, facts, rng })

  // Update sticky memory from answer references only
  if (answer.purchase) {
    state.lastPurchase = answer.purchase
    state.lastReferencedPurchaseId = answer.purchase.purchaseId || null
  }
  if (answer.referenced?.items?.length) {
    state.lastItemName = answer.referenced.items[0]
    state.lastItem = { name: answer.referenced.items[0] }
    const id = answer.cards?.[0]?.itemId ?? answer.upgrades?.[0]?.itemId
    if (id != null) {
      state.lastItemId = String(id)
      state.lastUpgradeCandidateId = String(id)
    }
  } else if (itemName && !itemUnmatched && [INTENTS.ITEM_PRICE, INTENTS.ITEM_SOURCE, INTENTS.AFFORDABILITY, INTENTS.ITEM_SEARCH].includes(intent)) {
    state.lastItemName = itemName
    state.lastItem = { name: itemName }
    if (itemResolved?.itemId != null) state.lastItemId = String(itemResolved.itemId)
  }

  // Unrelated unknown follow-up: do not keep stale links (renderAnswer already uses answer.referenced only)
  if (intent === INTENTS.UNKNOWN) {
    // leave lastItem sticky for intentional "how much" later, but response has no stale links
  }

  state.lastIntent = intent
  state.lastAnswer = {
    intent,
    facts: answer.requiredClaims,
    text: response.text,
    referenced: response.referenced,
  }
  state.lastSubject = charSel?.name || state.lastSubject
  rememberTemplate(state, response.templateId)
  if (answer._flavorId) rememberTemplate(state, answer._flavorId)

  return {
    response,
    state,
    intent,
    answer,
    suggestions: suggestionChips(suggestionState(facts, state)),
  }
}

function normalizeLoose(text) {
  return String(text || '').toLowerCase()
}

function suggestionState(facts, state) {
  const chips = {
    hasAccount: Boolean(facts.accountId),
    selectedCharacterId: state.selectedCharacterId,
    lastItemName: state.lastItemName,
    characters: facts.characters || [],
    pendingSlots: state.pendingSlots || [],
    pendingIntent: state.pendingIntent,
  }
  return chips
}

export function startConversation(facts) {
  const state = createConversationState()
  state.accountId = facts.accountId || null
  const response = greetingMessage(Boolean(facts.accountId))
  rememberTemplate(state, response.templateId)
  state.lastAnswer = { intent: INTENTS.GREETING, text: response.text, referenced: response.referenced }
  return {
    response,
    state,
    suggestions: suggestionChips(suggestionState(facts, state)),
  }
}

/** Sync character picker with conversation state */
export function selectCharacterId(state, charId, facts) {
  state.selectedCharacterId = charId || null
  const ch = (facts?.characters || []).find((c) => c.char_id === charId)
  state.lastSubject = ch?.name || null
  return state
}

export { INTENTS, matchCharacterMention }
