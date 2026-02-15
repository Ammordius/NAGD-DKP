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
  }, [profile?.account_id])

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
              View your characters and activity below. You can add characters from the account page. Unclaim below to release it and claim a different account.
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
              <h2 style={{ marginTop: 0 }}>Characters</h2>
              {characters.length === 0 ? (
                <p style={{ color: '#71717a' }}>No characters linked to this account.</p>
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
          ) : (
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
                              <Link to={`/characters/${encodeURIComponent(row.character_name || row.char_id || '')}`}>{row.character_name || row.char_id || '—'}</Link>
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
          )}
        </>
      )}
    </div>
  )
}
