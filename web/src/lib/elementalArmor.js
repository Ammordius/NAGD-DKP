/**
 * Elemental mold/pattern → class-specific armor mapping.
 * Loaded from elemental_mold_armor.json (built by scripts/build_elemental_mold_armor.py from dkp_elemental_to_magelo.json).
 * Used with item_stats.json so when a class is selected we show the wearable armor for that class
 * instead of the mold, while keeping DKP/loot context and showing which mold it came from.
 */

let loadPromise = null
const moldById = new Map()

export function ensureElementalArmorLoaded() {
  if (loadPromise == null) {
    loadPromise = fetch('/elemental_mold_armor.json')
      .then((r) => (r.ok ? r.json() : {}))
      .then((obj) => {
        if (obj && typeof obj === 'object') {
          for (const [id, entry] of Object.entries(obj)) {
            if (entry != null && typeof entry === 'object') {
              moldById.set(Number(id), entry)
              moldById.set(String(id), entry)
            }
          }
        }
        return obj
      })
      .catch(() => ({}))
  }
  return loadPromise
}

/** @param {number|string} moldId - DKP mold/pattern item ID */
export function getMoldInfo(moldId) {
  if (moldId == null) return null
  const id = typeof moldId === 'string' ? moldId : String(moldId)
  return moldById.get(Number(moldId)) ?? moldById.get(id) ?? null
}

/** @param {number|string} moldId - DKP mold/pattern item ID */
export function isElementalMold(moldId) {
  return getMoldInfo(moldId) != null
}

/**
 * Get the wearable armor item ID for a given mold and class.
 * @param {number|string} moldId - DKP mold/pattern item ID
 * @param {string} classAbbr - Uppercase class e.g. WAR, ROG, CLR
 * @returns {number|null} - Armor item ID or null
 */
export function getArmorIdForMoldAndClass(moldId, classAbbr) {
  const info = getMoldInfo(moldId)
  if (!info?.by_class || !classAbbr) return null
  const armorId = info.by_class[String(classAbbr).toUpperCase()]
  if (armorId == null) return null
  const n = Number(armorId)
  return Number.isNaN(n) ? null : n
}
