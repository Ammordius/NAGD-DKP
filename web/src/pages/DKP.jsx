import { useEffect, useState, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useDkpData, ACTIVE_DAYS } from '../lib/dkpLeaderboard'
import {
  LEADERBOARD_SORT_COLUMNS,
  attendanceShareColor,
  attendanceSharePercent,
  compareLeaderboardRows,
  leaderboardRowMetrics,
  nextLeaderboardSort,
  normalizeLeaderboardSort,
} from '../lib/dkpLeaderboardSort'
import { usePersistedState } from '../lib/usePersistedState'
import DkpSiteDisclaimer from '../components/DkpSiteDisclaimer'
import { MyDkpStandingsView, useMyAccountDkp } from '../components/MyDkpStandings'

export default function DKP({ isOfficer, profile }) {
  const {
    list: leaderboard,
    accountList: accountLeaderboard,
    accountTotalsByAccountId,
    periodTotals,
    summaryUpdatedAt,
    isLoading,
    error: hookError,
    mutate,
    apiData,
  } = useDkpData()
  const myDkp = useMyAccountDkp(profile?.account_id)
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
    const { error: accountError } = await supabase.rpc('refresh_account_dkp_summary')
    if (accountError) {
      setMutationError(accountError.message)
      await mutate()
      setRefreshing(false)
      return
    }
    await mutate()
    setRefreshing(false)
  }, [mutate])

  const [accountSearch, setAccountSearch] = usePersistedState('/dkp:accountSearch', '')
  const [sortKey, setSortKey] = usePersistedState('/dkp:sortKey', 'balance')
  const [sortDir, setSortDir] = usePersistedState('/dkp:sortDir', 'desc')
  const sort = normalizeLeaderboardSort(sortKey, sortDir)
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
  const showList = useMemo(
    () => [...filteredLeaderboard].sort((a, b) => compareLeaderboardRows(a, b, sort.key, sort.dir, accountTotalsByAccountId)),
    [filteredLeaderboard, sort.key, sort.dir, accountTotalsByAccountId],
  )
  const colLabel = 'Account'

  function handleSort(column) {
    const next = nextLeaderboardSort(sort.key, sort.dir, column)
    setSortKey(next.key)
    setSortDir(next.dir)
  }

  if (loading && !showList.length) return <div className="container">Loading DKP…</div>
  if (error && !showList.length) return <div className="container"><span className="error">{error}</span></div>

  return (
    <div className="container">
      <h1>DKP Leaderboard</h1>
      <MyDkpStandingsView {...myDkp} />
      <DkpSiteDisclaimer />
      <p style={{ color: '#71717a' }}>
        One row per account (one human). Earned, spent, and balance are the account totals. Adjustments are included.
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
              {LEADERBOARD_SORT_COLUMNS.map((column) => {
                const active = sort.key === column
                const label = column === 'account' ? colLabel : column === '30d' ? '30d' : column === '60d' ? '60d' : column[0].toUpperCase() + column.slice(1)
                const title = column === '30d' || column === '60d'
                  ? 'DKP earned / total DKP in period; % = share in period. Sort uses DKP earned in the period.'
                  : `Sort by ${label}`
                return (
                  <th
                    key={column}
                    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    style={column === 'balance' ? { color: 'var(--balance-green, #22c55e)', fontWeight: 'bold' } : undefined}
                  >
                    <button
                      type="button"
                      className="dkp-sort-btn"
                      onClick={() => handleSort(column)}
                      title={title}
                      aria-label={`${title}. ${active ? `Sorted ${sort.dir === 'asc' ? 'ascending' : 'descending'}` : 'Not sorted'}.`}
                    >
                      <span className="dkp-sort-label">{label}</span>
                      {active && (
                        <span
                          className={`dkp-sort-triangle ${sort.dir === 'asc' ? 'dkp-sort-triangle-asc' : 'dkp-sort-triangle-desc'}`}
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {showList.slice(0, 200).map((r, i) => {
              const metrics = leaderboardRowMetrics(r, accountTotalsByAccountId)
              const total30 = periodTotals['30d'] || 0
              const total60 = periodTotals['60d'] || 0
              const pct30 = attendanceSharePercent(metrics.earned30, total30)
              const pct60 = attendanceSharePercent(metrics.earned60, total60)
              const cell30 = pct30 == null ? '—' : `${metrics.earned30} / ${total30} (${pct30}%)`
              const cell60 = pct60 == null ? '—' : `${metrics.earned60} / ${total60} (${pct60}%)`
              return (
                <tr key={r.account_id + i}>
                  <td><Link to={`/accounts/${r.account_id}`}>{r.name}</Link></td>
                  <td style={{ color: 'var(--balance-green, #22c55e)', fontWeight: 'bold' }}>{metrics.balance}</td>
                  <td>{metrics.earned}</td>
                  <td>{metrics.spent}</td>
                  <td style={pct30 == null ? undefined : { color: attendanceShareColor(pct30) }}>{cell30}</td>
                  <td style={pct60 == null ? undefined : { color: attendanceShareColor(pct60) }}>{cell60}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {isOfficer && (
        <p style={{ color: '#71717a', fontSize: '0.9rem', marginTop: '1rem' }}>
          <Link to="/officer/SiteAdmin">Site Admin</Link> — Set accounts as active or inactive, and remove claim cooldowns.
        </p>
      )}
    </div>
  )
}
