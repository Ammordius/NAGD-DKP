import { useState, useCallback, useEffect, useRef } from 'react'

const PREFIX = 'pageState:'

function readPersisted(fullKey, initialValue, normalize) {
  try {
    const raw = sessionStorage.getItem(fullKey)
    if (raw == null) return initialValue
    const parsed = JSON.parse(raw)
    if (typeof normalize !== 'function') return parsed
    try {
      const next = normalize(parsed)
      return next === undefined ? initialValue : next
    } catch {
      return initialValue
    }
  } catch {
    return initialValue
  }
}

/**
 * Like useState but persisted to sessionStorage so state survives navigation.
 * Use for search text, filters, sort, etc. so switching tabs doesn't clear the form.
 * When `key` changes (e.g. different accountId in the key), the value is reloaded from storage.
 * @param {string} key - Storage key (will be prefixed with pageState:). Use path + field, e.g. '/mobs:query'
 * @param {T} initialValue - Initial value if nothing in storage
 * @param {(parsed: unknown) => T} [normalize] - Optional. Invalid saved values fall back inside normalize, or to initialValue if it throws.
 * @returns {[T, (value: T | ((prev: T) => T)) => void]}
 */
export function usePersistedState(key, initialValue, normalize) {
  const fullKey = PREFIX + key
  const normalizeRef = useRef(normalize)
  const initialRef = useRef(initialValue)
  normalizeRef.current = normalize
  initialRef.current = initialValue

  const [state, setStateInternal] = useState(() => readPersisted(fullKey, initialValue, normalize))

  useEffect(() => {
    setStateInternal(readPersisted(fullKey, initialRef.current, normalizeRef.current))
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
