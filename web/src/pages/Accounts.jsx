import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { createCache } from '../lib/cache'
import { fetchAll } from '../lib/accountData'

const CACHE_KEY = 'accounts_list_v2'
const CACHE_TTL = 10 * 60 * 1000
const MAGELO_BASE = 'https://www.takproject.net/magelo/character.php?char='

export default function Accounts() {
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    const cache = createCache(CACHE_KEY, CACHE_TTL)
    const cached = cache.get()
    if (cached?.length) {
      setAccounts(cached)
      setLoading(false)
    }

    Promise.all([
      fetchAll('accounts', 'account_id, toon_count, display_name'),
      fetchAll('character_account', 'account_id, char_id'),
      fetchAll('characters', 'char_id, name, class_name, level'),
    ]).then(([a, ca, ch]) => {
      if (a.error) {
        setError(a.error.message)
        setLoading(false)
        return
      }
      if (ca.error) {
        setError(ca.error.message)
        setLoading(false)
        return
      }
      if (ch.error) {
        setError(ch.error.message)
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
        display_name: acc.display_name,
        char_ids: byAccount[acc.account_id] || [],
        characters: (byAccount[acc.account_id] || []).map((cid) => charMap[cid]).filter(Boolean),
      }))
      accList.sort((x, y) => (y.characters?.length || 0) - (x.characters?.length || 0))
      setAccounts(accList)
      setLoading(false)
      cache.set(accList)
    })
  }, [])

  const filteredAccounts = useMemo(() => {
    if (!search.trim()) return accounts
    const q = search.trim().toLowerCase()
    return accounts.filter((acc) => {
      if ((acc.account_id || '').toLowerCase().includes(q)) return true
      if ((acc.display_name || '').toLowerCase().includes(q)) return true
      return (acc.characters || []).some((c) => (c.name || c.char_id || '').toLowerCase().includes(q))
    })
  }, [accounts, search])

  if (loading) return <div className="container">Loading accounts…</div>
  if (error) return <div className="container"><span className="error">{error}</span></div>

  return (
    <div className="container">
      <h1>Accounts &amp; characters</h1>
      <p style={{ color: '#71717a', marginBottom: '1rem' }}>
        All accounts with full character lists. Type a name to find who it is.
      </p>
      <div style={{ marginBottom: '1rem' }}>
        <input
          type="search"
          placeholder="Search by account, display name, or character name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
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
          aria-label="Search accounts and characters"
        />
        {search.trim() && (
          <span style={{ marginLeft: '0.5rem', color: '#71717a', fontSize: '0.875rem' }}>
            {filteredAccounts.length} account{filteredAccounts.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>
      <div className="card">
        <table style={{ tableLayout: 'fixed', width: '100%' }}>
          <colgroup>
            <col style={{ width: '14rem' }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>Account</th>
              <th>Characters</th>
            </tr>
          </thead>
          <tbody>
            {filteredAccounts.map((acc) => {
              const chars = acc.characters || []
              return (
                <tr key={acc.account_id}>
                  <td style={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                    <Link to={`/accounts/${acc.account_id}`}>
                      {acc.display_name?.trim() || acc.characters?.[0]?.name || acc.account_id}
                    </Link>
                    <span style={{ marginLeft: '0.5rem', color: '#71717a', fontSize: '0.875rem' }}>
                      <code>{acc.account_id}</code>
                      {acc.toon_count != null && ` · ${acc.toon_count} toons`}
                    </span>
                  </td>
                  <td style={{ verticalAlign: 'top', minWidth: 0 }}>
                    {chars.length === 0 ? (
                      <span style={{ color: '#71717a' }}>—</span>
                    ) : (
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '0.35rem 1rem',
                          alignItems: 'baseline',
                          minWidth: 0,
                          overflowWrap: 'break-word',
                        }}
                      >
                        {chars.map((c, i) => {
                          const name = c.name || c.char_id
                          const mageloUrl = `${MAGELO_BASE}${encodeURIComponent(name)}`
                          return (
                            <span
                              key={c.char_id}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                flexWrap: 'wrap',
                                flexShrink: 0,
                              }}
                            >
                              {i > 0 && <span style={{ color: '#52525b', marginRight: '0.25rem' }}>·</span>}
                              <Link to={`/characters/${encodeURIComponent(name)}`}>{name}</Link>
                              {(c.class_name || c.level) && (
                                <span style={{ color: '#71717a', fontSize: '0.875rem' }}>
                                  {[c.class_name, c.level].filter(Boolean).join(' · ')}
                                </span>
                              )}
                              <a
                                href={mageloUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ fontSize: '0.8rem', color: '#a78bfa', whiteSpace: 'nowrap' }}
                                title={`Magelo: ${name}`}
                              >
                                Magelo
                              </a>
                            </span>
                          )
                        })}
                      </div>
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
