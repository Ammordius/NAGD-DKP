/**
 * Item stats for hover cards. Currently uses mock data for known items;
 * can be replaced with API fetch or static JSON later.
 */

const TAKP_ITEM_BASE = 'https://www.takproject.net/allaclone/item.php?id='

// Mock stats for prototype — Hammer of Hours (id 21886) from TAKP AllaClone
const MOCK_STATS = {
  21886: {
    slot: 'PRIMARY',
    skill: '1H Blunt',
    ac: 15,
    atkDelay: 30,
    dmg: 30,
    dmgBonus: 13,
    mods: [
      { label: 'STA', value: '+15' },
      { label: 'CHA', value: '+15' },
      { label: 'WIS', value: '+20' },
      { label: 'AGI', value: '+25' },
      { label: 'HP', value: '+165' },
      { label: 'MANA', value: '+180' },
    ],
    resists: [
      { label: 'SV FIRE', value: '+18' },
      { label: 'SV COLD', value: '+18' },
      { label: 'SV MAGIC', value: '+18' },
    ],
    requiredLevel: 65,
    effect: 'Time Lapse (Combat) (Lvl: 1) (Rate: 100%)',
    focusEffect: 'Timeburn',
    weight: 2.7,
    size: 'MEDIUM',
    classes: 'CLR DRU SHM',
    races: 'ALL',
    droppedBy: ['Plane of Time', 'Terris Thule (20%)', 'Terris Thule (15%)'],
  },
}

const cache = new Map()

/**
 * Get item stats for hover card. Returns null if not available (then card shows compact view).
 * @param {number} itemId - TAKP AllaClone item id
 * @returns {Promise<object|null>}
 */
export function getItemStats(itemId) {
  if (itemId == null) return Promise.resolve(null)
  const id = Number(itemId)
  if (cache.has(id)) return Promise.resolve(cache.get(id))
  // For now only mock; later: return fetch(`/api/item-stats/${id}`).then(r => r.ok ? r.json() : null)
  const stats = MOCK_STATS[id] ?? null
  if (stats) cache.set(id, stats)
  return Promise.resolve(stats)
}

/**
 * Get item stats synchronously if already cached (e.g. for immediate show on hover).
 */
export function getItemStatsCached(itemId) {
  if (itemId == null) return null
  return cache.get(Number(itemId)) ?? MOCK_STATS[Number(itemId)] ?? null
}

export { TAKP_ITEM_BASE }
