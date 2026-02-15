import { useEffect, useState, useMemo, Fragment } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { createCache } from '../lib/cache'

const LAST3_CACHE_KEY = 'mob_loot_last3_v1'
const CACHE_TTL = 10 * 60 * 1000

/**
 * Lists mobs and their DKP loot from data/dkp_mob_loot.json (copied to web/public/dkp_mob_loot.json).
 * Each entry: { mob, zone, loot: [{ item_id, name, sources }] }.
 * Item names link to item page; last 3 drops (costs) and rolling average from raid_loot.
 */
export default function MobLoot() {
  const [data, setData] = useState(null)
  const [query, setQuery] = useState('')
  const [minAvgDkp, setMinAvgDkp] = useState('')
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState({})
  const [itemLast3, setItemLast3] = useState({})

  useEffect(() => {
    fetch('/dkp_mob_loot.json')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => setData(json || null))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
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
        const { data: chunk } = await supabase.from('raid_loot').select('raid_id, item_name, cost').range(from, to)
        if (cancelled) return
        if (!chunk?.length) break
        allLoot.push(...chunk)
        if (chunk.length < PAGE) break
        from += PAGE
      }
      if (cancelled || allLoot.length === 0) return
      const raidIds = [...new Set(allLoot.map((r) => r.raid_id).filter(Boolean))]
      const { data: raidRows } = await supabase.from('raids').select('raid_id, date_iso').in('raid_id', raidIds)
      if (cancelled) return
      const dateByRaid = {}
      ;(raidRows || []).forEach((row) => { dateByRaid[row.raid_id] = (row.date_iso || '').slice(0, 10) })
      const byItem = {}
      allLoot.forEach((row) => {
        const name = (row.item_name || '').trim().toLowerCase()
        if (!name) return
        if (!byItem[name]) byItem[name] = []
        byItem[name].push({ cost: row.cost, date: dateByRaid[row.raid_id] || '' })
      })
      const last3Map = {}
      Object.entries(byItem).forEach(([key, arr]) => {
        arr.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
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
        zone: v.zone || '',
        loot: v.loot || [],
      }))
    return list.sort((a, b) => (a.mob || '').localeCompare(b.mob || ''))
  }, [data])

  const entriesWithDkp = useMemo(() => {
    return entries.map((e) => {
      let totalAvgDkp = 0
      ;(e.loot || []).forEach((item) => {
        const name = (item.name || '').trim().toLowerCase()
        const avg = itemLast3[name]?.avg
        if (avg != null) totalAvgDkp += parseFloat(avg) || 0
      })
      return { ...e, totalAvgDkp }
    })
  }, [entries, itemLast3])

  const filtered = useMemo(() => {
    let list = entriesWithDkp
    const q = (query || '').trim().toLowerCase()
    if (q) {
      list = list.filter(
        (e) =>
          (e.mob || '').toLowerCase().includes(q) ||
          (e.zone || '').toLowerCase().includes(q)
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
      const z = (e.zone || '').trim() || '—'
      if (!groups[z]) groups[z] = []
      groups[z].push(e)
    })
    Object.keys(groups).forEach((z) => {
      groups[z].sort((a, b) => (a.mob || '').localeCompare(b.mob || ''))
    })
    return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]))
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
        DKP loot table per mob (from dkp_mob_loot.json). Search by mob or zone.
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
                        <td>{e.mob.replace(/^#/, '')}</td>
                        <td style={{ color: '#a1a1aa' }}>{e.zone || '—'}</td>
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
                                        <Link to={`/items/${encodeURIComponent(name)}`}>{name}</Link>
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
