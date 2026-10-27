/**
 * Template selection and response assembly.
 */

import { fillTemplate } from './templates.js'
import {
  categoriesForIntent,
  eligibleTemplates,
  buildPlaceholderValues,
} from './rules.js'
import { deriveEvents } from './events.js'
import { buildLinks } from './formatting.js'
import { INTENTS } from './intents.js'
import { FULL_GEAR_COST_REFUSAL, NO_ACCOUNT_HINT, INITIAL_GREETING } from './templates.js'

/**
 * Deterministic-ish pick among candidates using turn count for variation.
 * @param {Array<{ id: string }>} templates
 * @param {number} turnCount
 * @param {() => number} [rng]
 */
export function pickTemplate(templates, turnCount = 0, rng = Math.random) {
  if (!templates?.length) return null
  const idx = Math.floor(rng() * templates.length)
  // Mix in turnCount so consecutive turns with same pool still vary when rng is stubbed poorly
  return templates[(idx + turnCount) % templates.length]
}

/**
 * @param {{
 *   intent: string,
 *   facts: object,
 *   state: object,
 *   upgrades?: object[],
 *   itemName?: string|null,
 *   itemSource?: object|null,
 *   lastSale?: number|null,
 *   affordability?: 'yes'|'no'|'unknown'|null,
 *   itemUnmatched?: boolean,
 *   followupItem?: string|null,
 *   selectedCharacter?: object|null,
 *   purchase?: object|null,
 *   preferReturnGap?: boolean,
 *   rng?: () => number,
 * }} args
 */
export function buildResponse(args) {
  const {
    intent,
    facts,
    state,
    upgrades = [],
    itemName = null,
    itemSource = null,
    lastSale = null,
    affordability = null,
    itemUnmatched = false,
    followupItem = null,
    selectedCharacter = null,
    purchase = null,
    preferReturnGap = false,
    rng = Math.random,
  } = args

  if (intent === INTENTS.FULL_GEAR_COST) {
    return {
      text: FULL_GEAR_COST_REFUSAL,
      templateId: 'FULL_GEAR_COST',
      reasonCode: 'no_gearing_total',
      links: [],
      cards: [],
      placeholders: {},
    }
  }

  if (!facts?.accountId && intent !== INTENTS.GREETING && intent !== INTENTS.UNKNOWN && intent !== INTENTS.GENERAL_ROAST) {
    // Still roast, but note missing account for personalized data intents
    if ([INTENTS.BALANCE, INTENTS.SPENDING_ROAST, INTENTS.PURCHASE_HISTORY, INTENTS.WORST_PURCHASE, INTENTS.UPGRADES, INTENTS.ATTENDANCE, INTENTS.CHARACTERS, INTENTS.CHARACTER_ROAST].includes(intent)) {
      return {
        text: `${NO_ACCOUNT_HINT} Meanwhile: I've examined your decisions. I would like to speak to whoever authorized them.`,
        templateId: 'NO_ACCOUNT',
        reasonCode: 'no_claimed_account',
        links: [],
        cards: [],
        placeholders: {},
      }
    }
  }

  const events = deriveEvents(facts)
  const ctx = {
    facts,
    events,
    upgrades,
    itemName,
    itemSource,
    lastSale,
    affordability,
    itemUnmatched,
    followupItem,
    selectedCharacter,
    purchase,
    preferReturnGap,
  }

  const categories = categoriesForIntent(intent, ctx)
  let candidates = eligibleTemplates(categories, ctx, state.recentTemplateIds || [])
  if (!candidates.length) {
    candidates = eligibleTemplates(['general', 'unknown'], ctx, state.recentTemplateIds || [])
  }

  const values = buildPlaceholderValues(ctx)
  // Filter to templates whose placeholders can be filled
  const fillable = []
  for (const t of candidates) {
    const filled = fillTemplate(t.text, values)
    if (filled != null) fillable.push({ template: t, text: filled })
  }

  const pool = fillable.length
    ? fillable
    : eligibleTemplates(['general'], { facts, events }, state.recentTemplateIds || [])
        .map((t) => {
          const filled = fillTemplate(t.text, values)
          return filled != null ? { template: t, text: filled } : null
        })
        .filter(Boolean)

  if (!pool.length) {
    return {
      text: "You have managed to disappoint a collection of conditional statements. Congratulations.",
      templateId: 'A14',
      reasonCode: 'fallback_general',
      links: [],
      cards: [],
      placeholders: values,
    }
  }

  const picked = pickTemplate(pool, state.turnCount || 0, rng)
  const template = picked.template
  const text = picked.text

  const cards = []
  if (intent === INTENTS.UPGRADES && upgrades.length) {
    for (const u of upgrades.slice(0, 3)) {
      cards.push({
        type: 'upgrade',
        itemName: u.itemName,
        itemId: u.itemId,
        slot: u.slot,
        upgrade: u.upgrade,
        lastSale: u.lastSale ?? null,
        zone: u.zone ?? null,
        to: `/items/${encodeURIComponent(u.itemName)}`,
      })
    }
  }

  const links = buildLinks({
    itemName: values.item,
    characterName: values.toon,
  })

  // Worst-purchase metric clarity
  let finalText = text
  if (intent === INTENTS.WORST_PURCHASE && facts.biggestPurchase && template.category === 'biggest_purchase') {
    finalText = `${text} (Metric: largest verified DKP expense — not a scientific waste score.)`
  }

  return {
    text: finalText,
    templateId: template.id,
    reasonCode: template.eligibility || template.category,
    links,
    cards,
    placeholders: values,
  }
}

export function greetingMessage(hasAccount) {
  if (!hasAccount) {
    return {
      text: `${INITIAL_GREETING} ${NO_ACCOUNT_HINT}`,
      templateId: 'GREETING',
      reasonCode: 'greeting_no_account',
      links: [],
      cards: [],
    }
  }
  return {
    text: INITIAL_GREETING,
    templateId: 'GREETING',
    reasonCode: 'greeting',
    links: [],
    cards: [],
  }
}
