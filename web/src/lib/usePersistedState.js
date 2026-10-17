import { useState, useCallback, useEffect, useRef, useContext } from 'react'
import { PageStateUserContext } from './pageStateUser'
import { browserStorage, readPageState, writePageState } from './pageState'

/**
 * Like useState but persisted so viewing context survives navigation.
 * Use for search text, filters, sort, and other user intent. Ephemeral UI stays in useState.
 * When `key` changes (e.g. different accountId in the key), the value is reloaded from storage.
 * @param {string} key - Logical key. Stored as pageState: + key, e.g. '/mobs:query'
 * @param {T} initialValue - Initial value if nothing in storage
 * @param {(parsed: unknown) => T} [normalize] - Optional. Invalid saved values fall back inside normalize, or to initialValue if it throws.
 * @param {{ storage?: 'session' | 'local', version?: number, ttlMs?: number, userScope?: boolean, migrateUnscoped?: boolean }} [options]
 *   `storage: 'local'` writes a versioned `{ v, exp, value }` envelope. `userScope` keys the slot to the signed-in user.
 * @returns {[T, (value: T | ((prev: T) => T)) => void]}
 */
export function usePersistedState(key, initialValue, normalize, options) {
  const contextUserId = useContext(PageStateUserContext)
  const userScope = options?.userScope === true
  const userId = userScope ? (contextUserId || null) : null
  const storageKind = options?.storage === 'local' ? 'local' : 'session'
  const version = options?.storage === 'local' ? (options?.version ?? 1) : options?.version
  const ttlMs = options?.ttlMs
  const migrateUnscoped = options?.migrateUnscoped === true
  const active = !userScope || !!userId
  const slotKey = `${storageKind}:${userScope ? userId || '' : ''}:${version ?? ''}:${key}`

  const normalizeRef = useRef(normalize)
  const initialRef = useRef(initialValue)
  normalizeRef.current = normalize
  initialRef.current = initialValue

  const read = (initial) => {
    if (!active) return initial
    return readPageState(browserStorage(storageKind), key, initial, normalizeRef.current, {
      userId: userScope ? userId : undefined,
      version,
      ttlMs,
      migrateUnscoped: migrateUnscoped && userScope,
    })
  }

  const [state, setStateInternal] = useState(() => read(initialValue))

  useEffect(() => {
    setStateInternal(read(initialRef.current))
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
