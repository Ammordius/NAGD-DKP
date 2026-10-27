/**
 * Eligibility gates mapping intents + facts → template categories.
 */

import { INTENTS } from './intents.js'
import { classifyBalance, deriveEvents } from './events.js'
import { TEMPLATES } from './templates.js'

/**
 * @param {string} eligibility
 * @param {object} ctx
 */
export function isEligible(eligibility, ctx) {
  const facts = ctx.facts || {}
  const events = ctx.events || deriveEvents(facts)
  const has = (type) => events.some((e) => e.type === type)

  switch (eligibility) {
    case undefined:
    case null:
    case '':
    case 'general':
    case 'greeting':
      return true
    case 'balance_low':
      return classifyBalance(facts.currentDkp, facts.guildBalances) === 'low' && facts.currentDkp != null
    case 'balance_high':
      return classifyBalance(facts.currentDkp, facts.guildBalances) === 'high' && facts.currentDkp != null
    case 'balance_mid':
      return classifyBalance(facts.currentDkp, facts.guildBalances) === 'mid' && facts.currentDkp != null
    case 'biggest_purchase':
      return Boolean(facts.biggestPurchase?.itemName && facts.biggestPurchase?.cost != null)
    case 'recent_purchase':
      return Boolean(facts.recentPurchase?.itemName)
    case 'purchase_volume':
      return (facts.totalRecordedPurchases || 0) >= 1
    case 'slot_repeat':
      return (facts.slotRepeatPatterns || []).length > 0
    case 'price_outlier':
      return (facts.priceOutliers || []).length > 0
    case 'purchase_unknown_value':
      return Boolean(facts.biggestPurchase || facts.recentPurchase)
    case 'multi_char':
      return (facts.characters || []).length >= 2
    case 'spend_concentration':
      return has('SPEND_CONCENTRATION')
    case 'two_chars':
      return (facts.characters || []).length >= 2
    case 'upgrade_strong':
      return (ctx.upgrades || []).some((u) => u.strength === 'strong')
    case 'upgrade_modest':
      return (ctx.upgrades || []).some((u) => u.strength === 'modest')
    case 'upgrade_any':
      return (ctx.upgrades || []).length > 0
    case 'afford_yes':
      return ctx.affordability === 'yes'
    case 'afford_no':
      return ctx.affordability === 'no'
    case 'afford_unknown':
      return ctx.affordability === 'unknown'
    case 'attendance_frequent':
      return Boolean(facts.attendanceEligibility?.canRoastFrequent)
    case 'attendance_sparse':
      return Boolean(facts.attendanceEligibility?.canRoastSparse)
    case 'attendance_return':
      return Boolean(facts.attendanceEligibility?.canRoastReturn)
    case 'item_source':
      return Boolean(ctx.itemSource?.zone || ctx.itemSource?.mob)
    case 'item_sale':
      return ctx.lastSale != null
    case 'item_unmatched':
      return Boolean(ctx.itemUnmatched)
    case 'defense':
      return true
    case 'followup_item':
      return Boolean(ctx.followupItem)
    case 'unknown':
      return true
    default:
      return false
  }
}

/**
 * Categories preferred for each intent (ordered).
 * @param {string} intent
 * @param {object} ctx
 */
export function categoriesForIntent(intent, ctx = {}) {
  switch (intent) {
    case INTENTS.GREETING:
      return ['greeting', 'general']
    case INTENTS.BALANCE:
      return ['balance_low', 'balance_high', 'balance_mid', 'general']
    case INTENTS.SPENDING_ROAST:
    case INTENTS.PURCHASE_HISTORY:
      return ['price_outlier', 'biggest_purchase', 'slot_repeat', 'recent_purchase', 'purchase_volume', 'purchase_unknown_value', 'general']
    case INTENTS.WORST_PURCHASE:
      return ['price_outlier', 'biggest_purchase', 'purchase_unknown_value', 'general']
    case INTENTS.CHARACTERS:
    case INTENTS.CHARACTER_ROAST:
      return ['spend_concentration', 'two_chars', 'multi_char', 'general']
    case INTENTS.UPGRADES:
      return ['upgrade_strong', 'upgrade_modest', 'upgrade_any', 'general']
    case INTENTS.AFFORDABILITY:
      return ['afford_yes', 'afford_no', 'afford_unknown', 'general']
    case INTENTS.ITEM_PRICE:
      return ['item_sale', 'afford_unknown', 'item_unmatched', 'general']
    case INTENTS.ITEM_SOURCE:
      return ['item_source', 'item_unmatched', 'general']
    case INTENTS.ITEM_SEARCH:
      return ['item_source', 'item_sale', 'item_unmatched', 'general']
    case INTENTS.ATTENDANCE:
      return ['attendance_return', 'attendance_sparse', 'attendance_frequent', 'general']
    case INTENTS.DEFENSE:
      return ['defense', 'general']
    case INTENTS.FOLLOWUP:
      if (ctx.followupItem) return ['followup_item', 'item_sale', 'item_source', 'defense', 'general']
      return ['defense', 'general', 'unknown']
    case INTENTS.GENERAL_ROAST:
      return ['biggest_purchase', 'multi_char', 'balance_low', 'balance_high', 'general']
    case INTENTS.ACCOUNT_COMPARISON:
      return ['balance_low', 'balance_high', 'balance_mid', 'general']
    case INTENTS.FULL_GEAR_COST:
      return ['general']
    case INTENTS.UNKNOWN:
    default:
      return ['unknown', 'general']
  }
}

/**
 * @param {string[]} categories
 * @param {object} ctx
 * @param {string[]} recentIds
 */
export function eligibleTemplates(categories, ctx, recentIds = []) {
  const recent = new Set(recentIds || [])
  const out = []
  for (const cat of categories) {
    for (const t of TEMPLATES) {
      if (t.category !== cat && t.eligibility !== cat) continue
      if (!isEligible(t.eligibility || t.category, ctx)) continue
      out.push(t)
    }
  }
  // Prefer non-recent
  const fresh = out.filter((t) => !recent.has(t.id))
  return fresh.length ? fresh : out
}

/**
 * Build placeholder values from context.
 * @param {object} ctx
 */
export function buildPlaceholderValues(ctx) {
  const facts = ctx.facts || {}
  const purchase = ctx.purchase || facts.biggestPurchase || facts.recentPurchase
  const upgrade = (ctx.upgrades || [])[0]
  const conc = (ctx.events || []).find((e) => e.type === 'SPEND_CONCENTRATION')?.payload
  const slotPat = (facts.slotRepeatPatterns || [])[0]
  const outlier = (facts.priceOutliers || [])[0]
  const chars = facts.characters || []
  const toon =
    ctx.selectedCharacter?.name ||
    upgrade?.characterName ||
    conc?.character?.name ||
    slotPat?.toon ||
    chars[0]?.name ||
    null
  const otherToon = chars.find((c) => c.name && c.name !== toon)?.name || chars[1]?.name || null

  return {
    account: facts.accountName,
    toon,
    otherToon,
    item:
      ctx.itemName ||
      upgrade?.itemName ||
      purchase?.itemName ||
      outlier?.itemName ||
      ctx.followupItem ||
      null,
    cost: purchase?.cost ?? outlier?.cost ?? null,
    balance: facts.currentDkp,
    slot: upgrade?.slot || slotPat?.slot || null,
    upgrade: upgrade?.upgrade || null,
    zone: ctx.itemSource?.zone || null,
    mob: ctx.itemSource?.mob || null,
    lastSale: ctx.lastSale ?? null,
    medianPrice: outlier?.medianPrice ?? null,
    purchaseCount: facts.totalRecordedPurchases,
    charCount: chars.length,
    sharePct: conc?.sharePct ?? null,
    raidCount: facts.accountRaidCount,
    daysSince:
      ctx.preferReturnGap && facts.returnGapDays != null
        ? facts.returnGapDays
        : facts.daysSince,
    lastRaid: facts.lastAccountRaid?.raidName || null,
  }
}
