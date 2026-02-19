/**
 * Item stats for hover cards. Magelo-style structure (flags, slot, stats, effect/focus with spell ids).
 * Loaded from item_stats.json (built by scripts/build_item_stats.py from TAKP AllaClone + raid_item_sources).
 */

const TAKP_ITEM_BASE = 'https://www.takproject.net/allaclone/item.php?id='
const TAKP_SPELL_BASE = 'https://www.takproject.net/allaclone/spell.php?id='

const cache = new Map()

/** Lazy load item_stats.json (built by scripts/build_item_stats.py). Populates cache. */
let itemStatsLoadPromise = null
export function ensureItemStatsLoaded() {
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
  return ensureItemStatsLoaded().then(() => cache.get(id) ?? null)
}

export function getItemStatsCached(itemId) {
  if (itemId == null) return null
  return cache.get(Number(itemId)) ?? null
}

/** Gear score: total saves + AC + HP/3. Uses stats.gearScore if present, else computes from ac, resists, mods. */
export function getGearScore(stats) {
  if (!stats || typeof stats !== 'object') return 0
  if (typeof stats.gearScore === 'number') return stats.gearScore
  const ac = Number(stats.ac) || 0
  const resists = stats.resists || []
  const totalSaves = resists.reduce((s, r) => s + (Number(r?.value) || 0), 0)
  let hp = 0
  for (const m of stats.mods || []) {
    if ((m?.label || '').trim().toUpperCase() === 'HP') {
      hp = Number(m.value) || 0
      break
    }
  }
  return totalSaves + ac + Math.floor(hp / 3)
}

/** Return whether item stats have the given slot (slot string can be "PRIMARY SECONDARY" etc). */
export function itemHasSlot(stats, slot) {
  if (!stats?.slot || !slot) return false
  const slots = String(stats.slot).toUpperCase().split(/\s+/).filter(Boolean)
  return slots.includes(String(slot).toUpperCase())
}

/** Return whether item is usable by the given class (classes string e.g. "WAR CLR PAL"). */
export function itemUsableByClass(stats, cls) {
  if (!stats?.classes || !cls) return true
  const classes = String(stats.classes).toUpperCase().split(/\s+/).filter(Boolean)
  return classes.includes(String(cls).toUpperCase())
}

export { TAKP_ITEM_BASE, TAKP_SPELL_BASE }
