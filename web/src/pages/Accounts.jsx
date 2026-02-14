import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function Accounts() {
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState({})

  useEffect(() => {
    const limit = 10000
    Promise.all([
      supabase.from('accounts').select('account_id, toon_count').limit(limit),
      supabase.from('character_account').select('account_id, char_id').limit(limit),
      supabase.from('characters').select('char_id, name, class_name, level').limit(limit),
    ]).then(([a, ca, ch]) => {
      if (a.error) {
        setError(a.error.message)
        setLoading(false)
        return
      }
      const charMap = {}
      ;(ch.data || []).forEach((c) => { charMap[c.char_id] = c })
      const byAccount = {}
      ;(ca.data || []).forEach((row) => {
        if (!byAccount[row.account_id]) byAccount[row.account_id] = []
        byAccount[row.account_id].push(row.char_id)
      })
      const accList = (a.data || []).map((acc) => ({
        account_id: acc.account_id,
        toon_count: acc.toon_count,
        char_ids: byAccount[acc.account_id] || [],
        characters: (byAccount[acc.account_id] || []).map((cid) => charMap[cid]).filter(Boolean),
      }))
      accList.sort((x, y) => (y.characters?.length || 0) - (x.characters?.length || 0))
      setAccounts(accList)
      setLoading(false)
    })
  }, [])

  const toggle = (accountId) => {
    setExpanded((prev) => ({ ...prev, [accountId]: !prev[accountId] }))
  }

  if (loading) return <div className="container">Loading accounts…</div>
  if (error) return <div className="container"><span className="error">{error}</span></div>

  return (
    <div className="container">
      <h1>Accounts &amp; characters</h1>
      <p style={{ color: '#71717a', marginBottom: '1rem' }}>
        Relational list: each account with its characters (from character_account). Click to expand.
      </p>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th style={{ width: '2rem' }}></th>
              <th>Account</th>
              <th>Characters</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((acc) => {
              const isOpen = expanded[acc.account_id]
              const chars = acc.characters || []
              return (
                <tr key={acc.account_id}>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ padding: '0.25rem', fontSize: '1rem' }}
                      onClick={() => toggle(acc.account_id)}
                      aria-expanded={isOpen}
                    >
                      {isOpen ? '−' : '+'}
                    </button>
                  </td>
                  <td>
                    <code>{acc.account_id}</code>
                    {acc.toon_count != null && (
                      <span style={{ marginLeft: '0.5rem', color: '#71717a', fontSize: '0.875rem' }}>
                        ({acc.toon_count} toons)
                      </span>
                    )}
                  </td>
                  <td>
                    {chars.length === 0 ? (
                      <span style={{ color: '#71717a' }}>—</span>
                    ) : isOpen ? (
                      <ul style={{ margin: 0, paddingLeft: '1.25rem', listStyle: 'disc' }}>
                        {chars.map((c) => (
                          <li key={c.char_id}>
                            <Link to={`/dkp`}>{c.name || c.char_id}</Link>
                            {(c.class_name || c.level) && (
                              <span style={{ color: '#71717a', fontSize: '0.875rem' }}>
                                {' '}{[c.class_name, c.level].filter(Boolean).join(' · ')}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="raid-badges">
                        {chars.slice(0, 4).map((c) => (
                          <span key={c.char_id} className="badge">{c.name || c.char_id}</span>
                        ))}
                        {chars.length > 4 && <span className="badge">+{chars.length - 4}</span>}
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
