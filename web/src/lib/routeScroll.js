/** Per-route scroll anchors. One route's saved position is never applied to another. */

import {
  isPlainObject,
  migrateSessionKeyToUserLocal,
  pageStateFullKey,
  readPageState,
  writePageState,
} from './pageState.js'

export const SCROLL_SAVE_DELAY_MS = 150
const SCROLL_ANCHOR_SLACK_PX = 4
const SCROLL_PREFIX = 'pageState:scroll:'
export const MOBS_SCROLL_ROUTE = '/mobs'
const MOBS_SCROLL_LOGICAL = 'scroll:/mobs'
const MOBS_SCROLL_VERSION = 1

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
  const offset = typeof raw.offset === 'number' && Number.isFinite(raw.offset) ? raw.offset : null
  const savedAt = typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : null
  if (!anchorId && top == null) return null
  const record = { anchorId: anchorId || null, itemId, top }
  if (offset != null) record.offset = offset
  if (savedAt != null) record.savedAt = savedAt
  return record
}

/** @returns {{ anchorId: string | null, itemId: string | null, top: number | null } | null} */
export function normalizeScrollRecord(raw) {
  return anchorFields(raw)
}

/**
 * Last marker at or above the viewport top, in document order.
 * Entries may use `{ anchorId, itemId, top }` or the Raid Items `{ mobKey, itemKey, top }`.
 * @returns {{ anchorId: string, itemId: string | null, offset: number } | null}
 */
export function chooseRouteScrollAnchor(entries, viewportTop = 0) {
  if (!Array.isArray(entries) || entries.length === 0) return null
  const limit = viewportTop + SCROLL_ANCHOR_SLACK_PX
  let chosen = null
  for (const entry of entries) {
    const fields = anchorFields(entry)
    if (!fields?.anchorId) continue
    if (typeof entry?.top !== 'number' || !Number.isFinite(entry.top)) continue
    if (entry.top <= limit) chosen = { ...fields, offset: entry.top }
  }
  if (!chosen?.anchorId) return null
  return { anchorId: chosen.anchorId, itemId: chosen.itemId, offset: chosen.offset }
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

function scrollWriteIsStale(existing, incoming) {
  return typeof existing?.savedAt === 'number'
    && typeof incoming?.savedAt === 'number'
    && incoming.savedAt < existing.savedAt
}

export function writeScrollRecord(storage, routeKey, record) {
  if (!storage || typeof storage.setItem !== 'function' || !routeKey) return false
  const normalized = normalizeScrollRecord(record)
  if (!normalized) return false
  if (scrollWriteIsStale(readScrollRecord(storage, routeKey), normalized)) return false
  try {
    storage.setItem(scrollStorageKey(routeKey), JSON.stringify(normalized))
    return true
  } catch {
    // ignore quota or private mode
    return false
  }
}

/**
 * Persist a snapshot taken while this route's DOM was current.
 * `measured: false` leaves the stored record alone, so a later page at scroll 0 cannot wipe it.
 * A real measurement with no anchor and `top <= 0` clears the route.
 * @returns {'skip' | 'stale' | 'write' | 'clear'}
 */
export function commitScrollSnapshot(storage, snapshot) {
  if (!snapshot?.measured || !snapshot.routeKey) return 'skip'
  const existing = readScrollRecord(storage, snapshot.routeKey)
  const incoming = normalizeScrollRecord(snapshot)
  if (scrollWriteIsStale(existing, incoming || { savedAt: snapshot.savedAt })) return 'stale'
  const top = typeof snapshot.top === 'number' && Number.isFinite(snapshot.top) ? snapshot.top : 0
  if (!snapshot.anchorId && top <= 0) {
    clearScrollRecord(storage, snapshot.routeKey)
    return 'clear'
  }
  return writeScrollRecord(storage, snapshot.routeKey, snapshot) ? 'write' : 'stale'
}

/** True when the visible scroll-route marker still belongs to the route being measured. */
export function scrollMeasurementAllowed(markerRoute, measuringRoute) {
  if (!markerRoute) return true
  return markerRoute === measuringRoute
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

/** The item row only. Does not fall back to the section header. */
export function findExactScrollItem(root, record) {
  if (!root || typeof root.querySelectorAll !== 'function') return null
  const normalized = normalizeScrollRecord(record)
  if (!normalized?.anchorId || !normalized.itemId) return null
  for (const node of root.querySelectorAll('[data-scroll-anchor]')) {
    if (!node || typeof node.getAttribute !== 'function') continue
    if (node.getAttribute('data-scroll-anchor') !== normalized.anchorId) continue
    if (node.getAttribute('data-scroll-item') === normalized.itemId) return node
  }
  return null
}

function mobsScrollStores(stores) {
  return {
    session: stores?.session || null,
    local: stores?.local || null,
  }
}

/** Raid Items scroll is per signed-in user in localStorage. Other routes stay in sessionStorage. */
export function readRouteScroll(stores, routeKey, userId) {
  if (routeKey === MOBS_SCROLL_ROUTE) {
    const { session, local } = mobsScrollStores(stores)
    if (!userId || !local) return null
    migrateSessionKeyToUserLocal(session, local, MOBS_SCROLL_LOGICAL, userId, { version: MOBS_SCROLL_VERSION })
    return readPageState(local, MOBS_SCROLL_LOGICAL, null, normalizeScrollRecord, {
      userId,
      version: MOBS_SCROLL_VERSION,
    })
  }
  return readScrollRecord(stores?.session, routeKey)
}

export function clearRouteScroll(stores, routeKey, userId) {
  if (routeKey === MOBS_SCROLL_ROUTE) {
    const local = stores?.local
    if (!userId || !local || typeof local.removeItem !== 'function') return
    try {
      local.removeItem(pageStateFullKey(MOBS_SCROLL_LOGICAL, { userId }))
    } catch {
      // ignore
    }
    return
  }
  clearScrollRecord(stores?.session, routeKey)
}

/**
 * @returns {'skip' | 'stale' | 'write' | 'clear'}
 */
export function commitRouteScroll(stores, snapshot, userId) {
  if (!snapshot?.measured || !snapshot.routeKey) return 'skip'
  if (snapshot.routeKey !== MOBS_SCROLL_ROUTE) return commitScrollSnapshot(stores?.session, snapshot)
  const { session, local } = mobsScrollStores(stores)
  if (!userId || !local) return 'skip'
  migrateSessionKeyToUserLocal(session, local, MOBS_SCROLL_LOGICAL, userId, { version: MOBS_SCROLL_VERSION })
  const existing = readPageState(local, MOBS_SCROLL_LOGICAL, null, normalizeScrollRecord, {
    userId,
    version: MOBS_SCROLL_VERSION,
  })
  const incomingSavedAt = typeof snapshot.savedAt === 'number' ? snapshot.savedAt : null
  if (scrollWriteIsStale(existing, { savedAt: incomingSavedAt })) return 'stale'
  const top = typeof snapshot.top === 'number' && Number.isFinite(snapshot.top) ? snapshot.top : 0
  if (!snapshot.anchorId && top <= 0) {
    clearRouteScroll(stores, snapshot.routeKey, userId)
    return 'clear'
  }
  const normalized = normalizeScrollRecord(snapshot)
  if (!normalized) return 'skip'
  writePageState(local, MOBS_SCROLL_LOGICAL, normalized, { userId, version: MOBS_SCROLL_VERSION })
  return 'write'
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
