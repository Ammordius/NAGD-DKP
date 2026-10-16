/** Raid Items (/mobs) session view: which groups the user opened or closed, and show-more counts. */

export const MOB_LOOT_GROUPS_KEY = '/mobs:groups'
export const SCROLL_ANCHOR_STORAGE_KEY = 'pageState:/mobs:scrollAnchor'
export const ITEMS_PER_PAGE = 20
export const MAX_ITEMS_SHOWN = 500
export const SCROLL_SAVE_DELAY_MS = 150
const SCROLL_ANCHOR_SLACK_PX = 4

export const EMPTY_GROUP_STATE = Object.freeze({
  expanded: Object.freeze({}),
  itemsShown: Object.freeze({}),
})

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Keep boolean open/closed flags and integer show-more counts.
 * Absent expanded keys mean "no user choice". Explicit false wins over auto-open.
 * @param {unknown} raw
 */
export function normalizeGroupState(raw) {
  const src = isPlainObject(raw) ? raw : {}
  const expandedIn = isPlainObject(src.expanded) ? src.expanded : {}
  const shownIn = isPlainObject(src.itemsShown) ? src.itemsShown : {}
  const expanded = {}
  for (const [key, value] of Object.entries(expandedIn)) {
    if (!key || typeof value !== 'boolean') continue
    expanded[key] = value
  }
  const itemsShown = {}
  for (const [key, value] of Object.entries(shownIn)) {
    if (!key || typeof value !== 'number' || !Number.isInteger(value)) continue
    if (value < ITEMS_PER_PAGE || value > MAX_ITEMS_SHOWN) continue
    itemsShown[key] = value
  }
  return { expanded, itemsShown }
}

/**
 * @param {{ expanded?: Record<string, boolean> } | null | undefined} groups
 * @param {string} key
 * @param {{ filtersActive?: boolean, matchCount?: number }} options
 */
export function isMobOpen(groups, key, { filtersActive = false, matchCount = 0 } = {}) {
  const flag = groups?.expanded?.[key]
  if (flag === false) return false
  if (flag === true) return true
  return !!(filtersActive && matchCount > 0 && matchCount < 3)
}

/**
 * Record a user toggle. `currentlyOpen` includes derived auto-open, so closing
 * an auto-opened group stores explicit false.
 * @param {unknown} state
 * @param {string} key
 * @param {boolean} currentlyOpen
 */
export function toggleMobGroup(state, key, currentlyOpen) {
  const base = normalizeGroupState(state)
  if (!key || typeof key !== 'string') return base
  return {
    expanded: { ...base.expanded, [key]: !currentlyOpen },
    itemsShown: base.itemsShown,
  }
}

/**
 * @param {unknown} state
 * @param {string} key
 */
export function revealMoreItems(state, key) {
  const base = normalizeGroupState(state)
  if (!key || typeof key !== 'string') return base
  const current = base.itemsShown[key] ?? ITEMS_PER_PAGE
  const next = Math.min(MAX_ITEMS_SHOWN, current + ITEMS_PER_PAGE)
  if (next === current) return base
  return {
    expanded: base.expanded,
    itemsShown: { ...base.itemsShown, [key]: next },
  }
}

/**
 * @param {{ itemsShown?: Record<string, number> } | null | undefined} state
 * @param {string} key
 */
export function itemsShownLimit(state, key) {
  const value = state?.itemsShown?.[key]
  if (typeof value === 'number' && Number.isInteger(value) && value >= ITEMS_PER_PAGE && value <= MAX_ITEMS_SHOWN) {
    return value
  }
  return ITEMS_PER_PAGE
}

/**
 * Stable item marker. Prefer the loot row's item id, otherwise its name.
 * @param {{ item_id?: unknown, name?: unknown } | null | undefined} item
 */
export function itemAnchorKey(item) {
  if (!item || typeof item !== 'object') return null
  if (item.item_id != null && item.item_id !== '') return String(item.item_id)
  const name = typeof item.name === 'string' ? item.name.trim() : ''
  return name || null
}

/**
 * Last marker at or above the viewport top, in document order.
 * Entries need `{ mobKey, itemKey, top }` where `top` is viewport-relative.
 * Returns `{ mobKey, itemKey }` or null when the viewport is still above the list.
 * @param {Array<{ mobKey?: string, itemKey?: string | null, top?: number }> | null | undefined} entries
 * @param {number} [viewportTop]
 */
export function chooseScrollAnchor(entries, viewportTop = 0) {
  if (!Array.isArray(entries) || entries.length === 0) return null
  const limit = viewportTop + SCROLL_ANCHOR_SLACK_PX
  let chosen = null
  for (const entry of entries) {
    if (!entry || typeof entry.mobKey !== 'string' || !entry.mobKey) continue
    if (typeof entry.top !== 'number' || !Number.isFinite(entry.top)) continue
    if (entry.top <= limit) chosen = entry
  }
  if (!chosen) return null
  const itemKey = typeof chosen.itemKey === 'string' && chosen.itemKey ? chosen.itemKey : null
  return { mobKey: chosen.mobKey, itemKey }
}

/**
 * @param {unknown} raw
 * @returns {{ mobKey: string, itemKey: string | null } | null}
 */
export function normalizeScrollAnchor(raw) {
  if (!isPlainObject(raw) || typeof raw.mobKey !== 'string' || !raw.mobKey) return null
  const itemKey = typeof raw.itemKey === 'string' && raw.itemKey ? raw.itemKey : null
  return { mobKey: raw.mobKey, itemKey }
}

/**
 * @param {{ getItem?: (key: string) => string | null } | null | undefined} storage
 */
export function readScrollAnchor(storage) {
  if (!storage || typeof storage.getItem !== 'function') return null
  try {
    const raw = storage.getItem(SCROLL_ANCHOR_STORAGE_KEY)
    if (raw == null) return null
    return normalizeScrollAnchor(JSON.parse(raw))
  } catch {
    return null
  }
}

/**
 * @param {{ setItem?: (key: string, value: string) => void } | null | undefined} storage
 * @param {{ mobKey?: string, itemKey?: string | null } | null | undefined} anchor
 */
export function writeScrollAnchor(storage, anchor) {
  if (!storage || typeof storage.setItem !== 'function') return
  const normalized = normalizeScrollAnchor(anchor)
  if (!normalized) return
  try {
    storage.setItem(SCROLL_ANCHOR_STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // ignore quota or private mode
  }
}

/**
 * @param {{ removeItem?: (key: string) => void } | null | undefined} storage
 */
export function clearScrollAnchor(storage) {
  if (!storage || typeof storage.removeItem !== 'function') return
  try {
    storage.removeItem(SCROLL_ANCHOR_STORAGE_KEY)
  } catch {
    // ignore
  }
}

/**
 * Prefer the item row for this mob. Fall back to the mob header row.
 * @param {{ querySelectorAll?: (selector: string) => Iterable<{ getAttribute: (name: string) => string | null }> } | null | undefined} root
 * @param {{ mobKey?: string, itemKey?: string | null } | null | undefined} anchor
 */
export function findScrollAnchorElement(root, anchor) {
  if (!root || typeof root.querySelectorAll !== 'function') return null
  const normalized = normalizeScrollAnchor(anchor)
  if (!normalized) return null
  let mobRow = null
  for (const node of root.querySelectorAll('[data-mob-key]')) {
    if (!node || typeof node.getAttribute !== 'function') continue
    if (node.getAttribute('data-mob-key') !== normalized.mobKey) continue
    const itemKey = node.getAttribute('data-item-key')
    if (normalized.itemKey && itemKey === normalized.itemKey) return node
    if (!itemKey && !mobRow) mobRow = node
  }
  return mobRow
}

/**
 * `wait` until loot, stats, zones, armor, and the anchor node are ready.
 * `restore` once those gates pass. `cancel` after user input or a filter change.
 * `skip` when there is nothing safe to scroll to.
 * @param {Record<string, unknown> | null | undefined} state
 * @returns {'wait' | 'restore' | 'cancel' | 'skip'}
 */
export function scrollRestoreDecision(state) {
  const ready = state && typeof state === 'object' ? state : {}
  if (ready.userInteracted || ready.filtersChangedByUser) return 'cancel'
  if (!ready.dataReady || !ready.statsReady || !ready.zonesReady || !ready.armorReady) return 'wait'
  if (!normalizeScrollAnchor(ready.anchor)) return 'skip'
  if (ready.anchorInList === false) return 'skip'
  if (!ready.anchorInDom) return 'wait'
  return 'restore'
}
