/**
 * Shared in-memory loaders for static JSON files (dkp_mob_loot, raid_item_sources, item_sources).
 * Each file is fetched at most once per session; subsequent callers get the same promise/result.
 * Bump DKP_MOB_LOOT_VERSION when deploying updated dkp_mob_loot.json to avoid stale cache.
 */
const DKP_MOB_LOOT_VERSION = 2

let dkpMobLootPromise = null
let raidItemSourcesPromise = null
let itemSourcesPromise = null

/** @returns {Promise<object|null>} */
export function getDkpMobLoot() {
  if (dkpMobLootPromise == null) {
    dkpMobLootPromise = fetch(`/dkp_mob_loot.json?v=${DKP_MOB_LOOT_VERSION}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
  }
  return dkpMobLootPromise
}

/** @returns {Promise<object|null>} */
export function getRaidItemSources() {
  if (raidItemSourcesPromise == null) {
    raidItemSourcesPromise = fetch('/raid_item_sources.json')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
  }
  return raidItemSourcesPromise
}

/** @returns {Promise<object|null>} */
export function getItemSources() {
  if (itemSourcesPromise == null) {
    itemSourcesPromise = fetch('/item_sources.json')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
  }
  return itemSourcesPromise
}
