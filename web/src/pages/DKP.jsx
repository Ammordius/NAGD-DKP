import { useEffect, useState, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useDkpData, ACTIVE_DAYS } from '../lib/dkpLeaderboard'

export default function DKP({ isOfficer }) {
  const {
    list: leaderboard,
    accountList: accountLeaderboard,
    activeKeys,
    periodTotals,
    summaryUpdatedAt,
    isLoading,
    error: hookError,
    mutate,
    apiData,
  } = useDkpData()
  const [refreshing, setRefreshing] = useState(false)
  const [activeRaiders, setActiveRaiders] = useState([])
  const [activeManageOpen, setActiveManageOpen] = useState(false)
  const [activeAddKey, setActiveAddKey] = useState('')
  const [activeMutating, setActiveMutating] = useState(false)
  const [mutationError, setMutationError] = useState('')

  useEffect(() => {
    if (activeKeys?.length !== undefined) setActiveRaiders(activeKeys)
  }, [activeKeys])

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

  const inactiveAccounts = (apiData?.accounts ?? []).filter((a) => a.inactive === true)
  const activeAccounts = (apiData?.accounts ?? []).filter((a) => !a.inactive)
  const [inactiveSearchQuery, setInactiveSearchQuery] = useState('')
  const MAX_MARK_INACTIVE_MATCHES = 80

  const markInactiveMatches = useMemo(() => {
    const q = (inactiveSearchQuery || '').trim().toLowerCase()
    if (!q) return []
    const matches = activeAccounts.filter((acc) => {
      if ((acc.account_id || '').toLowerCase().includes(q)) return true
      if ((acc.display_name || '').toLowerCase().includes(q)) return true
      return (acc.toon_names || '').toLowerCase().includes(q)
    })
    return matches.slice(0, MAX_MARK_INACTIVE_MATCHES)
  }, [activeAccounts, inactiveSearchQuery])

  const handleMarkAccountInactive = useCallback(async (accountId) => {
    if (!accountId) return
    setActiveMutating(true)
    setMutationError('')
    const { error: e } = await supabase.from('accounts').update({ inactive: true }).eq('account_id', accountId)
    setActiveMutating(false)
    if (e) {
      setMutationError(e.message)
      return
    }
    setInactiveSearchQuery('')
    await mutate()
  }, [mutate])

  const handleRestoreAccount = useCallback(async (accountId) => {
    setActiveMutating(true)
    setMutationError('')
    const { error: e } = await supabase.from('accounts').update({ inactive: false }).eq('account_id', accountId)
    setActiveMutating(false)
    if (e) {
      setMutationError(e.message)
      return
    }
    await mutate()
  }, [mutate])

  const [accountSearch, setAccountSearch] = useState('')
  const filteredLeaderboard = useMemo(() => {
    if (!accountSearch.trim()) return accountLeaderboard
    const q = accountSearch.trim().toLowerCase()
    return accountLeaderboard.filter((r) => {
      if ((r.account_id || '').toLowerCase().includes(q)) return true
      if ((r.name || '').toLowerCase().includes(q)) return true
      return false
    })
  }, [accountLeaderboard, accountSearch])
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
          placeholder="Search by account or display name…"
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
              <hr style={{ margin: '1rem 0', borderColor: '#3f3f46' }} />
              <p style={{ color: '#71717a', fontSize: '0.9rem', marginTop: 0 }}>
                Inactive accounts are hidden from the DKP leaderboard and the Accounts list. Their loot and attendance still appear on raid and character pages.
              </p>
              <div style={{ marginBottom: '0.75rem' }}>
                <strong>Mark account inactive</strong>
                <p style={{ color: '#71717a', fontSize: '0.85rem', margin: '0.25rem 0 0.35rem 0' }}>
                  Search by display name, toon names, or account ID. No list until you search.
                </p>
                <input
                  type="search"
                  value={inactiveSearchQuery}
                  onChange={(e) => setInactiveSearchQuery(e.target.value)}
                  placeholder="Search by display name, toon names, or account ID…"
                  style={{
                    width: '100%',
                    maxWidth: '28rem',
                    padding: '0.5rem 0.75rem',
                    fontSize: '1rem',
                    marginTop: '0.35rem',
                    background: '#18181b',
                    color: '#fafafa',
                    border: '1px solid #3f3f46',
                    borderRadius: '6px',
                  }}
                  aria-label="Search accounts to mark inactive"
                />
                {inactiveSearchQuery.trim() && (
                  <ul style={{ listStyle: 'none', paddingLeft: 0, margin: '0.5rem 0 0', maxHeight: '12rem', overflowY: 'auto' }}>
                    {markInactiveMatches.length === 0 && (
                      <li style={{ color: '#71717a', fontSize: '0.9rem' }}>No matching accounts.</li>
                    )}
                    {markInactiveMatches.map((acc) => {
                      const label = (acc.display_name || '').trim() || (acc.toon_names || '').split(',')[0]?.trim() || acc.account_id
                      return (
                        <li key={acc.account_id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem', flexWrap: 'wrap' }}>
                          <span>{label}</span>
                          <span style={{ color: '#71717a', fontSize: '0.85rem' }}><code>{acc.account_id}</code></span>
                          <button type="button" onClick={() => handleMarkAccountInactive(acc.account_id)} disabled={activeMutating} style={{ fontSize: '0.85rem' }}>
                            Mark inactive
                          </button>
                        </li>
                      )
                    })}
                    {markInactiveMatches.length >= MAX_MARK_INACTIVE_MATCHES && (
                      <li style={{ color: '#71717a', fontSize: '0.85rem', marginTop: '0.25rem' }}>
                        Showing first {MAX_MARK_INACTIVE_MATCHES} matches. Narrow your search for more.
                      </li>
                    )}
                  </ul>
                )}
              </div>
              {inactiveAccounts.length > 0 && (
                <div>
                  <strong>Inactive accounts</strong>
                  <ul style={{ listStyle: 'none', paddingLeft: 0, margin: '0.35rem 0 0' }}>
                    {inactiveAccounts.map((acc) => {
                      const label = (acc.display_name || '').trim() || (acc.toon_names || '').split(',')[0]?.trim() || acc.account_id
                      return (
                        <li key={acc.account_id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                          <span>{label}</span>
                          <span style={{ color: '#71717a', fontSize: '0.85rem' }}><code>{acc.account_id}</code></span>
                          <button type="button" onClick={() => handleRestoreAccount(acc.account_id)} disabled={activeMutating} style={{ fontSize: '0.85rem' }}>Restore</button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
