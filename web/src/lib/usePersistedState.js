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
 * Like useState but persisted so viewing context survives navigation.
 * Use for search text, filters, sort, and other user intent. Ephemeral UI stays in useState.
 * When `key` changes (e.g. different accountId in the key), the value is reloaded from storage.
 * @param {string} key - Logical key. Stored as pageState: + key, e.g. '/mobs:query'
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
  }, [slotKey])

  const setState = useCallback((valueOrUpdater) => {
    setStateInternal((prev) => {
      const next = typeof valueOrUpdater === 'function' ? valueOrUpdater(prev) : valueOrUpdater
      if (active) {
        writePageState(browserStorage(storageKind), key, next, {
          userId: userScope ? userId : undefined,
          version,
          ttlMs,
        })
      }
      return next
    })
  }, [slotKey, active, key, userId, userScope, storageKind, version, ttlMs])

  return [state, setState]
}
