import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { usePersistedState } from '../lib/usePersistedState'

const PAGE_SIZE = 1000

async function fetchAllRows(table, select) {
  const all = []
  let from = 0
  while (true) {
    const to = from + PAGE_SIZE - 1
    const { data, error } = await supabase.from(table).select(select).range(from, to)
    if (error) throw error
    const rows = data || []
    all.push(...rows)
    if (rows.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return all
}

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
  const [paste, setPaste] = usePersistedState('/officer/who-parser:paste', '')
  const [activeTab, setActiveTab] = usePersistedState('/officer/who-parser:tab', 'grouped')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [characters, setCharacters] = useState([])
  const [charToAccount, setCharToAccount] = useState({})
  const [accountNames, setAccountNames] = useState({})
  const [copyStatus, setCopyStatus] = useState('')

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
        const [charsData, caData, accountsData] = await Promise.all([
          fetchAllRows('characters', 'char_id, name, class_name'),
          fetchAllRows('character_account', 'char_id, account_id'),
          fetchAllRows('accounts', 'account_id, display_name'),
        ])
        if (cancelled) return
        setCharacters(charsData || [])
        const caMap = {}
        ;(caData || []).forEach((row) => {
          if (row?.char_id && row?.account_id && caMap[String(row.char_id)] == null) {
            caMap[String(row.char_id)] = String(row.account_id)
          }
        })
        setCharToAccount(caMap)
        const nameMap = {}
        ;(accountsData || []).forEach((row) => {
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
      out[n.toLowerCase()] = {
        char_id: String(c.char_id),
        name: n,
        className: String(c?.class_name || '').trim() || 'Unknown',
      }
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
          characterDetails: [],
          unlinked: !accountId,
        })
      }
      const entry = groupedMap.get(key)
      if (!entry.characters.includes(matched.name)) entry.characters.push(matched.name)
      if (!entry.characterDetails.some((c) => c.name === matched.name)) {
        entry.characterDetails.push({
          name: matched.name,
          className: matched.className || 'Unknown',
        })
      }
    }
    const grouped = [...groupedMap.values()].sort((a, b) => {
      return String(a.displayName || '').localeCompare(String(b.displayName || ''))
    })
    const flatUnique = grouped.map((g) => ({
      accountId: g.accountId,
      displayName: g.displayName,
      toonCount: g.characters.length,
    }))
    const matchedCharacters = grouped
      .flatMap((g) =>
        g.characterDetails.map((c) => ({
          ...c,
          accountId: g.accountId,
          humanDisplayName: g.displayName,
        }))
      )
      .sort((a, b) => {
        const classCmp = String(a.className).localeCompare(String(b.className))
        if (classCmp !== 0) return classCmp
        return String(a.name).localeCompare(String(b.name))
      })
    const classMap = new Map()
    for (const c of matchedCharacters) {
      const className = String(c.className || '').trim() || 'Unknown'
      if (!classMap.has(className)) classMap.set(className, { className, count: 0, characters: [] })
      const row = classMap.get(className)
      row.count += 1
      row.characters.push(c.name)
    }
    const classSummary = [...classMap.values()].sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count
      return String(a.className).localeCompare(String(b.className))
    })
    return { grouped, flatUnique, unmatched, matchedCharacters, classSummary }
  }, [parsedNames, nameToChar, charToAccount, accountNames])

  async function handleCopyHumans() {
    const text = result.flatUnique.map((h) => h.displayName).join('\n')
    if (!text) {
      setCopyStatus('Nothing to copy.')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      setCopyStatus(`Copied ${result.flatUnique.length} humans.`)
    } catch (_) {
      setCopyStatus('Clipboard write failed in this browser.')
    }
  }

  async function handleCopyHumansWithCounts() {
    const text = result.flatUnique.map((h) => `${h.displayName} (${h.toonCount})`).join('\n')
    if (!text) {
      setCopyStatus('Nothing to copy.')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      setCopyStatus(`Copied ${result.flatUnique.length} humans with toon counts.`)
    } catch (_) {
      setCopyStatus('Clipboard write failed in this browser.')
    }
  }

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
        <h2 style={{ marginTop: 0 }}>View</h2>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`btn ${activeTab === 'grouped' ? '' : 'btn-ghost'}`}
            onClick={() => setActiveTab('grouped')}
          >
            Grouped humans
          </button>
          <button
            type="button"
            className={`btn ${activeTab === 'characters' ? '' : 'btn-ghost'}`}
            onClick={() => setActiveTab('characters')}
          >
            Characters
          </button>
        </div>
      </section>

      {activeTab === 'grouped' && (
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
                    <th>Characters</th>
                    <th>Count</th>
                  </tr>
                </thead>
                <tbody>
                  {result.grouped.map((group) => (
                    <tr key={`${group.accountId || group.displayName}`}>
                      <td>
                        {group.accountId ? (
                          <Link to={`/accounts/${encodeURIComponent(group.accountId)}`}>{group.displayName}</Link>
                        ) : (
                          group.displayName
                        )}
                      </td>
                      <td>{group.characters.join(', ')}</td>
                      <td>{group.characters.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {activeTab === 'characters' && (
        <section className="card" style={{ marginBottom: '1rem' }}>
          <h2 style={{ marginTop: 0 }}>Character details</h2>
          {result.matchedCharacters.length === 0 ? (
            <p style={{ color: '#71717a', marginBottom: 0 }}>No matched characters yet.</p>
          ) : (
            <div style={{ overflowX: 'auto', marginBottom: '1rem' }}>
              <table>
                <thead>
                  <tr>
                    <th>Character</th>
                    <th>Class</th>
                    <th>Human</th>
                  </tr>
                </thead>
                <tbody>
                  {result.matchedCharacters.map((char) => (
                    <tr key={`${char.name}:${char.accountId || char.humanDisplayName}`}>
                      <td>{char.name}</td>
                      <td>{char.className || 'Unknown'}</td>
                      <td>
                        {char.accountId ? (
                          <Link to={`/accounts/${encodeURIComponent(char.accountId)}`}>{char.humanDisplayName}</Link>
                        ) : (
                          char.humanDisplayName
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3 style={{ marginTop: 0 }}>Class summary</h3>
          {result.classSummary.length === 0 ? (
            <p style={{ color: '#71717a', marginBottom: 0 }}>No class summary yet.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Class</th>
                    <th>Count</th>
                    <th>Characters</th>
                  </tr>
                </thead>
                <tbody>
                  {result.classSummary.map((row) => (
                    <tr key={row.className}>
                      <td>{row.className}</td>
                      <td>{row.count}</td>
                      <td>{row.characters.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="card" style={{ marginBottom: '1rem' }}>
        <h2 style={{ marginTop: 0 }}>Flat unique humans</h2>
        {result.flatUnique.length === 0 ? (
          <p style={{ color: '#71717a', marginBottom: 0 }}>No unique humans yet.</p>
        ) : (
          <>
            <p style={{ marginTop: 0, marginBottom: '0.5rem' }}>
              <strong>{result.flatUnique.length}</strong> unique humans:
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
              <button type="button" className="btn btn-ghost" onClick={handleCopyHumans}>
                Copy humans to clipboard
              </button>
              <button type="button" className="btn btn-ghost" onClick={handleCopyHumansWithCounts}>
                Copy humans + toon counts
              </button>
              {copyStatus && <span style={{ color: '#a1a1aa', fontSize: '0.9rem' }}>{copyStatus}</span>}
            </div>
            <p style={{ marginBottom: 0 }}>
              {result.flatUnique.map((h, idx) => (
                <span key={`${h.accountId || h.displayName}-${idx}`}>
                  {idx > 0 ? ', ' : ''}
                  {h.accountId ? (
                    <Link to={`/accounts/${encodeURIComponent(h.accountId)}`}>{h.displayName}</Link>
                  ) : (
                    h.displayName
                  )}
                </span>
              ))}
            </p>
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
