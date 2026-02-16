import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useCharToAccountMap } from '../lib/useCharToAccountMap'

const LOOT_CACHE_KEY = 'loot_search_cache_v2'
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes

// Normalize mob name for comparison (strip # and trim, lowercase)
function normMob(m) {
  return (m || '').replace(/^#/, '').trim().toLowerCase()
}

// Item name -> drops from (mob/zone). Infer which mob dropped it using raid context when multiple sources exist.
function itemSourceLabel(itemSources, itemName, raidId, raidName, raidToMobs) {
  if (!itemSources || !itemName) return null
  const key = String(itemName).trim().toLowerCase()
  const arr = itemSources[key]
  if (!arr || !arr.length) return null
  const format = (s) => {
    const mob = (s.mob || '').replace(/^#/, '').trim()
    const zone = (s.zone || '').trim()
    if (!mob) return null
    return zone ? `${mob} (${zone})` : mob
  }
  if (arr.length === 1) return format(arr[0])
  const raidMobs = raidId && raidToMobs && raidToMobs[raidId] ? new Set([...raidToMobs[raidId]].map(normMob)) : null
  const raidNameLower = (raidName || '').toLowerCase()
  const keywords = [
    { k: ['water', 'plane of water', 'pow', 'minis'], prefer: ['water', 'plane of water'] },
    { k: ['cursed', 'emp', 'empire', 'rhag', 'ssra'], prefer: ['cursed', 'empire', 'ssraeshza', 'ssra', 'temple of ssraeshza'] },
    { k: ['fire', 'plane of fire', 'po fire'], prefer: ['fire', 'plane of fire'] },
    { k: ['earth', 'plane of earth', 'po earth'], prefer: ['earth', 'plane of earth'] },
    { k: ['air', 'plane of air', 'po air'], prefer: ['air', 'plane of air'] },
    { k: ['time', 'pot', 'plane of time'], prefer: ['time', 'plane of time'] },
    { k: ['vex thal', 'vexthal'], prefer: ['vex thal', 'vexthal'] },
  ]
  if (raidMobs && raidMobs.size > 0) {
    const exact = arr.find((s) => raidMobs.has(normMob(s.mob)))
    if (exact) return format(exact)
  }
  for (const { k, prefer } of keywords) {
    if (!k.some((kw) => raidNameLower.includes(kw))) continue
    const match = arr.find((s) => {
      const z = (s.zone || '').toLowerCase()
      const m = normMob(s.mob)
      return prefer.some((p) => z.includes(p) || m.includes(p))
    })
    if (match) return format(match)
  }
  return format(arr[0])
}

function loadCache() {
  try {
    const raw = sessionStorage.getItem(LOOT_CACHE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (!data?.loot || !Array.isArray(data.loot) || !data.raids || typeof data.raids !== 'object') return null
    if (data.fetchedAt && Date.now() - data.fetchedAt > CACHE_TTL_MS) return null
    return data
  } catch {
    return null
  }
}

function saveCache(loot, raids, maxLootId) {
  try {
    const maxId = maxLootId ?? (loot.length ? Math.max(...loot.map((r) => r.id).filter(Number.isFinite)) : 0)
    sessionStorage.setItem(LOOT_CACHE_KEY, JSON.stringify({
      loot,
      raids,
      maxLootId: maxId,
      fetchedAt: Date.now(),
    }))
  } catch (_) { /* ignore */ }
}

export default function LootSearch() {
  const { getAccountId } = useCharToAccountMap()
  const [loot, setLoot] = useState([])
  const [raids, setRaids] = useState({})
  const [classifications, setClassifications] = useState({})
  const [raidToMobs, setRaidToMobs] = useState({})
  const [itemSources, setItemSources] = useState(null)
  const [itemQuery, setItemQuery] = useState('')
  const [mobFilter, setMobFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const PAGE = 1000
    const MAX_LOOT_PAGES = 20

    const cached = loadCache()
    if (cached) {
      setLoot(cached.loot)
      setRaids(cached.raids)
      setLoading(false)
      // Background: fetch only new rows (id > maxLootId)
      const maxId = cached.maxLootId ?? 0
      supabase
        .from('raid_loot')
        .select('id, raid_id, event_id, item_name, character_name, char_id, cost')
        .gt('id', maxId)
        .order('id', { ascending: true })
        .limit(PAGE)
        .then(({ data: newRows, error: err }) => {
          if (err || !newRows?.length) return
          const newRaidIds = [...new Set(newRows.map((r) => r.raid_id).filter(Boolean))]
          const missingRaidIds = newRaidIds.filter((rid) => !cached.raids[rid])
          let nextRaids = cached.raids
          if (missingRaidIds.length > 0) {
            return supabase.from('raids').select('raid_id, raid_name, date_iso, date').in('raid_id', missingRaidIds).then(({ data: raidRows }) => {
              const mergedRaids = { ...cached.raids }
              ;(raidRows || []).forEach((row) => { mergedRaids[row.raid_id] = { name: row.raid_name || row.raid_id, date_iso: row.date_iso || '', date: row.date || '' } })
              const mergedLoot = [...newRows].reverse().concat(cached.loot)
              const newMaxId = Math.max(...mergedLoot.map((r) => r.id).filter(Number.isFinite))
              saveCache(mergedLoot, mergedRaids, newMaxId)
              setLoot(mergedLoot)
              setRaids(mergedRaids)
            })
          }
          const mergedLoot = [...newRows].reverse().concat(cached.loot)
          saveCache(mergedLoot, cached.raids, Math.max(...mergedLoot.map((r) => r.id).filter(Number.isFinite)))
          setLoot(mergedLoot)
        })
    }

    const run = async () => {
      if (cached) return // already showing cache; incremental update above
      const allLoot = []
      for (let from = 0; from < MAX_LOOT_PAGES * PAGE; from += PAGE) {
        const to = from + PAGE - 1
        const { data, error } = await supabase
          .from('raid_loot')
          .select('id, raid_id, event_id, item_name, character_name, char_id, cost')
          .order('id', { ascending: false })
          .range(from, to)
        if (error) {
          setError(error.message)
          setLoading(false)
          return
        }
        allLoot.push(...(data || []))
        if (!data || data.length < PAGE) break
      }
      const raidIds = [...new Set(allLoot.map((r) => r.raid_id).filter(Boolean))]
      const raidMap = {}
      const CHUNK = 500
      for (let i = 0; i < raidIds.length; i += CHUNK) {
        const chunk = raidIds.slice(i, i + CHUNK)
        const { data: raidRows } = await supabase.from('raids').select('raid_id, raid_name, date_iso, date').in('raid_id', chunk)
        ;(raidRows || []).forEach((row) => { raidMap[row.raid_id] = { name: row.raid_name || row.raid_id, date_iso: row.date_iso || '', date: row.date || '' } })
      }
      setLoot(allLoot)
      setRaids(raidMap)
      setLoading(false)
      saveCache(allLoot, raidMap, Math.max(...allLoot.map((r) => r.id).filter(Number.isFinite)))
    }
    run()
    supabase.from('raid_classifications').select('raid_id, mob').limit(50000).then(({ data }) => {
      const raidByMob = {}
      const raidToMobsMap = {}
      ;(data || []).forEach((row) => {
        if (!raidByMob[row.mob]) raidByMob[row.mob] = []
        if (!raidByMob[row.mob].includes(row.raid_id)) raidByMob[row.mob].push(row.raid_id)
        if (!raidToMobsMap[row.raid_id]) raidToMobsMap[row.raid_id] = []
        if (!raidToMobsMap[row.raid_id].includes(row.mob)) raidToMobsMap[row.raid_id].push(row.mob)
      })
      setClassifications(raidByMob)
      setRaidToMobs(raidToMobsMap)
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
    const dateIso = (raidId) => (raids[raidId]?.date_iso && String(raids[raidId].date_iso).trim()) ? String(raids[raidId].date_iso).slice(0, 10) : ''
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
                  <td style={{ color: '#a1a1aa', fontSize: '0.875rem' }}>{(raids[row.raid_id]?.date_iso && String(raids[row.raid_id].date_iso).trim()) ? String(raids[row.raid_id].date_iso).slice(0, 10) : (raids[row.raid_id]?.date || '—')}</td>
                  <td><Link to={`/items/${encodeURIComponent(row.item_name || '')}`}>{row.item_name || '—'}</Link></td>
                  <td style={{ color: '#a1a1aa', fontSize: '0.875rem' }}>
                    {itemSourceLabel(itemSources, row.item_name, row.raid_id, raids[row.raid_id]?.name, raidToMobs) ?? '—'}
                  </td>
                  <td><Link to={`/raids/${row.raid_id}`}>{raids[row.raid_id]?.name ?? row.raid_id}</Link></td>
                  <td>
                    {(() => {
                      const accountId = getAccountId(row.character_name || row.char_id)
                      const to = accountId ? `/accounts/${accountId}` : `/characters/${encodeURIComponent(row.character_name || row.char_id || '')}`
                      return <Link to={to}>{row.character_name || row.char_id || '—'}</Link>
                    })()}
                  </td>
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
