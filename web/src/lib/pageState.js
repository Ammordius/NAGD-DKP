/** Browser storage for user viewing context. Guild view state stays unscoped in sessionStorage. */

export const PAGE_STATE_PREFIX = 'pageState:'

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {string} key logical key, e.g. '/mobs:query'
 * @param {{ userId?: string | null }} [options]
 */
export function pageStateFullKey(key, options = {}) {
  const userId = options.userId
  const logical = userId ? `user:${userId}:${key}` : key
  return PAGE_STATE_PREFIX + logical
}

export function userPageStatePrefix(userId) {
  return `${PAGE_STATE_PREFIX}user:${userId}:`
}

export function listStorageKeys(storage) {
  if (!storage) return []
  if (typeof storage.keys === 'function') {
    try {
      return [...storage.keys()]
    } catch {
      return []
    }
  }
  if (typeof storage.length === 'number' && typeof storage.key === 'function') {
    const out = []
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i)
      if (key) out.push(key)
    }
    return out
  }
  return []
}

/** Remove one user's personalized page-state keys. Guild view keys are left alone. */
export function clearUserPageState(storage, userId) {
  if (!storage || !userId || typeof storage.removeItem !== 'function') return []
  const prefix = userPageStatePrefix(userId)
  const removed = []
  for (const key of listStorageKeys(storage)) {
    if (typeof key !== 'string' || !key.startsWith(prefix)) continue
    try {
      storage.removeItem(key)
      removed.push(key)
    } catch {
      // ignore quota or private mode
    }
  }
  return removed
}

/**
 * localStorage (and any versioned slot) stores `{ v, exp, value }`.
 * Session slots without a version stay raw JSON so existing keys keep working.
 */
export function encodeStoredValue(value, { version, ttlMs, now = Date.now() } = {}) {
  if (version == null) return value
  const exp = typeof ttlMs === 'number' && ttlMs > 0 ? now + ttlMs : null
  return { v: version, exp, value }
}

export function decodeStoredValue(parsed, { version, now = Date.now() } = {}) {
  if (version == null) return { ok: true, value: parsed }
  if (!isPlainObject(parsed) || parsed.v !== version || !Object.prototype.hasOwnProperty.call(parsed, 'value')) {
    return { ok: false }
  }
  if (parsed.exp != null && (typeof parsed.exp !== 'number' || now > parsed.exp)) return { ok: false }
  return { ok: true, value: parsed.value }
}

export function readPageState(storage, key, initialValue, normalize, options = {}) {
  if (!storage || typeof storage.getItem !== 'function') return initialValue
  const fullKey = pageStateFullKey(key, options)
  try {
    let raw = storage.getItem(fullKey)
    if (raw == null && options.userId && options.migrateUnscoped) {
      const legacyKey = pageStateFullKey(key, {})
      const legacy = storage.getItem(legacyKey)
      if (legacy != null) {
        raw = legacy
        try {
          storage.setItem(fullKey, legacy)
          storage.removeItem(legacyKey)
        } catch {
          // keep the legacy read even if the move fails
        }
      }
    }
    if (raw == null) return initialValue
    const parsed = JSON.parse(raw)
    const decoded = decodeStoredValue(parsed, options)
    if (!decoded.ok) return initialValue
    if (typeof normalize !== 'function') return decoded.value
    try {
      const next = normalize(decoded.value)
      return next === undefined ? initialValue : next
    } catch {
      return initialValue
    }
  } catch {
    return initialValue
  }
}

export function writePageState(storage, key, value, options = {}) {
  if (!storage || typeof storage.setItem !== 'function') return
  try {
    storage.setItem(pageStateFullKey(key, options), JSON.stringify(encodeStoredValue(value, options)))
  } catch {
    // ignore quota or private mode
  }
}

/**
 * Copy an unscoped session slot into a user-scoped local slot once.
 * Removes the session key so the next signed-in user does not inherit it.
 * @returns {boolean} true when a value was moved
 */
export function migrateSessionKeyToUserLocal(sessionStore, localStore, key, userId, options = {}) {
  if (!sessionStore || !localStore || !userId) return false
  if (typeof sessionStore.getItem !== 'function' || typeof localStore.getItem !== 'function') return false
  const version = options.version ?? 1
  const dest = pageStateFullKey(key, { userId })
  try {
    if (localStore.getItem(dest) != null) return false
    const legacy = sessionStore.getItem(pageStateFullKey(key, {}))
    if (legacy == null) return false
    const parsed = JSON.parse(legacy)
    writePageState(localStore, key, parsed, { userId, version })
    sessionStore.removeItem(pageStateFullKey(key, {}))
    return true
  } catch {
    return false
  }
}

export function browserStorage(kind) {
  try {
    if (kind === 'local') return localStorage
    return sessionStorage
  } catch {
    return null
  }
}
