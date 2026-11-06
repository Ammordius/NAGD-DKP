/**
 * Dialogue state machine for the DKP Inquisitor.
 * Clarifications store pendingIntent and resume on the next turn.
 */

import {
  classifyIntent,
  INTENTS,
  matchCharacterMention,
  isCharacterDkpSpentQuestion,
  isQuarmEligibilityQuestion,
  isCharacterStatsQuestion,
  extractSubjectCharacterName,
  extractCharacterSwapFollowUp,
  isRepeatableCharacterSwapIntent,
  isCharacterPronoun,
  messageUsesCharacterPronoun,
  CHARACTER_SCOPED_INTENTS,
} from './intents.js'
import { renderAnswer, greetingMessage } from './responseBuilder.js'
import { matchItemName, suggestionChips, formatDkp } from './formatting.js'
import { dispatchHandler } from './handlers/index.js'
import { lookupItemSource, catalogEntriesFromKnownSources } from '../itemSourceLookup.js'
import { resolveItemIdFromStats, extractUpgradeSlotHint } from './upgrades.js'
import { resolveSlotAlias } from './discovery/aliases.js'
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
    lastUpgradeSlots: [],
    lastDiscovery: null,
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

/**
 * Sticky character subject, never a pronoun token.
 * @param {object} state
 * @returns {string|null}
 */
function stickySubjectName(state) {
  const name = state?.lastSubject ? String(state.lastSubject).trim() : ''
  if (!name || isCharacterPronoun(name)) return null
  return name
}

/**
 * @param {string|null|undefined} name
 * @returns {string|null}
 */
function safeSubjectName(name) {
  const n = name ? String(name).trim() : ''
  if (!n || isCharacterPronoun(n)) return null
  return n
}

function rememberTemplate(state, templateId) {
  if (!templateId) return
  const recent = [...(state.recentTemplateIds || []), templateId].filter(Boolean)
  state.recentTemplateIds = recent.slice(-5)
}

function mageloRecommendNames(upgradeContext) {
  if (!upgradeContext) return []
  const names = []
  const stats = upgradeContext.itemStats || {}
  const raidIds = upgradeContext.raidItemIds
  if (raidIds && typeof raidIds[Symbol.iterator] === 'function') {
    for (const id of raidIds) {
      const row = stats[id] || stats[String(id)]
      const name = row?.name
      if (name) names.push({ name, itemId: id })
    }
  }
  return names
}

function resolveItem(facts, hint, state, useSticky, upgradeContext = null) {
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
  const fromSources = catalogEntriesFromKnownSources(facts.knownItemSources)
  const fromMagelo = mageloRecommendNames(upgradeContext)
  if (state.lastItemName) {
    fromMagelo.push({ name: state.lastItemName, itemId: state.lastItemId })
  }
  const merged = [...catalog, ...fromPurchases, ...fromSources, ...fromMagelo].filter((i) => i.name)
  const match = matchItemName(hint, merged)
  if (!match) return { unmatched: true, hint }
  if (match.ambiguous) return { ambiguous: true, candidates: match.candidates, hint }
  return { name: match.name, itemId: match.itemId ?? match.id ?? null }
}

const PRONOUN_TOKEN = /^(this|that|it|them|the)$/i

/**
 * Extract an explicit item hint from item-fit phrasing ("could use X" / "needs X").
 * Slot-only remnants like "this ring" return null so sticky/discovery primary can win.
 * @param {string} text
 * @returns {string|null}
 */
function extractItemFitHint(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const m =
    raw.match(/\b(?:could use|needs|use)\s+(.+?)(?:\?|$)/i) ||
    raw.match(/\bis (?:this|that|it) an? upgrade(?: for)?\s+(.+?)(?:\?|$)/i)
  if (!m) return null
  let hint = m[1].replace(/[?.!]+$/g, '').trim()
  hint = hint.replace(/^(this|that|it|the)\s+/i, '').trim()
  if (!hint || PRONOUN_TOKEN.test(hint)) return null
  // Slot-only ("ring", "finger") is not an item name — use sticky / lastDiscovery.
  if (resolveSlotAlias(hint)) return null
  return hint
}

/**
 * Resolve the candidate item for ITEM_FIT (named, sticky, or discovery primary).
 * @returns {{ name: string, itemId: string|number|null }|null}
 */
function resolveItemFitCandidate(facts, text, state, classified, upgradeContext) {
  const explicitHint = classified.matchedItemHint || extractItemFitHint(text)
  if (explicitHint) {
    const resolved = resolveItem(facts, explicitHint, state, false, upgradeContext)
    if (resolved?.name && !resolved.unmatched && !resolved.ambiguous) {
      return { name: resolved.name, itemId: resolved.itemId ?? null }
    }
    if (resolved?.ambiguous) return { ambiguous: true, candidates: resolved.candidates, hint: explicitHint }
    if (resolved?.unmatched) return { unmatched: true, hint: explicitHint }
  }

  if (state.lastItemName || state.lastItemId) {
    return { name: state.lastItemName || null, itemId: state.lastItemId ?? null }
  }

  const t = normalizeLoose(text)
  const hasPronoun = /\b(this|that|it)\b/.test(t)
  const slotFromText = resolveSlotAlias(t) || null
  const primaryName = state.lastDiscovery?.primary?.itemName || null
  if (primaryName && (hasPronoun || slotFromText)) {
    const prevSlot = state.lastDiscovery?.query?.slot || null
    if (!slotFromText || !prevSlot || String(slotFromText) === String(prevSlot)) {
      return { name: primaryName, itemId: state.lastDiscovery?.primary?.itemId ?? null }
    }
  }

  return null
}

function resolveStickyItemId(name, itemId, facts, upgradeContext) {
  if (itemId != null && itemId !== '') return String(itemId)
  if (!name) return null
  const fromStats = resolveItemIdFromStats(upgradeContext?.itemStats || null, null, name)
  if (fromStats != null) return String(fromStats)
  const catalog = [
    ...(facts.itemCatalog || []),
    ...catalogEntriesFromKnownSources(facts.knownItemSources),
  ]
  const match = matchItemName(name, catalog)
  if (match && !match.ambiguous) {
    const id = match.itemId ?? match.id
    if (id != null) return String(id)
  }
  return null
}

function lookupPrice(facts, itemName) {
  if (!itemName) return null
  const entry = facts.recentItemPrices?.[String(itemName).toLowerCase()]
  if (!entry?.values?.length) return null
  const n = Number(entry.values[0])
  return Number.isFinite(n) ? n : null
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
 *   discoveryResult?: object|null,
 *   discoveryAnswer?: object|null,
 *   discoveryRecognition?: object|null,
 *   whoIsResult?: object|null,
 *   whoIsName?: string|null,
 *   characterSpendResult?: object|null,
 *   rng?: () => number,
 * }} args
 */
export function handleMessage({
  text,
  facts,
  state,
  upgradeContext = null,
  discoveryResult = null,
  discoveryAnswer = null,
  discoveryRecognition = null,
  whoIsResult = null,
  whoIsName = null,
  characterSpendResult = null,
  rng = Math.random,
}) {
  state.turnCount = (state.turnCount || 0) + 1
  const priorLastIntent = state.lastIntent

  const classified = classifyIntent(text, {
    lastIntent: state.lastIntent,
    lastItemId: state.lastItemId,
    lastItemName: state.lastItemName,
    lastUpgradeCandidateId: state.lastUpgradeCandidateId,
    lastSubject: stickySubjectName(state),
    characters: facts.characters || [],
    pendingIntent: state.pendingIntent,
  })

  // Discovery only when recognition succeeded or an answer was prefetched — never via bare gate/lastIntent.
  // Who-is identity questions win over discovery (e.g. never treat "who is Foo" as loot).
  // Item-fit (which toons could use this) also wins so prior Quarm/slot context cannot re-hijack.
  // Upgrade slot follow-ups ("what about shoulder") after UPGRADES also beat discovery.
  // Character-swap follow-ups ("what about Badammo?") reuse prior character intent over loot.
  const whoIsHit = Boolean(whoIsResult) || classified.intent === INTENTS.WHO_IS
  const itemFitHit = !whoIsHit && classified.intent === INTENTS.ITEM_FIT
  const upgradeSlotHint = extractUpgradeSlotHint(text)
  const characterSwapName = extractCharacterSwapFollowUp(text)
  const characterSwapHit =
    !whoIsHit &&
    !itemFitHit &&
    Boolean(characterSwapName) &&
    !upgradeSlotHint &&
    isCharacterSwapFollowUp(text, state)
  const upgradesContext =
    state.lastIntent === INTENTS.UPGRADES ||
    state.lastIntent === INTENTS.GEAR_ASSESSMENT ||
    state.pendingIntent === INTENTS.UPGRADES ||
    state.pendingIntent === INTENTS.GEAR_ASSESSMENT ||
    classified.intent === INTENTS.UPGRADES
  const upgradesSlotHit =
    !whoIsHit &&
    !itemFitHit &&
    Boolean(upgradeSlotHint) &&
    (state.lastIntent === INTENTS.UPGRADES ||
      state.lastIntent === INTENTS.GEAR_ASSESSMENT ||
      state.pendingIntent === INTENTS.UPGRADES ||
      state.pendingIntent === INTENTS.GEAR_ASSESSMENT ||
      (classified.intent === INTENTS.FOLLOWUP &&
        (state.lastIntent === INTENTS.UPGRADES || state.lastIntent === INTENTS.GEAR_ASSESSMENT)) ||
      (classified.intent === INTENTS.UPGRADES && Boolean(upgradeSlotHint)))
  const recognitionOk =
    !whoIsHit &&
    !itemFitHit &&
    !upgradesSlotHit &&
    !characterSwapHit &&
    (discoveryRecognition?.status === 'recognized' ||
      discoveryRecognition?.status === 'ambiguous' ||
      discoveryRecognition?.status === 'unsupported')
  const discoveryHit =
    !whoIsHit &&
    !itemFitHit &&
    !upgradesSlotHit &&
    !characterSwapHit &&
    Boolean(discoveryResult || discoveryAnswer || recognitionOk)
  let intent = whoIsHit
    ? INTENTS.WHO_IS
    : itemFitHit
      ? INTENTS.ITEM_FIT
      : upgradesSlotHit
        ? INTENTS.UPGRADES
        : characterSwapHit
          ? state.lastIntent
          : discoveryHit
            ? INTENTS.LOOT_DISCOVERY
            : classified.intent
  let ambiguousClass = null
  let resolvedWhoIsName =
    whoIsName ||
    classified.whoIsName ||
    (intent === INTENTS.WHO_IS || (characterSwapHit && priorLastIntent === INTENTS.WHO_IS)
      ? characterSwapName
      : null)
  // Slot filter for upgrades: follow-up after buy path, or inline slot on an upgrades ask.
  let upgradeSlotIds = null
  let upgradeSlotLabel = null
  if (
    upgradeSlotHint &&
    (intent === INTENTS.UPGRADES ||
      upgradesSlotHit ||
      (upgradesContext && intent === INTENTS.FOLLOWUP))
  ) {
    upgradeSlotIds = upgradeSlotHint.slotIds
    upgradeSlotLabel = upgradeSlotHint.chipLabel
    intent = INTENTS.UPGRADES
  }

  // Resume pending clarification — only when the user is answering the ask,
  // not when they pivot to a confident new domain question.
  let resumedPending = false
  if (state.pendingIntent && state.pendingSlots?.includes('character')) {
    const matched = classified.matchedCharacter
    if (matched?.ambiguous) {
      ambiguousClass = matched
      intent = state.pendingIntent
      resumedPending = true
    } else if (matched?.char_id || matched?.name) {
      const answeringClarification =
        classified.clarificationReply ||
        classified.bareCharacterName ||
        intent === INTENTS.FOLLOWUP ||
        intent === state.pendingIntent
      if (answeringClarification) {
        state.selectedCharacterId = matched.char_id || state.selectedCharacterId
        intent = state.pendingIntent
        clearPending(state)
        resumedPending = true
      }
      // else: keep the new intent; pending abandoned below
    } else if (classified.clarificationReply || classified.bareCharacterName) {
      // name didn't resolve — stay pending
      intent = state.pendingIntent
      resumedPending = true
    }
  } else if (state.pendingIntent && state.pendingSlots?.includes('item')) {
    let itemHint = classified.matchedItemHint
    // Bare item name answering need_item (classifier only extracts hints from phrased asks)
    if (!itemHint) {
      const bare = resolveItem(facts, String(text || '').trim(), state, false, upgradeContext)
      if (bare?.name && !bare.ambiguous && !bare.unmatched) {
        itemHint = bare.name
        classified.matchedItemHint = bare.name
      }
    }
    if (itemHint) {
      const resolved = resolveItem(facts, itemHint, state, false, upgradeContext)
      const resolvedOk = Boolean(resolved?.name && !resolved.ambiguous && !resolved.unmatched)
      if (resolvedOk) {
        classified.matchedItemHint = resolved.name
        intent = state.pendingIntent
        clearPending(state)
        resumedPending = true
      } else if (
        intent === INTENTS.FOLLOWUP ||
        intent === state.pendingIntent ||
        intent === INTENTS.UNKNOWN
      ) {
        // Clarification-style reply with unmatched name — keep pending intent for need_item UX
        intent = state.pendingIntent
        clearPending(state)
        resumedPending = true
      }
      // else: confident new ask whose "item hint" was a false positive (e.g. character after "for")
    }
  }

  // Leave clarification mode when the user asks a confident new question.
  if (
    state.pendingIntent &&
    !resumedPending &&
    intent !== state.pendingIntent &&
    intent !== INTENTS.FOLLOWUP &&
    intent !== INTENTS.UNKNOWN
  ) {
    clearPending(state)
  }

  // Follow-up remapping when not resuming pending
  if (intent === INTENTS.FOLLOWUP && !state.pendingIntent) {
    const t = String(text || '').toLowerCase()
    if (isCharacterDkpSpentQuestion(t)) {
      intent = INTENTS.CHARACTER_DKP_SPENT
    } else if (isQuarmEligibilityQuestion(t)) {
      intent = INTENTS.QUARM_ELIGIBILITY
    } else if (isCharacterStatsQuestion(t)) {
      intent = INTENTS.CHARACTER_STATS
    } else if (/how much|price|cost|sold/.test(t) && (state.lastItemName || state.lastUpgradeCandidateId)) {
      intent = INTENTS.ITEM_PRICE
    } else if (/where|drop|source|zone|mob/.test(t) && state.lastItemName) {
      intent = INTENTS.ITEM_SOURCE
    } else if (/worth|bad|good|serious/.test(t) && state.lastReferencedPurchaseId) {
      intent = INTENTS.WORST_PURCHASE
    } else if (classified.matchedCharacter && !classified.bareCharacterName) {
      intent = state.lastIntent && isRepeatableCharacterSwapIntent(state.lastIntent)
        ? state.lastIntent
        : INTENTS.UPGRADES
    } else if (characterSwapName && isRepeatableCharacterSwapIntent(state.lastIntent)) {
      // Guild-wide / unlinked name after a repeatable character intent
      intent = state.lastIntent
    } else if (classified.bareCharacterPronoun && stickySubjectName(state)) {
      // "he" / "she" → rematch prior character-scoped / who-is intent with sticky subject
      intent =
        state.lastIntent && state.lastIntent !== INTENTS.LOOT_DISCOVERY
          ? state.lastIntent
          : INTENTS.UNKNOWN
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
        table: null,
        requiredClaims: ['character_selected'],
        referenced: { characters: [classified.matchedCharacter.name], items: [] },
      }
      state.lastIntent = INTENTS.FOLLOWUP
      state.lastAnswer = { intent: INTENTS.FOLLOWUP, text: response.text, referenced: response.referenced }
      rememberTemplate(state, response.templateId)
      return { response, state, intent: INTENTS.FOLLOWUP, suggestions: suggestionChips(suggestionState(facts, state)) }
    } else if (state.lastIntent && state.lastIntent !== INTENTS.LOOT_DISCOVERY) {
      intent = state.lastIntent
    } else {
      // Do not remap FOLLOWUP → LOOT_DISCOVERY without an executable discovery run.
      intent = INTENTS.UNKNOWN
    }
  }

  // WHY_BROKE vs BALANCE: broke chip / why patterns already classified
  if (intent === INTENTS.BALANCE && /why|broke/.test(normalizeLoose(text))) {
    // keep WHY_BROKE if why-broke patterns matched first; otherwise fine
  }

  // After FOLLOWUP remapping: pronoun who-is / bare "he" can reuse sticky subject.
  if (
    intent === INTENTS.WHO_IS &&
    !safeSubjectName(resolvedWhoIsName) &&
    stickySubjectName(state) &&
    (messageUsesCharacterPronoun(text) || classified.bareCharacterPronoun)
  ) {
    resolvedWhoIsName = stickySubjectName(state)
  }
  resolvedWhoIsName = safeSubjectName(resolvedWhoIsName)

  // Who-is resolves guild-wide names; do not treat the ask as linked-roster selection.
  const guildWideSubjectIntents = new Set([
    INTENTS.CHARACTER_DKP_SPENT,
    INTENTS.QUARM_ELIGIBILITY,
    INTENTS.CHARACTER_STATS,
  ])
  // Character-swap may name a roster toon that classifyIntent already matched.
  let swapMatched = classified.matchedCharacter
  if (characterSwapHit && characterSwapName && (!swapMatched || swapMatched.ambiguous)) {
    const fromRoster = (facts.characters || []).find(
      (c) => String(c.name || '').toLowerCase() === String(characterSwapName).toLowerCase(),
    )
    if (fromRoster) swapMatched = fromRoster
  }
  let charSel =
    intent === INTENTS.WHO_IS ? null : selectCharacter(facts, swapMatched, state)
  if (charSel?.ambiguous) {
    ambiguousClass = charSel
    charSel = null
  }
  // Character-scoped asks with "him/her" reuse sticky subject when no explicit match.
  if (
    !charSel &&
    CHARACTER_SCOPED_INTENTS.has(intent) &&
    !guildWideSubjectIntents.has(intent) &&
    stickySubjectName(state) &&
    (messageUsesCharacterPronoun(text) || classified.bareCharacterPronoun)
  ) {
    const sticky = stickySubjectName(state)
    const fromRoster = (facts.characters || []).find(
      (c) => String(c.name || '').toLowerCase() === String(sticky).toLowerCase(),
    )
    if (fromRoster) charSel = fromRoster
  }
  // Spend / viability / stats can name any guild toon, not only linked roster.
  if (!charSel && guildWideSubjectIntents.has(intent)) {
    let subjectName =
      characterSpendResult?.characterName ||
      characterSwapName ||
      extractSubjectCharacterName(text, { characters: facts.characters || [], intent })
    subjectName = safeSubjectName(subjectName)
    if (!subjectName) {
      const sticky = stickySubjectName(state)
      if (
        sticky &&
        (messageUsesCharacterPronoun(text) ||
          classified.bareCharacterPronoun ||
          !matchCharacterMention(text, facts.characters || []))
      ) {
        subjectName = sticky
      }
    }
    if (subjectName) {
      const fromRoster = (facts.characters || []).find(
        (c) => String(c.name || '').toLowerCase() === String(subjectName).toLowerCase(),
      )
      charSel = fromRoster || {
        name: subjectName,
        char_id: characterSpendResult?.charId || null,
        class_name: null,
      }
    }
  }
  if (charSel?.char_id) {
    state.selectedCharacterId = charSel.char_id
    const subject = safeSubjectName(charSel.name)
    if (subject) state.lastSubject = subject
  } else if (charSel?.name && guildWideSubjectIntents.has(intent)) {
    const subject = safeSubjectName(charSel.name)
    if (subject) state.lastSubject = subject
  }

  const stickyItem = [
    INTENTS.ITEM_PRICE,
    INTENTS.ITEM_SOURCE,
    INTENTS.AFFORDABILITY,
    INTENTS.FOLLOWUP,
    INTENTS.ITEM_FIT,
  ].includes(intent)

  let itemResolved = null
  if (intent === INTENTS.ITEM_FIT) {
    itemResolved = resolveItemFitCandidate(facts, text, state, classified, upgradeContext)
  } else if (intent !== INTENTS.WHO_IS) {
    itemResolved = resolveItem(facts, classified.matchedItemHint, state, stickyItem, upgradeContext)
  }

  // Slot-scoped upgrades are not item lookups — do not treat "shoulder" as an ambiguous item name.
  if (
    itemResolved?.ambiguous &&
    !discoveryHit &&
    intent !== INTENTS.WHO_IS &&
    !(intent === INTENTS.UPGRADES && upgradeSlotIds?.length)
  ) {
    const response = {
      text: `Which item? Candidates: ${itemResolved.candidates.map((c) => c.name).slice(0, 5).join(', ')}.`,
      templateId: 'AMBIGUOUS_ITEM',
      reasonCode: 'ambiguous_item',
      links: [],
      cards: [],
      table: null,
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
  let itemId =
    itemResolved?.itemId != null && itemResolved.itemId !== ''
      ? itemResolved.itemId
      : stickyItem
        ? state.lastItemId
        : null
  if (intent === INTENTS.ITEM_FIT && itemName && (itemId == null || itemId === '')) {
    itemId = resolveStickyItemId(itemName, null, facts, upgradeContext)
  }

  const lastSale = itemName && !itemUnmatched ? lookupPrice(facts, itemName) : null
  const itemSource = itemName && !itemUnmatched ? lookupItemSource(facts.knownItemSources, itemName) : null

  const answer = dispatchHandler({
    intent,
    facts,
    selectedCharacter: charSel,
    ambiguousClass,
    itemName,
    itemId,
    itemUnmatched,
    lastSale: lastSale != null ? Number(formatDkp(lastSale)) || lastSale : null,
    itemSource,
    upgradeContext,
    discoveryResult,
    discoveryAnswer,
    discoveryRecognition,
    whoIsResult,
    whoIsName: resolvedWhoIsName,
    characterSpendResult,
    slotIds: intent === INTENTS.UPGRADES ? upgradeSlotIds : null,
    slotLabel: intent === INTENTS.UPGRADES ? upgradeSlotLabel : null,
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
  if (
    (intent === INTENTS.UPGRADES || intent === INTENTS.GEAR_ASSESSMENT) &&
    Array.isArray(answer.upgradeSlots)
  ) {
    state.lastUpgradeSlots = answer.upgradeSlots
  }
  if (answer.referenced?.items?.length) {
    state.lastItemName = answer.referenced.items[0]
    state.lastItem = { name: answer.referenced.items[0] }
    const id =
      answer.cards?.[0]?.itemId ??
      answer.upgrades?.[0]?.itemId ??
      answer.itemFit?.itemId ??
      null
    if (id != null) {
      state.lastItemId = String(id)
      state.lastUpgradeCandidateId = String(id)
    } else {
      const resolvedId = resolveStickyItemId(answer.referenced.items[0], null, facts, upgradeContext)
      if (resolvedId != null) state.lastItemId = resolvedId
    }
  } else if (
    itemName &&
    !itemUnmatched &&
    [INTENTS.ITEM_PRICE, INTENTS.ITEM_SOURCE, INTENTS.AFFORDABILITY, INTENTS.ITEM_SEARCH, INTENTS.ITEM_FIT].includes(
      intent,
    )
  ) {
    state.lastItemName = itemName
    state.lastItem = { name: itemName }
    const resolvedId = resolveStickyItemId(itemName, itemResolved?.itemId ?? itemId, facts, upgradeContext)
    if (resolvedId != null) state.lastItemId = resolvedId
  }

  // Unrelated unknown follow-up: do not keep stale links (renderAnswer already uses answer.referenced only)
  if (intent === INTENTS.UNKNOWN) {
    // leave lastItem sticky for intentional "how much" later, but response has no stale links
  }

  // Defense: unsupported loot must not overwrite a character-scoped prior when the user
  // tried "what about <name>?" (primary path skips discovery; keep navigation intact).
  const preserveCharacterLastIntent =
    intent === INTENTS.LOOT_DISCOVERY &&
    discoveryRecognition?.status === 'unsupported' &&
    Boolean(characterSwapName) &&
    isRepeatableCharacterSwapIntent(priorLastIntent)

  state.lastIntent = preserveCharacterLastIntent ? priorLastIntent : intent
  state.lastAnswer = {
    intent,
    facts: answer.requiredClaims,
    text: response.text,
    referenced: response.referenced,
  }
  // Persist WHO_IS subject for pronoun coreference (guild-wide; roster sync only when linked).
  if (
    intent === INTENTS.WHO_IS &&
    whoIsResult &&
    (whoIsResult.status === 'ok' || whoIsResult.status === 'unlinked')
  ) {
    const whoSubject = safeSubjectName(whoIsResult.characterName || resolvedWhoIsName)
    if (whoSubject) {
      state.lastSubject = whoSubject
      const charId = whoIsResult.charId != null ? String(whoIsResult.charId) : null
      if (
        charId &&
        (facts.characters || []).some((c) => String(c.char_id) === charId)
      ) {
        state.selectedCharacterId = charId
      }
    }
  } else {
    const fromChar = safeSubjectName(charSel?.name)
    if (fromChar) state.lastSubject = fromChar
  }
  // Only persist successful, executable discovery context — never from unsupported/failed turns,
  // and never retain a prior primary when the current result has neither awards nor a raid.
  if (
    intent === INTENTS.LOOT_DISCOVERY &&
    discoveryResult?.ok !== false &&
    discoveryRecognition?.status !== 'unsupported' &&
    discoveryResult?.query
  ) {
    const awards = discoveryResult?.awards || []
    const primaryAward = awards[0] || null
    const q = discoveryResult.query
    const primaryItemName = primaryAward?.itemName || null
    const primaryItemId = primaryItemName
      ? resolveStickyItemId(
          primaryItemName,
          primaryAward?.itemId ?? primaryAward?.item_id ?? null,
          facts,
          upgradeContext,
        )
      : null
    state.lastDiscovery = {
      query: q,
      primary: primaryAward
        ? {
            itemName: primaryItemName,
            itemId: primaryItemId,
            characterName: primaryAward.characterName || primaryAward.assignedCharacterName || null,
            raidId: primaryAward.raidId || null,
            dateIso: primaryAward.dateIso || null,
          }
        : discoveryResult?.raid
          ? {
              itemName: null,
              itemId: null,
              characterName: null,
              raidId: discoveryResult.raid.raidId,
              dateIso: discoveryResult.raid.dateIso || null,
            }
          : null,
      recognition: discoveryRecognition || null,
    }
  }

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
  return {
    hasAccount: Boolean(facts.accountId),
    selectedCharacterId: state.selectedCharacterId,
    lastItemName: state.lastItemName,
    characters: facts.characters || [],
    pendingSlots: state.pendingSlots || [],
    pendingIntent: state.pendingIntent,
    lastIntent: state.lastIntent,
    lastUpgradeSlots: state.lastUpgradeSlots || [],
  }
}

/** Intents that may continue into slot-scoped Magelo upgrades ("what about his feet?"). */
const SLOT_FOLLOWUP_INTENTS = new Set([INTENTS.UPGRADES, INTENTS.GEAR_ASSESSMENT])

/**
 * True when the utterance is a slot-scoped upgrade follow-up after upgrades or gear assessment.
 * Used by the UI to load Magelo context and skip loot discovery recognition.
 */
export function isUpgradeSlotFollowUp(text, state = {}) {
  if (!text) return false
  const prior = state.lastIntent || state.pendingIntent
  if (!SLOT_FOLLOWUP_INTENTS.has(prior) && !SLOT_FOLLOWUP_INTENTS.has(state.pendingIntent)) {
    return false
  }
  return Boolean(extractUpgradeSlotHint(text))
}

/**
 * True when “what/how about &lt;name&gt;?” should reuse the prior character-scoped intent
 * instead of loot discovery. Slot follow-ups (“what about shoulder”) are excluded.
 */
export function isCharacterSwapFollowUp(text, state = {}) {
  if (!text) return false
  if (!isRepeatableCharacterSwapIntent(state.lastIntent)) return false
  if (extractUpgradeSlotHint(text)) return false
  return Boolean(extractCharacterSwapFollowUp(text))
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
