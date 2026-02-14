import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'

// Supabase/PostgREST returns at most 1000 rows per query. Paginate to fetch all rows.
const PAGE_SIZE = 1000
const ACTIVE_DAYS = 120 // Show raiders marked active or with activity in last N days

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
      r.earned += adjRow.earned_delta
      r.spent += adjRow.spent_delta || 0
    }
    r.balance = r.earned - r.spent
  })
  list.sort((a, b) => b.balance - a.balance)
}

function buildAccountLeaderboard(list, caData, accData) {
  const charToAccount = {}
  ;(caData || []).forEach((r) => { charToAccount[String(r.char_id)] = r.account_id })
  const accountNames = {}
  ;(accData || []).forEach((r) => {
    const first = (r.toon_names || '').split(',')[0]?.trim() || r.account_id
    accountNames[r.account_id] = first
  })
  const byAccount = {}
  list.forEach((r) => {
    const aid = charToAccount[String(r.char_id)] ?? '_no_account_'
    if (!byAccount[aid]) byAccount[aid] = { account_id: aid, earned: 0, spent: 0, name: accountNames[aid] || (aid === '_no_account_' ? '(no account)' : aid) }
    byAccount[aid].earned += r.earned
    byAccount[aid].spent += r.spent
  })
  const accountList = Object.values(byAccount).map((r) => ({ ...r, balance: r.earned - r.spent }))
  accountList.sort((a, b) => b.balance - a.balance)
  return accountList
}

function isActiveRow(r, activeKeysSet, cutoffDate) {
  if (!activeKeysSet && cutoffDate == null) return true
  if (activeKeysSet?.has(String(r.char_id))) return true
  if (r.last_activity_date && cutoffDate) {
    const d = typeof r.last_activity_date === 'string' ? new Date(r.last_activity_date) : r.last_activity_date
    if (!isNaN(d.getTime()) && d >= cutoffDate) return true
  }
  return false
}

export default function DKP({ isOfficer }) {
  const [leaderboard, setLeaderboard] = useState([])
  const [accountLeaderboard, setAccountLeaderboard] = useState([])
  const [view, setView] = useState('character')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [usingCache, setUsingCache] = useState(false)
  const [summaryUpdatedAt, setSummaryUpdatedAt] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [activeRaiders, setActiveRaiders] = useState([])
  const [activeManageOpen, setActiveManageOpen] = useState(false)
  const [activeAddKey, setActiveAddKey] = useState('')
  const [activeMutating, setActiveMutating] = useState(false)

  const loadFromCache = useCallback(async () => {
    const [summary, adj, ca, acc, active] = await Promise.all([
      supabase.from('dkp_summary').select('character_key, character_name, earned, spent, last_activity_date, updated_at'),
      supabase.from('dkp_adjustments').select('character_name, earned_delta, spent_delta').limit(1000),
      fetchAllRows('character_account', 'char_id, account_id'),
      fetchAllRows('accounts', 'account_id, toon_names'),
      fetchAllRows('active_raiders', 'character_key'),
    ])
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
    let list = rows.map((r) => ({
      char_id: r.character_key,
      name: r.character_name || r.character_key,
      earned: Number(r.earned) || 0,
      spent: Number(r.spent) || 0,
      last_activity_date: r.last_activity_date || null,
    }))
    list = list.filter((r) => isActiveRow(r, activeSet, cutoff))
    applyAdjustmentsAndBalance(list, adjustmentsMap)
    const accountList = buildAccountLeaderboard(list, ca?.data ?? [], acc?.data ?? [])
    setLeaderboard(list)
    setAccountLeaderboard(accountList)
    setSummaryUpdatedAt(rows[0]?.updated_at || null)
    setUsingCache(true)
    return { ok: true }
  }, [])

  const loadLive = useCallback(async () => {
    const [att, ev, evAtt, loot, ca, acc, adj] = await Promise.all([
      fetchAllRows('raid_attendance', 'raid_id, char_id, character_name'),
      fetchAllRows('raid_events', 'raid_id, event_id, dkp_value'),
      fetchAllRows('raid_event_attendance', 'raid_id, event_id, char_id, character_name'),
      fetchAllRows('raid_loot', 'char_id, character_name, cost'),
      fetchAllRows('character_account', 'char_id, account_id'),
      fetchAllRows('accounts', 'account_id, toon_names'),
      supabase.from('dkp_adjustments').select('character_name, earned_delta, spent_delta').limit(1000),
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
    const accountList = buildAccountLeaderboard(list, ca.data, acc.data)
    setLeaderboard(list)
    setAccountLeaderboard(accountList)
    setSummaryUpdatedAt(null)
    setUsingCache(false)
    return { ok: true }
  }, [])

  const load = useCallback(async () => {
    setError('')
    const cacheResult = await loadFromCache()
    if (cacheResult.ok) return
    if (cacheResult.error) {
      setError(cacheResult.error.message)
      setLoading(false)
      return
    }
    const liveResult = await loadLive()
    if (!liveResult.ok) {
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

  if (loading) return <div className="container">Loading DKP…</div>
  if (error) return <div className="container"><span className="error">{error}</span></div>

  const showList = view === 'account' ? accountLeaderboard : leaderboard
  const colLabel = view === 'account' ? 'Account (first toon)' : 'Character'

  return (
    <div className="container">
      <h1>DKP Leaderboard</h1>
      <p style={{ color: '#71717a' }}>
        Earned (raid attendance × event DKP) minus spent (loot). Toggle to view by character or by account (all toons on same account summed).
        {usingCache && summaryUpdatedAt && (
          <span style={{ marginLeft: '0.5rem' }}>· Cached {new Date(summaryUpdatedAt).toLocaleString()}</span>
        )}
        {usingCache && (
          <span style={{ marginLeft: '0.5rem' }}>· Showing active raiders only (marked active or activity in last {ACTIVE_DAYS} days)</span>
        )}
      </p>
      <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" onClick={() => setView('character')} style={{ fontWeight: view === 'character' ? 'bold' : 'normal' }}>By character</button>
        <button type="button" onClick={() => setView('account')} style={{ fontWeight: view === 'account' ? 'bold' : 'normal' }}>By account</button>
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
            </tr>
          </thead>
          <tbody>
            {showList.slice(0, 200).map((r, i) => (
              <tr key={view === 'account' ? r.account_id + i : r.char_id}>
                <td>{r.name}</td>
                <td>{Number(r.earned).toFixed(1)}</td>
                <td>{r.spent}</td>
                <td><strong>{Number(r.balance).toFixed(1)}</strong></td>
              </tr>
            ))}
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
