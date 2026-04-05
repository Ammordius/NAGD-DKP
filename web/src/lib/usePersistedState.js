import { useState, useCallback, useEffect } from 'react'

const PREFIX = 'pageState:'

/**
 * Like useState but persisted to sessionStorage so state survives navigation.
 * Use for search text, filters, sort, etc. so switching tabs doesn't clear the form.
 * When `key` changes (e.g. different accountId in the key), the value is reloaded from storage.
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

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(fullKey)
      if (raw == null) {
        setStateInternal(initialValue)
      } else {
        setStateInternal(JSON.parse(raw))
      }
    } catch {
      setStateInternal(initialValue)
    }
    // Only the storage slot should trigger reload; avoid unstable initialValue refs resetting state every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullKey])

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
