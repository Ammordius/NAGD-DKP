import { useEffect, useState, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const MAGELO_BASE = 'https://www.takproject.net/magelo/character.php?char='

const PAGE = 1000
async function fetchAll(table, select = '*', filter) {
  const all = []
  let from = 0
  while (true) {
    const to = from + PAGE - 1
    let q = supabase.from(table).select(select).range(from, to)
    if (filter) q = filter(q)
    const { data, error } = await q
    if (error) return { data: null, error }
    all.push(...(data || []))
    if (!data || data.length < PAGE) break
    from += PAGE
  }
  return { data: all, error: null }
}

export default function AccountDetail() {
  const { accountId } = useParams()
  const [tab, setTab] = useState('characters')
  const [account, setAccount] = useState(null)
  const [characters, setCharacters] = useState([])
  const [raids, setRaids] = useState({})
  const [activityByRaid, setActivityByRaid] = useState([])
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
          setActivityByRaid([])
          setRaids({})
          setLoading(false)
          return
        }
        Promise.all([
          supabase.from('characters').select('char_id, name, class_name, level').in('char_id', charIds),
          fetchAll('raid_attendance', 'raid_id, char_id, character_name', (q) => q.in('char_id', charIds)),
          fetchAll('raid_event_attendance', 'raid_id, event_id, char_id, character_name', (q) => q.in('char_id', charIds)),
          fetchAll('raid_loot', 'raid_id, char_id, character_name, item_name, cost', (q) => q.in('char_id', charIds)),
        ]).then(([chRes, attRes, evAttRes, lootRes]) => {
          const chars = (chRes.data || []).map((c) => ({ ...c, displayName: c.name || c.char_id }))
          setCharacters(chars)
          const raidIds = new Set([
            ...(attRes.data || []).map((r) => r.raid_id),
            ...(lootRes.data || []).map((r) => r.raid_id),
          ])
          if (raidIds.size === 0) {
            setRaids({})
            setActivityByRaid([])
            setLoading(false)
            return
          }
          const raidList = [...raidIds]
          Promise.all([
            supabase.from('raids').select('raid_id, raid_name, date_iso').in('raid_id', raidList),
            supabase.from('raid_events').select('raid_id, event_id, dkp_value').in('raid_id', raidList),
          ]).then(([rRes, eRes]) => {
            const rMap = {}
            ;(rRes.data || []).forEach((row) => { rMap[row.raid_id] = row })
            setRaids(rMap)
            const eventDkp = {}
            ;(eRes.data || []).forEach((ev) => {
              eventDkp[`${ev.raid_id}|${ev.event_id}`] = parseFloat(ev.dkp_value || 0)
            })
            const dkpByRaid = {}
            if (evAttRes.data?.length > 0) {
              evAttRes.data.forEach((a) => {
                const k = `${a.raid_id}|${a.event_id}`
                if (!dkpByRaid[a.raid_id]) dkpByRaid[a.raid_id] = 0
                dkpByRaid[a.raid_id] += eventDkp[k] || 0
              })
            } else {
              const totalByRaid = {}
              ;(eRes.data || []).forEach((ev) => {
                if (!totalByRaid[ev.raid_id]) totalByRaid[ev.raid_id] = 0
                totalByRaid[ev.raid_id] += parseFloat(ev.dkp_value || 0)
              })
              ;(attRes.data || []).forEach((a) => {
                if (!dkpByRaid[a.raid_id]) dkpByRaid[a.raid_id] = 0
                dkpByRaid[a.raid_id] += totalByRaid[a.raid_id] || 0
              })
            }
            const lootByRaid = {}
            ;(lootRes.data || []).forEach((row) => {
              if (!lootByRaid[row.raid_id]) lootByRaid[row.raid_id] = []
              lootByRaid[row.raid_id].push(row)
            })
            const activity = raidList.map((raidId) => ({
              raid_id: raidId,
              date: (rMap[raidId]?.date_iso || '').slice(0, 10),
              raid_name: rMap[raidId]?.raid_name || raidId,
              dkpEarned: dkpByRaid[raidId] ?? 0,
              items: lootByRaid[raidId] || [],
            })).sort((a, b) => (b.date || '').localeCompare(a.date || ''))
            setActivityByRaid(activity)
            setLoading(false)
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

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', borderBottom: '1px solid #27272a', paddingBottom: '0.5rem' }}>
        <button
          type="button"
          className={tab === 'characters' ? 'btn' : 'btn btn-ghost'}
          onClick={() => setTab('characters')}
        >
          Characters
        </button>
        <button
          type="button"
          className={tab === 'activity' ? 'btn' : 'btn btn-ghost'}
          onClick={() => setTab('activity')}
        >
          Activity
        </button>
      </div>

      {tab === 'characters' && (
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
                    {' · '}
                    <a href={mageloUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.9rem', color: '#a78bfa' }}>
                      Magelo
                    </a>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {tab === 'activity' && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Activity (earned DKP and items by raid)</h2>
          <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginBottom: '1rem' }}>Reverse chronological. Each raid shows DKP earned and items won by this account’s characters.</p>
          {activityByRaid.length === 0 ? (
            <p style={{ color: '#71717a' }}>No raid activity recorded.</p>
          ) : (
            <ul style={{ listStyle: 'none', paddingLeft: 0, margin: 0 }}>
              {activityByRaid.map((act) => (
                <li key={act.raid_id} style={{ marginBottom: '1.5rem', paddingBottom: '1rem', borderBottom: '1px solid #27272a' }}>
                  <p style={{ margin: '0 0 0.25rem 0' }}>
                    <Link to={`/raids/${act.raid_id}`}><strong>{act.raid_name}</strong></Link>
                    {act.date && <span style={{ color: '#71717a', marginLeft: '0.5rem' }}>{act.date}</span>}
                    <span style={{ marginLeft: '0.5rem' }}>· <strong>Earned: {Number(act.dkpEarned ?? 0).toFixed(0)}</strong> DKP</span>
                  </p>
                  {act.items.length > 0 && (
                    <ul style={{ margin: '0.25rem 0 0 1.25rem', paddingLeft: 0, listStyle: 'none' }}>
                      {act.items.map((row, i) => (
                        <li key={i} style={{ marginBottom: '0.25rem', fontSize: '0.9rem' }}>
                          <Link to={`/items/${encodeURIComponent(row.item_name || '')}`}>{row.item_name || '—'}</Link>
                          {' · '}
                          <Link to={`/characters/${encodeURIComponent(row.character_name || row.char_id || '')}`}>{row.character_name || row.char_id || '—'}</Link>
                          {row.cost != null && row.cost !== '' && <> · {row.cost} DKP</>}
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
    </div>
  )
}
