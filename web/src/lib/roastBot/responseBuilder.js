/**
 * Fact-first response assembly: required claims first, sarcasm as flavor only.
 */

import { fillTemplate, TEMPLATES } from './templates.js'
import { isEligible } from './rules.js'
import { buildLinks } from './formatting.js'
import { INITIAL_GREETING, NO_ACCOUNT_HINT } from './templates.js'

/**
 * @param {Array<{ id: string, text?: string, template?: object }>} templates
 * @param {number} turnCount
 * @param {() => number} [rng]
 */
export function pickTemplate(templates, turnCount = 0, rng = Math.random) {
  if (!templates?.length) return null
  const idx = Math.floor(rng() * templates.length)
  return templates[(idx + turnCount) % templates.length]
}

/**
 * First matching eligible category only (no union with general).
 * @param {string[]} categories
 * @param {object} ctx
 * @param {string[]} recentIds
 * @param {Record<string, string|number|null>} placeholders
 */
export function pickFromCategoryTiers(categories, ctx, recentIds, placeholders) {
  const recent = new Set(recentIds || [])
  for (const cat of categories) {
    if (cat === 'general') continue
    const pool = []
    for (const t of TEMPLATES) {
      if (t.category !== cat && t.eligibility !== cat) continue
      if (!isEligible(t.eligibility || t.category, ctx)) continue
      const filled = fillTemplate(t.text, placeholders)
      if (filled == null) continue
      pool.push({ template: t, text: filled })
    }
    if (!pool.length) continue
    const fresh = pool.filter((p) => !recent.has(p.template.id))
    return fresh.length ? fresh : pool
  }
  return []
}

/**
 * Optional short flavor from general templates that need no placeholders.
 */
export function pickFlavorSentence(recentIds, turnCount, rng) {
  const recent = new Set(recentIds || [])
  const pool = TEMPLATES.filter(
    (t) => t.category === 'general' && (!t.requiredFacts || t.requiredFacts.length === 0),
  )
    .filter((t) => !recent.has(t.id))
  if (!pool.length) return null
  const picked = pickTemplate(
    pool.map((t) => ({ template: t, text: t.text })),
    turnCount,
    rng,
  )
  return picked
}

/**
 * Render AnswerFacts from a domain handler into a user-facing response.
 * @param {{ answer: object, state: object, facts: object, rng?: () => number }} args
 */
export function renderAnswer({ answer, state, facts, rng = Math.random }) {
  if (!answer) {
    return {
      text: 'I am a collection of deterministic rules, not a miracle worker. Try a clearer question.',
      templateId: 'J14',
      reasonCode: 'empty_answer',
      links: [],
      cards: [],
      requiredClaims: [],
      referenced: { characters: [], items: [] },
    }
  }

  // Fixed / authored fact text paths (no template roulette over general)
  if (answer.templateId === 'DKP_EXPLAIN' || answer.templateId === 'CAPABILITIES' ||
      answer.templateId === 'FULL_GEAR_COST' || answer.templateId === 'GREETING' ||
      answer.templateId === 'NO_ACCOUNT' || answer.templateId === 'NEED_CHAR' ||
      answer.templateId === 'NEED_ITEM' || answer.templateId === 'UNKNOWN' ||
      answer.templateId === 'GEAR_ASSESSMENT' || answer.templateId === 'GEAR_MISSING' ||
      answer.reasonCode === 'why_broke' || answer.reasonCode === 'gear_assessment' ||
      answer.reasonCode === 'dkp_explain' || answer.reasonCode === 'capabilities' ||
      answer.reasonCode === 'no_gearing_total' || answer.reasonCode === 'need_character' ||
      answer.reasonCode === 'need_item' || answer.reasonCode === 'unknown' ||
      answer.reasonCode === 'unknown_no_analysis' || answer.reasonCode === 'magelo_unavailable' ||
      answer.reasonCode === 'upgrades_unavailable' || answer.reasonCode === 'character_not_in_magelo' ||
      answer.reasonCode === 'missing_magelo_export' || answer.reasonCode === 'missing_gear_score') {
    let text = answer.factText
    if (answer.allowFlavor && answer.reasonCode !== 'need_character' && answer.reasonCode !== 'need_item') {
      const flavor = pickFlavorSentence(state.recentTemplateIds, state.turnCount, rng)
      if (flavor?.text && !text.includes(flavor.text)) {
        text = `${text} ${flavor.text}`
        // track flavor id separately in recent via caller
        answer._flavorId = flavor.template?.id
      }
    }
    return {
      text,
      templateId: answer.templateId || answer.reasonCode,
      reasonCode: answer.reasonCode,
      links: buildLinksFromReferenced(answer.referenced),
      cards: answer.cards || [],
      requiredClaims: answer.requiredClaims || [],
      referenced: answer.referenced || { characters: [], items: [] },
      placeholders: answer.placeholders || {},
    }
  }

  const ctx = {
    facts,
    upgrades: answer.upgrades || [],
    itemName: answer.placeholders?.item || null,
    itemSource: answer.placeholders?.zone || answer.placeholders?.mob
      ? { zone: answer.placeholders.zone, mob: answer.placeholders.mob }
      : null,
    lastSale: answer.placeholders?.lastSale ?? null,
    affordability:
      answer.reasonCode === 'afford_yes' ? 'yes' : answer.reasonCode === 'afford_no' ? 'no' : answer.reasonCode === 'afford_unknown' ? 'unknown' : null,
    itemUnmatched: answer.category === 'item_unmatched',
    selectedCharacter: answer.placeholders?.toon ? { name: answer.placeholders.toon } : null,
    purchase: answer.purchase || null,
    preferReturnGap: answer.category === 'attendance_return',
  }

  const categories = [answer.category].filter(Boolean)
  const pool = pickFromCategoryTiers(categories, ctx, state.recentTemplateIds, answer.placeholders || {})

  let text = answer.factText
  let templateId = answer.templateId || answer.reasonCode
  if (pool.length) {
    const picked = pickTemplate(pool, state.turnCount || 0, rng)
    // Prefer template wording when it encodes the same required placeholders; keep factText claims intact by appending if needed
    if (picked?.text) {
      text = ensureClaimsInText(picked.text, answer.factText, answer.requiredClaims, answer.placeholders)
      templateId = picked.template.id
    }
  }

  if (answer.allowFlavor !== false) {
    const flavor = pickFlavorSentence(
      [...(state.recentTemplateIds || []), templateId],
      state.turnCount,
      rng,
    )
    if (flavor?.text && !text.includes(flavor.text.slice(0, 40))) {
      text = `${text} ${flavor.text}`
      answer._flavorId = flavor.template?.id
    }
  }

  return {
    text,
    templateId,
    reasonCode: answer.reasonCode,
    links: buildLinksFromReferenced(answer.referenced),
    cards: answer.cards || [],
    requiredClaims: answer.requiredClaims || [],
    referenced: answer.referenced || { characters: [], items: [] },
    placeholders: answer.placeholders || {},
  }
}

/**
 * Ensure factual claims appear: if template omitted a numeric fact present in factText, prefer factText.
 */
function ensureClaimsInText(templateText, factText, requiredClaims, placeholders) {
  const claims = requiredClaims || []
  if (claims.includes('balance') && placeholders?.balance != null) {
    const bal = String(placeholders.balance)
    if (!templateText.includes(bal) && factText.includes(bal)) {
      return `${factText} ${templateText}`
    }
  }
  if (claims.includes('last_sale') && placeholders?.lastSale != null) {
    const sale = String(placeholders.lastSale)
    if (!templateText.includes(sale) && factText.includes(sale)) {
      return `${factText} ${templateText}`
    }
  }
  if (claims.includes('largest_purchase') && placeholders?.cost != null) {
    const cost = String(placeholders.cost)
    if (!templateText.includes(cost)) {
      return `${factText} ${templateText}`
    }
  }
  return templateText
}

function buildLinksFromReferenced(referenced) {
  const links = []
  for (const name of referenced?.items || []) {
    links.push(...buildLinks({ itemName: name }))
  }
  for (const name of referenced?.characters || []) {
    links.push(...buildLinks({ characterName: name }))
  }
  return links
}

/** @deprecated use renderAnswer — kept for tests that call buildResponse */
export function buildResponse(args) {
  // Thin adapter for legacy tests: wrap as unknown answer
  const { intent, facts, state, rng } = args
  const answer = {
    intent,
    category: 'unknown',
    factText: args.itemName && args.lastSale != null
      ? `${args.itemName} last sold for ${args.lastSale} DKP (historical record, not a future guarantee).`
      : "Try asking about loot, upgrades, DKP, or your purchase history.",
    requiredClaims: args.lastSale != null ? ['last_sale'] : ['unknown_no_analysis'],
    placeholders: {
      item: args.itemName,
      lastSale: args.lastSale,
      balance: facts?.currentDkp,
      toon: args.selectedCharacter?.name,
    },
    referenced: {
      characters: args.selectedCharacter?.name ? [args.selectedCharacter.name] : [],
      items: args.itemName && !args.itemUnmatched ? [args.itemName] : [],
    },
    reasonCode: args.lastSale != null ? 'item_sale' : 'unknown',
    allowFlavor: false,
    templateId: args.lastSale != null ? null : 'UNKNOWN',
    upgrades: args.upgrades,
  }
  if (args.lastSale != null) {
    answer.category = 'item_sale'
    answer.allowFlavor = true
  }
  return renderAnswer({ answer, state, facts, rng })
}

export function greetingMessage(hasAccount) {
  if (!hasAccount) {
    return {
      text: `${INITIAL_GREETING} ${NO_ACCOUNT_HINT}`,
      templateId: 'GREETING',
      reasonCode: 'greeting_no_account',
      links: [],
      cards: [],
      requiredClaims: ['greeting'],
      referenced: { characters: [], items: [] },
    }
  }
  return {
    text: INITIAL_GREETING,
    templateId: 'GREETING',
    reasonCode: 'greeting',
    links: [],
    cards: [],
    requiredClaims: ['greeting'],
    referenced: { characters: [], items: [] },
  }
}
