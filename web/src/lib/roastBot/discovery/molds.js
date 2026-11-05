/**
 * Elemental / Timeless mold & pattern catalog for discovery NL.
 * Source: ele dkp armor molds.csv (28 DKP purchase molds).
 */

import { normAliasKey, resolveSlotAlias } from './aliases.js'
import { softMatchNames } from './fuzzy.js'

/** @typedef {{ id: string, name: string, slot: string, armor_type: string }} MoldEntry */

/** @type {MoldEntry[]} */
export const ELEMENTAL_MOLDS = Object.freeze([
  { id: '16362', name: 'Elemental Chain Coif Pattern', slot: 'head', armor_type: 'chain' },
  { id: '16363', name: 'Timeless Chain Tunic Pattern', slot: 'chest', armor_type: 'chain' },
  { id: '16364', name: 'Elemental Chain Sleeve Pattern', slot: 'arms', armor_type: 'chain' },
  { id: '16365', name: 'Elemental Chain Bracelet Pattern', slot: 'wrists', armor_type: 'chain' },
  { id: '16366', name: 'Elemental Chain Glove Pattern', slot: 'hands', armor_type: 'chain' },
  { id: '16367', name: 'Elemental Chain Pant Pattern', slot: 'legs', armor_type: 'chain' },
  { id: '16368', name: 'Elemental Chain Boot Pattern', slot: 'feet', armor_type: 'chain' },
  { id: '16369', name: 'Elemental Bracer Mold', slot: 'wrists', armor_type: 'plate' },
  { id: '16370', name: 'Elemental Boot Mold', slot: 'feet', armor_type: 'plate' },
  { id: '16371', name: 'Elemental Helm Mold', slot: 'head', armor_type: 'plate' },
  { id: '16372', name: 'Elemental Vambrace Mold', slot: 'arms', armor_type: 'plate' },
  { id: '16373', name: 'Elemental Greaves Mold', slot: 'legs', armor_type: 'plate' },
  { id: '16374', name: 'Elemental Gauntlet Mold', slot: 'hands', armor_type: 'plate' },
  { id: '16375', name: 'Timeless Breastplate Mold', slot: 'chest', armor_type: 'plate' },
  { id: '16376', name: 'Elemental Leather Helm Pattern', slot: 'head', armor_type: 'leather' },
  { id: '16377', name: 'Timeless Leather Tunic Pattern', slot: 'chest', armor_type: 'leather' },
  { id: '16378', name: 'Elemental Leather Sleeve Pattern', slot: 'arms', armor_type: 'leather' },
  { id: '16379', name: 'Elemental Leather Wrist Pattern', slot: 'wrists', armor_type: 'leather' },
  { id: '16380', name: 'Elemental Leather Glove Pattern', slot: 'hands', armor_type: 'leather' },
  { id: '16381', name: 'Elemental Leather Pant Pattern', slot: 'legs', armor_type: 'leather' },
  { id: '16382', name: 'Elemental Leather Boot Pattern', slot: 'feet', armor_type: 'leather' },
  { id: '16383', name: 'Elemental Silk Turban Pattern', slot: 'head', armor_type: 'silk' },
  { id: '16384', name: 'Timeless Silk Robe Pattern', slot: 'chest', armor_type: 'silk' },
  { id: '16385', name: 'Elemental Silk Sleeve Pattern', slot: 'arms', armor_type: 'silk' },
  { id: '16386', name: 'Elemental Silk Bracelet Pattern', slot: 'wrists', armor_type: 'silk' },
  { id: '16387', name: 'Elemental Silk Glove Pattern', slot: 'hands', armor_type: 'silk' },
  { id: '16388', name: 'Elemental Silk Pant Pattern', slot: 'legs', armor_type: 'silk' },
  { id: '16389', name: 'Elemental Silk Boot Pattern', slot: 'feet', armor_type: 'silk' },
])

/** EQ discovery slot → mold catalog slot */
const EQ_TO_MOLD_SLOT = {
  HEAD: 'head',
  CHEST: 'chest',
  ARMS: 'arms',
  LEGS: 'legs',
  WRIST: 'wrists',
  FEET: 'feet',
  HANDS: 'hands',
}

/** Extra mold-specific slot tokens (beyond SLOT_ALIASES). */
const MOLD_SLOT_TOKENS = {
  bp: 'chest',
  breastplate: 'chest',
  tunic: 'chest',
  robe: 'chest',
  vambrace: 'arms',
  sleeves: 'arms',
  sleeve: 'arms',
  greaves: 'legs',
  greave: 'legs',
  pant: 'legs',
  pants: 'legs',
  gauntlet: 'hands',
  gauntlets: 'hands',
  glove: 'hands',
  gloves: 'hands',
  coif: 'head',
  turban: 'head',
  helm: 'head',
  bracer: 'wrists',
  bracelet: 'wrists',
  wrist: 'wrists',
  boot: 'feet',
  boots: 'feet',
}

const ARMOR_TYPES = new Set(['plate', 'chain', 'leather', 'silk'])

const MOLD_CUE_RE = /\b(ele|elemental|timeless)\b|\b(mold|pattern)s?\b/

/**
 * @param {string} text
 * @returns {string|null} plate|chain|leather|silk
 */
export function resolveArmorType(text) {
  const key = normAliasKey(text)
  if (!key) return null
  for (const t of ARMOR_TYPES) {
    if (new RegExp(`\\b${t}\\b`).test(key)) return t
  }
  return null
}

/**
 * @param {string} text
 * @returns {string|null} mold slot key (head|chest|…)
 */
export function resolveMoldSlot(text) {
  const key = normAliasKey(text)
  if (!key) return null
  // Prefer longer mold-specific tokens first
  const entries = Object.entries(MOLD_SLOT_TOKENS).sort((a, b) => b[0].length - a[0].length)
  for (const [alias, slot] of entries) {
    if (new RegExp(`\\b${escapeRe(alias)}\\b`).test(key)) return slot
  }
  const eq = resolveSlotAlias(key)
  if (eq && EQ_TO_MOLD_SLOT[eq]) return EQ_TO_MOLD_SLOT[eq]
  return null
}

/**
 * True when the utterance looks like an elemental/timeless mold phrase.
 * @param {string} text
 */
export function looksLikeMoldPhrase(text) {
  const key = normAliasKey(text)
  if (!key) return false
  if (MOLD_CUE_RE.test(key)) return true
  const armor = resolveArmorType(key)
  const slot = resolveMoldSlot(key)
  return Boolean(armor && slot)
}

/**
 * Resolve colloquial mold phrasing to a single mold, a multi-name set, or null.
 * @param {string} text
 * @returns {{
 *   name?: string,
 *   itemId?: string|null,
 *   names?: Set<string>,
 *   ambiguous?: boolean,
 *   candidates?: Array<{ name: string }>,
 *   message?: string,
 * }|null}
 */
export function resolveMoldPhrase(text) {
  const key = normAliasKey(text)
  if (!key) return null

  // Exact / near-exact canonical name via includes of full mold name
  const exact = ELEMENTAL_MOLDS.find((m) => normAliasKey(m.name) === key)
  if (exact) return { name: exact.name, itemId: exact.id }

  const armor = resolveArmorType(key)
  const slot = resolveMoldSlot(key)
  const hasCue = MOLD_CUE_RE.test(key)

  // Guild shorthand without mold word: "plate bp", "silk arms"
  // Prefer type+slot when both present and the phrase is short (not a near-full name typo).
  if (armor && slot && key.split(/\s+/).length <= 3 && !/\b(elemental|timeless)\b/.test(key)) {
    const hit = ELEMENTAL_MOLDS.find((m) => m.armor_type === armor && m.slot === slot)
    if (hit) return { name: hit.name, itemId: hit.id }
  }

  // Near-canonical typos ("timless breastplate mold") before expanding to multi-sets
  if (/\b(mold|pattern)s?\b/.test(key) && key.split(/\s+/).length >= 3) {
    const soft = softMatchNames(
      key,
      ELEMENTAL_MOLDS.map((m) => ({ name: m.name, itemId: m.id })),
    )
    if (soft?.unique) {
      return {
        name: soft.unique.name,
        itemId: soft.unique.itemId != null ? String(soft.unique.itemId) : null,
        correctedFrom: String(text).trim(),
      }
    }
    if (soft?.ambiguous?.length) {
      return {
        ambiguous: true,
        spelling: true,
        candidates: soft.ambiguous.map((c) => ({ name: c.name })),
        message: `Did you mean ${soft.ambiguous
          .map((c) => c.name)
          .slice(0, 5)
          .join(', or ')}? Your spelling left a few possibilities.`,
      }
    }
  }

  if (armor && slot) {
    const hit = ELEMENTAL_MOLDS.find((m) => m.armor_type === armor && m.slot === slot)
    if (hit) return { name: hit.name, itemId: hit.id }
  }

  if (!hasCue && !(armor || slot)) return null
  // Need a mold/ele cue for broad (non type+slot) sets — avoid treating bare "arms" as molds
  if (!hasCue && !(armor && slot)) {
    // armor+slot already handled; armor-only or slot-only without cue → not molds
    if (!armor || !slot) return null
  }

  let filtered = ELEMENTAL_MOLDS.slice()
  if (armor) filtered = filtered.filter((m) => m.armor_type === armor)
  if (slot) filtered = filtered.filter((m) => m.slot === slot)

  // "timeless" without slot → chest molds only (all Timeless pieces are chest)
  if (/\btimeless\b/.test(key) && !slot) {
    filtered = filtered.filter((m) => m.name.toLowerCase().startsWith('timeless'))
  }

  if (filtered.length === 1) {
    return { name: filtered[0].name, itemId: filtered[0].id }
  }
  if (filtered.length > 1) {
    return {
      names: new Set(filtered.map((m) => m.name)),
    }
  }

  // Cue present but filters emptied — fall through
  if (hasCue && !armor && !slot) {
    return { names: new Set(ELEMENTAL_MOLDS.map((m) => m.name)) }
  }

  return null
}

/**
 * Compact phrase to keep as itemQuery during parse (preserves armor+slot tokens).
 * Near-full mold names (incl. typos) are kept intact for soft-match resolution.
 * @param {string} text
 * @returns {string|null}
 */
export function extractMoldItemQuery(text) {
  if (!looksLikeMoldPhrase(text)) return null
  const key = normAliasKey(text)
  const armor = resolveArmorType(key)
  const slot = resolveMoldSlot(key)
  const hasCue = MOLD_CUE_RE.test(key)
  const tokens = key.split(/\s+/).filter(Boolean)

  // Full / near-full names: "timeless breastplate mold", "timless breastplate mold"
  if (/\b(mold|pattern)s?\b/.test(key) && tokens.length >= 3) {
    const moldIdx = tokens.findIndex((t) => /^(mold|pattern)s?$/.test(t))
    if (moldIdx >= 0) {
      const stop = new Set([
        'the',
        'last',
        'time',
        'a',
        'an',
        'when',
        'whens',
        'did',
        'what',
        'about',
        'how',
        'many',
        'times',
        'dropped',
        'drop',
        'who',
        'got',
        'won',
      ])
      // Canonical names are 3–4 tokens; take a short window ending at mold/pattern
      let start = Math.max(0, moldIdx - 3)
      while (start < moldIdx && stop.has(tokens[start])) start += 1
      return tokens.slice(start, moldIdx + 1).join(' ')
    }
  }

  if (armor && slot) {
    // Prefer stable short form for resolve
    const slotWord =
      slot === 'chest' && /\bbp\b/.test(key)
        ? 'bp'
        : slot === 'arms'
          ? 'arms'
          : slot
    return `${armor} ${slotWord}`
  }
  if (hasCue && armor && !slot) return `${armor} mold`
  if (hasCue && slot && !armor) {
    const cue = /\btimeless\b/.test(key) ? 'timeless' : 'ele'
    return `${cue} ${slot}`
  }
  if (hasCue) {
    if (/\btimeless\b/.test(key)) return 'timeless mold'
    return 'ele mold'
  }
  return null
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
