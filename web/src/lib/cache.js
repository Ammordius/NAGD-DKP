/** Accounts list blob. Bump when list shape or default sort changes so a prior session does not keep the old order. */
export const ACCOUNTS_LIST_CACHE_KEY = 'accounts_list_v10'

/**
 * Simple sessionStorage cache with TTL. Use for loot, raids list, mob last3, etc.
 * @param {string} key
 * @param {number} ttlMs
 * @returns {{ get: () => any, set: (data: any) => void }}
 */
export function createCache(key, ttlMs = 10 * 60 * 1000) {
  return {
    get() {
      try {
        const raw = sessionStorage.getItem(key)
        if (!raw) return null
        const { data, at } = JSON.parse(raw)
        if (at && Date.now() - at > ttlMs) return null
        return data
      } catch {
        return null
      }
    },
    set(data) {
      try {
        sessionStorage.setItem(key, JSON.stringify({ data, at: Date.now() }))
      } catch (_) { /* ignore */ }
    },
  }
}
