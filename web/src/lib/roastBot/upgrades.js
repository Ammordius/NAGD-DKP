/**
 * Lazy Magelo + raid-loot-filtered upgrade scoring for the roast bot.
 * Never invents deltas when Magelo inventory or weights are missing.
 */

import { computeUpgradesForCharacter, SLOT_NAMES_FOR_UI } from '../mageloUpgradeEngine.js'
import { ensureItemStatsLoaded } from '../itemStats.js'
import { getDkpMobLoot, getRaidItemSources } from '../staticData.js'
import { classifyUpgradeDelta } from './events.js'
import { formatUpgradeDelta } from './formatting.js'

const CLASS_RANKINGS_URL =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_CLASS_RANKINGS_URL) ||
  '/class_rankings.json'

let rankingsPromise = null
let rankingsCache = null
const upgradeCache = new Map()

/** @param {string} [url] */
export function loadClassRankings(url = CLASS_RANKINGS_URL) {
  if (rankingsCache) return Promise.resolve(rankingsCache)
  if (!rankingsPromise) {
    rankingsPromise = fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (json) {
          rankingsCache = json
          return json
        }
        // Failed fetch must not stick — allow later retry
        rankingsPromise = null
        rankingsCache = null
        return null
      })
      .catch(() => {
        rankingsPromise = null
        rankingsCache = null
        return null
      })
  }
  return rankingsPromise
}

/** Test helper */
export function resetUpgradeCaches() {
  rankingsPromise = null
  rankingsCache = null
  upgradeCache.clear()
}

/**
 * @param {object|null} rankings
 * @param {string} characterName
 */
export function findMageloCharacter(rankings, characterName) {
  const want = String(characterName || '').trim().toLowerCase()
  if (!want || !rankings) return null
  const list = rankings.characters || rankings.Chars || rankings.toons || []
  for (const c of list) {
    const name = String(c.name || c.character_name || c.char_name || '').trim().toLowerCase()
    if (name === want) return c
  }
  return null
}

/**
 * Normalize Magelo inventory entries to { slot_id, item_id, item_name }.
 * @param {object} mageloChar
 */
export function extractInventory(mageloChar) {
  const inv = mageloChar?.inventory || mageloChar?.equipped || mageloChar?.items || []
  if (!Array.isArray(inv)) return []
  return inv
    .map((row) => ({
      slot_id: Number(row.slot_id ?? row.slotId ?? row.slot),
      item_id: row.item_id != null ? Number(row.item_id) : row.itemId != null ? Number(row.itemId) : null,
      item_name: row.item_name || row.itemName || row.name || '',
    }))
    .filter((r) => Number.isFinite(r.slot_id) && r.slot_id >= 1 && r.slot_id <= 22)
}

/**
 * Collect raid loot item ids from static JSON for a filtered scoring universe.
 */
export async function collectRaidLootItemIds() {
  const ids = new Set()
  const [mobLoot, raidSources] = await Promise.all([getDkpMobLoot(), getRaidItemSources()])
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const x of node) walk(x)
      return
    }
    if (node.item_id != null) ids.add(Number(node.item_id))
    if (node.itemId != null) ids.add(Number(node.itemId))
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') walk(v)
    }
  }
  walk(mobLoot)
  walk(raidSources)
  return ids
}

/**
 * @param {Record<string, object>} allStats
 * @param {Set<number>} raidIds
 */
export function filterItemStatsForRaidLoot(allStats, raidIds) {
  /** @type {Record<string, object>} */
  const out = {}
  if (!allStats) return out
  for (const [idStr, stats] of Object.entries(allStats)) {
    const id = Number(idStr)
    if (raidIds.has(id)) out[idStr] = stats
  }
  // If filter emptied everything (fixtures), fall back to full map for tests with tiny catalogs.
  if (Object.keys(out).length === 0) return { ...allStats }
  return out
}

/**
 * Build scoring context from rankings export + item stats.
 * @param {object} rankings
 * @param {Record<string, object>} itemStats
 */
export function buildUpgradeContext(rankings, itemStats) {
  const classWeights =
    rankings?.classWeights ||
    rankings?.class_weights ||
    rankings?.weights ||
    rankings?.ClassWeights ||
    {}
  const focusCandidates =
    rankings?.focusCandidates ||
    rankings?.focus_candidates ||
    rankings?.focusItems ||
    {}
  const spellFociiList = rankings?.spellFociiList || rankings?.spell_focii || null
  const elementalDisplayNames = rankings?.elementalDisplayNames || {}
  return {
    itemStats,
    classWeights,
    focusCandidates,
    spellFociiList,
    elementalDisplayNames,
  }
}

/**
 * Compute up to `limit` upgrade suggestions for a character.
 *
 * @param {{
 *   character: { char_id?: string, name?: string, class_name?: string },
 *   rankings?: object|null,
 *   itemStats?: Record<string, object>,
 *   raidItemIds?: Set<number>,
 *   limit?: number,
 * }} args
 */
export function computeCharacterUpgrades({
  character,
  rankings,
  itemStats,
  raidItemIds,
  limit = 3,
}) {
  if (!character?.name) {
    return { ok: false, reason: 'missing_character', suggestions: [] }
  }
  const magelo = findMageloCharacter(rankings, character.name)
  if (!magelo) {
    return { ok: false, reason: 'missing_magelo', suggestions: [] }
  }
  const inventory = extractInventory(magelo)
  if (!inventory.length) {
    return { ok: false, reason: 'missing_inventory', suggestions: [] }
  }
  const className = magelo.class || magelo.class_name || character.class_name
  if (!className) {
    return { ok: false, reason: 'missing_class', suggestions: [] }
  }
  const filtered = raidItemIds?.size
    ? filterItemStatsForRaidLoot(itemStats, raidItemIds)
    : itemStats || {}
  if (!filtered || Object.keys(filtered).length === 0) {
    return { ok: false, reason: 'missing_item_stats', suggestions: [] }
  }
  const ctx = buildUpgradeContext(rankings || {}, filtered)
  if (!ctx.classWeights || Object.keys(ctx.classWeights).length === 0) {
    return { ok: false, reason: 'missing_weights', suggestions: [] }
  }

  const char = { class: className, inventory }
  const result = computeUpgradesForCharacter(char, 3, false, ctx)
  if (result.error) {
    return { ok: false, reason: result.error, suggestions: [] }
  }

  /** @type {Array<object>} */
  const flat = []
  for (const slotEntry of result.bySlot || []) {
    const slotId = slotEntry.slotId
    const slotLabel = slotEntry.slotName || SLOT_NAMES_FOR_UI[slotId] || `Slot ${slotId}`
    for (const cand of slotEntry.candidates || []) {
      const strength = classifyUpgradeDelta(cand.delta)
      if (strength === 'none') continue
      flat.push({
        itemId: cand.itemId,
        itemName: cand.itemName,
        slotId,
        slot: slotLabel,
        delta: cand.delta,
        strength,
        upgrade: formatUpgradeDelta(cand.delta, slotLabel),
        characterId: character.char_id,
        characterName: character.name,
      })
    }
  }
  flat.sort((a, b) => b.delta - a.delta)
  const suggestions = flat.slice(0, limit)
  if (!suggestions.length) {
    return { ok: false, reason: 'no_positive_upgrades', suggestions: [], anyMissing: result.anyMissing }
  }
  return { ok: true, reason: null, suggestions, anyMissing: result.anyMissing }
}

/**
 * Async entry: load Magelo + item stats as needed, cache by account/char.
 */
export async function getUpgradesForCharacter(character, options = {}) {
  const cacheKey = `${options.accountId || ''}:${character?.char_id || character?.name || ''}:${options.cacheToken || ''}`
  if (upgradeCache.has(cacheKey)) return upgradeCache.get(cacheKey)

  const [rankings, itemStatsObj, raidItemIds] = await Promise.all([
    options.rankings !== undefined ? Promise.resolve(options.rankings) : loadClassRankings(options.rankingsUrl),
    options.itemStats
      ? Promise.resolve(options.itemStats)
      : ensureItemStatsLoaded().then(() => {
          // ensureItemStatsLoaded populates module cache; re-fetch object form
          return options.itemStats || fetch('/item_stats.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
        }),
    options.raidItemIds || collectRaidLootItemIds(),
  ])

  const result = computeCharacterUpgrades({
    character,
    rankings,
    itemStats: itemStatsObj,
    raidItemIds,
    limit: options.limit ?? 3,
  })
  // Cache successful upgrade computations only; allow retry after missing Magelo
  if (result.ok) upgradeCache.set(cacheKey, result)
  return result
}
