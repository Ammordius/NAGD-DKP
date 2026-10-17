/** Per-route scroll anchors. One route's saved position is never applied to another. */

import { isPlainObject } from './pageState.js'

export const SCROLL_SAVE_DELAY_MS = 150
const SCROLL_ANCHOR_SLACK_PX = 4
const SCROLL_PREFIX = 'pageState:scroll:'

export function scrollRouteKey(pathname, search = '') {
  const path = pathname || '/'
  const raw = search.startsWith('?') ? search.slice(1) : search
  const params = new URLSearchParams(raw)
  const tab = params.get('tab')
  if (tab && (path === '/profile' || path.startsWith('/accounts/'))) {
    return `${path}?tab=${tab}`
  }
  return path
}

export function scrollStorageKey(routeKey) {
  return SCROLL_PREFIX + routeKey
}

export function routesShareScroll(left, right) {
  return scrollRouteKey(left.pathname, left.search) === scrollRouteKey(right.pathname, right.search)
}

function anchorFields(raw) {
  if (!isPlainObject(raw)) return null
  const anchorId = typeof raw.anchorId === 'string' && raw.anchorId
    ? raw.anchorId
    : (typeof raw.mobKey === 'string' && raw.mobKey ? raw.mobKey : '')
  const itemRaw = raw.itemId != null ? raw.itemId : raw.itemKey
  const itemId = typeof itemRaw === 'string' && itemRaw ? itemRaw : null
  const top = typeof raw.top === 'number' && Number.isFinite(raw.top) ? raw.top : null
  if (!anchorId && top == null) return null
  return { anchorId: anchorId || null, itemId, top }
}

/** @returns {{ anchorId: string | null, itemId: string | null, top: number | null } | null} */
export function normalizeScrollRecord(raw) {
  return anchorFields(raw)
}

/**
 * Last marker at or above the viewport top, in document order.
 * Entries may use `{ anchorId, itemId, top }` or the Raid Items `{ mobKey, itemKey, top }`.
 * @returns {{ anchorId: string, itemId: string | null } | null}
 */
export function chooseRouteScrollAnchor(entries, viewportTop = 0) {
  if (!Array.isArray(entries) || entries.length === 0) return null
  const limit = viewportTop + SCROLL_ANCHOR_SLACK_PX
  let chosen = null
  for (const entry of entries) {
    const fields = anchorFields(entry)
    if (!fields?.anchorId) continue
    if (typeof entry?.top !== 'number' || !Number.isFinite(entry.top)) continue
    if (entry.top <= limit) chosen = fields
  }
  if (!chosen?.anchorId) return null
  return { anchorId: chosen.anchorId, itemId: chosen.itemId }
}

export function readScrollRecord(storage, routeKey) {
  if (!storage || typeof storage.getItem !== 'function' || !routeKey) return null
  try {
    const raw = storage.getItem(scrollStorageKey(routeKey))
    if (raw == null) return null
    return normalizeScrollRecord(JSON.parse(raw))
  } catch {
    return null
  }
}

export function writeScrollRecord(storage, routeKey, record) {
  if (!storage || typeof storage.setItem !== 'function' || !routeKey) return
  const normalized = normalizeScrollRecord(record)
  if (!normalized) return
  try {
    storage.setItem(scrollStorageKey(routeKey), JSON.stringify(normalized))
  } catch {
    // ignore quota or private mode
  }
}

export function clearScrollRecord(storage, routeKey) {
  if (!storage || typeof storage.removeItem !== 'function' || !routeKey) return
  try {
    storage.removeItem(scrollStorageKey(routeKey))
  } catch {
    // ignore
  }
}

/**
 * Prefer the item row. Fall back to the anchor row with no item id.
 * Nodes expose `data-scroll-anchor` and optional `data-scroll-item`.
 */
export function findRouteScrollElement(root, record) {
  if (!root || typeof root.querySelectorAll !== 'function') return null
  const normalized = normalizeScrollRecord(record)
  if (!normalized?.anchorId) return null
  let fallback = null
  for (const node of root.querySelectorAll('[data-scroll-anchor]')) {
    if (!node || typeof node.getAttribute !== 'function') continue
    if (node.getAttribute('data-scroll-anchor') !== normalized.anchorId) continue
    const itemId = node.getAttribute('data-scroll-item')
    if (normalized.itemId && itemId === normalized.itemId) return node
    if (!itemId && !fallback) fallback = node
  }
  return fallback
}

/**
 * `wait` until content and the anchor node exist.
 * `restore` scrolls to the anchor element.
 * `pixel` scrolls to a saved offset (virtualized lists).
 * `top` clears carryover from the previous route.
 * `cancel` after user input, a filter change, or a hash deep link.
 * `skip` when there is nothing safe to scroll to.
 * @returns {'wait' | 'restore' | 'pixel' | 'top' | 'cancel' | 'skip'}
 */
export function decideRouteScroll(state) {
  const ready = state && typeof state === 'object' ? state : {}
  if (ready.userInteracted || ready.filtersChangedByUser || ready.hashPresent) return 'cancel'
  const contentReady = Object.prototype.hasOwnProperty.call(ready, 'contentReady')
    ? !!ready.contentReady
    : !!(ready.dataReady && ready.statsReady && ready.zonesReady && ready.armorReady)
  if (!contentReady) return 'wait'
  if (ready.preferPixel && typeof ready.pixel === 'number' && Number.isFinite(ready.pixel)) return 'pixel'
  const anchor = normalizeScrollRecord(ready.anchor)
  const anchorId = anchor?.anchorId || null
  if (anchorId && ready.anchorInList === false) return ready.missingAnchor === 'top' ? 'top' : 'skip'
  if (!anchorId) {
    if (typeof ready.pixel === 'number' && Number.isFinite(ready.pixel)) return 'pixel'
    return ready.emptyAnchor === 'top' ? 'top' : 'skip'
  }
  if (!ready.anchorInDom) {
    if (ready.missingAnchor === 'top') return 'top'
    return 'wait'
  }
  return 'restore'
}

/** Hash deep links win over a saved anchor. */
export function hashBlocksScrollRestore(hash) {
  return typeof hash === 'string' && hash.length > 1
}
