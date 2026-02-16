import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useCharToAccountMap } from '../lib/useCharToAccountMap'

const MONTHS_OPTIONS = [1, 3, 6]
const PAGE_SIZE = 500

async function fetchAll(table, select = '*', filter) {
  const all = []
  let from = 0
  while (true) {
    const to = from + PAGE_SIZE - 1
    let q = supabase.from(table).select(select).range(from, to)
    if (filter) q = filter(q)
    const { data, error } = await q
    if (error) return { data: null, error }
    all.push(...(data || []))
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return { data: all, error: null }
}

export default function LootRecipients() {
  const { getAccountId } = useCharToAccountMap()
  const [months, setMonths] = useState(6)
  const [classFilter, setClassFilter] = useState('')
  const [loot, setLoot] = useState([])
  const [raids, setRaids] = useState({})
  const [characters, setCharacters] = useState([])
  const [accounts, setAccounts] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    setError('')
    const cutoff = new Date()
    cutoff.setMonth(cutoff.getMonth() - months)
    const cutoffIso = cutoff.toISOString().slice(0, 10)

    supabase.from('raids').select('raid_id, date_iso').gte('date_iso', cutoffIso).then((rRes) => {
      if (rRes.error) {
        setError(rRes.error.message)
        setLoading(false)
        return
      }
      const raidList = (rRes.data || []).map((row) => row.raid_id).filter(Boolean)
      const rMap = {}
      ;(rRes.data || []).forEach((row) => { rMap[row.raid_id] = row })
      setRaids(rMap)
      if (raidList.length === 0) {
        setLoot([])
        setLoading(false)
        return
      }
      const chunk = 200
      const allLoot = []
      const run = (offset) => {
        const slice = raidList.slice(offset, offset + chunk)
        return supabase.from('raid_loot').select('raid_id, char_id, character_name, assigned_char_id, assigned_character_name').in('raid_id', slice).then((lRes) => {
          if (lRes.error) return Promise.reject(lRes.error)
          allLoot.push(...(lRes.data || []))
          if (offset + chunk >= raidList.length) return allLoot
          return run(offset + chunk)
        })
      }
      run(0).then((lootRows) => {
        setLoot(lootRows)
        const charKeys = new Set()
        lootRows.forEach((row) => {
          const k = (row.assigned_character_name || row.character_name || row.char_id || '').trim()
          if (k) charKeys.add(k)
          const cid = (row.assigned_char_id || row.char_id || '').trim()
          if (cid) charKeys.add(cid)
        })
        const keys = [...charKeys]
        if (keys.length === 0) {
          setCharacters([])
          setLoading(false)
          return
        }
        const chunks = []
        for (let i = 0; i < keys.length; i += 200) {
          chunks.push(keys.slice(i, i + 200))
        }
        Promise.all(chunks.map((c) => supabase.from('characters').select('char_id, name, class_name').or(`char_id.in.(${c.join(',')}),name.in.(${c.join(',')})`))).then((results) => {
          const chars = (results || []).flatMap((r) => r.data || [])
          setCharacters(chars)
          const accountIds = new Set()
          keys.forEach((k) => {
            const aid = getAccountId(k)
            if (aid) accountIds.add(aid)
          })
          const aidList = [...accountIds]
          if (aidList.length === 0) {
            setAccounts({})
            setLoading(false)
            return
          }
          supabase.from('accounts').select('account_id, display_name, toon_names').in('account_id', aidList).then((aRes) => {
            const accMap = {}
            ;(aRes.data || []).forEach((row) => {
              accMap[row.account_id] = row.display_name?.trim() || row.toon_names?.split(',')[0]?.trim() || row.account_id
            })
            setAccounts(accMap)
            setLoading(false)
          }).catch((err) => {
            setError(err?.message)
            setLoading(false)
          })
        }).catch((err) => {
          setError(err?.message)
          setLoading(false)
        })
      }).catch((err) => {
        setError(err?.message || 'Failed to load loot')
        setLoading(false)
      })
    })
  }, [months, getAccountId])

  const classList = useMemo(() => {
    const set = new Set()
    characters.forEach((c) => {
      const cn = (c.class_name || '').trim()
      if (cn) set.add(cn)
    })
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [characters])

  const recipients = useMemo(() => {
    const byKey = {}
    loot.forEach((row) => {
      const charName = (row.assigned_character_name || row.character_name || '').trim()
      const charId = (row.assigned_char_id || row.char_id || '').trim()
      const key = charName || charId
      if (!key) return
      if (byKey[key]) return
      const accountId = getAccountId(charName || charId)
      const charRow = characters.find((c) => (c.name || '').trim() === key || (c.char_id || '').trim() === key || (c.name || '').trim() === charId || (c.char_id || '').trim() === charId)
      byKey[key] = {
        character_key: key,
        character_name: charName || charId,
        class_name: charRow?.class_name || '',
        account_id: accountId,
        account_display_name: accountId ? (accounts[accountId] || accountId) : null,
      }
    })
    let list = Object.values(byKey)
    if (classFilter) {
      list = list.filter((r) => (r.class_name || '').toLowerCase() === classFilter.toLowerCase())
    }
    return list.sort((a, b) => (a.account_display_name || a.character_name || '').localeCompare(b.account_display_name || b.character_name || ''))
  }, [loot, characters, accounts, classFilter, getAccountId])

  if (loading) return <div className="container">Loading…</div>
  if (error) return <div className="container"><span className="error">{error}</span> <Link to="/">← Home</Link></div>

  return (
    <div className="container">
      <p><Link to="/">← Home</Link></p>
      <h1>Loot recipients</h1>
      <p style={{ color: '#a1a1aa', marginBottom: '1rem' }}>
        Characters who received loot in the last {months} month{months !== 1 ? 's' : ''}. Filter by class to see e.g. all warriors.
      </p>
      <div className="card" style={{ marginBottom: '1rem', display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'center' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span>Window:</span>
          <select value={months} onChange={(e) => setMonths(Number(e.target.value))} style={{ padding: '0.35rem 0.5rem' }}>
            {MONTHS_OPTIONS.map((m) => (
              <option key={m} value={m}>Last {m} month{m !== 1 ? 's' : ''}</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span>Class:</span>
          <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)} style={{ padding: '0.35rem 0.5rem', minWidth: '8rem' }}>
            <option value="">All classes</option>
            {classList.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="card">
        <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginTop: 0 }}>
          Showing <strong>{recipients.length}</strong> character{recipients.length !== 1 ? 's' : ''} {classFilter ? `(${classFilter})` : ''}. Format: Account (Character).
        </p>
        <ul style={{ listStyle: 'none', paddingLeft: 0, margin: 0 }}>
          {recipients.map((r) => {
            const to = r.account_id ? `/accounts/${r.account_id}` : `/characters/${encodeURIComponent(r.character_name)}`
            const label = r.account_display_name ? `${r.account_display_name} (${r.character_name})` : r.character_name
            return (
              <li key={r.character_key} style={{ marginBottom: '0.35rem', fontSize: '0.95rem' }}>
                <Link to={to}>{label}</Link>
                {r.class_name && (
                  <span style={{ color: '#71717a', marginLeft: '0.5rem', fontSize: '0.875rem' }}>{r.class_name}</span>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
