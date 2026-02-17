import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useCharToAccountMap } from '../lib/useCharToAccountMap'
import AssignedLootDisclaimer from '../components/AssignedLootDisclaimer'
import ItemLink from '../components/ItemLink'
import { getDkpMobLoot, getRaidItemSources } from '../lib/staticData'

function buildItemIdMap(mobLoot) {
  const map = {}
  if (!mobLoot || typeof mobLoot !== 'object') return map
  Object.values(mobLoot).forEach((entry) => {
    (entry?.loot || []).forEach((item) => {
      if (item?.name && item?.item_id != null) {
        const key = item.name.trim().toLowerCase()
        if (map[key] == null) map[key] = item.item_id
      }
    })
  })
  return map
}

function buildRaidItemNameToId(raidSources) {
  const map = {}
  if (!raidSources || typeof raidSources !== 'object') return map
  Object.entries(raidSources).forEach(([id, entry]) => {
    const name = entry?.name && typeof entry.name === 'string' ? entry.name.trim() : null
    if (name) {
      const key = name.toLowerCase()
      const numId = Number(id)
      if (!Number.isNaN(numId) && map[key] == null) map[key] = numId
    }
  })
  return map
}

const MONTHS_OPTIONS = [
  { value: 1, label: 'Last 1 month' },
  { value: 3, label: 'Last 3 months' },
  { value: 6, label: 'Last 6 months' },
  { value: 12, label: 'Last 1 year' },
  { value: 0, label: 'All time' },
]
const PAGE_SIZE = 500
const CHUNK = 200
const LOOT_COLLAPSE_THRESHOLD = 5

export default function LootRecipients() {
  const { getAccountId } = useCharToAccountMap()
  const [months, setMonths] = useState(6)
  const [classFilter, setClassFilter] = useState('')
  const [sortBy, setSortBy] = useState('accountDkpTotal') // 'accountDkpTotal' | 'dkpSpentToon' | 'lastLootFirst'
  const [loot, setLoot] = useState([])
  const [raids, setRaids] = useState({})
  const [characters, setCharacters] = useState([])
  const [accounts, setAccounts] = useState({})
  const [accountChars, setAccountChars] = useState([]) // { account_id, char_id, name }
  const [dkpSummary, setDkpSummary] = useState({}) // character_key -> { earned, spent } (for account totals)
  const [characterDkpSpent, setCharacterDkpSpent] = useState({}) // key (id or name) -> total_spent on that character (from backend table)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expandedLootRows, setExpandedLootRows] = useState(() => new Set()) // character_key -> show full loot list
  const [mobLoot, setMobLoot] = useState(null)
  const [raidItemSources, setRaidItemSources] = useState(null)

  useEffect(() => {
    Promise.all([getDkpMobLoot(), getRaidItemSources()]).then(([mob, raid]) => {
      setMobLoot(mob)
      setRaidItemSources(raid)
    })
  }, [])

  const itemIdMap = useMemo(() => {
    const fromMob = buildItemIdMap(mobLoot)
    const fromRaid = buildRaidItemNameToId(raidItemSources)
    return { ...fromRaid, ...fromMob }
  }, [mobLoot, raidItemSources])

  useEffect(() => {
    setLoading(true)
    setError('')
    const cutoff = new Date()
    if (months > 0) {
      cutoff.setMonth(cutoff.getMonth() - months)
    } else {
      cutoff.setFullYear(1970)
      cutoff.setMonth(0)
      cutoff.setDate(1)
    }
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
        setCharacters([])
        setAccounts({})
        setAccountChars([])
        setDkpSummary({})
        setCharacterDkpSpent({})
        setLoading(false)
        return
      }
      const allLoot = []
      const run = (offset) => {
        const slice = raidList.slice(offset, offset + CHUNK)
        return supabase.from('raid_loot').select('raid_id, char_id, character_name, assigned_char_id, assigned_character_name, item_name, cost').in('raid_id', slice).then((lRes) => {
          if (lRes.error) return Promise.reject(lRes.error)
          allLoot.push(...(lRes.data || []))
          if (offset + CHUNK >= raidList.length) return allLoot
          return run(offset + CHUNK)
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
          setAccounts({})
          setAccountChars([])
          setDkpSummary({})
          setCharacterDkpSpent({})
          setLoading(false)
          return
        }
        const accountIds = new Set()
        keys.forEach((k) => {
          const aid = getAccountId(k)
          if (aid) accountIds.add(aid)
        })
        const aidList = [...accountIds]

        Promise.all([
          supabase.from('characters').select('char_id, name, class_name').in('char_id', keys),
          keys.length > 0 ? supabase.from('characters').select('char_id, name, class_name').in('name', keys) : { data: [] },
          aidList.length > 0 ? supabase.from('accounts').select('account_id, display_name, toon_names').in('account_id', aidList) : { data: [] },
          aidList.length > 0 ? supabase.from('character_account').select('account_id, char_id').in('account_id', aidList) : { data: [] },
        ]).then(async ([byIdRes, byNameRes, aRes, caRes]) => {
          const byId = (byIdRes.data || []).filter((c) => c && c.char_id)
          const byName = (byNameRes.data || []).filter((c) => c && c.name)
          const charMap = {}
          byId.forEach((c) => { charMap[c.char_id] = c })
          byName.forEach((c) => {
            if (!charMap[c.char_id]) charMap[c.char_id] = c
          })
          const chars = Object.values(charMap)
          setCharacters(chars)

          const accMap = {}
          ;(aRes.data || []).forEach((row) => {
            accMap[row.account_id] = row.display_name?.trim() || row.toon_names?.split(',')[0]?.trim() || row.account_id
          })
          setAccounts(accMap)

          const accountCharsList = (caRes.data || []).map((r) => ({ account_id: r.account_id, char_id: r.char_id }))
          setAccountChars(accountCharsList)

          const charIdsFromAccounts = [...new Set(accountCharsList.map((r) => r.char_id).filter(Boolean))]
          const charsForAccounts = charIdsFromAccounts.length > 0
            ? await supabase.from('characters').select('char_id, name').in('char_id', charIdsFromAccounts)
            : { data: [] }
          const nameByCharId = {}
          ;(charsForAccounts.data || []).forEach((c) => { nameByCharId[c.char_id] = (c.name || '').trim() })
          const allKeysForDkp = new Set(keys)
          // Include every resolved loot-recipient by both id and name so dkp_summary fetch matches backend keys
          chars.forEach((c) => {
            const id = (c.char_id != null && c.char_id !== '') ? String(c.char_id).trim() : null
            const name = (c.name || '').trim()
            if (id) allKeysForDkp.add(id)
            if (name) allKeysForDkp.add(name)
          })
          accountCharsList.forEach((r) => {
            if (r.char_id) allKeysForDkp.add(r.char_id)
            const n = nameByCharId[r.char_id]
            if (n) allKeysForDkp.add(n)
          })
          const dkpKeys = [...allKeysForDkp]
          if (dkpKeys.length === 0) {
            setDkpSummary({})
            setCharacterDkpSpent({})
            setLoading(false)
            return
          }
          const toKeyStable = (v) => (v != null && v !== '') ? String(v).trim() : ''
          const dkpChunks = []
          for (let i = 0; i < dkpKeys.length; i += CHUNK) {
            dkpChunks.push(dkpKeys.slice(i, i + CHUNK))
          }
          const [dkpResults, spentRes] = await Promise.all([
            Promise.all(dkpChunks.map((c) => supabase.from('dkp_summary').select('character_key, earned, spent').in('character_key', c))),
            supabase.rpc('get_character_dkp_spent', { p_keys: dkpKeys })
          ])
          const dkpMap = {}
          dkpResults.forEach((res) => {
            (res.data || []).forEach((row) => {
              const key = row.character_key != null ? String(row.character_key).trim() : ''
              if (!key) return
              dkpMap[key] = { earned: parseFloat(row.earned || 0) || 0, spent: parseFloat(row.spent || 0) || 0 }
            })
          })
          const spentMap = {}
          if (!spentRes.error && Array.isArray(spentRes.data)) {
            spentRes.data.forEach((row) => {
              const total = parseFloat(row.total_spent || 0) || 0
              if (row.character_key != null) spentMap[toKeyStable(row.character_key)] = total
              if (row.char_id != null) spentMap[toKeyStable(row.char_id)] = total
              if (row.character_name != null) spentMap[toKeyStable(row.character_name)] = total
            })
          }
          setDkpSummary(dkpMap)
          setCharacterDkpSpent(spentMap)
          setLoading(false)
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

  const accountDkpTotals = useMemo(() => {
    const totals = {}
    const counted = {} // account_id -> Set of char_id we've counted (one row per character in dkp_summary)
    accountChars.forEach((r) => {
      const aid = r.account_id
      if (!aid) return
      if (!totals[aid]) totals[aid] = 0
      const cid = (r.char_id || '').trim()
      if (!cid) return
      if (!counted[aid]) counted[aid] = new Set()
      if (counted[aid].has(cid)) return
      counted[aid].add(cid)
      const row = dkpSummary[cid]
      if (row) {
        totals[aid] += row.earned - row.spent
        return
      }
      const name = (characters.find((c) => (c.char_id || '').trim() === cid)?.name || '').trim()
      if (name && dkpSummary[name]) {
        totals[aid] += dkpSummary[name].earned - dkpSummary[name].spent
      }
    })
    return totals
  }, [accountChars, characters, dkpSummary])

  const recipients = useMemo(() => {
    const byKey = {}
    const UNASSIGNED_KEY = '\u200bUnassigned' // zero-width then "Unassigned" so it sorts
    loot.forEach((row) => {
      const hasAssignment = (row.assigned_character_name || row.assigned_char_id || '').trim()
      const charName = (row.assigned_character_name || '').trim()
      const charId = (row.assigned_char_id || '').trim()
      const key = hasAssignment ? (charName || charId) : UNASSIGNED_KEY
      // Skip unassigned: do not add to list (Unassigned is not a character)
      if (key === UNASSIGNED_KEY) return
      if (!byKey[key]) {
        const accountId = getAccountId(charName || charId)
        const charRow = characters.find((c) => (c.name || '').trim() === key || (c.char_id || '').trim() === key || (c.name || '').trim() === charId || (c.char_id || '').trim() === charId)
        byKey[key] = {
          character_key: key,
          character_name: charName || charId,
          char_id: charRow?.char_id?.trim() || '',
          class_name: charRow?.class_name || '',
          account_id: accountId,
          account_display_name: accountId ? (accounts[accountId] || accountId) : null,
          lootItems: [],
          dkpSpentOnToon: 0,
          lastLootDate: null,
        }
      }
      const cost = parseFloat(row.cost || 0) || 0
      byKey[key].lootItems.push({ item_name: row.item_name || '—', cost })
      byKey[key].dkpSpentOnToon += cost
      const raidDate = row.raid_id && raids[row.raid_id] ? raids[row.raid_id].date_iso : null
      if (raidDate && (!byKey[key].lastLootDate || raidDate > byKey[key].lastLootDate)) {
        byKey[key].lastLootDate = raidDate
      }
    })
    let list = Object.values(byKey)
    if (classFilter) {
      list = list.filter((r) => (r.class_name || '').toLowerCase() === classFilter.toLowerCase())
    }
    list.forEach((r) => {
      r.accountDkpTotal = r.account_id ? (accountDkpTotals[r.account_id] ?? 0) : 0
      const toKey = (v) => (v != null && v !== '') ? String(v).trim() : ''
      const charRow = characters.find((c) => toKey(c.name) === toKey(r.character_name || r.character_key) || toKey(c.char_id) === toKey(r.char_id))
      const spent =
        characterDkpSpent[toKey(r.character_key)] ??
        characterDkpSpent[toKey(r.char_id)] ??
        (charRow && (characterDkpSpent[toKey(charRow.name)] ?? characterDkpSpent[toKey(charRow.char_id)]))
      r.characterDkpSpentTotal = spent ?? 0
    })
    list.sort((a, b) => {
      if (sortBy === 'accountDkpTotal') {
        const va = a.accountDkpTotal ?? 0
        const vb = b.accountDkpTotal ?? 0
        if (va !== vb) return vb - va
      } else if (sortBy === 'lastLootFirst') {
        const da = a.lastLootDate || ''
        const db = b.lastLootDate || ''
        if (da !== db) return db.localeCompare(da) // most recent first (desc date)
      } else {
        // Sort by window sum; when all time, use backend total so we sort on full data (fetch is capped by raid limit)
        const va = months === 0 ? (a.characterDkpSpentTotal ?? 0) : (a.dkpSpentOnToon ?? 0)
        const vb = months === 0 ? (b.characterDkpSpentTotal ?? 0) : (b.dkpSpentOnToon ?? 0)
        if (va !== vb) return vb - va
      }
      return (a.account_display_name || a.character_name || '').localeCompare(b.account_display_name || b.character_name || '')
    })
    return list
  }, [loot, raids, characters, accounts, accountDkpTotals, dkpSummary, characterDkpSpent, classFilter, sortBy, months, getAccountId])

  if (loading) return <div className="container">Loading…</div>
  if (error) return <div className="container"><span className="error">{error}</span> <Link to="/">← Home</Link></div>

  return (
    <div className="container">
      <p><Link to="/">← Home</Link></p>
      <h1>Loot recipients</h1>
      <p style={{ color: '#a1a1aa', marginBottom: '1rem' }}>
        Characters who received loot {months === 0 ? ' (all time)' : `in the last ${months} month${months !== 1 ? 's' : ''}`}. Loot and DKP spent are for this window. Account DKP total is current.
      </p>
      <p style={{ color: '#eab308', marginBottom: '1rem', fontSize: '0.9rem' }}>
        Note: This page shows data from at most the last 1,000 raids. Loot lists and window DKP are based on that set; sorting when &quot;All time&quot; uses full backend totals.
      </p>
      <div className="card" style={{ marginBottom: '1rem', display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'center' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span>Window:</span>
          <select value={months} onChange={(e) => setMonths(Number(e.target.value))} style={{ padding: '0.35rem 0.5rem' }}>
            {MONTHS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
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
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span>Sort by:</span>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ padding: '0.35rem 0.5rem' }}>
            <option value="accountDkpTotal">Account DKP total (default)</option>
            <option value="dkpSpentToon">DKP spent on character</option>
            <option value="lastLootFirst">Most recent loot first</option>
          </select>
        </label>
      </div>
      <div className="card">
        <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginTop: 0 }}>
          Showing <strong>{recipients.length}</strong> character{recipients.length !== 1 ? 's' : ''} {classFilter ? `(${classFilter})` : ''}. Sorted by {sortBy === 'accountDkpTotal' ? 'account DKP total' : sortBy === 'lastLootFirst' ? 'most recent loot first' : 'DKP spent on character'} (desc).
        </p>
        <AssignedLootDisclaimer />
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Account (Character)</th>
                <th>Class</th>
                <th>Loot received ({months === 0 ? 'all time' : `last ${months}m`})</th>
                <th style={{ whiteSpace: 'nowrap' }}>DKP spent (window)</th>
                <th style={{ whiteSpace: 'nowrap' }}>Character DKP spent (all time)</th>
                <th style={{ whiteSpace: 'nowrap' }}>Account DKP total</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((r) => {
                const accountTo = r.account_id ? `/accounts/${r.account_id}` : null
                const characterTo = `/characters/${encodeURIComponent(r.character_name)}`
                const lootCount = r.lootItems.length
                const showCollapsed = lootCount > LOOT_COLLAPSE_THRESHOLD && !expandedLootRows.has(r.character_key)
                const toggleLoot = () => {
                  setExpandedLootRows((prev) => {
                    const next = new Set(prev)
                    if (next.has(r.character_key)) next.delete(r.character_key)
                    else next.add(r.character_key)
                    return next
                  })
                }
                return (
                  <tr key={r.character_key}>
                    <td>
                      {accountTo ? (
                        <><Link to={accountTo}>{r.account_display_name || r.account_id}</Link> (<Link to={characterTo}>{r.character_name}</Link>)</>
                      ) : (
                        <Link to={characterTo}>{r.character_name}</Link>
                      )}
                    </td>
                    <td style={{ color: '#a1a1aa' }}>{r.class_name || '—'}</td>
                    <td style={{ maxWidth: '20rem', fontSize: '0.9rem' }}>
                      {lootCount === 0 ? '—' : showCollapsed ? (
                        <button type="button" onClick={toggleLoot} style={{ background: 'none', border: 'none', color: 'var(--link-color, #3b82f6)', cursor: 'pointer', padding: 0, textDecoration: 'underline', fontSize: 'inherit' }}>
                          {lootCount} items (click to expand)
                        </button>
                      ) : (
                        <>
                          {lootCount > LOOT_COLLAPSE_THRESHOLD && (
                            <button type="button" onClick={toggleLoot} style={{ background: 'none', border: 'none', color: 'var(--link-color, #3b82f6)', cursor: 'pointer', padding: 0, marginBottom: '0.25rem', textDecoration: 'underline', fontSize: '0.85rem' }}>
                              Collapse
                            </button>
                          )}
                          <ul style={{ margin: 0, paddingLeft: '1.25rem', listStyle: 'disc' }}>
                            {r.lootItems.map((it, i) => {
                              const itemId = itemIdMap[(it.item_name || '').trim().toLowerCase()] ?? null
                              return (
                                <li key={i}>
                                  <ItemLink itemName={it.item_name} itemId={itemId}>{it.item_name}</ItemLink>
                                  {it.cost != null && it.cost !== '' && <span style={{ color: '#71717a' }}> ({it.cost} DKP)</span>}
                                </li>
                              )
                            })}
                          </ul>
                        </>
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{Number(r.dkpSpentOnToon || 0).toFixed(0)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{Number(r.characterDkpSpentTotal ?? 0).toFixed(0)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{Number(r.accountDkpTotal ?? 0).toFixed(0)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
