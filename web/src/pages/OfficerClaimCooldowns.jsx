import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useDkpData } from '../lib/dkpLeaderboard'
import { usePersistedState } from '../lib/usePersistedState'
import { buildAccountAdminRows, buildAccountColumnRows, buildCharacterRows, characterMatchesQuery, filterAccountAdminRows, accountColumnLabel } from '../lib/siteAdminCharacters'
import { normalizeUiPreferences } from '../lib/uiPreferences'
import { canRemoveSiteUser, removalBlockReason } from '../lib/siteAdminRemoveUser'

const SUGGEST_LIMIT = 80

const ROLE_OPTIONS = [
  { value: 'player', label: 'Player' },
  { value: 'officer', label: 'Officer' },
  { value: 'siteadmin', label: 'Site Admin' },
]

function roleLabel(role) {
  return ROLE_OPTIONS.find((option) => option.value === role)?.label || 'Player'
}

function gameAccountLabel(account) {
  if (!account) return ''
  return account.display_name?.trim() || account.toon_names?.split(',')[0]?.trim() || account.account_id
}

function accountListLabel(row) {
  if (!row?.account_id || row.label === row.account_id) return row?.label || ''
  return `${row.label} (${row.account_id})`
}

export default function OfficerClaimCooldowns({ isOfficer, isSiteAdmin = false, profile }) {
  const navigate = useNavigate()
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [resettingId, setResettingId] = useState(null)
  const [siteUsers, setSiteUsers] = useState([])
  const [siteAccounts, setSiteAccounts] = useState({})
  const [usersLoading, setUsersLoading] = useState(false)
  const [userError, setUserError] = useState('')
  const [roleEditId, setRoleEditId] = useState(null)
  const [roleDraft, setRoleDraft] = useState('player')
  const [roleSavingId, setRoleSavingId] = useState(null)
  const [unclaimingId, setUnclaimingId] = useState(null)
  const [removeConfirm, setRemoveConfirm] = useState({})
  const [removingId, setRemovingId] = useState(null)
  const [currentUserId, setCurrentUserId] = useState(null)

  const { apiData, isLoading: dkpLoading, mutate } = useDkpData()
  const [charQuery, setCharQuery] = usePersistedState('/officer/SiteAdmin:charQuery', '')
  const [selectedCharId, setSelectedCharId] = useState(null)
  const [selectedAccountId, setSelectedAccountId] = useState(null)
  const useCharacterAdminSelectors = normalizeUiPreferences(profile?.ui_preferences).useCharacterAdminSelectors
  const adminModeRef = useRef(useCharacterAdminSelectors)
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

  const accountAdminRows = useMemo(
    () => buildAccountAdminRows(apiData?.characters, apiData?.character_account, apiData?.accounts),
    [apiData?.characters, apiData?.character_account, apiData?.accounts]
  )

  const filteredRows = useMemo(
    () => characterRows.filter((row) => characterMatchesQuery(row, charQuery)),
    [characterRows, charQuery]
  )
  const filteredAccountRows = useMemo(
    () => filterAccountAdminRows(accountAdminRows, charQuery),
    [accountAdminRows, charQuery]
  )
  const pickerRows = useCharacterAdminSelectors ? filteredRows : filteredAccountRows

  const suggestRows = pickerRows.slice(0, SUGGEST_LIMIT)
  const selectedCharacter = useMemo(
    () => characterRows.find((row) => row.char_id === selectedCharId) || null,
    [characterRows, selectedCharId]
  )
  const actionAccountId = selectedAccountId || selectedCharacter?.account_id || null
  const actionAccount = actionAccountId ? accountsById.get(String(actionAccountId)) : null
  const actionAccountLabel = actionAccount ? accountColumnLabel(actionAccount) : (actionAccountId || '')

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
    let cancelled = false
    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) setCurrentUserId(data.session?.user?.id ?? null)
    })
    loadCooldowns()
    loadSiteUsers()
    return () => { cancelled = true }
  }, [isOfficer, isSiteAdmin, navigate])

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

  async function loadSiteUsers() {
    setUsersLoading(true)
    setUserError('')
    const { data, error: e } = await supabase
      .from('profiles')
      .select('id, display_name, role, account_id')
      .order('display_name', { ascending: true, nullsFirst: false })
    if (e) {
      setUsersLoading(false)
      setUserError(e.message)
      setSiteUsers([])
      return
    }
    const rows = data || []
    const accountIds = [...new Set(rows.map((row) => row.account_id).filter(Boolean))]
    let accountMap = {}
    if (accountIds.length > 0) {
      const { data: accounts, error: accountErr } = await supabase
        .from('accounts')
        .select('account_id, display_name, toon_names')
        .in('account_id', accountIds)
      if (accountErr) {
        setUsersLoading(false)
        setUserError(accountErr.message)
        setSiteUsers(rows)
        return
      }
      ;(accounts || []).forEach((account) => {
        accountMap[String(account.account_id)] = account
      })
    }
    setSiteAccounts(accountMap)
    setSiteUsers(rows)
    setUsersLoading(false)
  }

  async function handleUnclaimProfile(profileId) {
    setUnclaimingId(profileId)
    setUserError('')
    const { error: rpcErr } = await supabase.rpc('siteadmin_unclaim_profile', { p_profile_id: profileId })
    setUnclaimingId(null)
    if (rpcErr) {
      setUserError(rpcErr.message)
      return
    }
    await loadSiteUsers()
  }

  async function handleSaveRole(profileId) {
    setRoleSavingId(profileId)
    setUserError('')
    const { error: rpcErr } = await supabase.rpc('siteadmin_set_role', {
      p_profile_id: profileId,
      p_role: roleDraft,
    })
    setRoleSavingId(null)
    if (rpcErr) {
      setUserError(rpcErr.message)
      return
    }
    setRoleEditId(null)
    await loadSiteUsers()
  }

  async function handleRemoveUser(profileId) {
    if (removeConfirm[profileId] !== 'REMOVE') return
    setRemovingId(profileId)
    setUserError('')
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      if (!token) {
        setUserError('Not authenticated')
        return
      }
      const response = await fetch('/api/delete-site-user', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ profileId }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        setUserError(payload.error || 'Could not remove user')
        return
      }
      setRemoveConfirm((current) => {
        const next = { ...current }
        delete next[profileId]
        return next
      })
      await loadSiteUsers()
    } catch (err) {
      setUserError(err?.message || 'Could not remove user')
    } finally {
      setRemovingId(null)
    }
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
    setSelectedCharId(row.char_id || null)
    setSelectedAccountId(row.account_id || null)
    setCharQuery(row.label)
    setShowSuggest(false)
    setCharError('')
  }, [setCharQuery])

  useEffect(() => {
    if (adminModeRef.current === useCharacterAdminSelectors) return
    const wasCharacterMode = adminModeRef.current
    adminModeRef.current = useCharacterAdminSelectors
    if (wasCharacterMode) {
      const fromChar = characterRows.find((row) => row.char_id === selectedCharId)
      if (fromChar?.account_id) {
        setSelectedAccountId(fromChar.account_id)
        const accountRow = accountAdminRows.find((row) => row.account_id === fromChar.account_id)
        if (accountRow) setCharQuery(accountRow.label)
      } else if (fromChar) {
        const unlinked = accountAdminRows.find((row) => row.unlinked && row.char_id === fromChar.char_id)
        if (unlinked) setCharQuery(unlinked.label)
      }
      return
    }
    if (!selectedAccountId) return
    const keep = characterRows.find((row) => row.char_id === selectedCharId && row.account_id === selectedAccountId)
    const match = keep || characterRows.find((row) => row.account_id === selectedAccountId)
    if (!match) return
    setSelectedCharId(match.char_id)
    setCharQuery(match.label)
  }, [useCharacterAdminSelectors, characterRows, accountAdminRows, selectedCharId, selectedAccountId, setCharQuery])

  const handleSetActive = useCallback(async () => {
    if (!actionAccountId) {
      setCharError(selectedCharId ? 'That character is not linked to an account.' : 'Select an account.')
      return
    }
    const accountId = actionAccountId
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
  }, [actionAccountId, selectedCharId, mutate])

  const handleSetInactive = useCallback(async () => {
    if (!actionAccountId) {
      setCharError(selectedCharId ? 'That character is not linked to an account.' : 'Select an account.')
      return
    }
    const accountId = actionAccountId
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
  }, [actionAccountId, selectedCharId, mutate])

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
      const row = (showSuggest && suggestRows[suggestIndex]) || (pickerRows.length === 1 ? pickerRows[0] : null)
      if (row) selectCharacter(row)
    }
  }

  if (!isOfficer) return null

  const actor = {
    id: currentUserId,
    role: isSiteAdmin ? 'siteadmin' : 'officer',
  }

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
        <h2 style={{ marginTop: 0 }}>Set accounts as active or inactive</h2>
        <p style={{ color: '#71717a', fontSize: '0.9rem', marginTop: 0 }}>
          Active and inactive apply to a whole game account, including every linked character. Accounts on the DKP leaderboard are hidden when they have no attendance or loot in the last 120 days. Set an account active so it always shows, or inactive so it stays hidden.
          {useCharacterAdminSelectors
            ? ' Search by character name. The account in the label is the one that changes.'
            : ' Search by account, character, alt, or account id. Each account is listed once.'}
        </p>
        {charError && <p className="error" style={{ marginBottom: '0.75rem' }}>{charError}</p>}
        {actionAccountId && (
          <p className="officer-hint" style={{ marginTop: 0 }}>
            This sets the whole account {actionAccountLabel} (<code>{actionAccountId}</code>) active or inactive.
          </p>
        )}
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', marginBottom: '0.5rem' }}>
          <button type="button" onClick={handleSetActive} disabled={charMutating || !actionAccountId}>
            Set account active
          </button>
          <button type="button" onClick={handleSetInactive} disabled={charMutating || !actionAccountId}>
            Set account inactive
          </button>
        </div>
        <div className="officer-suggest-wrap" style={{ maxWidth: '28rem' }}>
          <input
            type="search"
            value={charQuery}
            onChange={(e) => {
              setCharQuery(e.target.value)
              setSelectedCharId(null)
              setSelectedAccountId(null)
              setShowSuggest(true)
            }}
            onFocus={() => setShowSuggest(true)}
            onBlur={() => setTimeout(() => setShowSuggest(false), 200)}
            onKeyDown={handleCharQueryKeyDown}
            placeholder={useCharacterAdminSelectors ? 'Character name' : 'Account, character, or alt'}
            autoComplete="off"
            aria-label={useCharacterAdminSelectors ? 'Search characters' : 'Search accounts'}
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
                  {dkpLoading || !apiData ? 'Loading…' : (useCharacterAdminSelectors ? 'No matching characters' : 'No matching accounts')}
                </li>
              ) : (
                suggestRows.map((row, index) => (
                  <li
                    key={row.key || row.char_id}
                    role="option"
                    aria-selected={index === suggestIndex || (row.account_id ? row.account_id === actionAccountId : row.char_id === selectedCharId)}
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
              {pickerRows.length > SUGGEST_LIMIT && (
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
          aria-label={useCharacterAdminSelectors ? 'Characters' : 'Accounts'}
          style={{ maxWidth: '28rem', marginTop: '0.5rem' }}
        >
          {pickerRows.length === 0 ? (
            <p className="officer-member-empty">
              {dkpLoading || !apiData
                ? (useCharacterAdminSelectors ? 'Loading characters…' : 'Loading accounts…')
                : (query
                  ? (useCharacterAdminSelectors ? 'No matching characters' : 'No matching accounts')
                  : (useCharacterAdminSelectors ? 'No characters' : 'No accounts'))}
            </p>
          ) : (
            pickerRows.map((row) => {
              const selected = row.account_id ? row.account_id === actionAccountId : row.char_id === selectedCharId
              return (
                <button
                  key={row.key || row.char_id}
                  ref={selected ? selectedCharRef : null}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={selected ? 'is-highlighted' : undefined}
                  title={row.label}
                  onClick={() => selectCharacter(row)}
                >
                  {row.label}
                </button>
              )
            })
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))', gap: '1rem', marginTop: '1rem' }}>
          <div>
            <strong>Active accounts</strong>
            <div className="officer-member-list" role="listbox" aria-label="Active accounts" style={{ marginTop: '0.35rem' }}>
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
                      title={accountListLabel(row)}
                      onClick={() => setSelectedActiveAccountId(row.account_id)}
                      style={{ flex: '1 1 auto', width: 'auto' }}
                    >
                      {accountListLabel(row)}
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
            <strong>Inactive accounts</strong>
            <div className="officer-member-list" role="listbox" aria-label="Inactive accounts" style={{ marginTop: '0.35rem' }}>
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
                      title={accountListLabel(row)}
                      onClick={() => setSelectedInactiveAccountId(row.account_id)}
                      style={{ flex: '1 1 auto', width: 'auto' }}
                    >
                      {accountListLabel(row)}
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

      <section className="card" style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ marginTop: 0 }}>Site Profile Accounts</h2>
          <p style={{ color: '#a1a1aa', marginBottom: '0.75rem' }}>
            Site users and the game account each one has claimed. Email addresses are not shown.
          </p>
          {userError && <p className="error" style={{ marginBottom: '0.75rem' }}>{userError}</p>}
          {usersLoading ? (
            <p style={{ color: '#71717a' }}>Loading…</p>
          ) : siteUsers.length === 0 ? (
            <p style={{ color: '#71717a' }}>No site profiles.</p>
          ) : (
            <div className="officer-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Display name</th>
                    <th>Claimed account</th>
                    <th>Current role</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {siteUsers.map((user) => {
                    const name = (user.display_name || '').trim()
                    const account = user.account_id ? siteAccounts[String(user.account_id)] : null
                    const accountLabel = gameAccountLabel(account) || user.account_id
                    const confirm = removeConfirm[user.id] || ''
                    const target = { id: user.id, role: user.role || 'player' }
                    const removable = canRemoveSiteUser(actor, target)
                    const blockReason = removable ? '' : removalBlockReason(actor, target)
                    return (
                      <tr key={user.id}>
                        <td style={{ verticalAlign: 'top' }}>
                          {name || <span style={{ color: '#71717a' }}>—</span>}
                          {!name && (
                            <div style={{ color: '#71717a', fontSize: '0.75rem' }}><code>{user.id}</code></div>
                          )}
                        </td>
                        <td style={{ verticalAlign: 'top' }}>
                          {user.account_id ? (
                            <>
                              <Link to={`/accounts/${user.account_id}`}>{accountLabel}</Link>
                              {isSiteAdmin && (
                                <div>
                                  <button
                                    type="button"
                                    className="btn btn-ghost"
                                    style={{ fontSize: '0.875rem', marginTop: '0.35rem' }}
                                    onClick={() => handleUnclaimProfile(user.id)}
                                    disabled={unclaimingId === user.id}
                                  >
                                    {unclaimingId === user.id ? 'Unclaiming...' : 'Unclaim account'}
                                  </button>
                                </div>
                              )}
                            </>
                          ) : (
                            <span style={{ color: '#71717a' }}>unclaimed</span>
                          )}
                        </td>
                        <td style={{ verticalAlign: 'top' }}>{roleLabel(user.role)}</td>
                        <td style={{ verticalAlign: 'top', minWidth: '16rem' }}>
                          {isSiteAdmin && (roleEditId === user.id ? (
                            <div className="officer-field-row" style={{ marginBottom: '0.75rem' }}>
                              <select
                                aria-label={`Role for ${name || user.id}`}
                                value={roleDraft}
                                onChange={(event) => setRoleDraft(event.target.value)}
                              >
                                {ROLE_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                              </select>
                              <button
                                type="button"
                                className="btn"
                                onClick={() => handleSaveRole(user.id)}
                                disabled={roleSavingId === user.id}
                              >
                                {roleSavingId === user.id ? 'Saving...' : 'Save'}
                              </button>
                              <button
                                type="button"
                                className="btn btn-ghost"
                                onClick={() => setRoleEditId(null)}
                                disabled={roleSavingId === user.id}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-ghost"
                              style={{ fontSize: '0.875rem', marginBottom: '0.5rem' }}
                              onClick={() => { setRoleEditId(user.id); setRoleDraft(user.role || 'player') }}
                            >
                              Change Role
                            </button>
                          ))}
                          {removable ? (
                            <details className="officer-delete" style={{ marginTop: '0.5rem' }}>
                              <summary>REMOVE USER</summary>
                              <p className="officer-hint">
                                Remove user from the site. This deletes the login, which also removes the site profile. It does not remove game accounts or characters. The user will need to sign up again. Type <strong>REMOVE</strong> to confirm.
                              </p>
                              <div className="officer-field-row">
                                <input
                                  type="text"
                                  value={confirm}
                                  onChange={(event) => setRemoveConfirm((current) => ({ ...current, [user.id]: event.target.value }))}
                                  placeholder="Type REMOVE"
                                  style={{ maxWidth: '12rem' }}
                                  aria-label={`Confirm removal of ${name || user.id}`}
                                />
                                <button
                                  type="button"
                                  className="btn officer-btn-danger"
                                  onClick={() => handleRemoveUser(user.id)}
                                  disabled={removingId === user.id || confirm !== 'REMOVE'}
                                >
                                  {removingId === user.id ? 'Removing...' : 'Remove user'}
                                </button>
                              </div>
                            </details>
                          ) : blockReason ? (
                            <p className="officer-hint" style={{ marginTop: '0.5rem', marginBottom: 0 }}>{blockReason}</p>
                          ) : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
    </div>
  )
}
