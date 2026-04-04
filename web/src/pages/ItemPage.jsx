import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { useParams, Link, useSearchParams, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useCharToAccountMap } from '../lib/useCharToAccountMap'
import AssignedLootDisclaimer from '../components/AssignedLootDisclaimer'
import ItemLink from '../components/ItemLink'
import ItemCard from '../components/ItemCard'
import { getItemStats } from '../lib/itemStats'
import { getDkpMobLoot, getRaidItemSources } from '../lib/staticData'
import { ensureElementalArmorLoaded, getMoldInfo, getArmorIdForMoldAndClass, isElementalMold } from '../lib/elementalArmor'
import { formatAccountCharacter } from '../lib/formatAccountCharacter'

const CLASS_OPTIONS = ['WAR', 'CLR', 'PAL', 'RNG', 'SHD', 'BRD', 'ROG', 'SHM', 'MNK', 'NEC', 'WIZ', 'MAG', 'ENC', 'BST']

const FACT_IN_CHUNK = 100
const RPC_FALLBACK_MAX = 10

/** True if URL asks to open the inferred second-place section. */
function queryWantsSecondPlaceOpen(searchParams) {
  for (const key of ['second_place', 'bid_estimate', 'bid_portfolio']) {
    const v = searchParams.get(key)
    if (v === null) continue
    const s = String(v).trim().toLowerCase()
    if (s === '' || s === '1' || s === 'true' || s === 'yes') return true
  }
  return false
}

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

// Build item_name (lowercase) -> item_id from raid_item_sources.json (id -> { name })
function buildRaidItemNameToId(raidSources) {
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

export default function ItemPage({ isOfficer = false }) {
  const { itemNameEncoded } = useParams()
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const secondPlaceSectionRef = useRef(null)
  const { getAccountId, getAccountDisplayName, getDisplayNameForAccountId, getRepresentativeCharNameForAccount } = useCharToAccountMap()
  const itemName = useMemo(() => (itemNameEncoded ? decodeURIComponent(itemNameEncoded) : ''), [itemNameEncoded])
  const [lootRows, setLootRows] = useState([])
  const [raids, setRaids] = useState({})
  const [mobLoot, setMobLoot] = useState(null)
  const [raidItemSources, setRaidItemSources] = useState(null)
  const [itemStats, setItemStats] = useState(null)
  const [elementalClass, setElementalClass] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [elementalDataReady, setElementalDataReady] = useState(false)

  const urlSecondPlaceOpen = useMemo(() => queryWantsSecondPlaceOpen(searchParams), [searchParams])
  const [secondPlaceOpen, setSecondPlaceOpen] = useState(false)
  const [factByLootId, setFactByLootId] = useState({})
  const [factLoading, setFactLoading] = useState(false)
  const [factError, setFactError] = useState('')
  const [rpcRunnerUpByLootId, setRpcRunnerUpByLootId] = useState({})
  const [rpcLoading, setRpcLoading] = useState(false)

  useEffect(() => {
    if (urlSecondPlaceOpen) setSecondPlaceOpen(true)
  }, [urlSecondPlaceOpen])

  useEffect(() => {
    if (!urlSecondPlaceOpen || !secondPlaceOpen || loading) return
    const id = requestAnimationFrame(() => {
      secondPlaceSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    return () => cancelAnimationFrame(id)
  }, [urlSecondPlaceOpen, secondPlaceOpen, loading, lootRows.length])

  useEffect(() => {
    setFactByLootId({})
    setFactError('')
    setRpcRunnerUpByLootId({})
  }, [itemName])

  const lootIdsForFact = useMemo(() => {
    const ids = (lootRows || []).map((r) => r.id).filter((id) => id != null)
    return [...new Set(ids.map((x) => Number(x)))].filter((n) => Number.isFinite(n) && n > 0)
  }, [lootRows])

  useEffect(() => {
    if (!isOfficer || !secondPlaceOpen || lootIdsForFact.length === 0) return
    let cancelled = false
    setFactLoading(true)
    setFactError('')
    ;(async () => {
      const merged = {}
      try {
        for (let i = 0; i < lootIdsForFact.length; i += FACT_IN_CHUNK) {
          const chunk = lootIdsForFact.slice(i, i + FACT_IN_CHUNK)
          const { data, error: qErr } = await supabase
            .from('bid_portfolio_auction_fact')
            .select('loot_id, runner_up_account_guess')
            .in('loot_id', chunk)
          if (cancelled) return
          if (qErr) {
            setFactError(qErr.message)
            return
          }
          ;(data || []).forEach((row) => {
            merged[Number(row.loot_id)] = row.runner_up_account_guess ?? null
          })
        }
        if (!cancelled) setFactByLootId(merged)
      } finally {
        if (!cancelled) setFactLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isOfficer, secondPlaceOpen, lootRows])

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
      supabase.from('raid_loot_with_assignment').select('id, raid_id, event_id, item_name, char_id, character_name, cost, assigned_char_id, assigned_character_name').ilike('item_name', escaped).limit(500),
      getDkpMobLoot(),
      getRaidItemSources(),
    ]).then(([lootRes, mobJson, raidJson]) => {
      if (lootRes.error) {
        setError(lootRes.error.message)
        setLoading(false)
        return
      }
      const rows = lootRes.data || []
      setMobLoot(mobJson)
      setRaidItemSources(raidJson)
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

  const loadRpcFallback = useCallback(async () => {
    if (!isOfficer || factLoading) return
    const reversed = [...historyAll].reverse()
    const targets = []
    for (const row of reversed) {
      const n = Number(row.id)
      if (!Number.isFinite(n)) continue
      if (Object.prototype.hasOwnProperty.call(factByLootId, n)) continue
      if (Object.prototype.hasOwnProperty.call(rpcRunnerUpByLootId, n)) continue
      targets.push(n)
      if (targets.length >= RPC_FALLBACK_MAX) break
    }
    if (targets.length === 0) return
    setRpcLoading(true)
    const next = { ...rpcRunnerUpByLootId }
    try {
      for (const lootId of targets) {
        const { data, error: rpcErr } = await supabase.rpc('officer_bid_portfolio_for_loot', { p_loot_id: lootId })
        if (rpcErr) {
          setFactError(rpcErr.message)
          break
        }
        next[lootId] = data?.runner_up_account_guess ?? null
      }
    } finally {
      setRpcRunnerUpByLootId(next)
      setRpcLoading(false)
    }
  }, [isOfficer, factLoading, historyAll, factByLootId, rpcRunnerUpByLootId])

  const itemIdMap = useMemo(() => buildItemIdMap(mobLoot), [mobLoot])
  const raidNameToId = useMemo(() => buildRaidItemNameToId(raidItemSources), [raidItemSources])
  const itemKey = (itemName || '').trim().toLowerCase()
  const takpId = itemIdMap[itemKey] ?? raidNameToId[itemKey]

  const moldInfo = elementalDataReady && takpId != null ? getMoldInfo(takpId) : null
  const displayArmorId = (takpId != null && elementalClass && moldInfo)
    ? getArmorIdForMoldAndClass(takpId, elementalClass)
    : null
  const showElementalClassPicker = elementalDataReady && takpId != null && isElementalMold(takpId)

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

  useEffect(() => {
    if (takpId == null) return
    ensureElementalArmorLoaded().then(() => setElementalDataReady(true)).catch(() => {})
  }, [takpId])

  const [armorStats, setArmorStats] = useState(null)
  useEffect(() => {
    if (displayArmorId == null) {
      setArmorStats(null)
      return
    }
    let cancelled = false
    getItemStats(displayArmorId).then((stats) => {
      if (!cancelled) setArmorStats(stats)
    })
    return () => { cancelled = true }
  }, [displayArmorId])

  const displayId = displayArmorId ?? takpId
  const displayStats = displayArmorId ? armorStats : itemStats
  const displayName = (displayArmorId && armorStats?.name) ? armorStats.name : itemName

  if (loading) return <div className="container">Loading item…</div>
  if (error) return <div className="container"><span className="error">{error}</span> <Link to="/loot">← Item History</Link></div>

  const secondPlaceLinkTo = `${location.pathname}?second_place=1`

  return (
    <div className="container">
      <p>
        <Link to="/loot">← Item History</Link>
        {' · '}
        <Link to="/mobs">Raid Items</Link>
        {isOfficer && historyAll.length > 0 && (
          <>
            {' · '}
            <Link to={secondPlaceLinkTo}>Inferred 2nd place</Link>
          </>
        )}
      </p>
      <h1 style={{ marginBottom: '0.5rem' }}>
        {takpId != null ? (
          <ItemLink
            itemName={displayName}
            itemId={displayId}
            externalHref={`https://www.takproject.net/allaclone/item.php?id=${displayId}`}
          >
            {displayName || '—'}
          </ItemLink>
        ) : (
          <span>{itemName || '—'}</span>
        )}
      </h1>
      {showElementalClassPicker && (
        <div style={{ marginBottom: '0.75rem' }}>
          <label>
            <span className="filter-label" style={{ marginRight: '0.5rem' }}>View armor for class</span>
            <select
              className="filter-select"
              value={elementalClass}
              onChange={(e) => setElementalClass(e.target.value)}
              aria-label="Class for elemental armor"
            >
              <option value="">— Mold / pattern —</option>
              {CLASS_OPTIONS.filter((c) => moldInfo?.by_class?.[c]).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          {displayArmorId && moldInfo && (
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.875rem', color: '#a78bfa' }}>
              Crafted from: <strong>{moldInfo.mold_name}</strong>
            </p>
          )}
        </div>
      )}
      {takpId != null && (
        <div style={{ marginBottom: '1rem' }}>
          <ItemCard name={displayName} itemId={displayId} stats={displayStats} compact={!displayStats} />
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

      {isOfficer && historyAll.length > 0 && !secondPlaceOpen && (
        <p style={{ marginBottom: '1rem' }}>
          <button type="button" className="btn btn-ghost" onClick={() => setSecondPlaceOpen(true)}>
            Show inferred second place (officers)
          </button>
        </p>
      )}

      {isOfficer && historyAll.length > 0 && secondPlaceOpen && (
        <div
          ref={secondPlaceSectionRef}
          className="card"
          style={{ marginBottom: '1.25rem', borderLeft: '4px solid #fbbf24' }}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5rem' }}>
            <h2 style={{ marginTop: 0, marginBottom: '0.25rem' }}>Inferred second place (officers)</h2>
            <button type="button" className="btn btn-ghost" style={{ fontSize: '0.85rem' }} onClick={() => setSecondPlaceOpen(false)}>
              Hide
            </button>
          </div>
          <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginTop: 0 }}>
            Heuristic only: no auction bid log. “Second place” is the richest non-buyer attendee whose reconstructed pool was at least the clearing price (see guild SQL docs).
          </p>
          {factError && <p className="error" style={{ marginBottom: '0.5rem' }}>{factError}</p>}
          {factLoading && <p style={{ color: '#a1a1aa', marginBottom: '0.5rem' }}>Loading cached inference…</p>}
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Raid</th>
                  <th>Winner</th>
                  <th>Cost</th>
                  <th>Inferred 2nd</th>
                </tr>
              </thead>
              <tbody>
                {[...historyAll].reverse().map((row, i) => {
                  const n = Number(row.id)
                  const hasFact = Number.isFinite(n) && Object.prototype.hasOwnProperty.call(factByLootId, n)
                  const hasRpc = Number.isFinite(n) && Object.prototype.hasOwnProperty.call(rpcRunnerUpByLootId, n)
                  let inferred = null
                  let inferredReady = false
                  if (hasFact) {
                    inferred = factByLootId[n]
                    inferredReady = true
                  } else if (hasRpc) {
                    inferred = rpcRunnerUpByLootId[n]
                    inferredReady = true
                  }
                  const charName = row.character_name || row.char_id || '—'
                  const accountId = getAccountId(row.character_name || row.char_id)
                  const accountName = getAccountDisplayName?.(row.character_name || row.char_id)
                  const winnerLabel = formatAccountCharacter(accountName, charName)
                  const winnerTo = accountId ? `/accounts/${accountId}` : `/characters/${encodeURIComponent(charName)}`
                  return (
                    <tr key={row.id ?? i}>
                      <td>{row.displayDate}</td>
                      <td>
                        <Link to={`/raids/${row.raid_id}`}>{raids[row.raid_id]?.raid_name || row.raid_id}</Link>
                      </td>
                      <td>
                        <Link to={winnerTo}>{winnerLabel}</Link>
                      </td>
                      <td>{row.cost ?? '—'}</td>
                      <td>
                        {!inferredReady && factLoading ? (
                          <span style={{ color: '#71717a' }}>…</span>
                        ) : inferred ? (
                          <Link to={`/accounts/${encodeURIComponent(String(inferred))}`}>
                            {formatAccountCharacter(
                              getDisplayNameForAccountId(inferred),
                              getRepresentativeCharNameForAccount?.(inferred) ?? '',
                            )}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p style={{ color: '#71717a', fontSize: '0.85rem', marginTop: '0.75rem', marginBottom: '0.5rem' }}>
            Values come from <code>bid_portfolio_auction_fact</code> when backfilled. If rows are empty, run the portfolio backfill (see repo docs) or load live inference for recent drops (slow).
          </p>
          <button type="button" className="btn btn-ghost" disabled={factLoading || rpcLoading} onClick={() => loadRpcFallback()}>
            {rpcLoading ? 'Loading…' : `Load live inference (up to ${RPC_FALLBACK_MAX} recent drops missing cache)`}
          </button>
        </div>
      )}

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
                    const label = formatAccountCharacter(accountName, charName)
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
