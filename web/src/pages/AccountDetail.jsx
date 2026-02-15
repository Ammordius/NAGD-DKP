import { useEffect, useState, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function AccountDetail() {
  const { accountId } = useParams()
  const [account, setAccount] = useState(null)
  const [characters, setCharacters] = useState([])
  const [dkpSummary, setDkpSummary] = useState({})
  const [lootByChar, setLootByChar] = useState({})
  const [raids, setRaids] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!accountId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    supabase.from('accounts').select('account_id, toon_names, display_name, toon_count').eq('account_id', accountId).single().then((accRes) => {
      if (accRes.error || !accRes.data) {
        setError(accRes.error?.message || 'Account not found')
        setLoading(false)
        return
      }
      setAccount(accRes.data)
      supabase.from('character_account').select('char_id').eq('account_id', accountId).then((caRes) => {
        const charIds = (caRes.data || []).map((r) => r.char_id).filter(Boolean)
        if (charIds.length === 0) {
          setCharacters([])
          setDkpSummary({})
          setLootByChar({})
          setLoading(false)
          return
        }
        Promise.all([
          supabase.from('characters').select('char_id, name, class_name, level').in('char_id', charIds),
          supabase.from('dkp_summary').select('character_key, character_name, earned, spent, earned_30d, earned_60d').in('character_key', charIds),
        ]).then(([chRes, sumRes]) => {
          const chars = (chRes.data || []).map((c) => ({ ...c, displayName: c.name || c.char_id }))
          setCharacters(chars)
          const sumMap = {}
          ;(sumRes.data || []).forEach((r) => {
            sumMap[r.character_key] = r
            if (r.character_name && r.character_name !== r.character_key) sumMap[r.character_name] = r
          })
          setDkpSummary(sumMap)
          supabase.from('raid_loot').select('raid_id, char_id, character_name, item_name, cost').in('char_id', charIds).limit(5000).then((lootRes) => {
            const byChar = {}
            ;(lootRes.data || []).forEach((row) => {
              const key = row.char_id || row.character_name || 'unknown'
              if (!byChar[key]) byChar[key] = []
              byChar[key].push(row)
            })
            setLootByChar(byChar)
            const raidIds = [...new Set((lootRes.data || []).map((r) => r.raid_id))]
            if (raidIds.length === 0) {
              setRaids({})
              setLoading(false)
              return
            }
            supabase.from('raids').select('raid_id, raid_name, date_iso').in('raid_id', raidIds).then((rRes) => {
              const rMap = {}
              ;(rRes.data || []).forEach((row) => { rMap[row.raid_id] = row })
              setRaids(rMap)
              setLoading(false)
            })
          })
        })
      })
    })
  }, [accountId])

  const displayName = account?.display_name?.trim() || account?.toon_names?.split(',')[0]?.trim() || accountId

  if (loading) return <div className="container">Loading account…</div>
  if (error) return <div className="container"><span className="error">{error}</span> <Link to="/accounts">← Accounts</Link></div>
  if (!account) return <div className="container">Account not found. <Link to="/accounts">← Accounts</Link></div>

  return (
    <div className="container">
      <p><Link to="/accounts">← Accounts</Link></p>
      <h1>{displayName}</h1>
      <p style={{ color: '#a1a1aa', marginBottom: '1rem' }}>
        Account <code>{accountId}</code>
        {account.toon_count != null && <span style={{ marginLeft: '0.5rem' }}>({account.toon_count} toons)</span>}
      </p>

      <h2>Raid-active characters</h2>
      <div className="card">
        {characters.length === 0 ? (
          <p style={{ color: '#71717a' }}>No characters linked to this account.</p>
        ) : (
          <ul style={{ listStyle: 'none', paddingLeft: 0, margin: 0 }}>
            {characters.map((c) => {
              const key = c.char_id || c.name
              const sum = dkpSummary[c.char_id] || dkpSummary[c.name]
              const lootList = lootByChar[c.char_id] || lootByChar[c.name] || []
              return (
                <li key={key} style={{ marginBottom: '1.5rem', paddingBottom: '1.5rem', borderBottom: '1px solid #27272a' }}>
                  <h3 style={{ marginTop: 0 }}>
                    <Link to={`/characters/${encodeURIComponent(c.name || c.char_id)}`}>{c.name || c.char_id}</Link>
                    {(c.class_name || c.level) && (
                      <span style={{ color: '#71717a', fontWeight: 'normal', fontSize: '0.9rem' }}>
                        {' '}· {[c.class_name, c.level].filter(Boolean).join(' ')}
                      </span>
                    )}
                  </h3>
                  <p style={{ margin: '0.25rem 0', color: '#a1a1aa' }}>
                    <strong>Earned DKP:</strong> {sum ? Number(sum.earned).toFixed(0) : '—'}
                    {sum?.spent != null && <> · <strong>Spent:</strong> {Number(sum.spent)}</>}
                    {sum?.earned_30d != null && <> · 30d: {sum.earned_30d}</>}
                  </p>
                  <p style={{ margin: '0.5rem 0 0.25rem 0', fontSize: '0.875rem', color: '#a1a1aa' }}>Items earned (at raids):</p>
                  {lootList.length === 0 ? (
                    <p style={{ margin: 0, color: '#71717a', fontSize: '0.875rem' }}>None recorded.</p>
                  ) : (
                    <table style={{ marginTop: '0.25rem' }}>
                      <thead>
                        <tr><th>Item</th><th>Raid</th><th>Cost</th></tr>
                      </thead>
                      <tbody>
                        {lootList.map((row, i) => (
                          <tr key={row.raid_id + (row.item_name || '') + i}>
                            <td><Link to={`/items/${encodeURIComponent(row.item_name || '')}`}>{row.item_name || '—'}</Link></td>
                            <td><Link to={`/raids/${row.raid_id}`}>{raids[row.raid_id]?.raid_name || row.raid_id}</Link></td>
                            <td>{row.cost ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
