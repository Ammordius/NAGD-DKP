/**
 * Formatting helpers for roast bot responses (no HTML interpolation).
 */

import { SLOT_NAMES_FOR_UI } from '../mageloUpgradeEngine.js'

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
 * @param {number|null|undefined} delta
 * @param {string} [slotName]
 */
export function formatUpgradeDelta(delta, slotName) {
  if (delta == null || !Number.isFinite(Number(delta))) return null
  const d = Math.round(Number(delta) * 10) / 10
  const slot = slotName ? ` ${slotName}` : ''
  const sign = d > 0 ? '+' : ''
  return `${sign}${d} score${slot}`
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
export function matchItemName(hint, catalog) {
  const q = String(hint || '').trim().toLowerCase()
  if (!q || q.length < 2) return null
  const items = catalog || []
  const exact = items.filter((i) => String(i.name || '').trim().toLowerCase() === q)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return { ambiguous: true, candidates: exact }

  const starts = items.filter((i) => String(i.name || '').trim().toLowerCase().startsWith(q))
  if (starts.length === 1) return starts[0]

  const includes = items.filter((i) => {
    const n = String(i.name || '').trim().toLowerCase()
    return n.includes(q) || q.includes(n)
  })
  if (includes.length === 1) return includes[0]
  if (includes.length > 1 && includes.length <= 5) return { ambiguous: true, candidates: includes }
  return null
}

/**
 * Build link payload for UI (React renders Link — never HTML strings).
 * @param {{ itemName?: string, itemId?: string|number, characterName?: string }} refs
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
  return links
}

/**
 * Suggestion chips based on conversation state.
 * @param {{ hasAccount: boolean, selectedCharacterId?: string|null, lastItemName?: string|null, characters?: object[] }} state
 */
export function suggestionChips(state = {}) {
  if (!state.hasAccount) {
    return [
      'Roast me anyway',
      'How does DKP work?',
      'What can you do?',
    ]
  }
  const chips = [
    'Roast my DKP spending',
    'What should I buy?',
    'What was my worst purchase?',
    'Roast my characters',
    "Why am I broke?",
    "How's my raiding?",
  ]
  if (state.lastItemName) {
    chips.unshift(`How much for ${state.lastItemName}?`)
    chips.unshift(`Where does ${state.lastItemName} drop?`)
  }
  if ((state.characters || []).length > 1) {
    const other = state.characters.find((c) => c.char_id !== state.selectedCharacterId)
    if (other?.name) chips.push(`What about my ${other.class_name || other.name}?`)
  }
  return chips.slice(0, 6)
}
