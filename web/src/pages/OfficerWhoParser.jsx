import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

function parseWhoNames(paste) {
  const names = []
  const seen = new Set()
  const lines = (paste || '').split(/\r?\n/)
  for (const line of lines) {
    const text = String(line || '').trim()
    if (!text) continue
    if (!/^\[[^\]]+\]/.test(text)) continue
    if (
      /Players on EverQuest:/i.test(text) ||
      /^-+$/i.test(text.replace(/^\[[^\]]+\]\s*/, '')) ||
      /There are \d+ players in /i.test(text)
    ) {
      continue
    }
    const noPrefix = text.replace(/^\[[^\]]+\]\s*/, '')
    const noAnon = noPrefix.replace(/\[[^\]]+\]\s*/g, '').trim()
    const withoutGuild = noAnon.replace(/\s+<[^>]+>\s*$/, '').trim()
    const nameMatch = withoutGuild.match(/^([A-Za-z][A-Za-z'`-]*)\b/)
    if (!nameMatch) continue
    const name = nameMatch[1].trim()
    const key = name.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      names.push(name)
    }
  }
  return names
}

export default function OfficerWhoParser({ isOfficer }) {
  const navigate = useNavigate()
  const [paste, setPaste] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [characters, setCharacters] = useState([])
  const [charToAccount, setCharToAccount] = useState({})
  const [accountNames, setAccountNames] = useState({})

  useEffect(() => {
    if (!isOfficer) {
      navigate('/')
      return
    }
    let cancelled = false
    async function load() {
      setLoading(true)
      setError('')
      try {
        const [charsRes, caRes, accountsRes] = await Promise.all([
          supabase.from('characters').select('char_id, name').limit(5000),
          supabase.from('character_account').select('char_id, account_id').limit(10000),
          supabase.from('accounts').select('account_id, display_name').limit(5000),
        ])
        if (cancelled) return
        if (charsRes.error) throw charsRes.error
        if (caRes.error) throw caRes.error
        if (accountsRes.error) throw accountsRes.error
        setCharacters(charsRes.data || [])
        const caMap = {}
        ;(caRes.data || []).forEach((row) => {
          if (row?.char_id && row?.account_id && caMap[String(row.char_id)] == null) {
            caMap[String(row.char_id)] = String(row.account_id)
          }
        })
        setCharToAccount(caMap)
        const nameMap = {}
        ;(accountsRes.data || []).forEach((row) => {
          if (row?.account_id) {
            nameMap[String(row.account_id)] = (row.display_name || '').trim() || String(row.account_id)
          }
        })
        setAccountNames(nameMap)
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [isOfficer, navigate])

  const nameToChar = useMemo(() => {
    const out = {}
    for (const c of characters) {
      const n = String(c?.name || '').trim()
      if (!n) continue
      out[n.toLowerCase()] = { char_id: String(c.char_id), name: n }
    }
    return out
  }, [characters])

  const parsedNames = useMemo(() => parseWhoNames(paste), [paste])

  const result = useMemo(() => {
    const groupedMap = new Map()
    const unmatched = []
    for (const rawName of parsedNames) {
      const matched = nameToChar[rawName.toLowerCase()]
      if (!matched) {
        unmatched.push(rawName)
        continue
      }
      const accountId = charToAccount[matched.char_id] || null
      const key = accountId ? `account:${accountId}` : `char:${matched.char_id}`
      if (!groupedMap.has(key)) {
        const display = accountId ? (accountNames[accountId] || accountId) : matched.name
        groupedMap.set(key, {
          accountId,
          displayName: display,
          characters: [],
          unlinked: !accountId,
        })
      }
      const entry = groupedMap.get(key)
      if (!entry.characters.includes(matched.name)) entry.characters.push(matched.name)
    }
    const grouped = [...groupedMap.values()].sort((a, b) => {
      return String(a.displayName || '').localeCompare(String(b.displayName || ''))
    })
    const flatUnique = grouped.map((g) => g.displayName)
    return { grouped, flatUnique, unmatched }
  }, [parsedNames, nameToChar, charToAccount, accountNames])

  if (!isOfficer) return null

  return (
    <div className="container">
      <h1>Officer /who parser</h1>
      <p style={{ color: '#a1a1aa', marginBottom: '1rem', maxWidth: '52rem' }}>
        Paste EQ <code>/who</code> output to collapse characters into unique humans using DKP account links.
        Human identity is based only on linked <code>account_id</code>. <Link to="/officer">← Officer</Link>
      </p>

      <section className="card" style={{ marginBottom: '1rem' }}>
        <h2 style={{ marginTop: 0 }}>Paste /who output</h2>
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder="[Fri Apr 17 09:19:47 2026] [ANONYMOUS] Mugs  <Destiny>"
          rows={14}
          style={{ width: '100%', maxWidth: '800px', fontFamily: 'monospace', padding: '0.5rem' }}
        />
        <p style={{ color: '#71717a', marginBottom: 0, fontSize: '0.9rem' }}>
          Parsed characters: <strong>{parsedNames.length}</strong>
          {' · '}
          Unique humans: <strong>{result.flatUnique.length}</strong>
          {' · '}
          Unmatched names: <strong>{result.unmatched.length}</strong>
          {loading ? ' · Loading roster…' : ''}
        </p>
        {error && <p className="error" style={{ marginTop: '0.5rem', marginBottom: 0 }}>{error}</p>}
      </section>

      <section className="card" style={{ marginBottom: '1rem' }}>
        <h2 style={{ marginTop: 0 }}>Grouped humans</h2>
        {result.grouped.length === 0 ? (
          <p style={{ color: '#71717a', marginBottom: 0 }}>No grouped results yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Human</th>
                  <th>Account</th>
                  <th>Characters</th>
                  <th>Count</th>
                </tr>
              </thead>
              <tbody>
                {result.grouped.map((group) => (
                  <tr key={`${group.accountId || group.displayName}`}>
                    <td>{group.displayName}</td>
                    <td>{group.accountId || 'Unlinked'}</td>
                    <td>{group.characters.join(', ')}</td>
                    <td>{group.characters.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" style={{ marginBottom: '1rem' }}>
        <h2 style={{ marginTop: 0 }}>Flat unique humans</h2>
        {result.flatUnique.length === 0 ? (
          <p style={{ color: '#71717a', marginBottom: 0 }}>No unique humans yet.</p>
        ) : (
          <>
            <p style={{ marginTop: 0, marginBottom: '0.5rem' }}>
              <strong>{result.flatUnique.length}</strong> unique humans:
            </p>
            <p style={{ marginBottom: 0 }}>{result.flatUnique.join(', ')}</p>
          </>
        )}
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>Unmatched names</h2>
        {result.unmatched.length === 0 ? (
          <p style={{ color: '#71717a', marginBottom: 0 }}>None.</p>
        ) : (
          <p style={{ marginBottom: 0 }}>
            {result.unmatched.join(', ')}
          </p>
        )}
      </section>
    </div>
  )
}
