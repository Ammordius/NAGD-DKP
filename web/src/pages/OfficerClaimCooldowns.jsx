import { useEffect, useState, useCallback, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useDkpData, ACTIVE_DAYS } from '../lib/dkpLeaderboard'
import { usePersistedState } from '../lib/usePersistedState'

const MAX_MARK_INACTIVE_MATCHES = 80

export default function OfficerClaimCooldowns({ isOfficer }) {
  const navigate = useNavigate()
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [resettingId, setResettingId] = useState(null)

  const { apiData, mutate } = useDkpData()
  const [activeRaiders, setActiveRaiders] = useState([])
  const [activeAddKey, setActiveAddKey] = usePersistedState('/officer/claim-cooldowns:activeAddKey', '')
  const [activeMutating, setActiveMutating] = useState(false)
  const [inactiveSearchQuery, setInactiveSearchQuery] = usePersistedState('/officer/claim-cooldowns:inactiveSearchQuery', '')

  useEffect(() => {
    if (apiData?.active_raiders?.length !== undefined) {
      setActiveRaiders((apiData.active_raiders || []).map((x) => String(x.character_key)))
    }
  }, [apiData?.active_raiders])

  const inactiveAccounts = (apiData?.accounts ?? []).filter((a) => a.inactive === true)
  const activeAccounts = (apiData?.accounts ?? []).filter((a) => !a.inactive)
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

  useEffect(() => {
    if (!isOfficer) {
      navigate('/officer', { replace: true })
      return
    }
    loadCooldowns()
  }, [isOfficer, navigate])

  async function loadCooldowns() {
    setLoading(true)
    setError('')
    const { data, error: e } = await supabase
      .from('profiles')
      .select('id, email, unclaim_cooldown_until, unclaim_count')
      .not('unclaim_cooldown_until', 'is', null)
      .order('unclaim_cooldown_until', { ascending: true })
    setLoading(false)
    if (e) {
      setError(e.message)
      setProfiles([])
      return
    }
    setProfiles(data || [])
  }

  async function handleResetCooldown(profileId) {
    setResettingId(profileId)
    setError('')
    const { error: rpcErr } = await supabase.rpc('reset_claim_cooldown', { p_profile_id: profileId })
    setResettingId(null)
    if (rpcErr) {
      setError(rpcErr.message)
      return
    }
    await loadCooldowns()
  }

  const handleAddActive = useCallback(async () => {
    const key = activeAddKey.trim()
    if (!key) return
    setActiveMutating(true)
    setError('')
    const { error: e } = await supabase.from('active_raiders').upsert({ character_key: key }, { onConflict: 'character_key' })
    setActiveMutating(false)
    if (e) {
      setError(e.message)
      return
    }
    setActiveAddKey('')
    setActiveRaiders((prev) => (prev.includes(key) ? prev : [...prev, key]))
    await mutate()
  }, [activeAddKey, mutate])

  const handleRemoveActive = useCallback(async (key) => {
    setActiveMutating(true)
    setError('')
    const { error: e } = await supabase.from('active_raiders').delete().eq('character_key', key)
    setActiveMutating(false)
    if (e) {
      setError(e.message)
      return
    }
    setActiveRaiders((prev) => prev.filter((k) => k !== key))
    await mutate()
  }, [mutate])

  const handleMarkAccountInactive = useCallback(async (accountId) => {
    if (!accountId) return
    setActiveMutating(true)
    setError('')
    const { error: e } = await supabase.from('accounts').update({ inactive: true }).eq('account_id', accountId)
    setActiveMutating(false)
    if (e) {
      setError(e.message)
      return
    }
    setInactiveSearchQuery('')
    await mutate()
  }, [mutate])

  const handleRestoreAccount = useCallback(async (accountId) => {
    setActiveMutating(true)
    setError('')
    const { error: e } = await supabase.from('accounts').update({ inactive: false }).eq('account_id', accountId)
    setActiveMutating(false)
    if (e) {
      setError(e.message)
      return
    }
    await mutate()
  }, [mutate])

  if (!isOfficer) return null

  return (
    <div className="container">
      <p><Link to="/officer">← Officer</Link></p>
      <h1>Admin</h1>

      {/* Claim cooldowns */}
      <section className="card" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ marginTop: 0 }}>Claim cooldowns</h2>
        <p style={{ color: '#a1a1aa', marginBottom: '0.75rem' }}>
          Players who unclaimed an account must wait before claiming again (10 min → 1 day → 7 days). Remove cooldown to let them claim immediately.
        </p>
        {error && <p className="error" style={{ marginBottom: '0.75rem' }}>{error}</p>}
        {loading ? (
          <p style={{ color: '#71717a' }}>Loading…</p>
        ) : profiles.length === 0 ? (
          <p style={{ color: '#71717a' }}>No accounts currently on claim cooldown.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Cooldown until</th>
                <th>Unclaim count</th>
                <th style={{ width: '10rem' }}></th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => {
                const until = p.unclaim_cooldown_until ? new Date(p.unclaim_cooldown_until) : null
                const isExpired = until && until <= new Date()
                return (
                  <tr key={p.id}>
                    <td>{p.email || <span style={{ color: '#71717a' }}>—</span>}</td>
                    <td>
                      {until ? until.toLocaleString() : '—'}
                      {isExpired && <span style={{ color: '#71717a', marginLeft: '0.5rem' }}>(expired)</span>}
                    </td>
                    <td>{p.unclaim_count ?? 0}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{ fontSize: '0.875rem' }}
                        onClick={() => handleResetCooldown(p.id)}
                        disabled={resettingId === p.id}
                      >
                        {resettingId === p.id ? 'Removing…' : 'Remove cooldown'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* Active raiders & inactive accounts */}
      <section className="card" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ marginTop: 0 }}>Active raiders & inactive accounts</h2>
        <p style={{ color: '#71717a', fontSize: '0.9rem', marginTop: 0 }}>
          Characters in the active list are always shown on the DKP leaderboard. Others are shown only if they have attendance or loot in the last {ACTIVE_DAYS} days. Inactive accounts are hidden from the leaderboard and Accounts list.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', marginTop: '0.75rem' }}>
          <input
            type="text"
            value={activeAddKey}
            onChange={(e) => setActiveAddKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddActive()}
            placeholder="Character name or char_id"
            style={{ padding: '0.35rem 0.5rem', minWidth: '12rem' }}
          />
          <button type="button" onClick={handleAddActive} disabled={activeMutating || !activeAddKey.trim()}>
            Add active
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
          <strong>Mark account inactive</strong> — Search by display name, toon names, or account ID.
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
        {inactiveAccounts.length > 0 && (
          <div style={{ marginTop: '1rem' }}>
            <strong>Inactive accounts</strong>
            <ul style={{ listStyle: 'none', paddingLeft: 0, margin: '0.35rem 0 0' }}>
              {inactiveAccounts.map((acc) => {
                const label = (acc.display_name || '').trim() || (acc.toon_names || '').split(',')[0]?.trim() || acc.account_id
                return (
                  <li key={acc.account_id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                    <span>{label}</span>
                    <span style={{ color: '#71717a', fontSize: '0.85rem' }}><code>{acc.account_id}</code></span>
                    <Link to={`/accounts/${acc.account_id}`} style={{ fontSize: '0.85rem', marginRight: '0.5rem' }}>View</Link>
                    <button type="button" onClick={() => handleRestoreAccount(acc.account_id)} disabled={activeMutating} style={{ fontSize: '0.85rem' }}>Restore</button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </section>
    </div>
  )
}
