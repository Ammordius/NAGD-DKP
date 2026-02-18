import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import useSWR from 'swr'
import { supabase } from '../lib/supabase'

const ACTIVE_DAYS = 120 // Show raiders marked active or with activity in last N days
const DKP_API_KEY = '/api/get-dkp'
const DEDUPING_INTERVAL_MS = 60 * 1000 // 60s: prevent multiple components from triggering simultaneous requests

async function fetcher(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(res.statusText || 'Failed to fetch DKP')
  return res.json()
}

function applyAdjustmentsAndBalance(list, adjustmentsMap) {
  list.forEach((r) => {
    const adjRow = adjustmentsMap[(r.name || '').trim()] || adjustmentsMap[(r.name || '').trim().replace(/^\(\*\)\s*/, '')]
    if (adjRow) {
      r.earned += Math.round(Number(adjRow.earned_delta) || 0)
      r.spent += Math.round(Number(adjRow.spent_delta) || 0)
    }
    r.balance = r.earned - r.spent
  })
  list.sort((a, b) => b.balance - a.balance)
}

function buildAccountLeaderboard(list, caData, accData, charData) {
  const charToAccount = {}
  ;(caData || []).forEach((r) => { charToAccount[String(r.char_id)] = r.account_id })
  const nameToAccount = {}
  if (charData?.length) {
    const charIdToName = {}
    charData.forEach((c) => { if (c.name) charIdToName[String(c.char_id)] = c.name })
    ;(caData || []).forEach((r) => {
      const name = charIdToName[String(r.char_id)]
      if (name) nameToAccount[name] = r.account_id
    })
  }
  const accountNames = {}
  ;(accData || []).forEach((r) => {
    const display = (r.display_name || '').trim()
    const first = (r.toon_names || '').split(',')[0]?.trim() || r.account_id
    accountNames[r.account_id] = display || first
  })
  const byAccount = {}
  list.forEach((r) => {
    const aid = charToAccount[String(r.char_id)] ?? nameToAccount[String(r.name || '')] ?? '_no_account_'
    if (!byAccount[aid]) byAccount[aid] = { account_id: aid, earned: 0, spent: 0, earned_30d: 0, earned_60d: 0, name: accountNames[aid] || (aid === '_no_account_' ? '(no account)' : aid) }
    byAccount[aid].earned += r.earned
    byAccount[aid].spent += r.spent
    byAccount[aid].earned_30d += (r.earned_30d != null ? r.earned_30d : 0)
    byAccount[aid].earned_60d += (r.earned_60d != null ? r.earned_60d : 0)
  })
  const accountList = Object.values(byAccount).map((r) => ({ ...r, balance: r.earned - r.spent }))
  accountList.sort((a, b) => b.balance - a.balance)
  return accountList
}

function isActiveRow(r, activeKeysSet, cutoffDate) {
  if (activeKeysSet?.has(String(r.char_id))) return true
  if (!cutoffDate) return false
  if (r.last_activity_date == null || r.last_activity_date === '') return false
  const d = typeof r.last_activity_date === 'string' ? new Date(r.last_activity_date) : r.last_activity_date
  if (isNaN(d.getTime())) return false
  return d >= cutoffDate
}

/** Merge duplicate character rows (same character name) so adjustments are applied only once per character.
 *  dkp_summary can have two rows for one person (e.g. character_key = char_id vs character_key = name); we merge by name. */
function dedupeByCharacterName(list) {
  const byName = {}
  list.forEach((r) => {
    const key = (r.name || r.char_id || '').toString().trim().toLowerCase()
    if (!key) return
    if (!byName[key]) {
      byName[key] = { ...r }
      return
    }
    const m = byName[key]
    m.earned += r.earned
    m.spent += r.spent
    m.earned_30d += r.earned_30d ?? 0
    m.earned_60d += r.earned_60d ?? 0
    if (r.last_activity_date && (!m.last_activity_date || (r.last_activity_date > m.last_activity_date))) {
      m.last_activity_date = r.last_activity_date
    }
    if (r.char_id && r.char_id !== m.char_id) m.char_id = m.char_id || r.char_id
  })
  return Object.values(byName)
}

/** Process /api/get-dkp response into leaderboard list and account list. */
function processApiPayload(payload, buildAccountLeaderboard) {
  if (!payload?.dkp_summary?.length) return null
  const rows = payload.dkp_summary
  const activeKeys = (payload.active_raiders ?? []).map((x) => String(x.character_key))
  const activeSet = new Set(activeKeys)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - ACTIVE_DAYS)
  cutoff.setHours(0, 0, 0, 0)
  const adjustmentsMap = {}
  ;(payload.dkp_adjustments ?? []).forEach((row) => {
    const n = (row.character_name || '').trim()
    if (n) adjustmentsMap[n] = { earned_delta: Number(row.earned_delta) || 0, spent_delta: Number(row.spent_delta) || 0 }
  })
  const pt = { '30d': 0, '60d': 0 }
  ;(payload.dkp_period_totals ?? []).forEach((row) => { pt[row.period] = Math.round(Number(row.total_dkp) || 0) })
  let list = rows.map((r) => ({
    char_id: r.character_key,
    name: r.character_name || r.character_key,
    earned: Math.round(Number(r.earned) || 0),
    spent: Math.round(Number(r.spent) || 0),
    earned_30d: Math.round(Number(r.earned_30d) || 0),
    earned_60d: Math.round(Number(r.earned_60d) || 0),
    last_activity_date: r.last_activity_date || null,
  }))
  list = dedupeByCharacterName(list)
  list = list.filter((r) => isActiveRow(r, activeSet, cutoff))
  applyAdjustmentsAndBalance(list, adjustmentsMap)
  const caData = payload.character_account ?? []
  const accData = payload.accounts ?? []
  const charData = payload.characters ?? []
  const accountList = buildAccountLeaderboard(list, caData, accData, charData)
  const summaryUpdatedAt = rows[0]?.updated_at ?? null
  return { list, accountList, activeKeys, periodTotals: pt, caData, accData, charData, summaryUpdatedAt }
}

export default function DKP({ isOfficer }) {
  const [leaderboard, setLeaderboard] = useState([])
  const [accountLeaderboard, setAccountLeaderboard] = useState([])
  const [usingCache, setUsingCache] = useState(false)
  const [summaryUpdatedAt, setSummaryUpdatedAt] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [activeRaiders, setActiveRaiders] = useState([])
  const [activeManageOpen, setActiveManageOpen] = useState(false)
  const [activeAddKey, setActiveAddKey] = useState('')
  const [activeMutating, setActiveMutating] = useState(false)
  const [caData, setCaData] = useState(null)
  const [accData, setAccData] = useState(null)
  const [charData, setCharData] = useState(null)
  const [periodTotals, setPeriodTotals] = useState({ '30d': 0, '60d': 0 })
  const [mutationError, setMutationError] = useState('')

  const { data: apiData, error: swrError, isLoading, mutate } = useSWR(DKP_API_KEY, fetcher, {
    dedupingInterval: DEDUPING_INTERVAL_MS,
    revalidateOnFocus: false,
  })

  // Process /api/get-dkp payload into leaderboard and account list.
  useEffect(() => {
    if (!apiData) return
    setMutationError('')
    const result = processApiPayload(apiData, buildAccountLeaderboard)
    if (!result) return
    setLeaderboard(result.list)
    setAccountLeaderboard(result.accountList)
    setActiveRaiders(result.activeKeys)
    setPeriodTotals(result.periodTotals)
    setCaData(result.caData)
    setAccData(result.accData)
    setCharData(result.charData)
    setSummaryUpdatedAt(result.summaryUpdatedAt)
    setUsingCache(true)
  }, [apiData])

  // When ca/acc/char data or leaderboard changes, rebuild account leaderboard.
  useEffect(() => {
    if (caData === null || accData === null || leaderboard.length === 0) return
    const accountList = buildAccountLeaderboard(leaderboard, caData, accData, charData ?? [])
    setAccountLeaderboard(accountList)
  }, [caData, accData, charData, leaderboard])

  const loading = isLoading
  const error = swrError?.message ?? mutationError ?? ''

  const handleRefreshTotals = useCallback(async () => {
    setRefreshing(true)
    setMutationError('')
    const { error: rpcError } = await supabase.rpc('refresh_dkp_summary')
    if (rpcError) {
      setMutationError(rpcError.message)
      setRefreshing(false)
      return
    }
    await mutate()
    setRefreshing(false)
  }, [mutate])

  const handleAddActive = useCallback(async () => {
    const key = activeAddKey.trim()
    if (!key) return
    setActiveMutating(true)
    setMutationError('')
    const { error: e } = await supabase.from('active_raiders').upsert({ character_key: key }, { onConflict: 'character_key' })
    setActiveMutating(false)
    if (e) {
      setMutationError(e.message)
      return
    }
    setActiveAddKey('')
    setActiveRaiders((prev) => (prev.includes(key) ? prev : [...prev, key]))
    await mutate()
  }, [activeAddKey, mutate])

  const handleRemoveActive = useCallback(async (key) => {
    setActiveMutating(true)
    setMutationError('')
    const { error: e } = await supabase.from('active_raiders').delete().eq('character_key', key)
    setActiveMutating(false)
    if (e) {
      setMutationError(e.message)
      return
    }
    setActiveRaiders((prev) => prev.filter((k) => k !== key))
    await mutate()
  }, [mutate])

  const showList = accountLeaderboard
  const colLabel = 'Account'

  if (loading && !showList.length) return <div className="container">Loading DKP…</div>
  if (error && !showList.length) return <div className="container"><span className="error">{error}</span></div>

  return (
    <div className="container">
      <h1>DKP Leaderboard</h1>
      <p style={{ color: '#71717a' }}>
        One row per account (one human). Earned (raid attendance × event DKP) minus spent (loot); all characters on the same account are combined.
        {usingCache && summaryUpdatedAt && (
          <span style={{ marginLeft: '0.5rem' }}>· Cached {new Date(summaryUpdatedAt).toLocaleString()}</span>
        )}
        {usingCache && (
          <span style={{ marginLeft: '0.5rem' }}>· Showing accounts with active raiders (marked active or activity in last {ACTIVE_DAYS} days)</span>
        )}
      </p>
      <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {isOfficer && (
          <button type="button" onClick={handleRefreshTotals} disabled={refreshing} style={{ marginLeft: 'auto' }}>
            {refreshing ? 'Refreshing…' : 'Refresh DKP totals'}
          </button>
        )}
      </div>
      {showList.length === 0 && (
        <p style={{ color: '#f59e0b', marginBottom: '1rem' }}>
          No DKP data. Make sure you’re logged in and the app is using the same Supabase project where you imported the CSVs (check Vercel env: VITE_SUPABASE_URL).
        </p>
      )}
      {showList.length > 0 && showList.every((r) => Number(r.spent) === 0) && (
        <p style={{ color: '#f59e0b', marginBottom: '1rem' }}>
          Spent is 0 for all characters. Import <code>data/raid_loot.csv</code> into the <strong>raid_loot</strong> table in Supabase so loot costs are included. See docs/SETUP-WALKTHROUGH.md.
        </p>
      )}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>{colLabel}</th>
              <th>Earned</th>
              <th>Spent</th>
              <th>Balance</th>
              <th title="DKP earned / total DKP in period">30d</th>
              <th title="DKP earned / total DKP in period">60d</th>
            </tr>
          </thead>
          <tbody>
            {showList.slice(0, 200).map((r, i) => {
              const total30 = periodTotals['30d'] || 0
              const total60 = periodTotals['60d'] || 0
              const e30 = r.earned_30d != null ? Math.round(r.earned_30d) : 0
              const e60 = r.earned_60d != null ? Math.round(r.earned_60d) : 0
              const cell30 = total30 > 0 ? `${e30} / ${total30}` : '—'
              const cell60 = total60 > 0 ? `${e60} / ${total60}` : '—'
              return (
                <tr key={r.account_id + i}>
                  <td><Link to={`/accounts/${r.account_id}`}>{r.name}</Link></td>
                  <td>{Number(r.earned)}</td>
                  <td>{Number(r.spent)}</td>
                  <td><strong>{Number(r.balance)}</strong></td>
                  <td>{cell30}</td>
                  <td>{cell60}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {isOfficer && (
        <div className="card" style={{ marginTop: '1.5rem' }}>
          <button type="button" onClick={() => setActiveManageOpen((o) => !o)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontWeight: 'bold', marginBottom: activeManageOpen ? '0.5rem' : 0 }}>
            {activeManageOpen ? '▼' : '▶'} Manage active raiders
          </button>
          {activeManageOpen && (
            <>
              <p style={{ color: '#71717a', fontSize: '0.9rem', marginTop: 0 }}>
                Characters in this list are always shown on the leaderboard. Others are shown only if they have attendance or loot in the last {ACTIVE_DAYS} days.
              </p>
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <input
                  type="text"
                  value={activeAddKey}
                  onChange={(e) => setActiveAddKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddActive()}
                  placeholder="Character name or char_id"
                  style={{ padding: '0.35rem 0.5rem', minWidth: '12rem' }}
                />
                <button type="button" onClick={handleAddActive} disabled={activeMutating || !activeAddKey.trim()}>
                  Add
                </button>
              </div>
              <ul style={{ listStyle: 'none', paddingLeft: 0, margin: 0 }}>
                {activeRaiders.map((key) => (
                  <li key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                    <span>{key}</span>
                    <button type="button" onClick={() => handleRemoveActive(key)} disabled={activeMutating} style={{ fontSize: '0.85rem' }}>Remove</button>
                  </li>
                ))}
                {activeRaiders.length === 0 && <li style={{ color: '#71717a' }}>None added yet. Add character names or char_ids to always show them.</li>}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}
