import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { loadAccountActivity } from '../lib/accountData'

const MAGELO_BASE = 'https://www.takproject.net/magelo/character.php?char='
const MIDDLE_DOT = '\u00B7'

export default function Profile({ profile, onProfileUpdate }) {
  const [claimedAccount, setClaimedAccount] = useState(null)
  const [characters, setCharacters] = useState([])
  const [activityByRaid, setActivityByRaid] = useState([])
  const [accountLoading, setAccountLoading] = useState(false)
  const [tab, setTab] = useState('activity')
  const [unclaimLoading, setUnclaimLoading] = useState(false)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [addCharOpen, setAddCharOpen] = useState(false)
  const [addCharInput, setAddCharInput] = useState('')
  const [addCharIdInput, setAddCharIdInput] = useState('')
  const [addCharError, setAddCharError] = useState('')
  const [addCharLoading, setAddCharLoading] = useState(false)

  useEffect(() => {
    if (!profile?.account_id) {
      setClaimedAccount(null)
      setCharacters([])
      setActivityByRaid([])
      return
    }
    supabase.from('accounts').select('account_id, display_name, toon_names').eq('account_id', profile.account_id).single().then(({ data }) => {
      setClaimedAccount(data)
    })
  }, [profile?.account_id])

  useEffect(() => {
    if (!profile?.account_id) return
    setAccountLoading(true)
    setError('')
    loadAccountActivity(profile.account_id).then((result) => {
      setAccountLoading(false)
      if (result.error) {
        setError(result.error)
        return
      }
      setError('')
      setCharacters(result.characters || [])
      setActivityByRaid(result.activityByRaid || [])
    }).catch(() => {
      setAccountLoading(false)
      setError('Failed to load account activity')
    })
  }, [profile?.account_id, refreshKey])

  async function handleUnclaim() {
    setError('')
    setUnclaimLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      setUnclaimLoading(false)
      return
    }
    const { error: updErr } = await supabase.from('profiles').update({ account_id: null }).eq('id', user.id)
    setUnclaimLoading(false)
    if (updErr) {
      setError(updErr.message)
      return
    }
    setClaimedAccount(null)
    setCharacters([])
    setActivityByRaid([])
    onProfileUpdate?.()
  }

  async function handleAddCharacter() {
    const raw = addCharInput.trim()
    if (!raw) {
      setAddCharError('Enter a character name')
      return
    }
    if (!profile?.account_id) {
      setAddCharError('No account claimed')
      return
    }
    setAddCharError('')
    setAddCharLoading(true)
    const { error: rpcErr } = await supabase.rpc('add_character_to_my_account', {
      p_character_name: raw,
      p_char_id_override: addCharIdInput.trim() || null,
      p_account_id: null,
    })
    setAddCharLoading(false)
    if (rpcErr) {
      setAddCharError(rpcErr.message)
      return
    }
    setAddCharOpen(false)
    setAddCharInput('')
    setAddCharIdInput('')
    setRefreshKey((k) => k + 1)
  }

  return (
    <div className="container">
      <p><Link to="/">← Home</Link></p>
      <h1>Profile</h1>
      <p style={{ color: '#a1a1aa', marginBottom: '1rem' }}>
        Role: <strong>{profile?.role ?? 'player'}</strong>
      </p>

      <div className="card" style={{ maxWidth: '28rem', marginBottom: '1.5rem' }}>
        <h2 style={{ marginTop: 0 }}>Claimed account</h2>
        {claimedAccount ? (
          <>
            <p style={{ marginBottom: '0.5rem' }}>
              You have claimed account{' '}
              <Link to={`/accounts/${claimedAccount.account_id}`}>
                {claimedAccount.display_name?.trim() || claimedAccount.toon_names?.split(',')[0]?.trim() || claimedAccount.account_id}
              </Link>
              {' '}(<code>{claimedAccount.account_id}</code>).
            </p>
            <p style={{ color: '#71717a', fontSize: '0.875rem', marginBottom: '0.75rem' }}>
              View your characters and activity below. Use the + on the Characters tab to add alts. Unclaim below to release it and claim a different account.
            </p>
            {error && <p style={{ color: '#f87171', fontSize: '0.875rem', marginBottom: '0.5rem' }}>{error}</p>}
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleUnclaim}
              disabled={unclaimLoading}
            >
              {unclaimLoading ? 'Unclaiming...' : 'Unclaim account'}
            </button>
          </>
        ) : (
          <p style={{ color: '#71717a' }}>
            You have not claimed an account. Go to an account page and click “Claim this account” to link it to your profile.
          </p>
        )}
      </div>

      {claimedAccount && (
        <>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', borderBottom: '1px solid #27272a', paddingBottom: '0.5rem' }}>
            <button
              type="button"
              className={tab === 'activity' ? 'btn' : 'btn btn-ghost'}
              onClick={() => setTab('activity')}
            >
              Activity
            </button>
            <button
              type="button"
              className={tab === 'characters' ? 'btn' : 'btn btn-ghost'}
              onClick={() => setTab('characters')}
            >
              Characters
            </button>
          </div>

          {accountLoading ? (
            <p style={{ color: '#71717a' }}>Loading your account activity...</p>
          ) : tab === 'characters' ? (
            <div className="card">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <h2 style={{ marginTop: 0 }}>Characters</h2>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ padding: '0.25rem 0.5rem', fontSize: '1.25rem', lineHeight: 1 }}
                  onClick={() => { setAddCharOpen(true); setAddCharError(''); setAddCharInput(''); setAddCharIdInput(''); }}
                  title="Add alt to this account"
                >
                  +
                </button>
              </div>
              {characters.length === 0 ? (
                <p style={{ color: '#71717a' }}>No characters linked to this account. Use + to add a character.</p>
              ) : (
                <ul style={{ listStyle: 'none', paddingLeft: 0, margin: 0 }}>
                  {characters.map((c) => {
                    const name = c.name || c.char_id
                    const mageloUrl = `${MAGELO_BASE}${encodeURIComponent(name)}`
                    return (
                      <li key={c.char_id || c.name} style={{ marginBottom: '0.5rem' }}>
                        <Link to={`/characters/${encodeURIComponent(name)}`}>{name}</Link>
                        {(c.class_name || c.level) && (
                          <span style={{ color: '#71717a', fontSize: '0.9rem', marginLeft: '0.5rem' }}>
                            {[c.class_name, c.level].filter(Boolean).join(' ')}
                          </span>
                        )}
                        {' '}{MIDDLE_DOT}{' '}
                        <a href={mageloUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.9rem', color: '#a78bfa' }}>
                          Magelo
                        </a>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          ) : null}

          {tab === 'characters' && addCharOpen && (
            <div className="card" style={{ marginTop: '1rem', maxWidth: '24rem' }}>
              <h3 style={{ marginTop: 0 }}>Add character to account</h3>
              <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginBottom: '0.75rem' }}>Enter character name. If they’re not in the database, we’ll add them. Optionally provide char ID from server.</p>
              <input
                type="text"
                className="input"
                placeholder="Character name (required)"
                value={addCharInput}
                onChange={(e) => setAddCharInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddCharacter()}
                style={{ marginBottom: '0.5rem', width: '100%' }}
              />
              <input
                type="text"
                className="input"
                placeholder="Char ID (optional, from server)"
                value={addCharIdInput}
                onChange={(e) => setAddCharIdInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddCharacter()}
                style={{ marginBottom: '0.5rem', width: '100%' }}
              />
              {addCharError && <p style={{ color: '#f87171', fontSize: '0.875rem', marginBottom: '0.5rem' }}>{addCharError}</p>}
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button type="button" className="btn" onClick={handleAddCharacter} disabled={addCharLoading}>
                  {addCharLoading ? 'Adding...' : 'Add'}
                </button>
<button type="button" className="btn btn-ghost" onClick={() => { setAddCharOpen(false); setAddCharError(''); setAddCharInput(''); setAddCharIdInput(''); }} disabled={addCharLoading}>
              Cancel
            </button>
              </div>
            </div>
          )}

          {tab === 'activity' ? (
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Activity (earned DKP and items by raid)</h2>
              <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginBottom: '1rem' }}>Reverse chronological. Each raid shows DKP earned and items won by the characters on this account.</p>
              {activityByRaid.length === 0 ? (
                <p style={{ color: '#71717a' }}>No raid activity recorded.</p>
              ) : (
                <ul style={{ listStyle: 'none', paddingLeft: 0, margin: 0 }}>
                  {activityByRaid.map((act) => (
                    <li key={act.raid_id} style={{ marginBottom: '1.5rem', paddingBottom: '1rem', borderBottom: '1px solid #27272a' }}>
                      <p style={{ margin: '0 0 0.25rem 0' }}>
                        <Link to={`/raids/${act.raid_id}`}><strong>{act.raid_name}</strong></Link>
                        {act.date && <span style={{ color: '#71717a', marginLeft: '0.5rem' }}>{act.date}</span>}
                        <span style={{ marginLeft: '0.5rem' }}>{MIDDLE_DOT} <strong>Earned: {Number(act.dkpEarned ?? 0).toFixed(0)}{act.dkpRaidTotal != null && act.dkpRaidTotal > 0 ? ` / ${Number(act.dkpRaidTotal).toFixed(0)}` : ''}</strong> DKP</span>
                      </p>
                      {act.items.length > 0 && (
                        <ul style={{ margin: '0.25rem 0 0 1.25rem', paddingLeft: 0, listStyle: 'none' }}>
                          {act.items.map((row, i) => (
                            <li key={i} style={{ marginBottom: '0.25rem', fontSize: '0.9rem' }}>
                              <Link to={`/items/${encodeURIComponent(row.item_name || '')}`}>{row.item_name || '—'}</Link>
                              {' '}{MIDDLE_DOT}{' '}
                              <Link to={`/accounts/${profile.account_id}`}>Account</Link> (
                              {(row.assigned_character_name || row.assigned_char_id) ? (
                                <Link to={`/characters/${encodeURIComponent(row.assigned_character_name || row.assigned_char_id)}`}>{row.assigned_character_name || row.assigned_char_id}</Link>
                              ) : (
                                <span style={{ color: '#71717a' }}>Unassigned</span>
                              )}
                              )
                              {row.cost != null && row.cost !== '' && <> {MIDDLE_DOT} {row.cost} DKP</>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
