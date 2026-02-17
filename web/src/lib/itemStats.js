/**
 * Item stats for hover cards. Magelo-style structure (flags, slot, stats, effect/focus with spell ids).
 * Loaded from item_stats.json (built by scripts/build_item_stats.py from TAKP AllaClone + raid_item_sources).
 */

const TAKP_ITEM_BASE = 'https://www.takproject.net/allaclone/item.php?id='
const TAKP_SPELL_BASE = 'https://www.takproject.net/allaclone/spell.php?id='

const cache = new Map()

/** Lazy load item_stats.json (built by scripts/build_item_stats.py). Populates cache. */
let itemStatsLoadPromise = null
function loadItemStatsJson() {
  if (itemStatsLoadPromise == null) {
    itemStatsLoadPromise = fetch('/item_stats.json')
      .then((r) => (r.ok ? r.json() : {}))
      .then((obj) => {
        if (obj && typeof obj === 'object') {
          for (const [k, v] of Object.entries(obj)) {
            if (v != null && typeof v === 'object' && Object.keys(v).length > 0) {
              cache.set(Number(k), v)
            }
          }
        }
        return obj
      })
      .catch(() => ({}))
  }
  return itemStatsLoadPromise
}

export function getItemStats(itemId) {
  if (itemId == null) return Promise.resolve(null)
  const id = Number(itemId)
  if (cache.has(id)) return Promise.resolve(cache.get(id))
  return loadItemStatsJson().then(() => cache.get(id) ?? null)
}

export function getItemStatsCached(itemId) {
  if (itemId == null) return null
  return cache.get(Number(itemId)) ?? null
}

export { TAKP_ITEM_BASE, TAKP_SPELL_BASE }
