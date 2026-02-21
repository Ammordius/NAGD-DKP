import { useEffect, useState, useMemo, useCallback, Fragment } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { usePersistedState } from '../lib/usePersistedState'
import { createCache } from '../lib/cache'
import { getDkpMobLoot, getRaidItemSources } from '../lib/staticData'
import { getItemStats, ensureItemStatsLoaded, getItemStatsCached, getGearScore, itemHasSlot, itemUsableByClass } from '../lib/itemStats'
import { ensureElementalArmorLoaded, getMoldInfo, getArmorIdForMoldAndClass } from '../lib/elementalArmor'

const ITEMS_PER_PAGE = 20

/** EQ slot options for filter (order for dropdown). */
const SLOT_OPTIONS = ['HEAD', 'FACE', 'NECK', 'SHOULDERS', 'ARMS', 'BACK', 'CHEST', 'WRIST', 'HANDS', 'WAIST', 'LEGS', 'FEET', 'PRIMARY', 'SECONDARY', 'RANGE', 'EAR', 'FINGERS', 'AMMO']
/** EQ class abbreviations for filter. */
const CLASS_OPTIONS = ['WAR', 'CLR', 'PAL', 'RNG', 'SHD', 'BRD', 'ROG', 'SHM', 'MNK', 'NEC', 'WIZ', 'MAG', 'ENC', 'BST']
const TAKP_ITEM_BASE = 'https://www.takproject.net/allaclone/item.php?id='

/** Map elemental_mold_armor slot (e.g. "head", "wrists") to filter slot (HEAD, WRIST). */
const ELEMENTAL_SLOT_TO_FILTER = {
  head: 'HEAD',
  chest: 'CHEST',
  arms: 'ARMS',
  legs: 'LEGS',
  wrists: 'WRIST',
  feet: 'FEET',
  hands: 'HANDS',
}
function elementalSlotMatchesFilter(moldSlot, filterSlot) {
  if (!moldSlot || !filterSlot) return false
  const mapped = ELEMENTAL_SLOT_TO_FILTER[String(moldSlot).toLowerCase()]
  return mapped === String(filterSlot).toUpperCase()
}

/** Build item name (lowercase) -> item_id from raid_item_sources (id -> { name }). */
function buildNameToIdFromRaid(raidSources) {
  const map = {}
  if (!raidSources || typeof raidSources !== 'object') return map
  Object.entries(raidSources).forEach(([id, entry]) => {
    const name = entry?.name && typeof entry.name === 'string' ? entry.name.trim() : null
    if (name) {
      const key = name.toLowerCase()
      const numId = Number(id)
      if (!Number.isNaN(numId) && map[key] == null) map[key] = numId
    }
  })
  return map
}

/** Build name (lowercase) -> item_id from dkp_mob_loot (all entries' loot that have item_id). */
function buildNameToIdFromMobLoot(mobLootData) {
  const map = {}
  if (!mobLootData || typeof mobLootData !== 'object') return map
  Object.values(mobLootData).forEach((entry) => {
    if (!entry || !Array.isArray(entry.loot)) return
    entry.loot.forEach((item) => {
      const id = item?.item_id
      const name = (item?.name || '').trim()
      if (id != null && name) {
        const key = name.toLowerCase()
        if (map[key] == null) map[key] = Number(id)
      }
    })
  })
  return map
}

/** Inline row: item name (link) + one line of stats when loaded. Optional gear score badge. When moldName is set, show "from mold" badge. initialStats avoids flash when parent already has cached stats. */
function InlineItemRow({ name, itemId, showGearScore, moldName, initialStats }) {
  const [stats, setStats] = useState(initialStats ?? null)
  useEffect(() => {
    if (initialStats != null) setStats((prev) => prev ?? initialStats)
  }, [initialStats])
  useEffect(() => {
    if (itemId == null) return
    getItemStats(itemId).then(setStats)
  }, [itemId])
  const resolvedStats = stats ?? initialStats
  const href = itemId != null ? `${TAKP_ITEM_BASE}${itemId}` : null
  const parts = []
  if (resolvedStats) {
    const { slot, ac, mods = [], resists = [], requiredLevel, effectSpellName, effectSpellId, classes } = resolvedStats
    if (slot) parts.push(slot)
    if (ac != null) parts.push(`AC: ${ac}`)
    if (effectSpellId != null || effectSpellName) parts.push(`Effect: ${effectSpellName || effectSpellId}`)
    if (mods.length) parts.push(mods.map((m) => `${m.label}: ${typeof m.value === 'number' && (m.label === 'HP' || m.label === 'MANA') ? (m.value >= 0 ? '+' : '') + m.value : m.value}`).join(', '))
    if (resists.length) parts.push(resists.map((r) => `${r.label}: ${r.value}`).join(' '))
    if (requiredLevel != null) parts.push(`Req ${requiredLevel}`)
    if (classes) parts.push(classes)
  }
  const statsLine = parts.filter(Boolean).join(' · ')
  const gearScore = resolvedStats && showGearScore ? getGearScore(resolvedStats) : null
  const displayName = name || resolvedStats?.name || 'Unknown item'
  const itemPageTo = `/items/${encodeURIComponent(displayName)}`
  return (
    <div className="mob-loot-item-row">
      <div className="mob-loot-item-name">
        {gearScore != null && gearScore > 0 && (
          <span className="mob-loot-gear-score" title="Gear score (saves + AC + HP/3)">{gearScore}</span>
        )}
        <Link to={itemPageTo}>{displayName}</Link>
        {moldName && (
          <span className="mob-loot-mold-badge" title={`Class-specific armor from mold: ${moldName}`}>
            {' '}(from mold)
          </span>
        )}
        {href && (
          <>
            {' '}
            <a href={href} target="_blank" rel="noopener noreferrer" className="mob-loot-item-takp" title="View on TAKP AllaClone">↗</a>
          </>
        )}
      </div>
      {statsLine && <div className="mob-loot-item-stats">{statsLine}</div>}
    </div>
  )
}

const LAST3_CACHE_KEY = 'mob_loot_last3_v2'
const CACHE_TTL = 10 * 60 * 1000

/** Zone display order: Time first, then Fire/Water/Air/Vex Thal, then the rest. */
const ZONE_ORDER = [
  'Plane of Time',
  'Plane of Fire',
  'Plane of Water',
  'Plane of Air',
  'Vex Thal',
]
/** Within Plane of Time, mob/group order (match by first mob in row). Names normalized for match (lowercase, spaces → underscores). */
const PLANE_OF_TIME_MOB_ORDER = [
  'P1',
  'Earthen_Overseer',
  'Gutripping_War_Beast',
  'Ralthos_Enrok',
  'A_Deadly_Warboar',
  'Avatar_of_the_Elements',
  'Saryrn',
  'Terris_Thule',
  'Tallon_Zek',
  'Vallon_Zek',
  'Bertoxxulous',
  'Cazic_Thule',
  'Rallos_Zek',
  'Innoruuk',
  'Quarm',
]
const POT_ORDER_MAP = new Map(PLANE_OF_TIME_MOB_ORDER.map((name, i) => [name.toLowerCase().replace(/\s+/g, '_'), i]))

/** Force specific mobs to the correct zone (overrides JSON/raid inference when wrong). */
const MOB_ZONE_OVERRIDES = {
  'a_monsterous_mudwalker': 'Plane of Earth',
  'a_mystical_arbitor_of_earth': 'Plane of Earth',
  'a_perfected_warder_of_earth': 'Plane of Earth',
  'peregrin_rockskull': 'Plane of Earth',
  'tribal_leader_diseranon': 'Plane of Earth',
  'avatar_of_earth': 'Tower of Solusek Ro',
  'the_protector_of_dresolik': 'Tower of Solusek Ro',
  'rizlona': 'Tower of Solusek Ro',
}

function mobSortKeyForPlaneOfTime(entry) {
  const names = (entry.mobs && entry.mobs.length) ? entry.mobs : [entry.mob]
  const normalized = names.map((n) => (n || '').replace(/^#/, '').trim().toLowerCase().replace(/\s+/g, '_'))
  let idx = PLANE_OF_TIME_MOB_ORDER.length
  for (const n of normalized) {
    const i = POT_ORDER_MAP.get(n)
    if (i !== undefined && i < idx) idx = i
  }
  return idx
}

/** Infer canonical zone from raid title (e.g. "Potime", "Time Day 1" -> "Plane of Time"). */
function inferZoneFromRaidName(raidName) {
  if (!raidName || typeof raidName !== 'string') return ''
  const s = raidName.toLowerCase().trim()
  const rules = [
    { keys: ['plane of time', 'potime', 'time day', 'time p1', 'time raid', 'time p1-4', 'slinkytime', 'time again', 'time for time', 'p1-3', 'p1-4', 'p2 ', 'p3 ', 'p4 '], zone: 'Plane of Time' },
    { keys: ['plane of water', 'water minis', 'coirnav', 'hydrotha', 'corinav'], zone: 'Plane of Water' },
    { keys: ['plane of fire', 'fire minis', 'fennin'], zone: 'Plane of Fire' },
    { keys: ['plane of earth', 'poe2', 'poe ', 'poe kill', ' earth ', 'tantisala', 'rathe council', 'earth stuff'], zone: 'Plane of Earth' },
    { keys: ['plane of air', ' air ', 'xegony', 'sigismond'], zone: 'Plane of Air' },
    { keys: ['vex thal', ' vt ', 'tvx'], zone: 'Vex Thal' },
    { keys: ['temple of veeshan', ' tov ', 'vulak', 'veeshan'], zone: 'Temple of Veeshan' },
    { keys: ['ssra', 'ssraeshza', 'empire'], zone: 'Temple of Ssraeshza' },
    { keys: ['cursed', 'necropolis'], zone: 'The Cursed Necropolis' },
    { keys: ['sleeper', 'tomb'], zone: "Sleeper's Tomb" },
    { keys: ['kael', 'drakkal'], zone: 'Kael Drakkal' },
    { keys: ['dozekar', ' doze '], zone: 'Dozekar' },
    { keys: ['burrower', 'deep burrower'], zone: 'Deep' },
    { keys: ['rhag', 'rhags'], zone: 'The Grey' },
    { keys: ['nagafen', 'nagafen\'s'], zone: "Nagafen's Lair" },
    { keys: ['icewell', 'dain'], zone: 'Icewell Keep' },
  ]
  for (const { keys, zone } of rules) {
    if (keys.some((k) => s.includes(k))) return zone
  }
  return ''
}

function normalizeMobKey(mob) {
  if (!mob || typeof mob !== 'string') return ''
  return mob.replace(/^#/, '').replace(/\|$/, '').trim().toLowerCase()
}

/**
 * Lists mobs and their DKP loot from data/dkp_mob_loot.json (copied to web/public/dkp_mob_loot.json).
 * Zones enriched from raid_classifications + raid names (e.g. Bertoxxulous -> Plane of Time). Grouped by zone.
 */
export default function MobLoot() {
  const [data, setData] = useState(null)
  const [raidItemSources, setRaidItemSources] = useState(null)
  const [query, setQuery] = usePersistedState('/mobs:query', '')
  const [filterSlot, setFilterSlot] = usePersistedState('/mobs:filterSlot', '')
  const [filterClass, setFilterClass] = usePersistedState('/mobs:filterClass', '')
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState({})
  const [itemsShownPerKey, setItemsShownPerKey] = useState({}) // key -> number to show
  const [itemLast3, setItemLast3] = useState({})
  const [mobZoneFromRaids, setMobZoneFromRaids] = useState({})
  const [itemStatsReady, setItemStatsReady] = useState(false)

  useEffect(() => {
    ensureItemStatsLoaded().then(() => setItemStatsReady(true)).catch(() => {})
    ensureElementalArmorLoaded().catch(() => {})
  }, [])

  const nameToId = useMemo(() => {
    const fromMobLoot = buildNameToIdFromMobLoot(data)
    const fromRaid = buildNameToIdFromRaid(raidItemSources)
    return { ...fromRaid, ...fromMobLoot }
  }, [data, raidItemSources])

  useEffect(() => {
    getRaidItemSources().then(setRaidItemSources)
  }, [])

  useEffect(() => {
    getDkpMobLoot()
      .then((json) => setData(json || null))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const { data: raidRows } = await supabase.from('raids').select('raid_id, raid_name')
      if (cancelled) return
      const raidIdToName = {}
      ;(raidRows || []).forEach((r) => { raidIdToName[r.raid_id] = (r.raid_name || '').trim() })

      const allClass = []
      let from = 0
      const PAGE = 2000
      while (true) {
        const { data: chunk } = await supabase.from('raid_classifications').select('raid_id, mob, zone').range(from, from + PAGE - 1)
        if (cancelled) return
        if (!chunk?.length) break
        allClass.push(...chunk)
        if (chunk.length < PAGE) break
        from += PAGE
      }
      if (cancelled) return

      const mobToZones = {}
      allClass.forEach((row) => {
        const mob = (row.mob || '').trim()
        if (!mob) return
        const key = normalizeMobKey(mob)
        const zoneFromDb = (row.zone || '').trim()
        const raidName = raidIdToName[row.raid_id] || ''
        const inferred = inferZoneFromRaidName(raidName)
        const zone = zoneFromDb || inferred
        if (!zone) return
        if (!mobToZones[key]) mobToZones[key] = []
        mobToZones[key].push(zone)
      })
      const mobToZone = {}
      Object.entries(mobToZones).forEach(([key, zones]) => {
        const counts = {}
        zones.forEach((z) => { counts[z] = (counts[z] || 0) + 1 })
        const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
        if (best) mobToZone[key] = best[0]
      })
      if (!cancelled) setMobZoneFromRaids(mobToZone)
    }
    run()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    const cache = createCache(LAST3_CACHE_KEY, CACHE_TTL)
    const cached = cache.get()
    if (cached && typeof cached === 'object' && Object.keys(cached).length > 0) {
      setItemLast3(cached)
    }

    const PAGE = 1000
    const run = async () => {
      const allLoot = []
      let from = 0
      while (true) {
        const to = from + PAGE - 1
        const { data: chunk } = await supabase.from('raid_loot').select('id, raid_id, item_name, cost').order('id', { ascending: false }).range(from, to)
        if (cancelled) return
        if (!chunk?.length) break
        allLoot.push(...chunk)
        if (chunk.length < PAGE) break
        from += PAGE
      }
      if (cancelled || allLoot.length === 0) return
      const raidIds = [...new Set(allLoot.map((r) => r.raid_id).filter(Boolean))]
      const dateByRaid = {}
      const CHUNK = 500
      for (let i = 0; i < raidIds.length; i += CHUNK) {
        const { data: raidRows } = await supabase.from('raids').select('raid_id, date_iso, date').in('raid_id', raidIds.slice(i, i + CHUNK))
        if (cancelled) return
        ;(raidRows || []).forEach((row) => {
          const iso = (row.date_iso || '').trim().slice(0, 10)
          const isIso = /^\d{4}-\d{2}-\d{2}/.test(iso)
          dateByRaid[row.raid_id] = isIso ? iso : (row.date || '').trim() || ''
        })
      }
      const byItem = {}
      allLoot.forEach((row) => {
        const name = (row.item_name || '').trim().toLowerCase()
        if (!name) return
        if (!byItem[name]) byItem[name] = []
        byItem[name].push({ id: row.id, cost: row.cost, date: dateByRaid[row.raid_id] || '' })
      })
      const last3Map = {}
      Object.entries(byItem).forEach(([key, arr]) => {
        arr.sort((a, b) => {
          const da = /^\d{4}-\d{2}-\d{2}/.test(String(a.date || '').trim()) ? String(a.date).slice(0, 10) : '9999-99-99'
          const db = /^\d{4}-\d{2}-\d{2}/.test(String(b.date || '').trim()) ? String(b.date).slice(0, 10) : '9999-99-99'
          const cmp = db.localeCompare(da)
          if (cmp !== 0) return cmp
          return (b.id ?? 0) - (a.id ?? 0)
        })
        const recent = arr.slice(0, 3)
        const costs = recent.map((r) => Number(r.cost))
        const avg = costs.length ? (costs.reduce((s, c) => s + c, 0) / costs.length).toFixed(1) : null
        last3Map[key] = { values: recent.map((r) => r.cost ?? '—'), avg }
      })
      if (!cancelled) {
        setItemLast3(last3Map)
        cache.set(last3Map)
      }
    }
    run()
    return () => { cancelled = true }
  }, [])

  const entries = useMemo(() => {
    if (!data || typeof data !== 'object') return []
    const list = Object.entries(data)
      .filter(([_, v]) => v && typeof v === 'object' && Array.isArray(v.loot) && (v.loot || []).length > 0)
      .map(([key, v]) => ({
        key,
        mob: v.mob || key.replace(/\|$/, ''),
        mobs: Array.isArray(v.mobs) ? v.mobs : null,
        zone: v.zone || '',
        loot: v.loot || [],
      }))
    return list.sort((a, b) => (a.mob || '').localeCompare(b.mob || ''))
  }, [data])

  const entriesWithZone = useMemo(() => {
    return entries.map((e) => {
      const fromJson = (e.zone || '').trim()
      const mobKeys = e.mobs?.length ? e.mobs : [e.mob]
      const overrideKey = mobKeys.map((m) => (m || '').replace(/^#/, '').trim().toLowerCase().replace(/\s+/g, '_')).find((k) => MOB_ZONE_OVERRIDES[k])
      if (overrideKey) {
        return { ...e, displayZone: MOB_ZONE_OVERRIDES[overrideKey] }
      }
      const fromRaids = mobKeys.map((m) => mobZoneFromRaids[normalizeMobKey(m)]).find(Boolean)
      let displayZone = fromJson || fromRaids || 'Other / Unknown'
      const isAvatarOfWar = mobKeys.some((m) => /avatar\s*of\s*war|avatar_of_war/i.test((m || '').replace(/^#/, '')))
      if (isAvatarOfWar) displayZone = 'Kael Drakkel'
      return { ...e, displayZone }
    })
  }, [entries, mobZoneFromRaids])

  /** Merge entries that are the same mob in the same zone (e.g. one from dkp, one from raid_item_sources). */
  const entriesMergedByMobAndZone = useMemo(() => {
    const zoneMobToEntries = new Map()
    entriesWithZone.forEach((e) => {
      const z = (e.displayZone || '').trim() || 'Other / Unknown'
      const mobNames = (e.mobs?.length ? e.mobs : [e.mob]).map((m) => (m || '').replace(/^#/, '').trim()).filter(Boolean)
      const mobSig = [...new Set(mobNames)].sort((a, b) => a.localeCompare(b)).join('\n')
      const key = `${z}\n${mobSig}`
      if (!zoneMobToEntries.has(key)) zoneMobToEntries.set(key, [])
      zoneMobToEntries.get(key).push(e)
    })
    const result = []
    zoneMobToEntries.forEach((group) => {
      if (group.length === 1) {
        result.push({ ...group[0], key: group[0].key })
        return
      }
      const first = group[0]
      const displayZone = (first.displayZone || '').trim() || 'Other / Unknown'
      const mobsSet = new Set()
      const lootByKey = new Map() // item_id or name -> { item, sources Set }
      group.forEach((e) => {
        (e.mobs?.length ? e.mobs : [e.mob]).forEach((m) => mobsSet.add((m || '').replace(/^#/, '').trim()))
        ;(e.loot || []).forEach((item) => {
          const id = item.item_id ?? item.name
          const k = id != null ? String(id) : (item.name || '').trim().toLowerCase()
          if (!lootByKey.has(k)) {
            lootByKey.set(k, { item: { ...item }, sources: new Set(item.sources || []) })
          } else {
            const existing = lootByKey.get(k)
            ;(item.sources || []).forEach((s) => existing.sources.add(s))
          }
        })
      })
      const mobs = [...mobsSet].filter(Boolean).sort((a, b) => a.localeCompare(b))
      const loot = [...lootByKey.values()].map(({ item, sources }) => ({
        ...item,
        sources: [...sources].sort(),
      }))
      const mergedKey = `${mobs[0] || 'mob'}|${displayZone}|merged`
      result.push({
        key: mergedKey,
        mob: mobs[0] || first.mob,
        mobs,
        zone: first.zone,
        displayZone,
        loot,
      })
    })
    return result
  }, [entriesWithZone])

  /** Use JSON mobs array when present; otherwise group entries with same zone + same loot (backward compat). */
  const entriesGrouped = useMemo(() => {
    const hasGroupedFormat = entriesMergedByMobAndZone.length > 0 && entriesMergedByMobAndZone.every((e) => Array.isArray(e.mobs) && e.mobs.length > 0)
    if (hasGroupedFormat) return entriesMergedByMobAndZone
    const lootKey = (loot) => (loot || []).map((x) => x.item_id ?? x.name).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b))).join(',')
    const byGroup = new Map()
    entriesMergedByMobAndZone.forEach((e) => {
      const z = (e.displayZone || '').trim() || 'Other / Unknown'
      const sig = lootKey(e.loot)
      const key = `${z}|${sig}`
      if (!byGroup.has(key)) {
        byGroup.set(key, {
          key,
          mob: e.mob,
          mobs: [],
          zone: e.zone,
          displayZone: z,
          loot: e.loot || [],
        })
      }
      const g = byGroup.get(key)
      const name = (e.mob || '').replace(/^#/, '').trim()
      if (name && !g.mobs.includes(name)) g.mobs.push(name)
    })
    return Array.from(byGroup.values()).map((g) => ({
      ...g,
      mobs: g.mobs.length ? g.mobs.sort((a, b) => a.localeCompare(b)) : null,
    }))
  }, [entriesMergedByMobAndZone])

  const filtered = useMemo(() => {
    let list = entriesGrouped
    const q = (query || '').trim().toLowerCase()
    if (q) {
      const mobNames = (e) => (e.mobs?.length ? e.mobs : [e.mob]).filter(Boolean).join(' ').toLowerCase()
      const itemNames = (e) => (e.loot || []).map((item) => (item.name || '').trim().toLowerCase()).filter(Boolean).join(' ')
      list = list.filter(
        (e) =>
          mobNames(e).includes(q) ||
          (e.displayZone || '').toLowerCase().includes(q) ||
          itemNames(e).includes(q)
      )
    }
    return list
  }, [entriesGrouped, query])

  /** For a mob's loot list: filter by slot/class and sort by gear score (desc). When class is selected, elemental molds resolve to class-specific armor for display and filtering. */
  const getFilteredAndSortedLoot = useCallback((loot) => {
    if (!loot?.length) return []
    const withStats = loot.map((item) => {
      const name = (item.name || '').trim().toLowerCase()
      const moldId = item.item_id ?? nameToId[name]
      const moldInfo = getMoldInfo(moldId)
      const armorId = filterClass && moldInfo ? getArmorIdForMoldAndClass(moldId, filterClass) : null
      const statsId = armorId ?? moldId
      const stats = getItemStatsCached(statsId)
      return {
        item,
        itemId: moldId,
        stats,
        moldInfo: moldInfo || null,
        moldName: armorId ? moldInfo.mold_name : null,
        displayItemId: armorId ?? null,
      }
    })
    let list = withStats
    if (filterSlot) {
      list = list.filter(({ stats, moldInfo }) => {
        if (itemHasSlot(stats, filterSlot)) return true
        if (moldInfo && elementalSlotMatchesFilter(moldInfo.slot, filterSlot)) return true
        return false
      })
    }
    if (filterClass) {
      list = list.filter(({ stats, moldInfo, displayItemId }) => {
        if (moldInfo && displayItemId) return true
        return itemUsableByClass(stats, filterClass)
      })
    }
    list = [...list].sort((a, b) => getGearScore(b.stats) - getGearScore(a.stats))
    return list
  }, [nameToId, filterSlot, filterClass, itemStatsReady])

  /** When slot/class filter is on, hide mobs that have no matching items and attach max gear score for sorting. */
  const filteredForDisplay = useMemo(() => {
    if (!filterSlot && !filterClass) return filtered
    return filtered
      .map((e) => {
        const loot = getFilteredAndSortedLoot(e.loot)
        if (loot.length === 0) return null
        const maxGearScore = getGearScore(loot[0].stats) // loot already sorted desc by gear score
        return { ...e, maxGearScore }
      })
      .filter(Boolean)
  }, [filtered, filterSlot, filterClass, getFilteredAndSortedLoot])

  const byZone = useMemo(() => {
    const groups = {}
    filteredForDisplay.forEach((e) => {
      const z = (e.displayZone || '').trim() || 'Other / Unknown'
      if (!groups[z]) groups[z] = []
      groups[z].push(e)
    })
    const zoneOrderSet = new Set(ZONE_ORDER)
    const sortByGearScore = (a, b) => (b.maxGearScore ?? 0) - (a.maxGearScore ?? 0) || (a.mob || '').localeCompare(b.mob || '')
    Object.keys(groups).forEach((z) => {
      if (filterSlot || filterClass) {
        groups[z].sort(sortByGearScore)
      } else if (z === 'Plane of Time') {
        groups[z].sort((a, b) => {
          const ka = mobSortKeyForPlaneOfTime(a)
          const kb = mobSortKeyForPlaneOfTime(b)
          if (ka !== kb) return ka - kb
          return (a.mob || '').localeCompare(b.mob || '')
        })
      } else {
        groups[z].sort((a, b) => (a.mob || '').localeCompare(b.mob || ''))
      }
    })
    const zoneEntries = Object.entries(groups)
    const zoneMaxGearScore = (entries) => Math.max(0, ...(entries || []).map((e) => e.maxGearScore ?? 0))
    const totalLoot = (entries) => entries.reduce((sum, e) => sum + (e.loot?.length || 0), 0)
    const bottomZones = new Set(['Other / Unknown', '—', ''])
    zoneEntries.sort((a, b) => {
      const [zoneA, entriesA] = a
      const [zoneB, entriesB] = b
      if (filterSlot || filterClass) {
        const scoreA = zoneMaxGearScore(entriesA)
        const scoreB = zoneMaxGearScore(entriesB)
        if (scoreB !== scoreA) return scoreB - scoreA
        return zoneA.localeCompare(zoneB)
      }
      const aInOrder = zoneOrderSet.has(zoneA)
      const bInOrder = zoneOrderSet.has(zoneB)
      if (aInOrder && bInOrder) return ZONE_ORDER.indexOf(zoneA) - ZONE_ORDER.indexOf(zoneB)
      if (aInOrder) return -1
      if (bInOrder) return 1
      if (bottomZones.has(zoneA) && bottomZones.has(zoneB)) return zoneA.localeCompare(zoneB)
      if (bottomZones.has(zoneA)) return 1
      if (bottomZones.has(zoneB)) return -1
      return totalLoot(entriesB) - totalLoot(entriesA)
    })
    return zoneEntries
  }, [filteredForDisplay, filterSlot, filterClass])

  /** When filtering by slot/class, auto-expand mobs that have <3 matching items. */
  useEffect(() => {
    if (!filterSlot && !filterClass) return
    const toExpand = {}
    filteredForDisplay.forEach((e) => {
      const loot = getFilteredAndSortedLoot(e.loot)
      if (loot.length > 0 && loot.length < 3) toExpand[e.key] = true
    })
    if (Object.keys(toExpand).length === 0) return
    setExpanded((prev) => ({ ...prev, ...toExpand }))
  }, [filterSlot, filterClass, filteredForDisplay, getFilteredAndSortedLoot])

  const toggle = (key) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const showMoreItems = (key) => {
    setItemsShownPerKey((prev) => ({ ...prev, [key]: (prev[key] || ITEMS_PER_PAGE) + ITEMS_PER_PAGE }))
  }

  if (loading) return <div className="container">Loading raid items…</div>
  if (!data) {
    return (
      <div className="container">
        <p className="error">Could not load dkp_mob_loot.json. Copy data/dkp_mob_loot.json to web/public/ or run the build script with --copy-dkp-mob-loot.</p>
      </div>
    )
  }

  return (
    <div className="container">
      <h1>Raid Items</h1>
      <p style={{ color: '#71717a', marginBottom: '1rem' }}>
        DKP loot table per mob. Search by item, mob, or zone; filter by slot and class; items sorted by gear score (saves + AC + HP/3).
      </p>
      <div className="search-bar mob-loot-filters">
        <label>
          <span className="filter-label">Search item, mob, or zone</span>
          <input
            type="search"
            placeholder="e.g. Vulak, Plane of Time, or item name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search by item, mob, or zone"
          />
        </label>
        <label>
          <span className="filter-label">Slot</span>
          <select
            className="filter-select"
            value={filterSlot}
            onChange={(e) => setFilterSlot(e.target.value)}
            aria-label="Filter by equipment slot"
          >
            <option value="">Any slot</option>
            {SLOT_OPTIONS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="filter-label">Class</span>
          <select
            className="filter-select"
            value={filterClass}
            onChange={(e) => setFilterClass(e.target.value)}
            aria-label="Filter by class"
          >
            <option value="">Any class</option>
            {CLASS_OPTIONS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      <p style={{ color: '#71717a', fontSize: '0.875rem', marginBottom: '1rem' }}>
        {filteredForDisplay.length} mob{filteredForDisplay.length !== 1 ? 's' : ''} (grouped by zone)
      </p>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th style={{ width: '2rem' }}></th>
              <th>Mob</th>
              <th>Zone</th>
              <th>Loot count</th>
            </tr>
          </thead>
          <tbody>
            {byZone.map(([zoneName, zoneEntries]) => (
              <Fragment key={zoneName}>
                <tr style={{ backgroundColor: 'rgba(0,0,0,0.25)' }}>
                  <td colSpan={4} style={{ padding: '0.5rem 0.75rem', fontWeight: 600, color: '#a78bfa', borderBottom: '1px solid #27272a' }}>
                    {zoneName}
                  </td>
                </tr>
                {zoneEntries.map((e) => {
                  const isOpen = expanded[e.key]
                  const filteredLoot = getFilteredAndSortedLoot(e.loot)
                  const limit = itemsShownPerKey[e.key] ?? ITEMS_PER_PAGE
                  const visibleLoot = filteredLoot.slice(0, limit)
                  const hasMore = filteredLoot.length > limit
                  return (
                    <Fragment key={e.key}>
                      <tr>
                        <td>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            style={{ padding: '0.25rem', fontSize: '1rem' }}
                            onClick={() => toggle(e.key)}
                            aria-expanded={isOpen}
                          >
                            {isOpen ? '−' : '+'}
                          </button>
                        </td>
                        <td>{(e.mobs?.length ? e.mobs.join(', ') : (e.mob || '')).replace(/^#/, '')}</td>
                        <td style={{ color: '#a1a1aa' }}>{e.displayZone || '—'}</td>
                        <td>
                          {(filterSlot || filterClass) ? `${filteredLoot.length} / ${e.loot.length}` : e.loot.length}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr key={`${e.key}-exp`}>
                          <td colSpan={4} style={{ padding: '0.5rem 1rem', verticalAlign: 'top', backgroundColor: 'rgba(0,0,0,0.2)' }}>
                            {filteredLoot.length === 0 ? (
                              <p style={{ color: '#71717a', fontSize: '0.875rem', margin: 0 }}>
                                No items match the current slot/class filter.
                              </p>
                            ) : (
                              <>
                                <table style={{ margin: 0 }}>
                                  <thead>
                                    <tr><th>Item (sorted by gear score)</th><th>DKP (last 3 / avg)</th></tr>
                                  </thead>
                                  <tbody>
                                    {visibleLoot.map(({ item, itemId, stats, moldName, displayItemId }) => {
                                      const name = item.name || '—'
                                      const last3 = itemLast3[(name || '').trim().toLowerCase()]
                                      const dkpStr = last3?.values?.length
                                        ? (last3.avg != null ? `${last3.values.join(', ')} (avg ${last3.avg})` : last3.values.join(', '))
                                        : '—'
                                      const displayName = (displayItemId && stats?.name) ? stats.name : name
                                      const rowItemId = displayItemId ?? itemId
                                      return (
                                        <tr key={item.item_id || item.name}>
                                          <td style={{ verticalAlign: 'middle', maxWidth: '420px' }}>
                                            <InlineItemRow name={displayName} itemId={rowItemId} showGearScore moldName={moldName} initialStats={stats} />
                                          </td>
                                          <td style={{ fontSize: '0.875rem', color: '#a78bfa', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
                                            {dkpStr}
                                          </td>
                                        </tr>
                                      )
                                    })}
                                  </tbody>
                                </table>
                                {hasMore && (
                                  <p style={{ margin: '0.5rem 0 0', fontSize: '0.875rem' }}>
                                    <button type="button" className="btn btn-ghost" onClick={() => showMoreItems(e.key)}>
                                      Show {Math.min(ITEMS_PER_PAGE, filteredLoot.length - limit)} more
                                    </button>
                                  </p>
                                )}
                              </>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
