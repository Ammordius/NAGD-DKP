/**
 * Formatting helpers for roast bot responses (no HTML interpolation).
 */

import { SLOT_NAMES_FOR_UI } from '../mageloUpgradeEngine.js'
import { INTENTS } from './intents.js'

/**
 * @param {number|string|null|undefined} n
 */
export function formatDkp(n) {
  if (n == null || n === '') return null
  const num = Number(n)
  if (!Number.isFinite(num)) return null
  if (Number.isInteger(num)) return String(num)
  return (Math.round(num * 10) / 10).toFixed(1).replace(/\.0$/, '')
}

/**
 * Absolute magnitude for display. ≥2 decimal places normally; 3 sig figs when |n| < 0.01
 * so tiny upgrades never round to a zero label.
 * @param {number} abs
 * @returns {string}
 */
function formatDeltaMagnitude(abs) {
  if (abs === 0) return '0.00'
  if (abs < 0.01) return Number(abs.toPrecision(3)).toString()
  return abs.toFixed(2)
}

/**
 * @param {number|null|undefined} delta
 * @param {string} [slotName]
 */
export function formatUpgradeDelta(delta, slotName) {
  if (delta == null || !Number.isFinite(Number(delta))) return null
  const raw = Number(delta)
  const slot = slotName ? ` ${slotName}` : ''
  if (raw === 0) return `0.00 score${slot}`
  const abs = Math.abs(raw)
  let mag = formatDeltaMagnitude(abs)
  // Guard: never label a strictly non-zero delta as zero
  if (Number(mag) === 0) mag = Number(abs.toPrecision(3)).toString()
  const sign = raw > 0 ? '+' : '-'
  return `${sign}${mag} score${slot}`
}

/**
 * @param {number|string} slotId
 */
export function slotName(slotId) {
  const id = Number(slotId)
  return SLOT_NAMES_FOR_UI[id] || (slotId != null ? `Slot ${slotId}` : null)
}

/**
 * Conservative item name match against a catalog.
 * @param {string} hint
 * @param {Array<{ id?: string|number, name: string, itemId?: string|number }>} catalog
 */
function preferCatalogEntry(entries) {
  if (!entries?.length) return null
  const withId = entries.find((i) => i.itemId != null || i.id != null)
  return withId || entries[0]
}

/** Collapse same display name (catalog + purchase duplicates) into one entry each. */
function uniqueByItemName(items) {
  const byName = new Map()
  for (const i of items || []) {
    const key = String(i.name || '').trim().toLowerCase()
    if (!key) continue
    const prev = byName.get(key)
    if (!prev || (prev.itemId == null && prev.id == null && (i.itemId != null || i.id != null))) {
      byName.set(key, i)
    }
  }
  return [...byName.values()]
}

export function matchItemName(hint, catalog) {
  const q = String(hint || '').trim().toLowerCase()
  if (!q || q.length < 2) return null
  const items = uniqueByItemName(catalog || [])
  const exact = items.filter((i) => String(i.name || '').trim().toLowerCase() === q)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) {
    // Same name after normalize should already be unique; different casing/id variants → pick one
    const sameName = exact.every(
      (i) => String(i.name || '').trim().toLowerCase() === String(exact[0].name || '').trim().toLowerCase(),
    )
    if (sameName) return preferCatalogEntry(exact)
    return { ambiguous: true, candidates: exact }
  }

  const starts = items.filter((i) => String(i.name || '').trim().toLowerCase().startsWith(q))
  if (starts.length === 1) return starts[0]

  const includes = items.filter((i) => {
    const n = String(i.name || '').trim().toLowerCase()
    return n.includes(q) || q.includes(n)
  })
  if (includes.length === 1) return includes[0]
  if (includes.length > 1 && includes.length <= 5) {
    const names = new Set(includes.map((i) => String(i.name || '').trim().toLowerCase()))
    if (names.size === 1) return preferCatalogEntry(includes)
    return { ambiguous: true, candidates: includes }
  }
  return null
}

/** Footer link to claim / browse game accounts. */
export const GAME_ACCOUNTS_LINK = {
  type: 'nav',
  label: 'Game Accounts',
  to: '/accounts',
}

/**
 * Example questions shown after "What can you ask?" (capabilities).
 * Keep in sync with CAPABILITIES_FACT_TEXT themes.
 */
export const CAPABILITIES_EXAMPLE_CHIPS = [
  'Roast my DKP spending',
  'Why am I broke?',
  'What is my DKP balance?',
  'What should I buy?',
  'What dropped off Quarm?',
  'Who got the last plate bp?',
]

/**
 * Authored capabilities copy — themed examples, not a dense paragraph.
 */
export const CAPABILITIES_FACT_TEXT = [
  'Ask about your DKP sins, guild loot, or who owns a toon. Examples:',
  'Roast / DKP — Roast my DKP spending · Why am I broke? · What is my DKP balance?',
  'Gear — What should I buy? · Is this a well geared enchanter?',
  'Loot intel — What dropped off Quarm? · Who got the last plate bp? · Who is Tandiyen?',
  'I will not invent numbers or accuse individual characters of skipping raids.',
].join('\n')

/**
 * Build link payload for UI (React renders Link — never HTML strings).
 * @param {{
 *   itemName?: string,
 *   itemId?: string|number,
 *   characterName?: string,
 *   raidId?: string|number,
 *   raidName?: string,
 *   accountId?: string|number,
 *   accountName?: string,
 * }} refs
 */
export function buildLinks(refs = {}) {
  const links = []
  if (refs.itemName) {
    links.push({
      type: 'item',
      label: refs.itemName,
      to: `/items/${encodeURIComponent(refs.itemName)}`,
      itemId: refs.itemId ?? null,
    })
  }
  if (refs.characterName) {
    links.push({
      type: 'character',
      label: refs.characterName,
      to: `/characters/${encodeURIComponent(refs.characterName)}`,
    })
  }
  if (refs.raidId != null && String(refs.raidId).trim() !== '') {
    const id = String(refs.raidId).trim()
    links.push({
      type: 'raid',
      label: refs.raidName || `Raid ${id}`,
      to: `/raids/${encodeURIComponent(id)}`,
      raidId: id,
    })
  }
  if (refs.accountId != null && String(refs.accountId).trim() !== '') {
    const id = String(refs.accountId).trim()
    links.push({
      type: 'account',
      label: refs.accountName || `Account ${id}`,
      to: `/accounts/${encodeURIComponent(id)}`,
      accountId: id,
    })
  }
  return links
}

/**
 * Suggestion chips — only actions with handlers. Reflect pending clarification.
 * @param {{
 *   hasAccount: boolean,
 *   selectedCharacterId?: string|null,
 *   lastItemName?: string|null,
 *   characters?: object[],
 *   pendingSlots?: string[],
 *   pendingIntent?: string|null,
 *   lastIntent?: string|null,
 *   lastUpgradeSlots?: object[],
 * }} state
 */
export function suggestionChips(state = {}) {
  if (state.pendingSlots?.includes('character')) {
    const names = (state.characters || []).map((c) => c.name).filter(Boolean).slice(0, 4)
    return names.length ? names : ['What can you ask?']
  }
  if (state.pendingSlots?.includes('item') && state.lastItemName) {
    return [`How much for ${state.lastItemName}?`, `Where does ${state.lastItemName} drop?`]
  }

  if (!state.hasAccount) {
    return [
      'Roast me anyway',
      'How does DKP work?',
      'What can you ask?',
    ]
  }

  // After capabilities / help, surface the themed example questions.
  if (state.lastIntent === 'capabilities') {
    return CAPABILITIES_EXAMPLE_CHIPS.slice(0, 6)
  }

  const chips = [
    'What can you ask?',
    'Roast my DKP spending',
    'What should I buy?',
    'What dropped off Quarm?',
    'What was my worst purchase?',
    "Why am I broke?",
  ]
  if (state.lastItemName) {
    chips.unshift(`How much for ${state.lastItemName}?`)
    chips.unshift(`Where does ${state.lastItemName} drop?`)
  }
  if ((state.characters || []).length > 1) {
    const other = state.characters.find((c) => c.char_id !== state.selectedCharacterId)
    if (other?.name) chips.push(`Is this a well geared ${other.class_name || other.name}?`)
  }

  // After an upgrades answer, surface slots that still have verified upgrades.
  if (
    state.lastIntent === 'upgrades' &&
    Array.isArray(state.lastUpgradeSlots) &&
    state.lastUpgradeSlots.length
  ) {
    const seen = new Set()
    const slotChips = []
    const ordered = [...state.lastUpgradeSlots].sort(
      (a, b) => (b.bestDelta || 0) - (a.bestDelta || 0),
    )
    for (const slot of ordered) {
      const label = slot.chipLabel || slot.slotLabel
      if (!label) continue
      const key = String(label).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      slotChips.push(`What about ${label}?`)
      if (slotChips.length >= 4) break
    }
    if (slotChips.length) {
      return [...slotChips, ...chips].slice(0, 6)
    }
  }

  return chips.slice(0, 6)
}

export { INTENTS }
