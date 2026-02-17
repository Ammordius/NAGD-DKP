import { useEffect, useState, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useCharToAccountMap } from '../lib/useCharToAccountMap'
import AssignedLootDisclaimer from '../components/AssignedLootDisclaimer'
import ItemLink from '../components/ItemLink'
import ItemCard from '../components/ItemCard'
import { getItemStats } from '../lib/itemStats'

// Build item_name (lowercase) -> item_id from dkp_mob_loot.json
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

// Parse YYYY-MM-DD to timestamp; invalid returns NaN
function parseDate(s) {
  if (!s || typeof s !== 'string') return NaN
  const t = new Date(s.trim().slice(0, 10)).getTime()
  return isNaN(t) ? NaN : t
}

// X ticks every 6 months for legibility; return [{ ts, label }]
function sixMonthTicks(minTs, maxTs) {
  if (minTs == null || maxTs == null || !Number.isFinite(minTs) || !Number.isFinite(maxTs) || maxTs <= minTs) return []
  const min = new Date(minTs)
  const max = new Date(maxTs)
  const ticks = []
  let y = min.getFullYear()
  let m = min.getMonth()
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  for (;;) {
    const d = new Date(y, m, 1)
    const ts = d.getTime()
    if (ts > maxTs) break
    if (ts >= minTs) ticks.push({ ts, label: `${monthNames[m]} ${y}` })
    m += 6
    if (m >= 12) { m -= 12; y += 1 }
  }
  if (ticks.length === 0) ticks.push({ ts: minTs, label: `${monthNames[min.getMonth()]} ${min.getFullYear()}` })
  return ticks
}

// Simple SVG line chart: linear X (date), linear Y (cost). X ticks every 6 months.
function PriceChart({ data, height = 180 }) {
  if (!data || data.length === 0) return null
  const costs = data.map((d) => Number(d.cost) || 0)
  const maxCost = Math.max(...costs, 1)
  const minCost = Math.min(...costs, 0)
  const range = maxCost - minCost || 1
  const w = 520
  const h = height
  const pad = { top: 12, right: 12, bottom: 28, left: 44 }
  const innerW = w - pad.left - pad.right
  const innerH = h - pad.top - pad.bottom

  const dates = data.map((d) => parseDate(d.date)).filter(Number.isFinite)
  const minTs = dates.length ? Math.min(...dates) : Date.now()
  const maxTs = dates.length ? Math.max(...dates) : Date.now()
  const timeRange = maxTs - minTs || 1

  // Linear X scale: date -> x
  const xScale = (ts) => pad.left + ((ts - minTs) / timeRange) * innerW
  // Linear Y scale: cost -> y
  const yScale = (cost) => pad.top + innerH - ((Number(cost) || 0) - minCost) / range * innerH

  const points = data.map((d) => {
    const ts = parseDate(d.date)
    const x = Number.isFinite(ts) ? xScale(ts) : pad.left
    const y = yScale(d.cost)
    return `${x},${y}`
  }).join(' ')

  const xTicks = sixMonthTicks(minTs, maxTs)
  const yTickCount = 5
  const yTicks = []
  for (let i = 0; i <= yTickCount; i++) {
    const t = minCost + (range * i) / yTickCount
    yTicks.push(Math.round(t))
  }
  const yTicksDedup = [...new Set(yTicks)].sort((a, b) => a - b)

  return (
    <div className="card" style={{ overflow: 'auto' }}>
      <h3 style={{ marginTop: 0 }}>DKP cost over time</h3>
      <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginBottom: '0.5rem' }}>X = date (linear), Y = cost (DKP, linear)</p>
      <svg width={w} height={h} style={{ display: 'block' }}>
        {/* Y gridlines + ticks (linear scale) */}
        {yTicksDedup.map((costVal) => {
          const y = yScale(costVal)
          return (
            <g key={costVal}>
              <line x1={pad.left} y1={y} x2={pad.left + innerW} y2={y} stroke="#27272a" strokeWidth="1" strokeDasharray="2,2" />
              <text x={pad.left - 6} y={y + 4} fill="#71717a" fontSize="10" textAnchor="end">{costVal}</text>
            </g>
          )
        })}
        {/* X gridlines + ticks (every 6 months) */}
        {xTicks.map(({ ts, label }) => {
          const x = xScale(ts)
          return (
            <g key={label}>
              <line x1={x} y1={pad.top} x2={x} y2={pad.top + innerH} stroke="#27272a" strokeWidth="1" strokeDasharray="2,2" />
              <text x={x} y={h - 6} fill="#71717a" fontSize="10" textAnchor="middle">{label}</text>
            </g>
          )
        })}
        <polyline fill="none" stroke="#a78bfa" strokeWidth="2" points={points} />
        {data.map((d, i) => {
          const ts = parseDate(d.date)
          const x = Number.isFinite(ts) ? xScale(ts) : pad.left
          const y = yScale(d.cost)
          return <circle key={i} cx={x} cy={y} r={4} fill="#7c3aed" />
        })}
      </svg>
    </div>
  )
}

export default function ItemPage() {
  const { itemNameEncoded } = useParams()
  const { getAccountId, getAccountDisplayName } = useCharToAccountMap()
  const itemName = useMemo(() => (itemNameEncoded ? decodeURIComponent(itemNameEncoded) : ''), [itemNameEncoded])
  const [lootRows, setLootRows] = useState([])
  const [raids, setRaids] = useState({})
  const [mobLoot, setMobLoot] = useState(null)
  const [itemStats, setItemStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!itemName) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    // Case-insensitive item match so "Earring" and "earring" show the same page
    const escaped = (itemName || '').replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
    Promise.all([
      supabase.from('raid_loot').select('id, raid_id, event_id, item_name, char_id, character_name, cost, assigned_char_id, assigned_character_name').ilike('item_name', escaped).limit(500),
      fetch('/dkp_mob_loot.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([lootRes, mobJson]) => {
      if (lootRes.error) {
        setError(lootRes.error.message)
        setLoading(false)
        return
      }
      const rows = lootRes.data || []
      setMobLoot(mobJson)
      if (rows.length === 0) {
        setLootRows([])
        setRaids({})
        setLoading(false)
        return
      }
      const raidIds = [...new Set(rows.map((r) => r.raid_id).filter(Boolean))]
      supabase.from('raids').select('raid_id, raid_name, date_iso, date').in('raid_id', raidIds).then((rRes) => {
        const rMap = {}
        ;(rRes.data || []).forEach((row) => { rMap[row.raid_id] = row })
        setRaids(rMap)
        setLootRows(rows)
        setLoading(false)
      })
    })
  }, [itemName])

  const { historyByDate, historyAll, lastThree, rollingAvg } = useMemo(() => {
    const dateIso = (rid) => (raids[rid]?.date_iso && String(raids[rid].date_iso).trim()) ? String(raids[rid].date_iso).slice(0, 10) : null
    const displayDate = (rid) => dateIso(rid) || raids[rid]?.date || '—'
    const allRows = lootRows.map((row) => ({
      ...row,
      date: dateIso(row.raid_id),
      displayDate: displayDate(row.raid_id),
    }))
    // Sort by date (null last), then by id desc so most recent is last
    allRows.sort((a, b) => {
      const da = a.date || '9999-99-99'
      const db = b.date || '9999-99-99'
      const cmp = da.localeCompare(db)
      if (cmp !== 0) return cmp
      return (b.id ?? 0) - (a.id ?? 0)
    })
    const withDate = allRows.filter((r) => r.date)
    const last3 = allRows.slice(-3).reverse()
    const avg = last3.length ? (last3.reduce((s, r) => s + (Number(r.cost) || 0), 0) / last3.length).toFixed(1) : null
    return { historyByDate: withDate, historyAll: allRows, lastThree: last3, rollingAvg: avg }
  }, [lootRows, raids])

  const itemIdMap = useMemo(() => buildItemIdMap(mobLoot), [mobLoot])
  const takpId = itemIdMap[(itemName || '').trim().toLowerCase()]

  useEffect(() => {
    if (takpId == null) {
      setItemStats(null)
      return
    }
    let cancelled = false
    getItemStats(takpId).then((stats) => {
      if (!cancelled) setItemStats(stats)
    })
    return () => { cancelled = true }
  }, [takpId])

  if (loading) return <div className="container">Loading item…</div>
  if (error) return <div className="container"><span className="error">{error}</span> <Link to="/loot">← Loot search</Link></div>

  return (
    <div className="container">
      <p><Link to="/loot">← Loot search</Link> · <Link to="/mobs">Mob loot</Link></p>
      <h1 style={{ marginBottom: '0.5rem' }}>
        <ItemLink
          itemName={itemName}
          itemId={takpId}
          externalHref={takpId != null ? `https://www.takproject.net/allaclone/item.php?id=${takpId}` : undefined}
        >
          {itemName || '—'}
        </ItemLink>
      </h1>
      {takpId != null && (
        <div style={{ marginBottom: '1rem' }}>
          <ItemCard name={itemName} itemId={takpId} stats={itemStats} compact={!itemStats} />
        </div>
      )}

      {lastThree.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid #7c3aed' }}>
          <h3 style={{ marginTop: 0 }}>Last 3 drops (rolling average)</h3>
          <p style={{ margin: '0 0 0.5rem 0' }}>
            Explicit costs: <strong>{lastThree.map((r) => r.cost ?? '—').join(', ')}</strong>
            {rollingAvg != null && (
              <> · Rolling average: <strong>{rollingAvg}</strong> DKP</>
            )}
          </p>
        </div>
      )}

      {historyByDate.length > 0 && <PriceChart data={historyByDate} />}

      <h2>Drop history</h2>
      <AssignedLootDisclaimer compact />
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Raid</th>
              <th>Winner</th>
              <th>On toon</th>
              <th>Cost (DKP)</th>
            </tr>
          </thead>
          <tbody>
            {historyAll.length === 0 && <tr><td colSpan={5}>No drops recorded</td></tr>}
            {[...historyAll].reverse().map((row, i) => (
              <tr key={row.id || i}>
                <td>{row.displayDate}</td>
                <td><Link to={`/raids/${row.raid_id}`}>{raids[row.raid_id]?.raid_name || row.raid_id}</Link></td>
                <td>
                  {(() => {
                    const charName = row.character_name || row.char_id || '—'
                    const accountId = getAccountId(row.character_name || row.char_id)
                    const accountName = getAccountDisplayName?.(row.character_name || row.char_id)
                    const label = accountName ? `${accountName} (${charName})` : charName
                    const to = accountId ? `/accounts/${accountId}` : `/characters/${encodeURIComponent(charName)}`
                    return <Link to={to}>{label}</Link>
                  })()}
                </td>
                <td style={{ color: '#a1a1aa', fontSize: '0.875rem' }}>
                  {(row.assigned_character_name || row.assigned_char_id) ? (
                    <Link to={`/characters/${encodeURIComponent(row.assigned_character_name || row.assigned_char_id)}`}>{row.assigned_character_name || row.assigned_char_id}</Link>
                  ) : (
                    <span style={{ color: '#71717a' }}>Unassigned</span>
                  )}
                </td>
                <td>{row.cost ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
