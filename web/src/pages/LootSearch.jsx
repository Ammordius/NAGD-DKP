import { useEffect, useState, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useCharToAccountMap } from '../lib/useCharToAccountMap'
import AssignedLootDisclaimer from '../components/AssignedLootDisclaimer'
import ItemLink from '../components/ItemLink'
import { getDkpMobLoot, getItemSources } from '../lib/staticData'

function buildItemIdMap(mobLoot) {
  const map = {}
  if (!mobLoot || typeof mobLoot !== 'object') return map
  Object.values(mobLoot).forEach((entry) => {
    (entry?.loot || []).forEach((item) => {
      if (item?.name && item?.item_id != null) {
        const key = item.name.trim().toLowerCase()
        if (map[key] == null) map[key] = item.item_id
      }
    })
  })
  return map
}

const LOOT_CACHE_KEY = 'loot_search_cache_v3' // v3: includes assigned_char_id, assigned_character_name
const CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes

// Prevent grid cells from overflowing into adjacent rows/columns
const cellStyle = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

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
  const { getAccountId, getAccountDisplayName } = useCharToAccountMap()
  const [loot, setLoot] = useState([])
  const [raids, setRaids] = useState({})
  const [raidToMobs, setRaidToMobs] = useState({})
  const [itemSources, setItemSources] = useState(null)
  const [mobLoot, setMobLoot] = useState(null)
  const [itemQuery, setItemQuery] = useState('')
  const [sortBy, setSortBy] = useState('date')
  const [sortDesc, setSortDesc] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    getDkpMobLoot().then(setMobLoot)
  }, [])

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
        .from('raid_loot_with_assignment')
        .select('id, raid_id, event_id, item_name, character_name, char_id, cost, assigned_char_id, assigned_character_name')
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
          .from('raid_loot_with_assignment')
          .select('id, raid_id, event_id, item_name, character_name, char_id, cost, assigned_char_id, assigned_character_name')
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
      const raidToMobsMap = {}
      ;(data || []).forEach((row) => {
        if (!raidToMobsMap[row.raid_id]) raidToMobsMap[row.raid_id] = []
        if (!raidToMobsMap[row.raid_id].includes(row.mob)) raidToMobsMap[row.raid_id].push(row.mob)
      })
      setRaidToMobs(raidToMobsMap)
    })
    getItemSources()
      .then((json) => setItemSources(json || null))
      .catch(() => setItemSources(null))
  }, [])

  const itemIdMap = useMemo(() => buildItemIdMap(mobLoot), [mobLoot])

  const filteredLoot = useMemo(() => {
    let list = loot
    const q = (itemQuery || '').trim().toLowerCase()
    if (q) {
      list = list.filter((row) => (row.item_name || '').toLowerCase().includes(q))
    }
    const dateIso = (raidId) => (raids[raidId]?.date_iso && String(raids[raidId].date_iso).trim()) ? String(raids[raidId].date_iso).slice(0, 10) : ''
    const cmp = (a, b) => {
      let raw
      switch (sortBy) {
        case 'item':
          raw = (a.item_name || '').localeCompare(b.item_name || '')
          break
        case 'cost': {
          const ca = a.cost != null ? Number(a.cost) : -1
          const cb = b.cost != null ? Number(b.cost) : -1
          raw = ca - cb
          break
        }
        case 'buyer':
          raw = (a.character_name || a.char_id || '').localeCompare(b.character_name || b.char_id || '')
          break
        case 'toon':
          raw = (a.assigned_character_name || a.assigned_char_id || '').localeCompare(b.assigned_character_name || b.assigned_char_id || '')
          break
        case 'date':
        default:
          raw = (dateIso(b.raid_id) || '').localeCompare(dateIso(a.raid_id) || '')
      }
      return sortDesc ? raw : -raw
    }
    return [...list].sort(cmp)
  }, [loot, itemQuery, sortBy, sortDesc, raids])

  const parentRef = useRef(null)
  const ROW_HEIGHT = 40
  const virtualizer = useVirtualizer({
    count: filteredLoot.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  })

  const baseCell = { ...cellStyle, padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--border, #27272a)' }
  const renderRow = (row, i) => {
    const dateStr = (raids[row.raid_id]?.date_iso && String(raids[row.raid_id].date_iso).trim()) ? String(raids[row.raid_id].date_iso).slice(0, 10) : (raids[row.raid_id]?.date || '—')
    const charName = row.character_name || row.char_id || '—'
    const accountId = getAccountId(row.character_name || row.char_id)
    const accountName = getAccountDisplayName?.(row.character_name || row.char_id)
    const label = accountName ? `${accountName} (${charName})` : charName
    const to = accountId ? `/accounts/${accountId}` : `/characters/${encodeURIComponent(charName)}`
    return (
      <>
        <div className="loot-cell" style={{ ...baseCell, color: '#a1a1aa', fontSize: '0.875rem' }} title={dateStr}>{dateStr}</div>
        <div className="loot-cell" style={baseCell} title={row.item_name || ''}><ItemLink itemName={row.item_name || ''} itemId={itemIdMap[(row.item_name || '').trim().toLowerCase()]}>{row.item_name || '—'}</ItemLink></div>
        <div className="loot-cell" style={baseCell}>{row.cost ?? '—'}</div>
        <div className="loot-cell" style={baseCell} title={label}><Link to={to}>{label}</Link></div>
        <div className="loot-cell" style={{ ...baseCell, color: '#a1a1aa', fontSize: '0.875rem' }} title={row.assigned_character_name || row.assigned_char_id || 'Unassigned'}>
          {(row.assigned_character_name || row.assigned_char_id) ? (
            <Link to={`/characters/${encodeURIComponent(row.assigned_character_name || row.assigned_char_id)}`}>{row.assigned_character_name || row.assigned_char_id}</Link>
          ) : (
            <span style={{ color: '#71717a' }}>Unassigned</span>
          )}
        </div>
        <div className="loot-cell" style={baseCell} title={raids[row.raid_id]?.name ?? row.raid_id}><Link to={`/raids/${row.raid_id}`}>{raids[row.raid_id]?.name ?? row.raid_id}</Link></div>
        <div className="loot-cell" style={{ ...baseCell, color: '#a1a1aa', fontSize: '0.875rem' }} title={itemSourceLabel(itemSources, row.item_name, row.raid_id, raids[row.raid_id]?.name, raidToMobs) ?? ''}>
          {itemSourceLabel(itemSources, row.item_name, row.raid_id, raids[row.raid_id]?.name, raidToMobs) ?? '—'}
        </div>
      </>
    )
  }

  const gridStyle = { display: 'grid', gridTemplateColumns: '100px minmax(120px, 1fr) 60px minmax(100px, 1fr) minmax(100px, 1fr) minmax(100px, 1fr) minmax(120px, 1fr)', minWidth: 700 }

  if (loading) return <div className="container">Loading loot…</div>
  if (error) return <div className="container"><span className="error">{error}</span></div>

  return (
    <div className="container">
      <h1>Loot &amp; DKP by item</h1>
      <p style={{ color: '#71717a', marginBottom: '1rem' }}>
        Search by item name. Cost is DKP spent per row. Hover truncated cells for full text.
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
          <span style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', color: '#a1a1aa' }}>Sort by</span>
          <select
            className="filter-select"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            aria-label="Sort by"
          >
            <option value="date">Date</option>
            <option value="item">Item</option>
            <option value="cost">Cost</option>
            <option value="buyer">Buyer</option>
            <option value="toon">On toon</option>
          </select>
        </label>
        <label>
          <span style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', color: '#a1a1aa' }}>Order</span>
          <select
            className="filter-select"
            value={sortDesc ? 'desc' : 'asc'}
            onChange={(e) => setSortDesc(e.target.value === 'desc')}
            aria-label="Sort order"
          >
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </label>
      </div>
      <p style={{ color: '#71717a', fontSize: '0.875rem', marginBottom: '0.25rem' }}>
        {filteredLoot.length} row{filteredLoot.length !== 1 ? 's' : ''}
      </p>
      <AssignedLootDisclaimer compact />
      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <div style={gridStyle} role="row" aria-rowindex={0}>
            <div className="loot-cell" style={{ ...cellStyle, padding: '0.5rem 0.75rem', fontWeight: 600, borderBottom: '1px solid var(--border, #27272a)', background: 'var(--card-bg, #18181b)' }}>Date</div>
            <div className="loot-cell" style={{ ...cellStyle, padding: '0.5rem 0.75rem', fontWeight: 600, borderBottom: '1px solid var(--border, #27272a)', background: 'var(--card-bg, #18181b)' }}>Item</div>
            <div className="loot-cell" style={{ ...cellStyle, padding: '0.5rem 0.75rem', fontWeight: 600, borderBottom: '1px solid var(--border, #27272a)', background: 'var(--card-bg, #18181b)' }}>Cost</div>
            <div className="loot-cell" style={{ ...cellStyle, padding: '0.5rem 0.75rem', fontWeight: 600, borderBottom: '1px solid var(--border, #27272a)', background: 'var(--card-bg, #18181b)' }}>Buyer</div>
            <div className="loot-cell" style={{ ...cellStyle, padding: '0.5rem 0.75rem', fontWeight: 600, borderBottom: '1px solid var(--border, #27272a)', background: 'var(--card-bg, #18181b)' }}>On toon</div>
            <div className="loot-cell" style={{ ...cellStyle, padding: '0.5rem 0.75rem', fontWeight: 600, borderBottom: '1px solid var(--border, #27272a)', background: 'var(--card-bg, #18181b)' }}>Raid</div>
            <div className="loot-cell" style={{ ...cellStyle, padding: '0.5rem 0.75rem', fontWeight: 600, borderBottom: '1px solid var(--border, #27272a)', background: 'var(--card-bg, #18181b)' }}>Drops from</div>
          </div>
          <div
            ref={parentRef}
            style={{ overflow: 'auto', maxHeight: '70vh' }}
            aria-label="Loot table body"
          >
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = filteredLoot[virtualRow.index]
                return (
                  <div
                    key={row.id || `${row.raid_id}-${row.item_name}-${virtualRow.index}`}
                    style={{
                      ...gridStyle,
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                    role="row"
                    aria-rowindex={virtualRow.index + 1}
                  >
                    {renderRow(row, virtualRow.index)}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
