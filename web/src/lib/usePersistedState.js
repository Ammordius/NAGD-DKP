import { useState, useCallback } from 'react'

const PREFIX = 'pageState:'

/**
 * Like useState but persisted to sessionStorage so state survives navigation.
 * Use for search text, filters, sort, etc. so switching tabs doesn't clear the form.
 * @param {string} key - Storage key (will be prefixed with pageState:). Use path + field, e.g. '/mobs:query'
 * @param {T} initialValue - Initial value if nothing in storage
 * @returns {[T, (value: T | ((prev: T) => T)) => void]}
 */
export function usePersistedState(key, initialValue) {
  const fullKey = PREFIX + key
  const [state, setStateInternal] = useState(() => {
    try {
      const raw = sessionStorage.getItem(fullKey)
      if (raw == null) return initialValue
      const parsed = JSON.parse(raw)
      return parsed
    } catch {
      return initialValue
    }
  })

  const setState = useCallback((valueOrUpdater) => {
    setStateInternal((prev) => {
      const next = typeof valueOrUpdater === 'function' ? valueOrUpdater(prev) : valueOrUpdater
      try {
        sessionStorage.setItem(fullKey, JSON.stringify(next))
      } catch (_) {
        // ignore quota or private mode
      }
      return next
    })
  }, [fullKey])

  return [state, setState]
}
