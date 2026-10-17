import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  SCROLL_SAVE_DELAY_MS,
  chooseRouteScrollAnchor,
  clearScrollRecord,
  decideRouteScroll,
  findRouteScrollElement,
  hashBlocksScrollRestore,
  readScrollRecord,
  scrollRouteKey,
  writeScrollRecord,
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

export function RouteScrollProvider({ children }) {
  const location = useLocation()
  const routeKey = scrollRouteKey(location.pathname, location.search)
  const hashBlocked = hashBlocksScrollRestore(location.hash)
  const memory = useRef({
    routeKey,
    contentReady: false,
    registered: false,
    container: null,
    listIds: null,
    preferPixel: false,
    leaveToPage: false,
    userInteracted: false,
    suppressSave: false,
    phase: 'pending',
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
      memory.current.phase = 'settled'
      memory.current.userInteracted = true
      clearScrollRecord(sessionStorage, key || memory.current.routeKey)
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
    const previousKey = memory.current.routeKey
    if (previousKey && previousKey !== routeKey) {
      capture(previousKey, memory.current)
    }
    memory.current.routeKey = routeKey
    memory.current.userInteracted = false
    memory.current.phase = 'pending'
  }, [routeKey])

  useEffect(() => {
    const mark = () => {
      if (memory.current.phase === 'settled') return
      memory.current.userInteracted = true
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
      frames += 1
      const current = memory.current
      if (current.routeKey !== routeKey) return
      const record = readScrollRecord(sessionStorage, routeKey)
      const listIds = current.listIds
      const anchorInList = record?.anchorId && listIds
        ? listIds.has(record.anchorId)
        : undefined
      const root = current.container || document
      const node = record?.anchorId ? findRouteScrollElement(root, record) : null
      const contentReady = current.registered ? current.contentReady : frames >= 2
      const decision = decideRouteScroll({
        hashPresent: hashBlocked,
        userInteracted: current.userInteracted,
        contentReady: current.leaveToPage ? true : contentReady,
        preferPixel: current.preferPixel,
        pixel: record?.top,
        anchor: record,
        anchorInList,
        anchorInDom: !!node,
        missingAnchor: 'top',
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
      if (decision === 'restore' && node && typeof node.scrollIntoView === 'function') {
        node.scrollIntoView({ block: 'start' })
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
  }, [routeKey, hashBlocked, epoch])

  useEffect(() => {
    let timer = 0
    const save = () => {
      if (memory.current.phase !== 'settled') return
      if (memory.current.suppressSave) return
      if (memory.current.routeKey !== routeKey) return
      capture(routeKey, memory.current)
    }
    const onScroll = () => {
      if (memory.current.phase !== 'settled' || memory.current.suppressSave) return
      window.clearTimeout(timer)
      timer = window.setTimeout(save, SCROLL_SAVE_DELAY_MS)
    }
    const flush = () => {
      window.clearTimeout(timer)
      timer = 0
      save()
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
      {children}
    </ScrollContext.Provider>
  )
}

function capture(routeKey, current) {
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
  const anchor = chooseRouteScrollAnchor(entries, 0)
  const top = readOffset(container)
  if (anchor) {
    writeScrollRecord(sessionStorage, routeKey, { ...anchor, top })
    return
  }
  if (top > 0) {
    writeScrollRecord(sessionStorage, routeKey, { anchorId: null, itemId: null, top })
    return
  }
  clearScrollRecord(sessionStorage, routeKey)
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
