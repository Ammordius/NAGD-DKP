import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const MAGELO_BASE = 'https://www.takproject.net/magelo/character.php?char='
const MIDDLE_DOT = '\u00B7'

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

export default function AccountDetail({ isOfficer, profile }) {
  const { accountId } = useParams()
  const [tab, setTab] = useState('activity')
  const [account, setAccount] = useState(null)
  const [characters, setCharacters] = useState([])
  const [raids, setRaids] = useState({})
  const [activityByRaid, setActivityByRaid] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [addCharOpen, setAddCharOpen] = useState(false)
  const [addCharInput, setAddCharInput] = useState('')
  const [addCharError, setAddCharError] = useState('')
  const [addCharLoading, setAddCharLoading] = useState(false)
  const [claimLoading, setClaimLoading] = useState(false)
  const [myAccountId, setMyAccountId] = useState(profile?.account_id ?? null)
  const isMyAccount = myAccountId === accountId
  const canAddChar = isOfficer || isMyAccount

  useEffect(() => {
    if (!accountId || !profile) return
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      supabase.from('profiles').select('account_id').eq('id', user.id).single().then(({ data }) => {
        setMyAccountId(data?.account_id ?? null)
      })
    })
  }, [accountId, profile, refreshKey])

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
        ]).then(([chRes, attRes, evAttByCharId, lootRes]) => {
          const chars = (chRes.data || []).map((c) => ({ ...c, displayName: c.name || c.char_id }))
          setCharacters(chars)
          const names = chars.map((c) => c.name).filter(Boolean)
          // Also fetch event attendance by character_name so we pick up rows keyed by name (e.g. from Officer tool).
          // Fetch per name to avoid .in() limits/failures; merge and dedupe.
          const evAttByNamePromise = names.length > 0
            ? Promise.all(names.map((name) => fetchAll('raid_event_attendance', 'raid_id, event_id, char_id, character_name', (q) => q.eq('character_name', name))))
            : Promise.resolve([])
          evAttByNamePromise.then((byNameResults) => {
            const byNameRows = (byNameResults || []).flatMap((r) => r.data || [])
            const seen = new Set()
            const evAttRes = { data: [] }
            for (const row of [...(evAttByCharId.data || []), ...byNameRows]) {
              const key = `${row.raid_id}|${row.event_id}|${row.char_id || row.character_name || ''}`
              if (seen.has(key)) continue
              seen.add(key)
              evAttRes.data.push(row)
            }
            const raidIds = new Set([
              ...(attRes.data || []).map((r) => r.raid_id),
              ...(lootRes.data || []).map((r) => r.raid_id),
              ...(evAttRes.data || []).map((r) => r.raid_id),
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
              const totalRaidDkp = {}
              ;(eRes.data || []).forEach((ev) => {
                const v = parseFloat(ev.dkp_value || 0)
                eventDkp[`${ev.raid_id}|${ev.event_id}`] = v
                if (!totalRaidDkp[ev.raid_id]) totalRaidDkp[ev.raid_id] = 0
                totalRaidDkp[ev.raid_id] += v
              })
              const totalByRaid = {}
              ;(eRes.data || []).forEach((ev) => {
                if (!totalByRaid[ev.raid_id]) totalByRaid[ev.raid_id] = 0
                totalByRaid[ev.raid_id] += parseFloat(ev.dkp_value || 0)
              })
              const dkpByRaid = {}
              if (evAttRes.data?.length > 0) {
                evAttRes.data.forEach((a) => {
                  const k = `${a.raid_id}|${a.event_id}`
                  if (!dkpByRaid[a.raid_id]) dkpByRaid[a.raid_id] = 0
                  dkpByRaid[a.raid_id] += eventDkp[k] || 0
                })
                // Fallback: for raids where we have raid_attendance but no event-level rows, use full raid total
                const attRaidIds = new Set((attRes.data || []).map((r) => r.raid_id))
                raidList.forEach((raidId) => {
                  if ((dkpByRaid[raidId] ?? 0) === 0 && attRaidIds.has(raidId)) {
                    dkpByRaid[raidId] = totalByRaid[raidId] ?? 0
                  }
                })
              } else {
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
                dkpRaidTotal: totalRaidDkp[raidId] ?? 0,
                items: lootByRaid[raidId] || [],
              })).sort((a, b) => (b.date || '').localeCompare(a.date || ''))
              setActivityByRaid(activity)
              setLoading(false)
            })
          })
        })
      })
    })
  }, [accountId, refreshKey])

  const displayName = account?.display_name?.trim() || account?.toon_names?.split(',')[0]?.trim() || accountId

  async function handleClaimAccount() {
    setClaimLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      setClaimLoading(false)
      return
    }
    const { error: updErr } = await supabase.from('profiles').update({ account_id: accountId }).eq('id', user.id)
    setClaimLoading(false)
    if (updErr) setError(updErr.message)
    else setMyAccountId(accountId)
  }

  async function handleAddCharacter() {
    const raw = addCharInput.trim()
    if (!raw) {
      setAddCharError('Enter a character name or char_id')
      return
    }
    setAddCharError('')
    setAddCharLoading(true)
    const { data: byId } = await supabase.from('characters').select('char_id, name').eq('char_id', raw).limit(1)
    const { data: byName } = await supabase.from('characters').select('char_id, name').ilike('name', raw).limit(2)
    const chars = (byId?.length ? byId : byName) || []
    const char = (chars.length === 1) ? chars[0] : (chars.length > 1 && chars.some((c) => (c.name || '').toLowerCase() === raw.toLowerCase())) ? chars.find((c) => (c.name || '').toLowerCase() === raw.toLowerCase()) : chars[0]
    if (!char?.char_id) {
      setAddCharError(chars?.length > 1 ? 'Multiple characters match; use exact name or char_id' : 'Character not found in database')
      setAddCharLoading(false)
      return
    }
    const { error: insErr } = await supabase.from('character_account').insert({ char_id: char.char_id, account_id: accountId })
    setAddCharLoading(false)
    if (insErr) {
      setAddCharError(insErr.message)
      return
    }
    setAddCharOpen(false)
    setAddCharInput('')
    setRefreshKey((k) => k + 1)
  }

  if (loading) return <div className="container">Loading account...</div>
  if (error) return <div className="container"><span className="error">{error}</span> <Link to="/accounts">← Accounts</Link></div>
  if (!account) return <div className="container">Account not found. <Link to="/accounts">← Accounts</Link></div>

  return (
    <div className="container">
      <p><Link to="/accounts">← Accounts</Link></p>
      <h1>{displayName}</h1>
      <p style={{ color: '#a1a1aa', marginBottom: '1rem' }}>
        Account <code>{accountId}</code>
        {account.toon_count != null && <span style={{ marginLeft: '0.5rem' }}>({account.toon_count} toons)</span>}
        {isMyAccount && <span style={{ marginLeft: '0.5rem', color: '#a78bfa' }}> {MIDDLE_DOT} This is your account</span>}
        {profile && !isMyAccount && !myAccountId && (
          <button type="button" className="btn btn-ghost" style={{ marginLeft: '0.5rem', fontSize: '0.875rem' }} onClick={handleClaimAccount} disabled={claimLoading}>
            {claimLoading ? 'Claiming...' : 'Claim this account'}
          </button>
        )}
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', borderBottom: '1px solid #27272a', paddingBottom: '0.5rem' }}>
        <button
          type="button"
          className={tab === 'activity' ? 'btn' : 'btn btn-ghost'}
          onClick={() => setTab('activity')}
        >
          Activity
        </button>
        <button
          type="button"
          className={tab === 'characters' ? 'btn' : 'btn btn-ghost'}
          onClick={() => setTab('characters')}
        >
          Characters
        </button>
      </div>

      {tab === 'characters' && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <h2 style={{ marginTop: 0 }}>Characters</h2>
            {canAddChar && (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ padding: '0.25rem 0.5rem', fontSize: '1.25rem', lineHeight: 1 }}
                onClick={() => { setAddCharOpen(true); setAddCharError(''); setAddCharInput(''); }}
                title="Add alt to this account"
              >
                +
              </button>
            )}
          </div>
          {characters.length === 0 ? (
            <p style={{ color: '#71717a' }}>No characters linked to this account.{canAddChar && ' Use + to add a character.'}</p>
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
                    {' '}{MIDDLE_DOT}{' '}
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

      {addCharOpen && (
        <div className="card" style={{ marginTop: '1rem', maxWidth: '24rem' }}>
          <h3 style={{ marginTop: 0 }}>Add character to account</h3>
          <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginBottom: '0.75rem' }}>Enter character name or char_id. Character must exist in the database.</p>
          <input
            type="text"
            className="input"
            placeholder="Character name or char_id"
            value={addCharInput}
            onChange={(e) => setAddCharInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddCharacter()}
            style={{ marginBottom: '0.5rem', width: '100%' }}
          />
          {addCharError && <p style={{ color: '#f87171', fontSize: '0.875rem', marginBottom: '0.5rem' }}>{addCharError}</p>}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" className="btn" onClick={handleAddCharacter} disabled={addCharLoading}>
              {addCharLoading ? 'Adding...' : 'Add'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => { setAddCharOpen(false); setAddCharError(''); setAddCharInput(''); }} disabled={addCharLoading}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {tab === 'activity' && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Activity (earned DKP and items by raid)</h2>
          <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginBottom: '1rem' }}>Reverse chronological. Each raid shows DKP earned and items won by the characters on this account.</p>
          {activityByRaid.length === 0 ? (
            <p style={{ color: '#71717a' }}>No raid activity recorded.</p>
          ) : (
            <ul style={{ listStyle: 'none', paddingLeft: 0, margin: 0 }}>
              {activityByRaid.map((act) => (
                <li key={act.raid_id} style={{ marginBottom: '1.5rem', paddingBottom: '1rem', borderBottom: '1px solid #27272a' }}>
                  <p style={{ margin: '0 0 0.25rem 0' }}>
                    <Link to={`/raids/${act.raid_id}`}><strong>{act.raid_name}</strong></Link>
                    {act.date && <span style={{ color: '#71717a', marginLeft: '0.5rem' }}>{act.date}</span>}
                    <span style={{ marginLeft: '0.5rem' }}>{MIDDLE_DOT} <strong>Earned: {Number(act.dkpEarned ?? 0).toFixed(0)}{act.dkpRaidTotal != null && act.dkpRaidTotal > 0 ? ` / ${Number(act.dkpRaidTotal).toFixed(0)}` : ''}</strong> DKP</span>
                  </p>
                  {act.items.length > 0 && (
                    <ul style={{ margin: '0.25rem 0 0 1.25rem', paddingLeft: 0, listStyle: 'none' }}>
                      {act.items.map((row, i) => (
                        <li key={i} style={{ marginBottom: '0.25rem', fontSize: '0.9rem' }}>
                          <Link to={`/items/${encodeURIComponent(row.item_name || '')}`}>{row.item_name || '—'}</Link>
                          {' '}{MIDDLE_DOT}{' '}
                          <Link to={`/characters/${encodeURIComponent(row.character_name || row.char_id || '')}`}>{row.character_name || row.char_id || '—'}</Link>
                          {row.cost != null && row.cost !== '' && <> {MIDDLE_DOT} {row.cost} DKP</>}
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
