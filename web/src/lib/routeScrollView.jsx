import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { browserStorage } from './pageState.js'
import { PageStateUserContext } from './pageStateUser'
import {
  SCROLL_SAVE_DELAY_MS,
  chooseRouteScrollAnchor,
  commitRouteScroll,
  clearRouteScroll,
  decideRouteScroll,
  findExactScrollItem,
  findRouteScrollElement,
  hashBlocksScrollRestore,
  readRouteScroll,
  scrollMeasurementAllowed,
  scrollRouteKey,
} from './routeScroll'

const ScrollContext = createContext(null)

function readOffset(container) {
  if (container) return container.scrollTop
  return window.scrollY || document.documentElement?.scrollTop || 0
}

function writeOffset(container, top) {
  if (container) {
    container.scrollTop = top
    return
  }
  window.scrollTo(0, top)
}

function scrollStores() {
  return { session: browserStorage('session'), local: browserStorage('local') }
}

function applyAnchorScroll(node, offset, container) {
  if (!node) return
  if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'start' })
  if (typeof offset !== 'number' || !Number.isFinite(offset)) return
  if (typeof node.getBoundingClientRect !== 'function') return
  const origin = container && typeof container.getBoundingClientRect === 'function'
    ? container.getBoundingClientRect().top
    : 0
  const delta = (node.getBoundingClientRect().top - origin) - offset
  if (Math.abs(delta) < 1) return
  if (container) container.scrollTop += delta
  else window.scrollBy(0, delta)
}

function measureSnapshot(routeKey, current) {
  if (typeof document === 'undefined') return null
  const marker = document.querySelector?.('[data-scroll-route]')
  const markerRoute = marker && typeof marker.getAttribute === 'function'
    ? marker.getAttribute('data-scroll-route')
    : null
  if (!scrollMeasurementAllowed(markerRoute, routeKey)) return null
  const container = current.container
  const root = container || document
  const origin = container && typeof container.getBoundingClientRect === 'function'
    ? container.getBoundingClientRect().top
    : 0
  const entries = []
  if (root && typeof root.querySelectorAll === 'function') {
    root.querySelectorAll('[data-scroll-anchor]').forEach((node) => {
      const anchorId = node.getAttribute('data-scroll-anchor')
      if (!anchorId || typeof node.getBoundingClientRect !== 'function') return
      const itemId = node.getAttribute('data-scroll-item')
      entries.push({
        anchorId,
        itemId: itemId || null,
        top: node.getBoundingClientRect().top - origin,
      })
    })
  }
  if (current.listIds && entries.length > 0 && !entries.some((entry) => current.listIds.has(entry.anchorId))) {
    return null
  }
  if (current.listIds && entries.length === 0) return null
  const anchor = chooseRouteScrollAnchor(entries, 0)
  const top = readOffset(container)
  const savedAt = Date.now()
  if (anchor) {
    return {
      measured: true,
      routeKey,
      anchorId: anchor.anchorId,
      itemId: anchor.itemId,
      offset: anchor.offset,
      top,
      savedAt,
    }
  }
  return { measured: true, routeKey, anchorId: null, itemId: null, offset: null, top, savedAt }
}

export function RouteScrollProvider({ children }) {
  const location = useLocation()
  const routeKey = scrollRouteKey(location.pathname, location.search)
  const hashBlocked = hashBlocksScrollRestore(location.hash)
  const userId = useContext(PageStateUserContext)
  const memory = useRef({
    routeKey,
    userId,
    contentReady: false,
    registered: false,
    container: null,
    listIds: null,
    preferPixel: false,
    leaveToPage: false,
    userInteracted: false,
    suppressSave: false,
    phase: 'pending',
    snapshot: null,
    pin: null,
  })
  const [epoch, setEpoch] = useState(0)
  const notify = () => setEpoch((n) => n + 1)

  const api = useMemo(() => ({
    setContentReady(ready) {
      memory.current.registered = true
      memory.current.contentReady = !!ready
      notify()
    },
    releaseContentReady() {
      memory.current.registered = false
      memory.current.contentReady = false
    },
    setContainer(element) {
      memory.current.container = element || null
      notify()
    },
    setListIds(ids) {
      memory.current.listIds = ids
    },
    setPreferPixel(prefer) {
      memory.current.preferPixel = !!prefer
    },
    setLeaveToPage(leave) {
      memory.current.leaveToPage = !!leave
      if (leave) memory.current.phase = 'settled'
      notify()
    },
    forget(key) {
      const target = key || memory.current.routeKey
      memory.current.phase = 'settled'
      memory.current.userInteracted = true
      memory.current.pin = null
      memory.current.snapshot = null
      clearRouteScroll(scrollStores(), target, memory.current.userId)
    },
  }), [])

  useEffect(() => {
    if (!('scrollRestoration' in history)) return undefined
    const previous = history.scrollRestoration
    history.scrollRestoration = 'manual'
    return () => {
      history.scrollRestoration = previous || 'auto'
    }
  }, [])

  useEffect(() => {
    const snap = memory.current.snapshot
    const previousUserId = memory.current.userId
    if (snap?.measured && (snap.routeKey !== routeKey || previousUserId !== userId)) {
      commitRouteScroll(scrollStores(), snap, previousUserId)
    }
    memory.current.userId = userId
    memory.current.routeKey = routeKey
    memory.current.userInteracted = false
    memory.current.phase = 'pending'
    memory.current.pin = null
    memory.current.snapshot = null
  }, [routeKey, userId])

  useEffect(() => {
    const mark = (event) => {
      if (memory.current.suppressSave) return
      if (event?.type === 'keydown' && event.metaKey) return
      memory.current.userInteracted = true
      memory.current.pin = null
    }
    window.addEventListener('wheel', mark, { passive: true })
    window.addEventListener('touchstart', mark, { passive: true })
    window.addEventListener('keydown', mark)
    return () => {
      window.removeEventListener('wheel', mark)
      window.removeEventListener('touchstart', mark)
      window.removeEventListener('keydown', mark)
    }
  }, [])

  useEffect(() => {
    if (memory.current.phase === 'settled') return undefined
    let frame = 0
    let frames = 0
    let cancelled = false
    const attempt = () => {
      if (cancelled || memory.current.phase === 'settled') return
      if (memory.current.userInteracted) {
        memory.current.phase = 'settled'
        return
      }
      frames += 1
      const current = memory.current
      if (current.routeKey !== routeKey) return
      const record = readRouteScroll(scrollStores(), routeKey, current.userId)
      const listIds = current.listIds
      const anchorInList = record?.anchorId && listIds
        ? listIds.has(record.anchorId)
        : undefined
      const root = current.container || document
      const gaveUp = frames >= 30
      const exact = record?.itemId ? findExactScrollItem(root, record) : null
      const fallback = record?.anchorId ? findRouteScrollElement(root, record) : null
      const needItem = !!record?.itemId
      const node = exact || (needItem ? (gaveUp ? fallback : null) : fallback)
      const anchorInDom = needItem ? (!!exact || (gaveUp && !!fallback)) : !!fallback
      const contentReady = current.registered ? current.contentReady : frames >= 2
      const decision = decideRouteScroll({
        hashPresent: hashBlocked,
        userInteracted: current.userInteracted,
        contentReady: current.leaveToPage ? true : contentReady,
        preferPixel: current.preferPixel,
        pixel: record?.top,
        anchor: record,
        anchorInList,
        anchorInDom,
        missingAnchor: gaveUp || anchorInList === false ? 'top' : undefined,
        emptyAnchor: current.leaveToPage ? undefined : 'top',
      })
      if (current.leaveToPage) {
        current.phase = 'settled'
        return
      }
      if (decision === 'wait') {
        if (current.registered && !current.contentReady) return
        if (frames < 30) frame = requestAnimationFrame(attempt)
        else current.phase = 'settled'
        return
      }
      current.phase = 'settled'
      if (decision === 'cancel' || decision === 'skip') return
      current.suppressSave = true
      if (decision === 'restore' && node) {
        const offset = exact && typeof record?.offset === 'number' ? record.offset : undefined
        applyAnchorScroll(node, offset, current.container)
        if (exact) {
          current.pin = {
            routeKey,
            anchorId: record.anchorId,
            itemId: record.itemId,
            offset: record.offset,
          }
          notify()
        }
      } else if (decision === 'pixel' && typeof record?.top === 'number') {
        writeOffset(current.container, record.top)
      } else if (decision === 'top') {
        writeOffset(current.container, 0)
      }
      requestAnimationFrame(() => {
        current.suppressSave = false
      })
    }
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(attempt)
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [routeKey, hashBlocked, epoch, userId])

  useEffect(() => {
    const pin = memory.current.pin
    if (!pin || pin.routeKey !== routeKey) return undefined
    let frame = 0
    const repin = () => {
      const currentPin = memory.current.pin
      if (!currentPin || currentPin.routeKey !== routeKey || memory.current.userInteracted) return
      const root = memory.current.container || document
      const node = findExactScrollItem(root, currentPin) || findRouteScrollElement(root, currentPin)
      if (!node) return
      memory.current.suppressSave = true
      applyAnchorScroll(node, currentPin.offset, memory.current.container)
      requestAnimationFrame(() => {
        memory.current.suppressSave = false
      })
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(repin)
    }
    const root = memory.current.container || document.documentElement
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
    resize?.observe(root)
    const mutations = typeof MutationObserver !== 'undefined'
      ? new MutationObserver(schedule)
      : null
    if (mutations && document.body) mutations.observe(document.body, { childList: true, subtree: true, characterData: true })
    return () => {
      cancelAnimationFrame(frame)
      resize?.disconnect()
      mutations?.disconnect()
    }
  }, [routeKey, epoch, userId])

  useEffect(() => {
    let timer = 0
    const flush = () => {
      window.clearTimeout(timer)
      timer = 0
      const snap = memory.current.snapshot
      if (!snap?.measured || snap.routeKey !== routeKey) return
      commitRouteScroll(scrollStores(), snap, memory.current.userId)
    }
    const onScroll = () => {
      if (memory.current.suppressSave) return
      if (memory.current.routeKey !== routeKey) return
      // A new page often scrolls to 0 before restore. Keep the saved anchor unless the user has scrolled.
      if (memory.current.phase !== 'settled' && !memory.current.userInteracted) return
      const snap = measureSnapshot(routeKey, memory.current)
      if (!snap) return
      memory.current.snapshot = snap
      window.clearTimeout(timer)
      timer = window.setTimeout(flush, SCROLL_SAVE_DELAY_MS)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    const target = memory.current.container || window
    target.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      flush()
      target.removeEventListener('scroll', onScroll)
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [routeKey, epoch])

  return (
    <ScrollContext.Provider value={api}>
      <div data-scroll-route={routeKey} style={{ display: 'contents' }}>{children}</div>
    </ScrollContext.Provider>
  )
}

export function useScrollContentReady(ready) {
  const api = useContext(ScrollContext)
  useEffect(() => {
    if (!api) return undefined
    api.setContentReady(ready)
    return () => api.releaseContentReady()
  }, [api, ready])
}

export function useScrollContainer(ref, revision) {
  const api = useContext(ScrollContext)
  useEffect(() => {
    if (!api) return undefined
    api.setContainer(ref?.current || null)
    return () => api.setContainer(null)
  }, [api, ref, revision])
}

export function useScrollListIds(ids) {
  const api = useContext(ScrollContext)
  const key = Array.isArray(ids) ? ids.join('\0') : ''
  useEffect(() => {
    if (!api) return undefined
    api.setListIds(key ? new Set(key.split('\0')) : null)
    return () => api.setListIds(null)
  }, [api, key])
}

export function useScrollPixelMode(enabled) {
  const api = useContext(ScrollContext)
  useEffect(() => {
    if (!api) return undefined
    api.setPreferPixel(enabled)
    return () => api.setPreferPixel(false)
  }, [api, enabled])
}

/** Let the page position itself (hash section, second-place query). */
export function useLeaveScrollToPage(active) {
  const api = useContext(ScrollContext)
  useEffect(() => {
    if (!api) return undefined
    api.setLeaveToPage(active)
    return () => api.setLeaveToPage(false)
  }, [api, active])
}

/** Drop the saved anchor when the user changes search or filters. Does not touch other view state. */
export function useForgetScrollOnChange(token) {
  const api = useContext(ScrollContext)
  const location = useLocation()
  const seen = useRef(null)
  useEffect(() => {
    if (!api) return
    const routeKey = scrollRouteKey(location.pathname, location.search)
    if (seen.current == null) {
      seen.current = token
      return
    }
    if (seen.current === token) return
    seen.current = token
    api.forget(routeKey)
  }, [api, token, location.pathname, location.search])
}
