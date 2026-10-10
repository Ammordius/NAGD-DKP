import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { usePersistedState } from '../lib/usePersistedState'
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

// Prevent grid cells from overflowing into adjacent rows/columns
const cellStyle = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const PAGE_SIZE = 100
const SCROLL_LOAD_PX = 240
const SEARCH_DEBOUNCE_MS = 300
const CLASSIFICATION_CHUNK = 20

const LOOT_SELECT = 'id, raid_id, item_name, character_name, char_id, cost, assigned_char_id, assigned_character_name, raid_name, date_iso, date'

const SORT_COLUMNS = {
  date: 'date_iso',
  item: 'item_name',
  cost: 'cost_num',
  buyer: 'character_name',
  toon: 'assigned_character_name',
}

function escapeIlike(value) {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

function lootHistoryQuery(term, sortBy, sortDesc, withCount) {
  let q = supabase.from('raid_loot_history').select(LOOT_SELECT, withCount ? { count: 'exact' } : {})
  const trimmed = (term || '').trim()
  if (trimmed) q = q.ilike('item_name', `%${escapeIlike(trimmed)}%`)
  const column = SORT_COLUMNS[sortBy] || 'date_iso'
  return q
    .order(column, { ascending: !sortDesc, nullsFirst: false })
    .order('id', { ascending: false })
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

export default function LootSearch() {
  const { getAccountId, getAccountDisplayName } = useCharToAccountMap()
  const [rows, setRows] = useState([])
  const [totalCount, setTotalCount] = useState(null)
  const [raidToMobs, setRaidToMobs] = useState({})
  const [itemSources, setItemSources] = useState(null)
  const [mobLoot, setMobLoot] = useState(null)
  const [itemQuery, setItemQuery] = usePersistedState('/loot:itemQuery', '')
  const [debouncedQuery, setDebouncedQuery] = useState(itemQuery)
  const [sortBy, setSortBy] = usePersistedState('/loot:sortBy', 'date')
  const [sortDesc, setSortDesc] = usePersistedState('/loot:sortDesc', true)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  const parentRef = useRef(null)
  const requestId = useRef(0)
  const loadingMoreRef = useRef(false)
  const reachedEndRef = useRef(false)
  const raidMobsDone = useRef(new Set())
  const raidMobsInflight = useRef(new Set())

  useEffect(() => {
    getDkpMobLoot().then(setMobLoot)
    getItemSources()
      .then((json) => setItemSources(json || null))
      .catch(() => setItemSources(null))
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(itemQuery), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [itemQuery])

  useEffect(() => {
    const myId = ++requestId.current
    loadingMoreRef.current = false
    reachedEndRef.current = false
    setLoadingMore(false)
    setLoading(true)
    setError('')
    setRows([])
    setTotalCount(null)
    parentRef.current?.scrollTo(0, 0)

    let cancelled = false
    ;(async () => {
      const { data, error: queryError, count } = await lootHistoryQuery(debouncedQuery, sortBy, sortDesc, true)
        .range(0, PAGE_SIZE - 1)
      if (cancelled || myId !== requestId.current) return
      if (queryError) {
        setError(queryError.message)
        setLoading(false)
        return
      }
      const page = data || []
      setRows(page)
      if (typeof count === 'number') setTotalCount(count)
      else if (page.length < PAGE_SIZE) setTotalCount(page.length)
      if (page.length < PAGE_SIZE || (typeof count === 'number' && page.length >= count)) {
        reachedEndRef.current = true
      }
      setLoading(false)
    })()

    return () => { cancelled = true }
  }, [debouncedQuery, sortBy, sortDesc])

  const loadMore = useCallback(async () => {
    if (loading || loadingMoreRef.current || reachedEndRef.current) return
    if (totalCount != null && rows.length >= totalCount) return
    if (rows.length === 0) return
    const from = rows.length
    const myId = requestId.current
    loadingMoreRef.current = true
    setLoadingMore(true)
    const { data, error: queryError } = await lootHistoryQuery(debouncedQuery, sortBy, sortDesc, false)
      .range(from, from + PAGE_SIZE - 1)
    if (myId !== requestId.current) return
    if (queryError) {
      setError(queryError.message)
      setLoadingMore(false)
      loadingMoreRef.current = false
      return
    }
    const page = data || []
    if (page.length < PAGE_SIZE) reachedEndRef.current = true
    setRows((prev) => {
      if (prev.length !== from) return prev
      const seen = new Set(prev.map((row) => row.id))
      const next = prev.slice()
      for (const row of page) {
        if (!seen.has(row.id)) next.push(row)
      }
      if (next.length === prev.length) reachedEndRef.current = true
      return next
    })
    setLoadingMore(false)
    loadingMoreRef.current = false
  }, [debouncedQuery, loading, rows.length, sortBy, sortDesc, totalCount])

  const maybeLoadMore = useCallback(() => {
    const el = parentRef.current
    if (!el || loading || rows.length === 0) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_LOAD_PX) loadMore()
  }, [loadMore, loading, rows.length])

  useEffect(() => {
    const el = parentRef.current
    if (!el) return undefined
    const onScroll = () => maybeLoadMore()
    el.addEventListener('scroll', onScroll)
    maybeLoadMore()
    return () => el.removeEventListener('scroll', onScroll)
  }, [maybeLoadMore])

  useEffect(() => {
    const missing = []
    for (const row of rows) {
      const id = row.raid_id
      if (!id || raidMobsDone.current.has(id) || raidMobsInflight.current.has(id)) continue
      raidMobsInflight.current.add(id)
      missing.push(id)
    }
    if (!missing.length) return undefined
    let cancelled = false
    ;(async () => {
      const merged = []
      try {
        for (let i = 0; i < missing.length; i += CLASSIFICATION_CHUNK) {
          const slice = missing.slice(i, i + CLASSIFICATION_CHUNK)
          const { data, error: queryError } = await supabase
            .from('raid_classifications')
            .select('raid_id, mob')
            .in('raid_id', slice)
            .limit(1000)
          if (queryError) throw queryError
          merged.push(...(data || []))
        }
      } catch {
        if (!cancelled) missing.forEach((id) => raidMobsInflight.current.delete(id))
        return
      }
      if (cancelled) return
      missing.forEach((id) => {
        raidMobsInflight.current.delete(id)
        raidMobsDone.current.add(id)
      })
      setRaidToMobs((prev) => {
        const next = { ...prev }
        for (const id of missing) {
          if (!next[id]) next[id] = []
        }
        for (const row of merged) {
          if (!next[row.raid_id]) next[row.raid_id] = []
          if (!next[row.raid_id].includes(row.mob)) next[row.raid_id].push(row.mob)
        }
        return next
      })
    })()
    return () => {
      cancelled = true
      missing.forEach((id) => raidMobsInflight.current.delete(id))
    }
  }, [rows])

  const itemIdMap = useMemo(() => buildItemIdMap(mobLoot), [mobLoot])

  const ROW_HEIGHT = 40
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  })

  const baseCell = { ...cellStyle, padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--border, #27272a)' }
  const renderRow = (row) => {
    const dateStr = (row.date_iso && String(row.date_iso).trim()) ? String(row.date_iso).slice(0, 10) : (row.date || '—')
    const charName = row.character_name || row.char_id || '—'
    const accountId = getAccountId(row.character_name || row.char_id)
    const accountName = getAccountDisplayName?.(row.character_name || row.char_id)
    const label = accountName ? `${accountName} (${charName})` : charName
    const to = accountId ? `/accounts/${accountId}` : `/characters/${encodeURIComponent(charName)}`
    const raidName = row.raid_name || row.raid_id
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
        <div className="loot-cell" style={baseCell} title={raidName}><Link to={`/raids/${row.raid_id}`}>{raidName}</Link></div>
        <div className="loot-cell" style={{ ...baseCell, color: '#a1a1aa', fontSize: '0.875rem' }} title={itemSourceLabel(itemSources, row.item_name, row.raid_id, raidName, raidToMobs) ?? ''}>
          {itemSourceLabel(itemSources, row.item_name, row.raid_id, raidName, raidToMobs) ?? '—'}
        </div>
      </>
    )
  }

  const gridStyle = { display: 'grid', gridTemplateColumns: '100px minmax(120px, 1fr) 60px minmax(100px, 1fr) minmax(100px, 1fr) minmax(100px, 1fr) minmax(120px, 1fr)', minWidth: 700 }
  const countLabel = totalCount == null
    ? (loading ? 'Loading…' : '')
    : `${totalCount.toLocaleString()} row${totalCount === 1 ? '' : 's'}`

  return (
    <div className="container">
      <h1>Item History</h1>
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
        {countLabel}
        {loadingMore ? ' · loading more…' : ''}
      </p>
      {error ? <p className="error">{error}</p> : null}
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
            aria-busy={loading || loadingMore}
          >
            {loading && rows.length === 0 ? (
              <div style={{ padding: '0.75rem', color: '#a1a1aa' }}>Loading loot…</div>
            ) : null}
            {!loading && rows.length === 0 && !error ? (
              <div style={{ padding: '0.75rem', color: '#a1a1aa' }}>No matching rows.</div>
            ) : null}
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index]
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
                    {renderRow(row)}
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
