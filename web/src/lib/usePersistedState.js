import { useState, useCallback, useEffect, useRef, useContext } from 'react'
import { PageStateUserContext } from './pageStateUser'
import { browserStorage, migrateSessionKeyToUserLocal, pageStateFullKey, readPageState, writePageState } from './pageState'

/**
 * Like useState but persisted so viewing context survives navigation.
 * Use for search text, filters, sort, and other user intent. Ephemeral UI stays in useState.
 * When `key` changes (e.g. different accountId in the key), the value is reloaded from storage.
 * @param {string} key - Logical key. Stored as pageState: + key, e.g. '/mobs:query'
 * @param {T} initialValue - Initial value if nothing in storage
 * @param {(parsed: unknown) => T} [normalize] - Optional. Invalid saved values fall back inside normalize, or to initialValue if it throws.
 * @param {{ storage?: 'session' | 'local', version?: number, ttlMs?: number, userScope?: boolean, migrateUnscoped?: boolean, migrateFromSession?: boolean, mergeWrite?: Function, listenStorage?: boolean }} [options]
 *   The default is a versioned local slot for the signed-in user. `storage: 'session'` keeps the old tab-only slot.
 *   `migrateFromSession` copies a session slot into that user's local slot once.
 *   `mergeWrite(stored, previous, next)` rebases this tab's edit onto a newer stored value.
 *   `listenStorage` applies newer local writes from other tabs.
 * @returns {[T, (value: T | ((prev: T) => T)) => void]}
 */
export function usePersistedState(key, initialValue, normalize, options) {
  const contextUserId = useContext(PageStateUserContext)
  const storageKind = options?.storage === 'session' ? 'session' : 'local'
  const userScope = options?.userScope === true || (storageKind === 'local' && options?.userScope !== false)
  const userId = userScope ? (contextUserId || null) : null
  const version = storageKind === 'local' ? (options?.version ?? 1) : options?.version
  const ttlMs = options?.ttlMs
  const migrateUnscoped = options?.migrateUnscoped === true
  const migrateFromSession = options?.migrateFromSession !== false && storageKind === 'local' && userScope
  const listenStorage = options?.listenStorage !== false && storageKind === 'local'
  const active = !userScope || !!userId
  const slotKey = `${storageKind}:${userScope ? userId || '' : ''}:${version ?? ''}:${key}`

  const normalizeRef = useRef(normalize)
  const initialRef = useRef(initialValue)
  const mergeRef = useRef(options?.mergeWrite)
  normalizeRef.current = normalize
  initialRef.current = initialValue
  mergeRef.current = options?.mergeWrite

  const read = (initial) => {
    if (!active) return initial
    const storage = browserStorage(storageKind)
    if (migrateFromSession && userScope && userId && storageKind === 'local') {
      migrateSessionKeyToUserLocal(browserStorage('session'), storage, key, userId, { version })
    }
    return readPageState(storage, key, initial, normalizeRef.current, {
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
      if (next === prev) return prev
      if (!active) return next
      const storage = browserStorage(storageKind)
      let toWrite = next
      if (mergeRef.current) {
        const stored = read(initialRef.current)
        toWrite = mergeRef.current(stored, prev, next)
      }
      writePageState(storage, key, toWrite, {
        userId: userScope ? userId : undefined,
        version,
        ttlMs,
      })
      return toWrite
    })
  }, [slotKey, active, key, userId, userScope, storageKind, version, ttlMs])

  useEffect(() => {
    if (!listenStorage || storageKind !== 'local' || !active || typeof window === 'undefined') return undefined
    const fullKey = pageStateFullKey(key, { userId: userScope ? userId : undefined })
    const onStorage = (event) => {
      if (event.key !== fullKey) return
      setStateInternal(read(initialRef.current))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [listenStorage, storageKind, active, key, userId, userScope, slotKey])

  return [state, setState]
}
