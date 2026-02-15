import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// Supabase/PostgREST returns at most 1000 rows per query. Paginate to fetch all rows.
const PAGE_SIZE = 1000
const ACTIVE_DAYS = 120 // Show raiders marked active or with activity in last N days
const CACHE_KEY = 'dkp_leaderboard_v2'
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes: show cached data immediately, refresh in background

async function fetchAllRows(table, select = '*') {
  const all = []
  let from = 0
  while (true) {
    const to = from + PAGE_SIZE - 1
    const { data, error } = await supabase.from(table).select(select).range(from, to)
    if (error) return { data: null, error }
    all.push(...(data || []))
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return { data: all, error: null }
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

export default function DKP({ isOfficer }) {
  const [leaderboard, setLeaderboard] = useState([])
  const [accountLeaderboard, setAccountLeaderboard] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
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

  // Load summary + adjustments + active + character_account + accounts so we always show one row per account.
  const loadFromCache = useCallback(async (opts = {}) => {
    const { includeAccountData = true } = opts
    const tables = [
      supabase.from('dkp_summary').select('character_key, character_name, earned, spent, earned_30d, earned_60d, last_activity_date, updated_at'),
      supabase.from('dkp_adjustments').select('character_name, earned_delta, spent_delta').limit(1000),
      fetchAllRows('active_raiders', 'character_key'),
      supabase.from('dkp_period_totals').select('period, total_dkp'),
      fetchAllRows('character_account', 'char_id, account_id'),
      fetchAllRows('accounts', 'account_id, toon_names, display_name'),
      fetchAllRows('characters', 'char_id, name'),
    ]
    const results = await Promise.all(tables)
    const [summary, adj, active, periodTotalsRes, ca, acc, charDataRes] = results
    const charData = charDataRes?.data ?? []
    if (summary.error) return { ok: false, error: summary.error }
    const rows = summary.data || []
    if (rows.length === 0) return { ok: false }
    const activeKeys = (active?.data ?? []).map((x) => String(x.character_key))
    setActiveRaiders(activeKeys)
    const activeSet = new Set(activeKeys)
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - ACTIVE_DAYS)
    cutoff.setHours(0, 0, 0, 0)
    const adjustments = (adj?.data) || []
    const adjustmentsMap = {}
    adjustments.forEach((row) => {
      const n = (row.character_name || '').trim()
      if (n) adjustmentsMap[n] = { earned_delta: Number(row.earned_delta) || 0, spent_delta: Number(row.spent_delta) || 0 }
    })
    const pt = { '30d': 0, '60d': 0 }
    ;(periodTotalsRes?.data || []).forEach((row) => { pt[row.period] = Math.round(Number(row.total_dkp) || 0) })
    setPeriodTotals(pt)
    let list = rows.map((r) => ({
      char_id: r.character_key,
      name: r.character_name || r.character_key,
      earned: Math.round(Number(r.earned) || 0),
      spent: Math.round(Number(r.spent) || 0),
      earned_30d: Math.round(Number(r.earned_30d) || 0),
      earned_60d: Math.round(Number(r.earned_60d) || 0),
      last_activity_date: r.last_activity_date || null,
    }))
    list = list.filter((r) => isActiveRow(r, activeSet, cutoff))
    applyAdjustmentsAndBalance(list, adjustmentsMap)
    if (ca?.data) setCaData(ca.data)
    if (acc?.data) setAccData(acc.data)
    setCharData(charData)
    const accountList = buildAccountLeaderboard(list, ca?.data ?? [], acc?.data ?? [], charData)
    setLeaderboard(list)
    setAccountLeaderboard(accountList)
    const updatedAt = rows[0]?.updated_at ?? null
    setSummaryUpdatedAt(updatedAt)
    setUsingCache(true)
    return { ok: true, list, accountList, summaryUpdatedAt: updatedAt }
  }, [])

  // When we get ca/acc/char data, rebuild account leaderboard from current character list.
  useEffect(() => {
    if (caData === null || accData === null || leaderboard.length === 0) return
    const accountList = buildAccountLeaderboard(leaderboard, caData, accData, charData ?? [])
    setAccountLeaderboard(accountList)
  }, [caData, accData, charData, leaderboard])

  const loadLive = useCallback(async () => {
    const [att, ev, evAtt, loot, ca, acc, adj, charRes] = await Promise.all([
      fetchAllRows('raid_attendance', 'raid_id, char_id, character_name'),
      fetchAllRows('raid_events', 'raid_id, event_id, dkp_value'),
      fetchAllRows('raid_event_attendance', 'raid_id, event_id, char_id, character_name'),
      fetchAllRows('raid_loot', 'char_id, character_name, cost'),
      fetchAllRows('character_account', 'char_id, account_id'),
      fetchAllRows('accounts', 'account_id, toon_names, display_name'),
      supabase.from('dkp_adjustments').select('character_name, earned_delta, spent_delta').limit(1000),
      fetchAllRows('characters', 'char_id, name'),
    ])
    const err = att.error || ev.error || evAtt.error || loot.error || ca.error || acc.error
    if (err) return { ok: false, error: err }
    const adjustments = (adj?.data) || []
    const adjustmentsMap = {}
    adjustments.forEach((row) => {
      const n = (row.character_name || '').trim()
      if (n) adjustmentsMap[n] = { earned_delta: Number(row.earned_delta) || 0, spent_delta: Number(row.spent_delta) || 0 }
    })
    const eventAttendance = evAtt.data || []
    const eventDkp = {}
    ;(ev.data || []).forEach((e) => {
      const k = `${e.raid_id}|${e.event_id}`
      eventDkp[k] = (eventDkp[k] || 0) + parseFloat(e.dkp_value || 0)
    })
    const earned = {}
    const usePerEvent = eventAttendance.length > 0
    if (usePerEvent) {
      eventAttendance.forEach((a) => {
        const key = a.char_id || a.character_name || 'unknown'
        if (!earned[key]) earned[key] = { name: a.character_name || key, earned: 0 }
        earned[key].earned += eventDkp[`${a.raid_id}|${a.event_id}`] || 0
        if (a.character_name) earned[key].name = a.character_name
      })
    } else {
      const evByRaid = {}
      ;(ev.data || []).forEach((e) => { evByRaid[e.raid_id] = (evByRaid[e.raid_id] || 0) + parseFloat(e.dkp_value || 0) })
      ;(att.data || []).forEach((a) => {
        const key = a.char_id || a.character_name || 'unknown'
        if (!earned[key]) earned[key] = { name: a.character_name || key, earned: 0 }
        earned[key].earned += evByRaid[a.raid_id] || 0
        if (a.character_name) earned[key].name = a.character_name
      })
    }
    const spent = {}
    ;(loot.data || []).forEach((row) => {
      const key = row.char_id || row.character_name
      if (!key) return
      spent[key] = (spent[key] || 0) + parseInt(row.cost || 0, 10)
    })
    const list = Object.entries(earned).map(([key, v]) => ({
      char_id: key,
      name: typeof v === 'object' ? v.name : key,
      earned: typeof v === 'object' ? v.earned : 0,
      spent: spent[key] || 0,
    }))
    applyAdjustmentsAndBalance(list, adjustmentsMap)
    const charData = charRes?.data ?? []
    const accountList = buildAccountLeaderboard(list, ca.data, acc.data, charData)
    setLeaderboard(list)
    setAccountLeaderboard(accountList)
    setSummaryUpdatedAt(null)
    setUsingCache(false)
    return { ok: true, list, accountList }
  }, [])

  const load = useCallback(async (opts = {}) => {
    const { skipCache = false } = opts
    setError('')

    if (!skipCache) {
      try {
        const raw = sessionStorage.getItem(CACHE_KEY)
        if (raw) {
          const obj = JSON.parse(raw)
          if (obj.fetchedAt && (Date.now() - obj.fetchedAt) < CACHE_TTL_MS && Array.isArray(obj.leaderboard)) {
            setLeaderboard(obj.leaderboard)
            setAccountLeaderboard(Array.isArray(obj.accountLeaderboard) ? obj.accountLeaderboard : [])
            setSummaryUpdatedAt(obj.summaryUpdatedAt ?? null)
            setUsingCache(!!obj.usingCache)
            setLoading(false)
          }
        }
      } catch (_) { /* ignore */ }
    }

    const cacheResult = await loadFromCache()
    if (cacheResult.ok) {
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify({
          leaderboard: cacheResult.list,
          accountLeaderboard: cacheResult.accountList,
          summaryUpdatedAt: cacheResult.summaryUpdatedAt ?? null,
          usingCache: true,
          fetchedAt: Date.now(),
        }))
      } catch (_) { /* ignore */ }
      return
    }
    if (cacheResult.error) {
      setError(cacheResult.error.message)
      setLoading(false)
      return
    }
    const liveResult = await loadLive()
    if (liveResult.ok) {
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify({
          leaderboard: liveResult.list,
          accountLeaderboard: liveResult.accountList,
          summaryUpdatedAt: null,
          usingCache: false,
          fetchedAt: Date.now(),
        }))
      } catch (_) { /* ignore */ }
    } else {
      setError(liveResult.error?.message || 'Failed to load DKP')
    }
  }, [loadFromCache, loadLive])

  useEffect(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load])

  const handleRefreshTotals = useCallback(async () => {
    setRefreshing(true)
    setError('')
    const { error: rpcError } = await supabase.rpc('refresh_dkp_summary')
    if (rpcError) {
      setError(rpcError.message)
      setRefreshing(false)
      return
    }
    setLoading(true)
    await loadFromCache()
    setLoading(false)
    setRefreshing(false)
  }, [loadFromCache])

  const handleAddActive = useCallback(async () => {
    const key = activeAddKey.trim()
    if (!key) return
    setActiveMutating(true)
    const { error: e } = await supabase.from('active_raiders').upsert({ character_key: key }, { onConflict: 'character_key' })
    setActiveMutating(false)
    if (e) setError(e.message)
    else {
      setActiveAddKey('')
      setActiveRaiders((prev) => (prev.includes(key) ? prev : [...prev, key]))
      loadFromCache()
    }
  }, [activeAddKey, loadFromCache])

  const handleRemoveActive = useCallback(async (key) => {
    setActiveMutating(true)
    const { error: e } = await supabase.from('active_raiders').delete().eq('character_key', key)
    setActiveMutating(false)
    if (e) setError(e.message)
    else {
      setActiveRaiders((prev) => prev.filter((k) => k !== key))
      loadFromCache()
    }
  }, [loadFromCache])

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
