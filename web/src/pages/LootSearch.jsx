import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// Item name -> drops from (mob/zone). Loaded from web/public/item_sources.json (built from items_seen_to_mobs + raid_loot_classification).
function itemSourceLabel(itemSources, itemName) {
  if (!itemSources || !itemName) return null
  const key = String(itemName).trim().toLowerCase()
  const arr = itemSources[key]
  if (!arr || !arr.length) return null
  const first = arr[0]
  const mob = first.mob || ''
  const zone = first.zone || ''
  if (!mob) return null
  return zone ? `${mob.replace(/^#/, '')} (${zone})` : mob.replace(/^#/, '')
}

export default function LootSearch() {
  const [loot, setLoot] = useState([])
  const [raids, setRaids] = useState({})
  const [classifications, setClassifications] = useState({})
  const [itemSources, setItemSources] = useState(null)
  const [itemQuery, setItemQuery] = useState('')
  const [mobFilter, setMobFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const limit = 50000
    Promise.all([
      supabase.from('raid_loot').select('id, raid_id, event_id, item_name, character_name, char_id, cost').limit(limit),
      supabase.from('raids').select('raid_id, raid_name, date_iso').limit(limit),
    ]).then(([l, r]) => {
      if (l.error) {
        setError(l.error.message)
        setLoading(false)
        return
      }
      setLoot(l.data || [])
      const raidMap = {}
      ;(r.data || []).forEach((row) => { raidMap[row.raid_id] = { name: row.raid_name || row.raid_id, date_iso: row.date_iso || '' } })
      setRaids(raidMap)
      setLoading(false)
    })
    supabase.from('raid_classifications').select('raid_id, mob').limit(limit).then(({ data }) => {
      const raidByMob = {}
      ;(data || []).forEach((row) => {
        if (!raidByMob[row.mob]) raidByMob[row.mob] = []
        if (!raidByMob[row.mob].includes(row.raid_id)) raidByMob[row.mob].push(row.raid_id)
      })
      setClassifications(raidByMob)
    })
    fetch('/item_sources.json')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => setItemSources(json || null))
      .catch(() => setItemSources(null))
  }, [])

  const mobOptions = useMemo(() => {
    const mobs = Object.keys(classifications).filter((m) => m).sort()
    return mobs.map((m) => ({ value: m, label: m.replace(/^#/, '') }))
  }, [classifications])

  const filteredLoot = useMemo(() => {
    let list = loot
    const q = (itemQuery || '').trim().toLowerCase()
    if (q) {
      list = list.filter((row) => (row.item_name || '').toLowerCase().includes(q))
    }
    if (mobFilter) {
      const raidIds = classifications[mobFilter]
      if (raidIds && raidIds.length) {
        const set = new Set(raidIds)
        list = list.filter((row) => set.has(row.raid_id))
      }
    }
    const dateIso = (raidId) => (raids[raidId] && raids[raidId].date_iso) ? String(raids[raidId].date_iso).slice(0, 10) : ''
    list = [...list].sort((a, b) => (dateIso(b.raid_id) || '').localeCompare(dateIso(a.raid_id) || ''))
    return list
  }, [loot, itemQuery, mobFilter, classifications, raids])

  if (loading) return <div className="container">Loading loot…</div>
  if (error) return <div className="container"><span className="error">{error}</span></div>

  return (
    <div className="container">
      <h1>Loot &amp; DKP by item or raid type</h1>
      <p style={{ color: '#71717a', marginBottom: '1rem' }}>
        Search by exact item name or filter by raid type (mobs we killed). Shows cost (DKP spent) per row.
      </p>
      <div className="search-bar">
        <label>
          <span style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', color: '#a1a1aa' }}>Item name</span>
          <input
            type="search"
            placeholder="e.g. Mithril Helm"
            value={itemQuery}
            onChange={(e) => setItemQuery(e.target.value)}
            aria-label="Search by item name"
          />
        </label>
        <label>
          <span style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', color: '#a1a1aa' }}>Raid type (mob)</span>
          <select
            className="filter-select"
            value={mobFilter}
            onChange={(e) => setMobFilter(e.target.value)}
            aria-label="Filter by raid type"
          >
            <option value="">All raids</option>
            {mobOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </label>
      </div>
      <p style={{ color: '#71717a', fontSize: '0.875rem', marginBottom: '1rem' }}>
        {filteredLoot.length} row{filteredLoot.length !== 1 ? 's' : ''}
      </p>
      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Item</th>
                <th>Drops from</th>
                <th>Raid</th>
                <th>Character</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {filteredLoot.slice(0, 500).map((row, i) => (
                <tr key={row.id || `${row.raid_id}-${row.item_name}-${i}`}>
                  <td style={{ color: '#a1a1aa', fontSize: '0.875rem' }}>{(raids[row.raid_id]?.date_iso || '').slice(0, 10) || '—'}</td>
                  <td><Link to={`/items/${encodeURIComponent(row.item_name || '')}`}>{row.item_name || '—'}</Link></td>
                  <td style={{ color: '#a1a1aa', fontSize: '0.875rem' }}>
                    {itemSourceLabel(itemSources, row.item_name) ?? '—'}
                  </td>
                  <td><Link to={`/raids/${row.raid_id}`}>{raids[row.raid_id]?.name ?? row.raid_id}</Link></td>
                  <td><Link to={`/characters/${encodeURIComponent(row.character_name || row.char_id || '')}`}>{row.character_name || row.char_id || '—'}</Link></td>
                  <td>{row.cost ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filteredLoot.length > 500 && (
          <p style={{ marginTop: '0.75rem', color: '#71717a', fontSize: '0.875rem' }}>
            Showing first 500. Narrow by item or raid type to see more.
          </p>
        )}
      </div>
    </div>
  )
}
