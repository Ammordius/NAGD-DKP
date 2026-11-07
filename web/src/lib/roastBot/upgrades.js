/**
 * Lazy Magelo + raid-loot-filtered upgrade scoring for the roast bot.
 * Never invents deltas when Magelo inventory or weights are missing.
 */

import {
  CLASS_TO_ABBREV,
  computeUpgradesForCharacter,
  evaluateItemUpgradeForCharacter,
  itemMatchesSlot,
  itemUsableByClass,
  SLOT_NAMES_FOR_UI,
} from '../mageloUpgradeEngine.js'
import {
  ensureElementalArmorLoaded,
  getArmorIdForMoldAndClass,
  getMoldInfo,
  isElementalMold,
} from '../elementalArmor.js'
import { ensureItemStatsLoaded } from '../itemStats.js'
import { getDkpMobLoot, getRaidItemSources } from '../staticData.js'
import { classifyUpgradeDelta } from './events.js'
import { formatUpgradeDelta } from './formatting.js'
import { SLOT_ALIASES, normAliasKey } from './discovery/aliases.js'

/**
 * Exact slot-alias match only (no substring scan). Avoids treating
 * "Earthen Bracer of Fortitude" as a WRIST upgrade follow-up.
 * @param {string} text
 * @returns {string|null}
 */
function resolveExactSlotAlias(text) {
  const key = normAliasKey(text)
  if (!key) return null
  return SLOT_ALIASES[key] || null
}

/**
 * Discovery canonical slot strings → Magelo inventory slot ids (1–22).
 * Paired slots (ear/wrist/finger) map to both inventory positions.
 */
export const CANONICAL_SLOT_TO_IDS = {
  EAR: [1, 4],
  HEAD: [2],
  FACE: [3],
  NECK: [5],
  SHOULDER: [6],
  SHOULDERS: [6],
  ARMS: [7],
  BACK: [8],
  WRIST: [9, 10],
  RANGE: [11],
  HANDS: [12],
  PRIMARY: [13],
  MAIN: [13],
  SECONDARY: [14],
  OFF: [14],
  FINGER: [15, 16],
  FINGERS: [15, 16],
  CHEST: [17],
  LEGS: [18],
  FEET: [19],
  WAIST: [20],
  POWER: [21],
  AMMO: [22],
}

/**
 * @param {string|null|undefined} canonical
 * @returns {number[]|null}
 */
export function slotIdsFromCanonical(canonical) {
  if (!canonical) return null
  const ids = CANONICAL_SLOT_TO_IDS[String(canonical).toUpperCase()]
  return ids?.length ? [...ids] : null
}

/**
 * Chip / dialogue label for a Magelo slot id (collapse paired slots).
 * @param {number} slotId
 * @param {string} [slotLabel]
 */
export function chipLabelForSlot(slotId, slotLabel) {
  if (slotId === 15 || slotId === 16) return 'Ring'
  if (slotId === 9 || slotId === 10) return 'Wrist'
  if (slotId === 1 || slotId === 4) return 'Ear'
  return slotLabel || SLOT_NAMES_FOR_UI[slotId] || `Slot ${slotId}`
}

const SLOT_HINT_DETERMINERS = /^(?:his|her|their|my|our|the|a|an)\s+/i

/**
 * Strip trailing junk and leading possessives/determiners before exact slot resolve.
 * @param {string} hint
 * @returns {string}
 */
function normalizeSlotHintPhrase(hint) {
  let cleaned = String(hint || '')
    .replace(/[?.!,/;:]+$/g, '')
    .trim()
  cleaned = cleaned.replace(SLOT_HINT_DETERMINERS, '').trim()
  cleaned = cleaned.replace(/[?.!,/;:]+$/g, '').trim()
  return cleaned
}

/**
 * Exact-alias resolve for a single whitespace token (punctuation stripped).
 * @param {string} token
 * @param {(hint: string) => { canonical: string, slotIds: number[], chipLabel: string }|null} tryResolve
 * @returns {{ canonical: string, slotIds: number[], chipLabel: string }|null}
 */
function tryResolveToken(token, tryResolve) {
  const cleaned = String(token || '')
    .replace(/^[?.!,/;:]+|[?.!,/;:]+$/g, '')
    .replace(SLOT_HINT_DETERMINERS, '')
    .replace(/^[?.!,/;:]+|[?.!,/;:]+$/g, '')
    .trim()
  if (!cleaned) return null
  return tryResolve(cleaned)
}

/**
 * When upgrades / about-follow-up phrasing is present, find a single exact slot token.
 * Multi-slot phrases return null to avoid ambiguous filters.
 * @param {string} raw
 * @param {(hint: string) => { canonical: string, slotIds: number[], chipLabel: string }|null} tryResolve
 * @returns {{ canonical: string, slotIds: number[], chipLabel: string }|null}
 */
function scanSingleSlotToken(raw, tryResolve) {
  const hits = []
  const seen = new Set()
  for (const token of String(raw || '').split(/\s+/).filter(Boolean)) {
    const hit = tryResolveToken(token, tryResolve)
    if (!hit) continue
    const key = hit.canonical
    if (seen.has(key)) continue
    seen.add(key)
    hits.push(hit)
    if (hits.length > 1) return null
  }
  return hits.length === 1 ? hits[0] : null
}

/**
 * Extract an equipment-slot hint for upgrade follow-ups ("what about shoulder", bare "shoulder").
 * @param {string} text
 * @returns {{ canonical: string, slotIds: number[], chipLabel: string }|null}
 */
export function extractUpgradeSlotHint(text) {
  const raw = String(text || '').trim()
  if (!raw) return null

  const tryResolve = (hint) => {
    const cleaned = normalizeSlotHintPhrase(hint)
    if (!cleaned) return null
    const canonical = resolveExactSlotAlias(cleaned)
    if (!canonical) return null
    const slotIds = slotIdsFromCanonical(canonical)
    if (!slotIds?.length) return null
    return {
      canonical,
      slotIds,
      chipLabel: chipLabelForSlot(slotIds[0], SLOT_NAMES_FOR_UI[slotIds[0]]),
    }
  }

  // Bare slot reply: "shoulder", "shoulders?", "his wrist/."
  const direct = tryResolve(raw)
  if (direct) return direct

  // Dialogue chips / follow-ups: "what about shoulder?", "what about his wrist/."
  const about = raw.match(/\b(?:what about|how about)\s+(.+?)(?:\?|$)/i)
  if (about) {
    const fromAbout = tryResolve(about[1])
    if (fromAbout) return fromAbout
  }

  // Noun-first: "what wrist upgrades…", "which shoulder upgrades…"
  const nounFirst = raw.match(
    /\b(?:what|which|any|show(?:\s+me)?)\s+(?:(?:his|her|their|my|our|the|a|an)\s+)?(\w+)\s+upgrades?\b/i,
  )
  if (nounFirst) {
    const fromNoun = tryResolve(nounFirst[1])
    if (fromNoun) return fromNoun
  }

  // "<slot> upgrades for …"
  const slotUpgradesFor = raw.match(
    /\b(?:(?:his|her|their|my|our|the|a|an)\s+)?(\w+)\s+upgrades?\s+(?:for|on|to)\b/i,
  )
  if (slotUpgradesFor) {
    const fromSlotUpgrades = tryResolve(slotUpgradesFor[1])
    if (fromSlotUpgrades) return fromSlotUpgrades
  }

  // Inline on buy path: "what should I buy for shoulders" or "… for Iaminae shoulders"
  const forSlot = raw.match(/\bfor\s+(.+?)(?:\?|$)/i)
  if (forSlot) {
    const forHint = normalizeSlotHintPhrase(forSlot[1] || '')
    const tokens = forHint.split(/\s+/).filter(Boolean)
    // Prefer a trailing exact slot token (character name + slot)
    if (tokens.length >= 1) {
      const fromTrailing = tryResolve(tokens[tokens.length - 1])
      if (fromTrailing) return fromTrailing
    }
    const fromFor = tryResolve(forHint)
    if (fromFor) return fromFor
  }

  // Fallback token scan for upgrade / about utterances with a single exact slot word.
  if (/\bupgrades?\b/i.test(raw) || /\b(?:what about|how about)\b/i.test(raw)) {
    const scanned = scanSingleSlotToken(raw, tryResolve)
    if (scanned) return scanned
  }

  return null
}

/**
 * @param {Array<{ slotId: number, slot: string, delta: number }>} flat
 * @returns {Array<{ slotId: number, slotLabel: string, chipLabel: string, bestDelta: number, count: number }>}
 */
function buildUpgradeSlots(flat) {
  /** @type {Map<number, { slotId: number, slotLabel: string, chipLabel: string, bestDelta: number, count: number }>} */
  const byId = new Map()
  for (const row of flat) {
    const slotId = row.slotId
    if (!Number.isFinite(slotId)) continue
    const prev = byId.get(slotId)
    if (!prev) {
      byId.set(slotId, {
        slotId,
        slotLabel: row.slot,
        chipLabel: chipLabelForSlot(slotId, row.slot),
        bestDelta: row.delta,
        count: 1,
      })
    } else {
      prev.count += 1
      if (row.delta > prev.bestDelta) prev.bestDelta = row.delta
    }
  }
  return [...byId.values()].sort((a, b) => b.bestDelta - a.bestDelta)
}

/** Hosted Magelo export (gh-pages). Override with VITE_CLASS_RANKINGS_URL. */
export const DEFAULT_CLASS_RANKINGS_URL =
  'https://ammordius.github.io/NAGD-spell-inventory/class_rankings.json'

const CLASS_RANKINGS_URL =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_CLASS_RANKINGS_URL) ||
  DEFAULT_CLASS_RANKINGS_URL

let rankingsPromise = null
/** @type {{ ok: true, rankings: object } | null} */
let rankingsCache = null
const upgradeCache = new Map()

/**
 * Minimal schema check for Magelo class_rankings export.
 * @param {unknown} json
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateClassRankingsSchema(json) {
  if (!json || typeof json !== 'object') {
    return { ok: false, error: 'invalid_schema' }
  }
  const list = json.characters || json.Chars || json.toons
  if (!Array.isArray(list)) {
    return { ok: false, error: 'invalid_schema' }
  }
  const weights = json.classWeights || json.class_weights || json.weights || json.ClassWeights
  if (!weights || typeof weights !== 'object' || Object.keys(weights).length === 0) {
    return { ok: false, error: 'invalid_schema' }
  }
  return { ok: true }
}

/**
 * @param {string} [url]
 * @returns {Promise<{ ok: true, rankings: object } | { ok: false, error: string, status?: number }>}
 */
export function loadClassRankings(url = CLASS_RANKINGS_URL) {
  if (rankingsCache?.ok) return Promise.resolve(rankingsCache)
  if (!rankingsPromise) {
    rankingsPromise = fetch(url)
      .then(async (r) => {
        if (!r.ok) {
          rankingsPromise = null
          rankingsCache = null
          const error = r.status === 404 ? 'http_404' : 'http_status'
          return { ok: false, error, status: r.status }
        }
        let json
        try {
          json = await r.json()
        } catch {
          rankingsPromise = null
          rankingsCache = null
          return { ok: false, error: 'invalid_json' }
        }
        const schema = validateClassRankingsSchema(json)
        if (!schema.ok) {
          rankingsPromise = null
          rankingsCache = null
          return { ok: false, error: schema.error }
        }
        const success = { ok: true, rankings: json }
        rankingsCache = success
        return success
      })
      .catch(() => {
        rankingsPromise = null
        rankingsCache = null
        return { ok: false, error: 'network' }
      })
  }
  return rankingsPromise
}

/** Human-readable Magelo load failure for chat replies (no insults). */
export function formatMageloLoadError(result) {
  if (!result || result.ok) return null
  const err = result.error || 'unknown'
  if (err === 'http_404') return 'Magelo rankings fetch failed (HTTP 404)'
  if (err === 'http_status') {
    const status = result.status != null ? `HTTP ${result.status}` : 'HTTP error'
    return `Magelo rankings fetch failed (${status})`
  }
  if (err === 'invalid_json') return 'Magelo rankings response was not valid JSON'
  if (err === 'invalid_schema') {
    return 'Magelo rankings JSON failed schema validation (need characters[] and class weights)'
  }
  if (err === 'network') return 'Magelo rankings network request failed'
  return `Magelo rankings unavailable (${err})`
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
 * Raid-filter item stats, then inject class-specific wearable armor for any
 * elemental molds/patterns in the raid loot set (MobLoot / Magelo parity).
 *
 * @param {Record<string, object>|null|undefined} allStats
 * @param {Set<number>|null|undefined} raidIds
 * @param {string} classAbbrev - e.g. WAR, ROG
 * @returns {{ itemStats: Record<string, object>, armorToMold: Map<number, { moldId: number, moldName: string }> }}
 */
export function expandRaidLootWithClassArmor(allStats, raidIds, classAbbrev) {
  /** @type {Record<string, object>} */
  const itemStats = raidIds?.size
    ? filterItemStatsForRaidLoot(allStats, raidIds)
    : { ...(allStats || {}) }
  /** @type {Map<number, { moldId: number, moldName: string }>} */
  const armorToMold = new Map()
  if (!allStats || !classAbbrev) return { itemStats, armorToMold }

  const moldIds = raidIds?.size
    ? [...raidIds]
    : Object.keys(allStats).map((id) => Number(id)).filter((n) => Number.isFinite(n))

  for (const moldId of moldIds) {
    if (!Number.isFinite(moldId)) continue
    const info = getMoldInfo(moldId)
    if (!info) continue
    const armorId = getArmorIdForMoldAndClass(moldId, classAbbrev)
    if (armorId == null) continue
    const armorStats = allStats[String(armorId)] || allStats[armorId]
    if (!armorStats) continue
    itemStats[String(armorId)] = armorStats
    const moldName =
      (typeof info.mold_name === 'string' && info.mold_name.trim()) ||
      allStats[String(moldId)]?.name ||
      allStats[moldId]?.name ||
      `Mold ${moldId}`
    armorToMold.set(armorId, { moldId: Number(moldId), moldName })
  }
  return { itemStats, armorToMold }
}

/**
 * @param {Map<number, { moldId: number, moldName: string }>|null|undefined} armorToMold
 * @param {number|string|null|undefined} itemId
 */
function moldMetaForArmor(armorToMold, itemId) {
  if (!armorToMold?.size || itemId == null) return null
  const n = Number(itemId)
  if (!Number.isFinite(n)) return null
  return armorToMold.get(n) || null
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
 * Count items in `itemStats` that match any of the given slot ids for a class.
 * Used to distinguish an empty candidate universe from zero positive deltas.
 * @param {Record<string, object>} itemStats
 * @param {number[]} slotIds
 * @param {string} classAbbrev
 */
export function countSlotClassMatches(itemStats, slotIds, classAbbrev) {
  if (!itemStats || !slotIds?.length) return 0
  let count = 0
  for (const stats of Object.values(itemStats)) {
    if (!stats) continue
    if (!itemUsableByClass(stats.classes, classAbbrev)) continue
    if (slotIds.some((slotId) => itemMatchesSlot(slotId, stats.slot))) count += 1
  }
  return count
}

/**
 * @param {object} args
 * @param {number} [args.raidFilteredCount]
 * @param {number} [args.matchCount]
 * @param {number} [args.upgradeRowCount]
 * @param {boolean} [args.anyMissing]
 */
function buildUpgradeDebug(args) {
  return {
    raidFilteredCount: args.raidFilteredCount ?? 0,
    matchCount: args.matchCount ?? 0,
    upgradeRowCount: args.upgradeRowCount ?? 0,
    anyMissing: Boolean(args.anyMissing),
  }
}

function logUpgradeDebug(debug) {
  const isDev =
    typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV
  if (!isDev || typeof console === 'undefined' || typeof console.debug !== 'function') return
  console.debug(
    '[roastBot upgrades]',
    `raidFiltered=${debug.raidFilteredCount}`,
    `slotClassMatches=${debug.matchCount}`,
    `upgradeRows=${debug.upgradeRowCount}`,
    `anyMissing=${debug.anyMissing}`,
  )
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
 *   slotIds?: number[]|null,
 * }} args
 */
export function computeCharacterUpgrades({
  character,
  rankings,
  itemStats,
  raidItemIds,
  limit = 3,
  slotIds: filterSlotIds = null,
}) {
  if (!character?.name) {
    return { ok: false, reason: 'missing_character', suggestions: [], upgradeSlots: [] }
  }
  const magelo = findMageloCharacter(rankings, character.name)
  if (!magelo) {
    return { ok: false, reason: 'missing_magelo', suggestions: [], upgradeSlots: [] }
  }
  const inventory = extractInventory(magelo)
  if (!inventory.length) {
    return { ok: false, reason: 'missing_inventory', suggestions: [], upgradeSlots: [] }
  }
  const className = magelo.class || magelo.class_name || character.class_name
  if (!className) {
    return { ok: false, reason: 'missing_class', suggestions: [], upgradeSlots: [] }
  }
  const classAbbrev = CLASS_TO_ABBREV[className] || ''
  const { itemStats: filtered, armorToMold } = expandRaidLootWithClassArmor(
    itemStats,
    raidItemIds,
    classAbbrev,
  )
  if (!filtered || Object.keys(filtered).length === 0) {
    return { ok: false, reason: 'missing_item_stats', suggestions: [], upgradeSlots: [] }
  }
  const ctx = buildUpgradeContext(rankings || {}, filtered)
  if (!ctx.classWeights || Object.keys(ctx.classWeights).length === 0) {
    return { ok: false, reason: 'missing_weights', suggestions: [], upgradeSlots: [] }
  }

  const filterSet =
    Array.isArray(filterSlotIds) && filterSlotIds.length
      ? new Set(filterSlotIds.filter((id) => Number.isFinite(id)))
      : null
  const maxPerSlot = filterSet ? 5 : 3
  const resultLimit = filterSet ? Math.min(limit ?? 5, 5) : limit

  const char = { class: className, inventory }
  const result = computeUpgradesForCharacter(char, maxPerSlot, false, ctx)
  if (result.error) {
    return { ok: false, reason: result.error, suggestions: [], upgradeSlots: [] }
  }

  const allSlotIds = (result.bySlot || []).map((s) => s.slotId).filter((id) => Number.isFinite(id))
  const matchCount = countSlotClassMatches(filtered, allSlotIds, classAbbrev)
  const raidFilteredCount = Object.keys(filtered).length

  /** @type {Array<object>} */
  const flatAll = []
  /** @type {Array<object>} */
  const flatFiltered = []
  let upgradeRowCount = 0
  let missingEquippedStats = false
  for (const slotEntry of result.bySlot || []) {
    const slotId = slotEntry.slotId
    const slotLabel = slotEntry.slotName || SLOT_NAMES_FOR_UI[slotId] || `Slot ${slotId}`
    if (slotEntry.currentItemId != null && slotEntry.currentInData === false) {
      missingEquippedStats = true
    }
    // Engine contract: bySlot[].upgrades (not .candidates — that property is never returned)
    const rows = slotEntry.upgrades || []
    upgradeRowCount += rows.length
    const inFilter = !filterSet || filterSet.has(slotId)
    for (const cand of rows) {
      const strength = classifyUpgradeDelta(cand.delta)
      if (strength === 'none') continue
      const moldMeta = moldMetaForArmor(armorToMold, cand.itemId)
      const row = {
        itemId: cand.itemId,
        itemName: moldMeta?.moldName || cand.itemName,
        moldId: moldMeta?.moldId ?? null,
        moldName: moldMeta?.moldName ?? null,
        slotId,
        slot: slotLabel,
        delta: cand.delta,
        strength,
        upgrade: formatUpgradeDelta(cand.delta, slotLabel),
        characterId: character.char_id,
        characterName: character.name,
      }
      flatAll.push(row)
      if (inFilter) flatFiltered.push(row)
    }
  }
  flatAll.sort((a, b) => b.delta - a.delta)
  flatFiltered.sort((a, b) => b.delta - a.delta)

  /** Dedupe by itemId so paired slots (rings/wrists/ears) do not double-list the same item. */
  const seen = new Set()
  const ranked = []
  for (const row of flatFiltered) {
    const key = row.itemId != null ? String(row.itemId) : `${row.itemName}:${row.slotId}`
    if (seen.has(key)) continue
    seen.add(key)
    ranked.push(row)
  }

  const suggestions = ranked.slice(0, resultLimit)
  const upgradeSlots = buildUpgradeSlots(flatAll)
  const debug = buildUpgradeDebug({
    raidFilteredCount,
    matchCount,
    upgradeRowCount,
    anyMissing: result.anyMissing,
  })
  logUpgradeDebug(debug)

  if (!suggestions.length) {
    let reason = 'no_positive_upgrades'
    if (filterSet) reason = 'no_upgrades_for_slot'
    else if (matchCount === 0) reason = 'empty_candidate_set'
    else if (missingEquippedStats || result.anyMissing) reason = 'missing_equipped_item_stats'
    return {
      ok: false,
      reason,
      suggestions: [],
      upgradeSlots,
      anyMissing: result.anyMissing,
      debug,
    }
  }
  return {
    ok: true,
    reason: null,
    suggestions,
    upgradeSlots,
    anyMissing: result.anyMissing,
    debug,
  }
}

/**
 * Resolve a numeric item id from sticky id and/or display name via itemStats.
 * @param {Record<string, object>|null|undefined} itemStats
 * @param {string|number|null|undefined} itemId
 * @param {string|null|undefined} itemName
 * @returns {number|null}
 */
export function resolveItemIdFromStats(itemStats, itemId, itemName) {
  if (itemId != null && itemId !== '') {
    const n = Number(itemId)
    if (Number.isFinite(n) && !Number.isNaN(n)) {
      if (!itemStats || itemStats[String(n)] || itemStats[n]) return n
    }
  }
  const want = String(itemName || '')
    .trim()
    .toLowerCase()
  if (!want || !itemStats) return null
  for (const [idStr, stats] of Object.entries(itemStats)) {
    if (String(stats?.name || '').trim().toLowerCase() === want) {
      const n = Number(idStr)
      return Number.isFinite(n) ? n : null
    }
  }
  return null
}

/**
 * Score one candidate item across all linked account characters (item → roster).
 *
 * @param {{
 *   characters: Array<{ char_id?: string, name?: string, class_name?: string }>,
 *   itemId?: string|number|null,
 *   itemName?: string|null,
 *   rankings?: object|null,
 *   itemStats?: Record<string, object>,
 *   raidItemIds?: Set<number>,
 * }} args
 */
export function evaluateItemFitForAccount({
  characters,
  itemId = null,
  itemName = null,
  rankings = null,
  itemStats = null,
  raidItemIds = null,
}) {
  const list = Array.isArray(characters) ? characters.filter((c) => c?.name) : []
  if (!list.length) {
    return { ok: false, reason: 'no_characters', itemId: null, itemName: itemName || null, fits: [] }
  }
  if (!rankings) {
    return { ok: false, reason: 'magelo_unavailable', itemId: null, itemName: itemName || null, fits: [] }
  }
  const baseFiltered = raidItemIds?.size
    ? filterItemStatsForRaidLoot(itemStats, raidItemIds)
    : itemStats || {}
  // Prefer full stats for id resolution (raid filter may drop the candidate itself when not in raid set).
  const resolvedId = resolveItemIdFromStats(itemStats || baseFiltered, itemId, itemName)
  if (resolvedId == null) {
    return {
      ok: false,
      reason: 'item_unresolved',
      itemId: null,
      itemName: itemName || null,
      fits: [],
    }
  }
  const moldInfo = isElementalMold(resolvedId) ? getMoldInfo(resolvedId) : null
  const candidateStats =
    (itemStats || {})[String(resolvedId)] || (itemStats || {})[resolvedId] || baseFiltered[String(resolvedId)]
  const resolvedName =
    (moldInfo && typeof moldInfo.mold_name === 'string' && moldInfo.mold_name.trim()) ||
    candidateStats?.name ||
    itemName ||
    `Item ${resolvedId}`
  if (!baseFiltered || Object.keys(baseFiltered).length === 0) {
    return { ok: false, reason: 'missing_item_stats', itemId: resolvedId, itemName: resolvedName, fits: [] }
  }
  // Ensure candidate is present in scoring map even if raid filter omitted it.
  const scoringStats = { ...baseFiltered }
  if (!scoringStats[String(resolvedId)] && candidateStats) {
    scoringStats[String(resolvedId)] = candidateStats
  }
  const weightsProbe = buildUpgradeContext(rankings, scoringStats)
  if (!weightsProbe.classWeights || Object.keys(weightsProbe.classWeights).length === 0) {
    return { ok: false, reason: 'missing_weights', itemId: resolvedId, itemName: resolvedName, fits: [] }
  }

  /** @type {Array<object>} */
  const fits = []
  for (const character of list) {
    const magelo = findMageloCharacter(rankings, character.name)
    if (!magelo) {
      fits.push({
        characterId: character.char_id || null,
        characterName: character.name,
        eligible: false,
        isUpgrade: false,
        reason: 'missing_magelo',
        scoreDelta: null,
        slotName: null,
        upgrade: null,
        currentItemName: null,
        candidateName: resolvedName,
      })
      continue
    }
    const inventory = extractInventory(magelo)
    if (!inventory.length) {
      fits.push({
        characterId: character.char_id || null,
        characterName: character.name,
        eligible: false,
        isUpgrade: false,
        reason: 'missing_inventory',
        scoreDelta: null,
        slotName: null,
        upgrade: null,
        currentItemName: null,
        candidateName: resolvedName,
      })
      continue
    }
    const className = magelo.class || magelo.class_name || character.class_name
    if (!className) {
      fits.push({
        characterId: character.char_id || null,
        characterName: character.name,
        eligible: false,
        isUpgrade: false,
        reason: 'missing_class',
        scoreDelta: null,
        slotName: null,
        upgrade: null,
        currentItemName: null,
        candidateName: resolvedName,
      })
      continue
    }

    const classAbbrev = CLASS_TO_ABBREV[className] || ''
    let scoreItemId = resolvedId
    const charScoringStats = { ...scoringStats }
    if (moldInfo) {
      const armorId = getArmorIdForMoldAndClass(resolvedId, classAbbrev)
      if (armorId == null) {
        fits.push({
          characterId: character.char_id || null,
          characterName: character.name,
          eligible: false,
          isUpgrade: false,
          reason: 'class_mismatch',
          scoreDelta: null,
          slotName: null,
          upgrade: null,
          currentItemName: null,
          candidateName: resolvedName,
        })
        continue
      }
      const armorStats = (itemStats || {})[String(armorId)] || (itemStats || {})[armorId]
      if (!armorStats) {
        fits.push({
          characterId: character.char_id || null,
          characterName: character.name,
          eligible: false,
          isUpgrade: false,
          reason: 'missing_item_stats',
          scoreDelta: null,
          slotName: null,
          upgrade: null,
          currentItemName: null,
          candidateName: resolvedName,
        })
        continue
      }
      charScoringStats[String(armorId)] = armorStats
      scoreItemId = armorId
    }

    const ctx = buildUpgradeContext(rankings, charScoringStats)
    const evalResult = evaluateItemUpgradeForCharacter(
      { class: className, inventory },
      scoreItemId,
      ctx,
    )
    if (!evalResult.eligible) {
      fits.push({
        characterId: character.char_id || null,
        characterName: character.name,
        eligible: false,
        isUpgrade: false,
        reason: evalResult.reason || 'ineligible',
        scoreDelta: null,
        slotName: null,
        upgrade: null,
        currentItemName: null,
        candidateName: resolvedName,
      })
      continue
    }
    const delta = Number(evalResult.scoreDelta)
    const slotLabel = evalResult.slotName || null
    fits.push({
      characterId: character.char_id || null,
      characterName: character.name,
      eligible: true,
      isUpgrade: Boolean(evalResult.isUpgrade),
      reason: evalResult.isUpgrade ? 'upgrade' : 'not_upgrade',
      scoreDelta: Number.isFinite(delta) ? delta : 0,
      slotId: evalResult.slotId ?? null,
      slotName: slotLabel,
      upgrade: formatUpgradeDelta(delta, slotLabel || undefined),
      currentItemName: evalResult.currentItemName || null,
      candidateName: resolvedName,
    })
  }

  fits.sort((a, b) => {
    const rank = (row) => {
      if (row.isUpgrade) return 0
      if (row.eligible) return 1
      return 2
    }
    const dr = rank(a) - rank(b)
    if (dr !== 0) return dr
    return (Number(b.scoreDelta) || 0) - (Number(a.scoreDelta) || 0)
  })

  return {
    ok: true,
    reason: null,
    itemId: resolvedId,
    itemName: resolvedName,
    fits,
  }
}

/**
 * Async entry: load Magelo + item stats as needed, cache by account/char.
 */
export async function getUpgradesForCharacter(character, options = {}) {
  const slotKey = Array.isArray(options.slotIds) ? options.slotIds.slice().sort().join(',') : ''
  const cacheKey = `${options.accountId || ''}:${character?.char_id || character?.name || ''}:${options.cacheToken || ''}:${slotKey}:${options.limit ?? 3}`
  if (upgradeCache.has(cacheKey)) return upgradeCache.get(cacheKey)

  const [rankingsLoaded, itemStatsObj, raidItemIds] = await Promise.all([
    options.rankings !== undefined
      ? Promise.resolve(
          options.rankings
            ? { ok: true, rankings: options.rankings }
            : { ok: false, error: 'missing_rankings' },
        )
      : loadClassRankings(options.rankingsUrl),
    options.itemStats
      ? Promise.resolve(options.itemStats)
      : ensureItemStatsLoaded().then(() => {
          // ensureItemStatsLoaded populates module cache; re-fetch object form
          return options.itemStats || fetch('/item_stats.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
        }),
    options.raidItemIds || collectRaidLootItemIds(),
    ensureElementalArmorLoaded(),
  ])

  if (!rankingsLoaded?.ok) {
    return {
      ok: false,
      reason: rankingsLoaded?.error || 'magelo_fetch_failed',
      suggestions: [],
      upgradeSlots: [],
    }
  }

  const result = computeCharacterUpgrades({
    character,
    rankings: rankingsLoaded.rankings,
    itemStats: itemStatsObj,
    raidItemIds,
    limit: options.limit ?? 3,
    slotIds: options.slotIds || null,
  })
  // Cache successful upgrade computations only; allow retry after missing Magelo
  if (result.ok) upgradeCache.set(cacheKey, result)
  return result
}
