import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useDkpData } from '../lib/dkpLeaderboard'
import { usePersistedState } from '../lib/usePersistedState'
import { buildAccountColumnRows, buildCharacterRows, characterMatchesQuery } from '../lib/siteAdminCharacters'

const SUGGEST_LIMIT = 80

export default function OfficerClaimCooldowns({ isOfficer }) {
  const navigate = useNavigate()
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [resettingId, setResettingId] = useState(null)

  const { apiData, isLoading: dkpLoading, mutate } = useDkpData()
  const [charQuery, setCharQuery] = usePersistedState('/officer/SiteAdmin:charQuery', '')
  const [selectedCharId, setSelectedCharId] = useState(null)
  const [showSuggest, setShowSuggest] = useState(false)
  const [suggestIndex, setSuggestIndex] = useState(0)
  const [charError, setCharError] = useState('')
  const [charMutating, setCharMutating] = useState(false)
  const [selectedActiveAccountId, setSelectedActiveAccountId] = useState(null)
  const [selectedInactiveAccountId, setSelectedInactiveAccountId] = useState(null)
  const selectedCharRef = useRef(null)

  const accountsById = useMemo(() => {
    const map = new Map()
    for (const account of apiData?.accounts ?? []) {
      if (account?.account_id != null) map.set(String(account.account_id), account)
    }
    return map
  }, [apiData?.accounts])

  const characterRows = useMemo(
    () => buildCharacterRows(apiData?.characters, apiData?.character_account, apiData?.accounts),
    [apiData?.characters, apiData?.character_account, apiData?.accounts]
  )

  const filteredRows = useMemo(
    () => characterRows.filter((row) => characterMatchesQuery(row, charQuery)),
    [characterRows, charQuery]
  )

  const suggestRows = filteredRows.slice(0, SUGGEST_LIMIT)
  const selectedCharacter = useMemo(
    () => characterRows.find((row) => row.char_id === selectedCharId) || null,
    [characterRows, selectedCharId]
  )

  const activeCharRows = useMemo(
    () => buildAccountColumnRows(
      (apiData?.active_accounts ?? []).map((row) => row.account_id),
      accountsById
    ),
    [apiData?.active_accounts, accountsById]
  )

  const inactiveCharRows = useMemo(
    () => buildAccountColumnRows(
      (apiData?.accounts ?? []).filter((account) => account.inactive === true).map((account) => account.account_id),
      accountsById
    ),
    [apiData?.accounts, accountsById]
  )

  useEffect(() => {
    setSuggestIndex(0)
  }, [charQuery])

  useEffect(() => {
    selectedCharRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedCharId])

  useEffect(() => {
    if (!isOfficer) {
      navigate('/', { replace: true })
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

  const selectCharacter = useCallback((row) => {
    if (!row) return
    setSelectedCharId(row.char_id)
    setCharQuery(row.label)
    setShowSuggest(false)
    setCharError('')
  }, [setCharQuery])

  const handleSetActive = useCallback(async () => {
    if (!selectedCharacter) return
    if (!selectedCharacter.account_id) {
      setCharError('That character is not linked to an account.')
      return
    }
    const accountId = selectedCharacter.account_id
    setCharMutating(true)
    setCharError('')
    const { error: upsertErr } = await supabase
      .from('active_accounts')
      .upsert({ account_id: accountId }, { onConflict: 'account_id' })
    if (upsertErr) {
      setCharMutating(false)
      setCharError(upsertErr.message)
      return
    }
    const { error: updateErr } = await supabase
      .from('accounts')
      .update({ inactive: false })
      .eq('account_id', accountId)
    setCharMutating(false)
    if (updateErr) {
      setCharError(updateErr.message)
      return
    }
    setSelectedInactiveAccountId((current) => (current === accountId ? null : current))
    await mutate()
  }, [selectedCharacter, mutate])

  const handleSetInactive = useCallback(async () => {
    if (!selectedCharacter) return
    if (!selectedCharacter.account_id) {
      setCharError('That character is not linked to an account.')
      return
    }
    const accountId = selectedCharacter.account_id
    setCharMutating(true)
    setCharError('')
    const { error: updateErr } = await supabase
      .from('accounts')
      .update({ inactive: true })
      .eq('account_id', accountId)
    if (updateErr) {
      setCharMutating(false)
      setCharError(updateErr.message)
      return
    }
    const { error: deleteErr } = await supabase
      .from('active_accounts')
      .delete()
      .eq('account_id', accountId)
    setCharMutating(false)
    if (deleteErr) {
      setCharError(deleteErr.message)
      return
    }
    setSelectedActiveAccountId((current) => (current === accountId ? null : current))
    await mutate()
  }, [selectedCharacter, mutate])

  const handleRemoveActive = useCallback(async () => {
    if (!selectedActiveAccountId) return
    setCharMutating(true)
    setCharError('')
    const { error: deleteErr } = await supabase
      .from('active_accounts')
      .delete()
      .eq('account_id', selectedActiveAccountId)
    setCharMutating(false)
    if (deleteErr) {
      setCharError(deleteErr.message)
      return
    }
    setSelectedActiveAccountId(null)
    await mutate()
  }, [selectedActiveAccountId, mutate])

  const handleRemoveInactive = useCallback(async () => {
    if (!selectedInactiveAccountId) return
    setCharMutating(true)
    setCharError('')
    const { error: updateErr } = await supabase
      .from('accounts')
      .update({ inactive: false })
      .eq('account_id', selectedInactiveAccountId)
    setCharMutating(false)
    if (updateErr) {
      setCharError(updateErr.message)
      return
    }
    setSelectedInactiveAccountId(null)
    await mutate()
  }, [selectedInactiveAccountId, mutate])

  function handleCharQueryKeyDown(event) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setShowSuggest(true)
      setSuggestIndex((index) => Math.min(index + 1, Math.max(suggestRows.length - 1, 0)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setShowSuggest(true)
      setSuggestIndex((index) => Math.max(index - 1, 0))
      return
    }
    if (event.key === 'Escape') {
      setShowSuggest(false)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const row = (showSuggest && suggestRows[suggestIndex]) || (filteredRows.length === 1 ? filteredRows[0] : null)
      if (row) selectCharacter(row)
    }
  }

  if (!isOfficer) return null

  const query = (charQuery || '').trim()
  const showSuggestList = showSuggest && query.length > 0

  return (
    <div className="container">
      <p><Link to="/officer/RaidAdmin">← Raid Admin</Link></p>
      <h1>Site Admin</h1>

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

      <section className="card" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ marginTop: 0 }}>Set characters as Active or Inactive</h2>
        <p style={{ color: '#71717a', fontSize: '0.9rem', marginTop: 0 }}>
          Characters on DKP Leaderboard are automatically hidden if they have no attendance or loot in the last 120 days. You can set a character as Active so they always show up, or you can set a character as Inactive to always hide them.
        </p>
        {charError && <p className="error" style={{ marginBottom: '0.75rem' }}>{charError}</p>}
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', marginBottom: '0.5rem' }}>
          <button type="button" onClick={handleSetActive} disabled={charMutating || !selectedCharacter}>
            Set Active
          </button>
          <button type="button" onClick={handleSetInactive} disabled={charMutating || !selectedCharacter}>
            Set Inactive
          </button>
        </div>
        <div className="officer-suggest-wrap" style={{ maxWidth: '28rem' }}>
          <input
            type="search"
            value={charQuery}
            onChange={(e) => {
              setCharQuery(e.target.value)
              setSelectedCharId(null)
              setShowSuggest(true)
            }}
            onFocus={() => setShowSuggest(true)}
            onBlur={() => setTimeout(() => setShowSuggest(false), 200)}
            onKeyDown={handleCharQueryKeyDown}
            placeholder="Character name"
            autoComplete="off"
            aria-label="Search characters"
            aria-autocomplete="list"
            aria-expanded={showSuggestList}
            aria-controls="site-admin-char-suggest"
            style={{ width: '100%', maxWidth: 'none' }}
          />
          {showSuggestList && (
            <ul
              id="site-admin-char-suggest"
              className="card officer-suggest"
              role="listbox"
              onMouseDown={(e) => e.preventDefault()}
            >
              {suggestRows.length === 0 ? (
                <li style={{ color: '#71717a', cursor: 'default' }}>
                  {dkpLoading || !apiData ? 'Loading characters…' : 'No matching characters'}
                </li>
              ) : (
                suggestRows.map((row, index) => (
                  <li
                    key={row.char_id}
                    role="option"
                    aria-selected={index === suggestIndex || selectedCharId === row.char_id}
                    style={index === suggestIndex ? { background: '#27272a' } : undefined}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      selectCharacter(row)
                    }}
                    onMouseEnter={() => setSuggestIndex(index)}
                  >
                    {row.label}
                  </li>
                ))
              )}
              {filteredRows.length > SUGGEST_LIMIT && (
                <li style={{ color: '#71717a', cursor: 'default' }}>
                  Showing first {SUGGEST_LIMIT} matches. Keep typing, or pick from the list below.
                </li>
              )}
            </ul>
          )}
        </div>
        <div
          className="officer-member-list"
          role="listbox"
          aria-label="Characters"
          style={{ maxWidth: '28rem', marginTop: '0.5rem' }}
        >
          {filteredRows.length === 0 ? (
            <p className="officer-member-empty">
              {dkpLoading || !apiData ? 'Loading characters…' : (query ? 'No matching characters' : 'No characters')}
            </p>
          ) : (
            filteredRows.map((row) => (
              <button
                key={row.char_id}
                ref={selectedCharId === row.char_id ? selectedCharRef : null}
                type="button"
                role="option"
                aria-selected={selectedCharId === row.char_id}
                className={selectedCharId === row.char_id ? 'is-highlighted' : undefined}
                title={row.label}
                onClick={() => selectCharacter(row)}
              >
                {row.label}
              </button>
            ))
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))', gap: '1rem', marginTop: '1rem' }}>
          <div>
            <strong>Active Chars</strong>
            <div className="officer-member-list" role="listbox" aria-label="Active Chars" style={{ marginTop: '0.35rem' }}>
              {activeCharRows.length === 0 ? (
                <p className="officer-member-empty">None</p>
              ) : (
                activeCharRows.map((row) => (
                  <div key={row.account_id} style={{ display: 'flex', alignItems: 'center' }}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selectedActiveAccountId === row.account_id}
                      className={selectedActiveAccountId === row.account_id ? 'is-highlighted' : undefined}
                      title={row.label}
                      onClick={() => setSelectedActiveAccountId(row.account_id)}
                      style={{ flex: '1 1 auto', width: 'auto' }}
                    >
                      {row.label}
                    </button>
                    <Link to={`/accounts/${row.account_id}`} style={{ fontSize: '0.8rem', padding: '0 0.45rem', flex: '0 0 auto' }}>View</Link>
                  </div>
                ))
              )}
            </div>
            <button
              type="button"
              onClick={handleRemoveActive}
              disabled={charMutating || !selectedActiveAccountId}
              style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}
            >
              Remove
            </button>
          </div>
          <div>
            <strong>Inactive Chars</strong>
            <div className="officer-member-list" role="listbox" aria-label="Inactive Chars" style={{ marginTop: '0.35rem' }}>
              {inactiveCharRows.length === 0 ? (
                <p className="officer-member-empty">None</p>
              ) : (
                inactiveCharRows.map((row) => (
                  <div key={row.account_id} style={{ display: 'flex', alignItems: 'center' }}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selectedInactiveAccountId === row.account_id}
                      className={selectedInactiveAccountId === row.account_id ? 'is-highlighted' : undefined}
                      title={row.label}
                      onClick={() => setSelectedInactiveAccountId(row.account_id)}
                      style={{ flex: '1 1 auto', width: 'auto' }}
                    >
                      {row.label}
                    </button>
                    <Link to={`/accounts/${row.account_id}`} style={{ fontSize: '0.8rem', padding: '0 0.45rem', flex: '0 0 auto' }}>View</Link>
                  </div>
                ))
              )}
            </div>
            <button
              type="button"
              onClick={handleRemoveInactive}
              disabled={charMutating || !selectedInactiveAccountId}
              style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}
            >
              Remove
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
