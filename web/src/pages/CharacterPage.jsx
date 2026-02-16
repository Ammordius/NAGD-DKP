import { useEffect, useState, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import AssignedLootDisclaimer from '../components/AssignedLootDisclaimer'

const MAGELO_BASE = 'https://www.takproject.net/magelo/character.php?char='

export default function CharacterPage() {
  const { charKey } = useParams()
  const charIdOrName = useMemo(() => (charKey ? decodeURIComponent(charKey) : ''), [charKey])
  const [accountId, setAccountId] = useState(null)
  const [charId, setCharId] = useState(null)
  const [displayName, setDisplayName] = useState(charIdOrName)
  const [lootOnCharacter, setLootOnCharacter] = useState([])
  const [raids, setRaids] = useState({})
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
      let resolvedCharId = null
      if (!accId) {
        const byName = (chRes.data || []).find((c) => (c.name || '').trim().toLowerCase() === key.toLowerCase())
        if (byName) {
          accId = charToAcc[String(byName.char_id).trim()] ?? null
          name = (byName.name || '').trim() || name
          resolvedCharId = String(byName.char_id).trim()
        }
      } else {
        const ch = (chRes.data || []).find((c) => String(c.char_id).trim() === key)
        if (ch?.name) name = (ch.name || '').trim()
        resolvedCharId = key
      }
      setAccountId(accId)
      setCharId(resolvedCharId)
      setDisplayName(name || charIdOrName)
      setLoading(false)
    }).catch((err) => {
      setError(err?.message || 'Failed to load')
      setLoading(false)
    })
  }, [charIdOrName])

  // Loot assigned to this character (from Magelo assignment)
  useEffect(() => {
    if (!displayName && !charId) return
    const promises = []
    if (charId) promises.push(supabase.from('raid_loot').select('raid_id, item_name, cost, character_name, assigned_char_id, assigned_character_name').eq('assigned_char_id', charId))
    if (displayName) promises.push(supabase.from('raid_loot').select('raid_id, item_name, cost, character_name, assigned_char_id, assigned_character_name').ilike('assigned_character_name', displayName))
    Promise.all(promises).then((results) => {
      const seen = new Set()
      const merged = []
      results.forEach(({ data: rows }) => {
        ;(rows || []).forEach((r) => {
          const key = `${r.raid_id}\t${r.item_name}\t${r.character_name || r.assigned_character_name}`
          if (!seen.has(key)) { seen.add(key); merged.push(r) }
        })
      })
      merged.sort((a, b) => (b.raid_id || '').localeCompare(a.raid_id || ''))
      setLootOnCharacter(merged)
      const rids = [...new Set(merged.map((r) => r.raid_id).filter(Boolean))]
      if (rids.length === 0) return
      supabase.from('raids').select('raid_id, raid_name, date_iso').in('raid_id', rids).then(({ data: raidRows }) => {
        const rMap = {}
        ;(raidRows || []).forEach((row) => { rMap[row.raid_id] = row })
        setRaids(rMap)
      })
    })
  }, [displayName, charId])

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

      {lootOnCharacter.length > 0 && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <h2 style={{ marginTop: 0 }}>Loot assigned to this toon</h2>
          <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginBottom: '0.25rem' }}>
            Items assigned to this toon from DKP (from Magelo). <a href={mageloUrl} target="_blank" rel="noopener noreferrer">View on Magelo</a> to see gear.
          </p>
          <AssignedLootDisclaimer />
          <p style={{ fontSize: '0.9rem', marginBottom: '0.75rem' }}>
            <strong>Total DKP spent on this toon:</strong>{' '}
            {lootOnCharacter.reduce((sum, r) => sum + (parseInt(String(r.cost || 0), 10) || 0), 0)} DKP
          </p>
          <ul style={{ listStyle: 'none', paddingLeft: 0, margin: 0 }}>
            {lootOnCharacter.map((row, i) => (
              <li key={i} style={{ marginBottom: '0.35rem', fontSize: '0.9rem' }}>
                <Link to={`/items/${encodeURIComponent(row.item_name || '')}`}>{row.item_name || '—'}</Link>
                {' · '}
                <Link to={`/raids/${row.raid_id}`}>{raids[row.raid_id]?.raid_name || row.raid_id}</Link>
                {raids[row.raid_id]?.date_iso && <span style={{ color: '#71717a', marginLeft: '0.25rem' }}>{String(raids[row.raid_id].date_iso).slice(0, 10)}</span>}
                {row.cost != null && row.cost !== '' && <span style={{ marginLeft: '0.35rem' }}>{row.cost} DKP</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
