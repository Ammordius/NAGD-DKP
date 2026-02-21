import { useEffect, useState, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useDkpData, ACTIVE_DAYS } from '../lib/dkpLeaderboard'

export default function DKP({ isOfficer }) {
  const {
    list: leaderboard,
    accountList: accountLeaderboard,
    periodTotals,
    summaryUpdatedAt,
    isLoading,
    error: hookError,
    mutate,
    apiData,
  } = useDkpData()
  const [refreshing, setRefreshing] = useState(false)
  const [mutationError, setMutationError] = useState('')

  const usingCache = Boolean(accountLeaderboard?.length)
  const loading = isLoading
  const error = hookError ?? mutationError ?? ''

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

  const [accountSearch, setAccountSearch] = useState('')
  const filteredLeaderboard = useMemo(() => {
    if (!accountSearch.trim()) return accountLeaderboard
    const q = accountSearch.trim().toLowerCase()
    const toonNamesByAccount = {}
    ;(apiData?.accounts ?? []).forEach((acc) => {
      toonNamesByAccount[acc.account_id] = (acc.toon_names || '').toLowerCase()
    })
    return accountLeaderboard.filter((r) => {
      if ((r.account_id || '').toLowerCase().includes(q)) return true
      if ((r.name || '').toLowerCase().includes(q)) return true
      if ((toonNamesByAccount[r.account_id] || '').includes(q)) return true
      return false
    })
  }, [accountLeaderboard, accountSearch, apiData?.accounts])
  const showList = filteredLeaderboard
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
        <input
          type="search"
          placeholder="Search by account, display name, or toon name…"
          value={accountSearch}
          onChange={(e) => setAccountSearch(e.target.value)}
          style={{
            width: '100%',
            maxWidth: '28rem',
            padding: '0.5rem 0.75rem',
            fontSize: '1rem',
            border: '1px solid #3f3f46',
            borderRadius: '6px',
            background: '#18181b',
            color: '#fafafa',
          }}
          aria-label="Search accounts on leaderboard"
        />
        {accountSearch.trim() && (
          <span style={{ color: '#71717a', fontSize: '0.875rem' }}>
            {filteredLeaderboard.length} account{filteredLeaderboard.length !== 1 ? 's' : ''}
          </span>
        )}
        {isOfficer && (
          <button type="button" onClick={handleRefreshTotals} disabled={refreshing} style={{ marginLeft: 'auto' }}>
            {refreshing ? 'Refreshing…' : 'Refresh DKP totals'}
          </button>
        )}
      </div>
      {accountLeaderboard.length === 0 && (
        <p style={{ color: '#f59e0b', marginBottom: '1rem' }}>
          No DKP data. Make sure you’re logged in and the app is using the same Supabase project where you imported the CSVs (check Vercel env: VITE_SUPABASE_URL).
        </p>
      )}
      {accountLeaderboard.length > 0 && showList.length === 0 && (
        <p style={{ color: '#71717a', marginBottom: '1rem' }}>No accounts match your search.</p>
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
              <th style={{ textDecoration: 'underline' }}>{colLabel}</th>
              <th style={{ color: 'var(--balance-green, #22c55e)', fontWeight: 'bold', textDecoration: 'underline' }}>Balance</th>
              <th style={{ textDecoration: 'underline' }}>Earned</th>
              <th style={{ textDecoration: 'underline' }}>Spent</th>
              <th style={{ textDecoration: 'underline' }} title="DKP earned / total DKP in period; % = share in period">30d</th>
              <th style={{ textDecoration: 'underline' }} title="DKP earned / total DKP in period; % = share in period">60d</th>
            </tr>
          </thead>
          <tbody>
            {showList.slice(0, 200).map((r, i) => {
              const total30 = periodTotals['30d'] || 0
              const total60 = periodTotals['60d'] || 0
              const e30 = r.earned_30d != null ? Math.round(r.earned_30d) : 0
              const e60 = r.earned_60d != null ? Math.round(r.earned_60d) : 0
              const cell30 = total30 > 0 ? `${e30} / ${total30} (${Math.round((e30 / total30) * 100)}%)` : '—'
              const cell60 = total60 > 0 ? `${e60} / ${total60} (${Math.round((e60 / total60) * 100)}%)` : '—'
              return (
                <tr key={r.account_id + i}>
                  <td><Link to={`/accounts/${r.account_id}`}>{r.name}</Link></td>
                  <td style={{ color: 'var(--balance-green, #22c55e)', fontWeight: 'bold' }}>{Number(r.balance)}</td>
                  <td>{Number(r.earned)}</td>
                  <td>{Number(r.spent)}</td>
                  <td>{cell30}</td>
                  <td>{cell60}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {isOfficer && (
        <p style={{ color: '#71717a', fontSize: '0.9rem', marginTop: '1rem' }}>
          <Link to="/officer/claim-cooldowns">Admin</Link> — Manage active raiders, mark accounts inactive, and remove claim cooldowns.
        </p>
      )}
    </div>
  )
}
