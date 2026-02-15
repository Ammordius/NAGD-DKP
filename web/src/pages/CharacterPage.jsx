import { useEffect, useState, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const MAGELO_BASE = 'https://www.takproject.net/magelo/character.php?char='

export default function CharacterPage() {
  const { charKey } = useParams()
  const charIdOrName = useMemo(() => (charKey ? decodeURIComponent(charKey) : ''), [charKey])
  const [accountId, setAccountId] = useState(null)
  const [displayName, setDisplayName] = useState(charIdOrName)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!charIdOrName) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    // Resolve charKey (name or char_id) to account_id via character_account + characters
    Promise.all([
      supabase.from('character_account').select('char_id, account_id').limit(20000),
      supabase.from('characters').select('char_id, name').limit(20000),
    ]).then(([caRes, chRes]) => {
      const charToAcc = {}
      ;(caRes.data || []).forEach((r) => {
        if (r.char_id != null && r.account_id != null) {
          charToAcc[String(r.char_id).trim()] = r.account_id
        }
      })
      const key = String(charIdOrName).trim()
      let accId = charToAcc[key] ?? null
      let name = key
      if (!accId) {
        const byName = (chRes.data || []).find((c) => (c.name || '').trim().toLowerCase() === key.toLowerCase())
        if (byName) {
          accId = charToAcc[String(byName.char_id).trim()] ?? null
          name = (byName.name || '').trim() || name
        }
      } else {
        const ch = (chRes.data || []).find((c) => String(c.char_id).trim() === key)
        if (ch?.name) name = (ch.name || '').trim()
      }
      setAccountId(accId)
      setDisplayName(name || charIdOrName)
      setLoading(false)
    }).catch((err) => {
      setError(err?.message || 'Failed to load')
      setLoading(false)
    })
  }, [charIdOrName])

  if (loading) return <div className="container">Loading character…</div>
  if (error) return <div className="container"><span className="error">{error}</span> <Link to="/dkp">← DKP</Link></div>

  const mageloUrl = `${MAGELO_BASE}${encodeURIComponent(displayName)}`

  return (
    <div className="container">
      <p><Link to="/dkp">← DKP</Link> · <Link to="/accounts">Accounts</Link></p>
      <h1>{displayName}</h1>
      <p style={{ color: '#a1a1aa', marginBottom: '1rem' }}>
        <a href={mageloUrl} target="_blank" rel="noopener noreferrer">View on TAKP Magelo</a>
        {accountId && (
          <>
            {' · '}
            <Link to={`/accounts/${accountId}`}>View account (raid history &amp; loot)</Link>
          </>
        )}
      </p>
      {!accountId && (
        <p style={{ color: '#71717a', fontSize: '0.875rem' }}>
          This character is not linked to an account. Raid history and loot are shown on account pages.
        </p>
      )}
    </div>
  )
}
