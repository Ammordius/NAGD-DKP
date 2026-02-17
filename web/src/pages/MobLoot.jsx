import { useEffect, useState, useMemo, Fragment } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { createCache } from '../lib/cache'
import ItemLink from '../components/ItemLink'

const LAST3_CACHE_KEY = 'mob_loot_last3_v2'
const CACHE_TTL = 10 * 60 * 1000

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
  const [query, setQuery] = useState('')
  const [minAvgDkp, setMinAvgDkp] = useState('')
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState({})
  const [itemLast3, setItemLast3] = useState({})
  const [mobZoneFromRaids, setMobZoneFromRaids] = useState({})

  useEffect(() => {
    fetch('/dkp_mob_loot.json')
      .then((res) => (res.ok ? res.json() : null))
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
      const fromRaids = mobKeys.map((m) => mobZoneFromRaids[normalizeMobKey(m)]).find(Boolean)
      const displayZone = fromJson || fromRaids || 'Other / Unknown'
      return { ...e, displayZone }
    })
  }, [entries, mobZoneFromRaids])

  const entriesWithDkp = useMemo(() => {
    return entriesWithZone.map((e) => {
      let totalAvgDkp = 0
      ;(e.loot || []).forEach((item) => {
        const name = (item.name || '').trim().toLowerCase()
        const avg = itemLast3[name]?.avg
        if (avg != null) totalAvgDkp += parseFloat(avg) || 0
      })
      return { ...e, totalAvgDkp }
    })
  }, [entriesWithZone, itemLast3])

  const filtered = useMemo(() => {
    let list = entriesWithDkp
    const q = (query || '').trim().toLowerCase()
    if (q) {
      const mobNames = (e) => (e.mobs?.length ? e.mobs : [e.mob]).filter(Boolean).join(' ').toLowerCase()
      list = list.filter(
        (e) =>
          mobNames(e).includes(q) ||
          (e.displayZone || '').toLowerCase().includes(q)
      )
    }
    const min = parseFloat(minAvgDkp)
    if (!Number.isNaN(min) && min > 0) {
      list = list.filter((e) => e.totalAvgDkp >= min)
    }
    return list
  }, [entriesWithDkp, query, minAvgDkp])

  const byZone = useMemo(() => {
    const groups = {}
    filtered.forEach((e) => {
      const z = (e.displayZone || '').trim() || 'Other / Unknown'
      if (!groups[z]) groups[z] = []
      groups[z].push(e)
    })
    Object.keys(groups).forEach((z) => {
      groups[z].sort((a, b) => (a.mob || '').localeCompare(b.mob || ''))
    })
    const bottomZones = new Set(['Other / Unknown', '—', ''])
    const zoneEntries = Object.entries(groups)
    const totalDkp = (entries) => entries.reduce((sum, e) => sum + (e.totalAvgDkp || 0), 0)
    zoneEntries.sort((a, b) => {
      const [zoneA, entriesA] = a
      const [zoneB, entriesB] = b
      const aBottom = bottomZones.has(zoneA)
      const bBottom = bottomZones.has(zoneB)
      if (aBottom && bBottom) return zoneA.localeCompare(zoneB)
      if (aBottom) return 1
      if (bBottom) return -1
      return totalDkp(entriesB) - totalDkp(entriesA)
    })
    return zoneEntries
  }, [filtered])

  const toggle = (key) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  if (loading) return <div className="container">Loading mob loot…</div>
  if (!data) {
    return (
      <div className="container">
        <p className="error">Could not load dkp_mob_loot.json. Copy data/dkp_mob_loot.json to web/public/ or run the build script with --copy-dkp-mob-loot.</p>
      </div>
    )
  }

  return (
    <div className="container">
      <h1>Loot by mob</h1>
      <p style={{ color: '#71717a', marginBottom: '1rem' }}>
        DKP loot table per mob. Zones from dkp_mob_loot or inferred from raid names (e.g. Potime → Plane of Time). Search by mob or zone.
      </p>
      <div className="search-bar">
        <label>
          <span style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', color: '#a1a1aa' }}>Search mob or zone</span>
          <input
            type="search"
            placeholder="e.g. Vulak or Plane of Time"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search mob or zone"
          />
        </label>
        <label>
          <span style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', color: '#a1a1aa' }}>Min total avg DKP</span>
          <input
            type="number"
            min={0}
            step={1}
            placeholder="e.g. 50"
            value={minAvgDkp}
            onChange={(e) => setMinAvgDkp(e.target.value)}
            aria-label="Minimum total average DKP"
            style={{ maxWidth: '120px' }}
          />
        </label>
      </div>
      <p style={{ color: '#71717a', fontSize: '0.875rem', marginBottom: '1rem' }}>
        {filtered.length} mob{filtered.length !== 1 ? 's' : ''} (grouped by zone)
      </p>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th style={{ width: '2rem' }}></th>
              <th>Mob</th>
              <th>Zone</th>
              <th>Loot count</th>
              <th>Total avg DKP</th>
            </tr>
          </thead>
          <tbody>
            {byZone.map(([zoneName, zoneEntries]) => (
              <Fragment key={zoneName}>
                <tr style={{ backgroundColor: 'rgba(0,0,0,0.25)' }}>
                  <td colSpan={5} style={{ padding: '0.5rem 0.75rem', fontWeight: 600, color: '#a78bfa', borderBottom: '1px solid #27272a' }}>
                    {zoneName}
                  </td>
                </tr>
                {zoneEntries.map((e) => {
                  const isOpen = expanded[e.key]
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
                        <td>{e.loot.length}</td>
                        <td style={{ color: '#a78bfa' }}>{e.totalAvgDkp > 0 ? Number(e.totalAvgDkp).toFixed(1) : '—'}</td>
                      </tr>
                      {isOpen && (
                        <tr key={`${e.key}-exp`}>
                          <td colSpan={5} style={{ padding: '0.5rem 1rem', verticalAlign: 'top', backgroundColor: 'rgba(0,0,0,0.2)' }}>
                            <table style={{ margin: 0 }}>
                              <thead>
                                <tr><th>Item</th><th>Last 3 drops (DKP)</th><th>Rolling avg</th><th>Sources</th></tr>
                              </thead>
                              <tbody>
                                {e.loot.map((item) => {
                                  const name = item.name || '—'
                                  const last3 = itemLast3[(name || '').trim().toLowerCase()]
                                  return (
                                    <tr key={item.item_id || item.name}>
                                      <td>
                                        <ItemLink itemName={name} itemId={item.item_id}>{name}</ItemLink>
                                      </td>
                                      <td style={{ fontSize: '0.875rem' }}>
                                        {last3?.values?.length ? last3.values.join(', ') : '—'}
                                      </td>
                                      <td style={{ fontSize: '0.875rem', color: '#a78bfa' }}>
                                        {last3?.avg != null ? last3.avg : '—'}
                                      </td>
                                      <td style={{ fontSize: '0.875rem', color: '#a1a1aa' }}>{(item.sources || []).join(', ') || '—'}</td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
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
