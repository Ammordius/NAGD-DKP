/**
 * Read-only account fact builder for the DKP Inquisitor.
 * Pure normalization over data already loaded via existing site fetchers.
 */

import { lootSpentCharacterKey, aggregateLootSpent } from '../characterSpent.js'
import {
  buildAccountAttendanceFacts,
  attendanceRoastEligibility,
} from './attendance.js'
import { isPriceOutlier, THRESHOLDS } from './events.js'
import { slotName } from './formatting.js'

/**
 * Deduplicate loot rows by id.
 * @param {Array<{ id?: number|string }>} rows
 */
export function dedupeLootRows(rows) {
  const byId = new Map()
  for (const row of rows || []) {
    const id = row?.id != null ? String(row.id) : null
    if (!id) continue
    if (!byId.has(id)) byId.set(id, row)
  }
  return [...byId.values()]
}

/**
 * Normalize a loot row into a purchase fact.
 * Account charged follows buyer; character attribution prefers assignment then buyer.
 */
export function normalizePurchase(row, characters = []) {
  const costRaw = row?.cost
  const cost = costRaw == null || costRaw === '' ? null : Number(costRaw)
  const hasCost = cost != null && Number.isFinite(cost)
  const buyerCharId = String(row?.char_id ?? '').trim() || null
  const buyerName = String(row?.character_name ?? '').trim() || null
  const assignedCharId = String(row?.assigned_char_id ?? '').trim() || null
  const assignedName = String(row?.assigned_character_name ?? '').trim() || null
  const attributionKey = lootSpentCharacterKey(row) || null
  const char =
    characters.find((c) => c.char_id && (c.char_id === assignedCharId || c.char_id === attributionKey)) ||
    characters.find((c) => c.name && (c.name === assignedName || c.name === attributionKey || c.name === buyerName)) ||
    null

  return {
    purchaseId: row?.id != null ? String(row.id) : null,
    itemName: String(row?.item_name || '').trim() || null,
    itemId: row?.item_id != null ? Number(row.item_id) : null,
    cost: hasCost ? cost : null,
    raidId: row?.raid_id != null ? String(row.raid_id) : null,
    saleDate: row?.sale_date || row?.date_iso || null,
    buyerCharId,
    buyerName,
    assignedCharId,
    assignedName,
    assignedViaMagelo: Boolean(row?.assigned_via_magelo),
    attributionKey,
    attributedCharacterId: char?.char_id || assignedCharId || null,
    attributedCharacterName: char?.name || assignedName || null,
    attributionReliable: Boolean(assignedCharId || (char && attributionKey)),
    slot: row?.slot || row?.equip_slot || null,
  }
}

/**
 * Build slot-repeat patterns from purchases with known slots and reliable character attribution.
 * @param {ReturnType<typeof normalizePurchase>[]} purchases
 */
export function findSlotRepeatPatterns(purchases) {
  /** @type {Map<string, ReturnType<typeof normalizePurchase>[]>} */
  const byKey = new Map()
  for (const p of purchases || []) {
    if (!p.attributionReliable || !p.attributedCharacterName) continue
    const slot = p.slot || null
    if (!slot) continue
    const key = `${p.attributedCharacterId || p.attributedCharacterName}|${String(slot).toLowerCase()}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(p)
  }
  const patterns = []
  for (const group of byKey.values()) {
    if (group.length < THRESHOLDS.SLOT_REPEAT_MIN) continue
    const first = group[0]
    patterns.push({
      toon: first.attributedCharacterName,
      toonId: first.attributedCharacterId,
      slot: typeof first.slot === 'number' ? slotName(first.slot) : String(first.slot),
      count: group.length,
      purchases: group,
    })
  }
  return patterns
}

/**
 * @param {{
 *   accountId?: string|null,
 *   accountName?: string|null,
 *   currentDkp?: number|null,
 *   guildBalances?: number[],
 *   characters?: Array<{ char_id?: string, name?: string, class_name?: string, level?: number }>,
 *   lootRows?: object[],
 *   attendanceRows?: object[],
 *   characterAccount?: object[],
 *   raidsById?: Record<string, object>,
 *   guildRaidCountInWindow?: number|null,
 *   recentItemPrices?: Record<string, { values: Array<string|number>, avg: string|null }>,
 *   knownItemSources?: Record<string, {
 *     zone?: string,
 *     mob?: string,
 *     displayName?: string,
 *     itemId?: number|string|null,
 *     sources?: Array<{ mob?: string, zone?: string }>,
 *   }>,
 *   itemCatalog?: Array<{ name: string, itemId?: number }>,
 *   comparableSalesByItem?: Record<string, number[]>,
 *   gearByCharacter?: Record<string, object>,
 *   upgradesByCharacter?: Record<string, object>,
 *   now?: Date,
 * }} input
 */
export function buildAccountFacts(input = {}) {
  const accountId = input.accountId ? String(input.accountId).trim() : null
  const characters = (input.characters || []).map((c) => ({
    char_id: c.char_id,
    name: c.name || c.displayName,
    class_name: c.class_name,
    level: c.level,
    displayName: c.name || c.displayName,
  }))

  const loot = dedupeLootRows(input.lootRows || [])
  const purchases = loot
    .map((row) => normalizePurchase(row, characters))
    .filter((p) => p.itemName)
    .sort((a, b) => {
      const da = String(a.saleDate || '')
      const db = String(b.saleDate || '')
      return db.localeCompare(da)
    })

  const withCost = purchases.filter((p) => p.cost != null && p.cost > 0)
  const biggestPurchase = withCost.length
    ? withCost.reduce((best, p) => (p.cost > best.cost ? p : best), withCost[0])
    : null
  const recentPurchase = withCost[0] || purchases[0] || null

  const purchasesByCharacterSpent = aggregateLootSpent(loot)
  /** @type {Record<string, typeof purchases>} */
  const purchasesByCharacter = {}
  for (const p of purchases) {
    const key = p.attributionKey || '_unattributed'
    if (!purchasesByCharacter[key]) purchasesByCharacter[key] = []
    purchasesByCharacter[key].push(p)
  }

  const comparableSalesByItem = input.comparableSalesByItem || {}
  const priceOutliers = []
  for (const p of withCost) {
    const key = (p.itemName || '').toLowerCase()
    const comps = comparableSalesByItem[key] || []
    // Exclude this purchase's own cost when possible
    const others = comps.filter((c) => c !== p.cost)
    const { outlier, median } = isPriceOutlier(p.cost, others.length ? others : comps)
    if (outlier && median != null) {
      priceOutliers.push({ ...p, medianPrice: median })
    }
  }

  const attendance = accountId
    ? buildAccountAttendanceFacts({
        accountId,
        characters,
        characterAccount: input.characterAccount,
        attendanceRows: input.attendanceRows || [],
        raidsById: input.raidsById || {},
        guildRaidCountInWindow: input.guildRaidCountInWindow,
        now: input.now,
      })
    : {
        accountRaidHistory: [],
        accountRaidCount: null,
        lastAccountRaid: null,
        daysSince: null,
        returnGapDays: null,
        dataCoverage: 'unknown',
      }

  const attendanceEligibility = attendanceRoastEligibility(attendance)

  return {
    accountId,
    accountName: input.accountName || null,
    currentDkp: input.currentDkp != null && Number.isFinite(Number(input.currentDkp))
      ? Number(input.currentDkp)
      : null,
    earnedDkp: input.earnedDkp != null && Number.isFinite(Number(input.earnedDkp))
      ? Number(input.earnedDkp)
      : null,
    spentDkp: input.spentDkp != null && Number.isFinite(Number(input.spentDkp))
      ? Number(input.spentDkp)
      : null,
    guildBalances: input.guildBalances || [],
    characters,
    purchases,
    purchasesByCharacter,
    purchasesByCharacterSpent,
    biggestPurchase,
    recentPurchase,
    totalRecordedPurchases: purchases.length,
    accountRaidHistory: attendance.accountRaidHistory,
    lastAccountRaid: attendance.lastAccountRaid,
    accountRaidCount: attendance.accountRaidCount,
    daysSince: attendance.daysSince,
    returnGapDays: attendance.returnGapDays,
    attendanceEligibility,
    gearByCharacter: input.gearByCharacter || {},
    upgradesByCharacter: input.upgradesByCharacter || {},
    recentItemPrices: input.recentItemPrices || {},
    knownItemSources: input.knownItemSources || {},
    itemCatalog: input.itemCatalog || [],
    slotRepeatPatterns: findSlotRepeatPatterns(purchases),
    priceOutliers,
    dataCoverage: {
      account: Boolean(accountId),
      balance: input.currentDkp != null,
      purchases: purchases.length > 0,
      attendance: attendance.dataCoverage,
      magelo: Object.keys(input.gearByCharacter || {}).length > 0,
    },
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Whether a purchase is attributed to the given character (reliable attribution only).
 * @param {ReturnType<typeof normalizePurchase>} purchase
 * @param {{ char_id?: string, name?: string }} character
 */
export function purchaseMatchesCharacter(purchase, character) {
  if (!purchase?.attributionReliable || !character) return false
  const id = String(character.char_id || '').trim()
  const name = String(character.name || '').trim().toLowerCase()
  if (id && purchase.attributedCharacterId && String(purchase.attributedCharacterId) === id) return true
  if (id && purchase.attributionKey && String(purchase.attributionKey) === id) return true
  if (name && purchase.attributedCharacterName && String(purchase.attributedCharacterName).toLowerCase() === name) {
    return true
  }
  if (name && purchase.attributionKey && String(purchase.attributionKey).toLowerCase() === name) return true
  return false
}

/**
 * Account-wide or character-scoped purchase view for spend intents.
 * When character is null (Auto), returns account-level biggest/recent/outliers.
 * When character is set, only reliably attributed purchases for that toon.
 *
 * @param {object} facts
 * @param {{ char_id?: string, name?: string }|null} character
 */
export function scopedPurchaseFacts(facts, character = null) {
  if (!character) {
    return {
      scope: 'account',
      character: null,
      purchases: facts.purchases || [],
      biggestPurchase: facts.biggestPurchase || null,
      recentPurchase: facts.recentPurchase || null,
      priceOutliers: facts.priceOutliers || [],
      slotRepeatPatterns: facts.slotRepeatPatterns || [],
      totalRecordedPurchases: facts.totalRecordedPurchases || 0,
    }
  }

  const purchases = (facts.purchases || []).filter((p) => purchaseMatchesCharacter(p, character))
  const withCost = purchases.filter((p) => p.cost != null && p.cost > 0)
  const biggestPurchase = withCost.length
    ? withCost.reduce((best, p) => (p.cost > best.cost ? p : best), withCost[0])
    : null
  const recentPurchase = withCost[0] || purchases[0] || null
  const accountOutliers = facts.priceOutliers || []
  const priceOutliers = accountOutliers.filter((p) => purchaseMatchesCharacter(p, character))
  const slotRepeatPatterns = (facts.slotRepeatPatterns || []).filter(
    (pat) =>
      (character.char_id && pat.toonId && String(pat.toonId) === String(character.char_id)) ||
      (character.name && pat.toon && String(pat.toon).toLowerCase() === String(character.name).toLowerCase()),
  )

  return {
    scope: 'character',
    character,
    purchases,
    biggestPurchase,
    recentPurchase,
    priceOutliers,
    slotRepeatPatterns,
    totalRecordedPurchases: purchases.length,
  }
}

/**
 * Prefer the worst in-scope price outlier (highest paid/median ratio); else biggest/recent.
 * Attaches medianPrice on the chosen purchase when it is an outlier.
 *
 * @param {ReturnType<typeof scopedPurchaseFacts>} scoped
 * @returns {{ purchase: object|null, category: string|null }}
 */
export function pickSpendPurchase(scoped) {
  const outliers = scoped.priceOutliers || []
  if (outliers.length) {
    const worst = outliers.reduce((best, p) => {
      const ratio = p.medianPrice > 0 ? p.cost / p.medianPrice : 0
      const bestRatio = best.medianPrice > 0 ? best.cost / best.medianPrice : 0
      if (ratio !== bestRatio) return ratio > bestRatio ? p : best
      return p.cost > best.cost ? p : best
    })
    return { purchase: worst, category: 'price_outlier' }
  }
  if (scoped.biggestPurchase?.itemName && scoped.biggestPurchase.cost != null) {
    return { purchase: scoped.biggestPurchase, category: 'biggest_purchase' }
  }
  if (scoped.recentPurchase?.itemName) {
    return { purchase: scoped.recentPurchase, category: 'recent_purchase' }
  }
  if ((scoped.slotRepeatPatterns || []).length > 0) {
    const pat = scoped.slotRepeatPatterns[0]
    const purchase = pat.purchases?.[0] || scoped.recentPurchase || null
    return { purchase, category: 'slot_repeat' }
  }
  if ((scoped.totalRecordedPurchases || 0) >= 1) {
    return { purchase: scoped.recentPurchase || null, category: 'purchase_volume' }
  }
  return { purchase: null, category: null }
}

/**
 * Extract loot rows from fetchAccountDetail activity payload when available.
 * AccountDetail returns activityByRaid with loot arrays — also accept flat lootRows.
 */
export function lootRowsFromAccountDetail(detail) {
  if (!detail) return []
  if (Array.isArray(detail.lootRows)) return detail.lootRows
  const rows = []
  for (const raid of detail.activityByRaid || []) {
    for (const loot of raid.items || raid.loot || raid.lootRows || []) {
      rows.push({
        ...loot,
        raid_id: loot.raid_id ?? raid.raid_id,
        sale_date: loot.sale_date || raid.date_iso || raid.date,
      })
    }
  }
  return rows
}

/**
 * Flatten attendance rows from account detail for account-level facts.
 * Only raids with earned attendance (tic/DKP) count — loot-only raids do not.
 */
export function attendanceRowsFromAccountDetail(detail) {
  if (!detail) return []
  if (Array.isArray(detail.attendanceRows)) return detail.attendanceRows
  const rows = []
  const accountId = detail.account?.account_id
  for (const raid of detail.activityByRaid || []) {
    const raidId = raid.raid_id
    const earned = Number(raid.dkpEarned || 0) > 0 || Number(raid.ticEarned || 0) > 0
    if (raidId != null && earned) {
      rows.push({
        raid_id: raidId,
        account_id: accountId,
        raid_name: raid.raid_name,
        date_iso: raid.date_iso || raid.date,
        char_id: null,
        character_name: null,
      })
    }
    for (const att of raid.attendance || raid.attendees || []) {
      rows.push({
        raid_id: raidId,
        account_id: att.account_id || accountId,
        char_id: att.char_id,
        character_name: att.character_name,
        raid_name: raid.raid_name,
        date_iso: raid.date_iso || raid.date,
      })
    }
  }
  return rows
}

export function raidsByIdFromAccountDetail(detail) {
  if (!detail) return {}
  if (detail.raids && typeof detail.raids === 'object' && !Array.isArray(detail.raids)) {
    return detail.raids
  }
  const map = {}
  for (const raid of detail.activityByRaid || []) {
    const id = String(raid.raid_id ?? '').trim()
    if (id) map[id] = { raid_id: id, raid_name: raid.raid_name, date_iso: raid.date_iso || raid.date }
  }
  return map
}
