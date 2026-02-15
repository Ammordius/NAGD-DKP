import { useEffect, useState, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const TAKP_ITEM_BASE = 'https://www.takproject.net/allaclone/item.php?id='

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

// Simple SVG line chart: X = date, Y = cost (DKP)
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
  const points = data.map((d, i) => {
    const x = pad.left + (i / Math.max(data.length - 1, 1)) * innerW
    const y = pad.top + innerH - ((Number(d.cost) || 0) - minCost) / range * innerH
    return `${x},${y}`
  }).join(' ')
  const firstDate = data[0]?.date || ''
  const lastDate = data[data.length - 1]?.date || ''
  return (
    <div className="card" style={{ overflow: 'auto' }}>
      <h3 style={{ marginTop: 0 }}>DKP cost over time</h3>
      <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginBottom: '0.5rem' }}>X = date, Y = cost (DKP)</p>
      <svg width={w} height={h} style={{ display: 'block' }}>
        <polyline
          fill="none"
          stroke="#a78bfa"
          strokeWidth="2"
          points={points}
        />
        {data.map((d, i) => {
          const x = pad.left + (i / Math.max(data.length - 1, 1)) * innerW
          const y = pad.top + innerH - ((Number(d.cost) || 0) - minCost) / range * innerH
          return (
            <circle key={i} cx={x} cy={y} r={4} fill="#7c3aed" />
          )
        })}
        {/* Y axis (left): cost scale */}
        <text x={pad.left - 4} y={pad.top} fill="#71717a" fontSize="10" textAnchor="end">{maxCost}</text>
        <text x={pad.left - 4} y={pad.top + innerH} fill="#71717a" fontSize="10" textAnchor="end">{minCost}</text>
        {/* X axis (bottom): date range */}
        <text x={pad.left} y={h - 6} fill="#71717a" fontSize="10">{firstDate}</text>
        <text x={pad.left + innerW} y={h - 6} fill="#71717a" fontSize="10" textAnchor="end">{lastDate}</text>
      </svg>
    </div>
  )
}

export default function ItemPage() {
  const { itemNameEncoded } = useParams()
  const itemName = useMemo(() => (itemNameEncoded ? decodeURIComponent(itemNameEncoded) : ''), [itemNameEncoded])
  const [lootRows, setLootRows] = useState([])
  const [raids, setRaids] = useState({})
  const [mobLoot, setMobLoot] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!itemName) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    Promise.all([
      supabase.from('raid_loot').select('id, raid_id, event_id, item_name, char_id, character_name, cost').eq('item_name', itemName).limit(500),
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
      supabase.from('raids').select('raid_id, raid_name, date_iso').in('raid_id', raidIds).then((rRes) => {
        const rMap = {}
        ;(rRes.data || []).forEach((row) => { rMap[row.raid_id] = row })
        setRaids(rMap)
        setLootRows(rows)
        setLoading(false)
      })
    })
  }, [itemName])

  const { historyByDate, lastThree, rollingAvg } = useMemo(() => {
    const withDate = lootRows.map((row) => ({
      ...row,
      date: (raids[row.raid_id]?.date_iso || '').slice(0, 10) || null,
    })).filter((r) => r.date)
    withDate.sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    const last3 = withDate.slice(-3).reverse()
    const avg = last3.length ? (last3.reduce((s, r) => s + (Number(r.cost) || 0), 0) / last3.length).toFixed(1) : null
    return { historyByDate: withDate, lastThree: last3, rollingAvg: avg }
  }, [lootRows, raids])

  const itemIdMap = useMemo(() => buildItemIdMap(mobLoot), [mobLoot])
  const takpId = itemIdMap[(itemName || '').trim().toLowerCase()]

  if (loading) return <div className="container">Loading item…</div>
  if (error) return <div className="container"><span className="error">{error}</span> <Link to="/loot">← Loot search</Link></div>

  return (
    <div className="container">
      <p><Link to="/loot">← Loot search</Link> · <Link to="/mobs">Mob loot</Link></p>
      <h1>{itemName || '—'}</h1>
      <p style={{ color: '#a1a1aa', marginBottom: '1rem' }}>
        {takpId != null ? (
          <a href={`${TAKP_ITEM_BASE}${takpId}`} target="_blank" rel="noopener noreferrer">View on TAKP AllaClone</a>
        ) : (
          <span>Item not in mob loot table (no TAKP link)</span>
        )}
      </p>

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
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Raid</th>
              <th>Winner</th>
              <th>Cost (DKP)</th>
            </tr>
          </thead>
          <tbody>
            {historyByDate.length === 0 && <tr><td colSpan={4}>No drops recorded</td></tr>}
            {[...historyByDate].reverse().map((row, i) => (
              <tr key={row.id || i}>
                <td>{row.date || '—'}</td>
                <td><Link to={`/raids/${row.raid_id}`}>{raids[row.raid_id]?.raid_name || row.raid_id}</Link></td>
                <td>
                  <Link to={`/characters/${encodeURIComponent(row.character_name || row.char_id || '')}`}>
                    {row.character_name || row.char_id || '—'}
                  </Link>
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
