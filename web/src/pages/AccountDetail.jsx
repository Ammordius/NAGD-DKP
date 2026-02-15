import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const MAGELO_BASE = 'https://www.takproject.net/magelo/character.php?char='
const MIDDLE_DOT = '\u00B7'

const PAGE = 1000
const ACTIVITY_PAGE_SIZE = 50
/** Only paginate activity when raid count exceeds this (e.g. 1611 raids). */
const ACTIVITY_PAGINATION_THRESHOLD = 100
const IN_CHUNK = 150 // avoid URL length limits and timeouts when filtering by 1000+ ids

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

/** Fetch rows where column is in values, in chunks to avoid URL length limits and timeouts. */
async function fetchByChunkedIn(table, select, column, values) {
  if (!values.length) return { data: [], error: null }
  const all = []
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const chunk = values.slice(i, i + IN_CHUNK)
    const { data, error } = await supabase.from(table).select(select).in(column, chunk)
    if (error) return { data: null, error }
    all.push(...(data || []))
  }
  return { data: all, error: null }
}

export default function AccountDetail({ isOfficer, profile }) {
  const { accountId } = useParams()
  const [tab, setTab] = useState('activity')
  const [activityPage, setActivityPage] = useState(1)
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
          fetchAll('raid_loot', 'raid_id, char_id, character_name, item_name, cost', (q) => q.in('char_id', charIds)),
          supabase.from('characters').select('char_id, name').in('char_id', charIds).then((cr) => {
            const ch = cr.data || []
            const characterKeys = [...new Set([...charIds, ...ch.map((c) => c.name).filter(Boolean)])]
            if (characterKeys.length === 0) return { data: [] }
            return fetchAll('raid_attendance_dkp', 'raid_id, character_key, dkp_earned', (q) => q.in('character_key', characterKeys), { order: { column: 'raid_id', ascending: true } })
          }),
        ]).then(([chRes, attRes, lootRes, attDkpRes]) => {
          const chars = (chRes.data || []).map((c) => ({ ...c, displayName: c.name || c.char_id }))
          setCharacters(chars)
          const attDkp = (attDkpRes?.error ? [] : (attDkpRes?.data || []))
          const raidIds = new Set([
            ...(attRes.data || []).map((r) => r.raid_id),
            ...(lootRes.data || []).map((r) => r.raid_id),
            ...attDkp.map((r) => r.raid_id),
          ])
          if (raidIds.size === 0) {
            setRaids({})
            setActivityByRaid([])
            setLoading(false)
            return
          }
          const raidList = [...raidIds]
          Promise.all([
            fetchByChunkedIn('raids', 'raid_id, raid_name, date_iso', 'raid_id', raidList),
            fetchByChunkedIn('raid_dkp_totals', 'raid_id, total_dkp', 'raid_id', raidList),
          ]).then(([rRes, totalsRes]) => {
            if (rRes?.error) {
              setError(rRes.error?.message || 'Failed to load raids')
              setLoading(false)
              return
            }
            if (totalsRes?.error) {
              setError(totalsRes.error?.message || 'Failed to load raid totals')
              setLoading(false)
              return
            }
            const rMap = {}
            ;(rRes.data || []).forEach((row) => { rMap[row.raid_id] = row })
            setRaids(rMap)
            const totalRaidDkp = {}
            ;(totalsRes.data || []).forEach((row) => { totalRaidDkp[row.raid_id] = parseFloat(row.total_dkp || 0) })
            const dkpByRaid = {}
            attDkp.forEach((row) => {
              if (!dkpByRaid[row.raid_id]) dkpByRaid[row.raid_id] = 0
              dkpByRaid[row.raid_id] += parseFloat(row.dkp_earned || 0)
            })
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
            setActivityPage(1)
            setLoading(false)
          }).catch((err) => {
            setError(err?.message || 'Failed to load raid data')
            setLoading(false)
          })
        }).catch((err) => {
          setError(err?.message || 'Failed to load activity')
          setLoading(false)
        })
      }).catch((err) => {
        setError(err?.message || 'Failed to load characters')
        setLoading(false)
      })
    }).catch((err) => {
      setError(err?.message || 'Failed to load account')
      setLoading(false)
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
            <>
              {(() => {
                const total = activityByRaid.length
                const usePagination = total > ACTIVITY_PAGINATION_THRESHOLD
                const totalPages = usePagination ? Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE)) : 1
                const page = Math.min(Math.max(1, activityPage), totalPages)
                const start = usePagination ? (page - 1) * ACTIVITY_PAGE_SIZE : 0
                const activityToShow = usePagination ? activityByRaid.slice(start, start + ACTIVITY_PAGE_SIZE) : activityByRaid
                return (
                  <>
                    {usePagination && (
                      <>
                        <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginBottom: '0.75rem' }}>
                          Showing {start + 1}–{start + activityToShow.length} of {total} raids
                          {totalPages > 1 && (
                            <span style={{ marginLeft: '0.5rem' }}>
                              {MIDDLE_DOT} Page {page} of {totalPages}
                            </span>
                          )}
                        </p>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap' }}>
                          {totalPages > 10 && (
                            <button
                              type="button"
                              className="btn btn-ghost"
                              disabled={page <= 1}
                              onClick={() => setActivityPage(1)}
                            >
                              First
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={page <= 1}
                            onClick={() => setActivityPage((p) => Math.max(1, p - 1))}
                          >
                            Previous
                          </button>
                          {totalPages <= 10 && (
                            Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
                              <button
                                key={n}
                                type="button"
                                className={n === page ? 'btn' : 'btn btn-ghost'}
                                style={{ minWidth: '2.25rem', padding: '0.25rem 0.5rem' }}
                                onClick={() => setActivityPage(n)}
                              >
                                {n}
                              </button>
                            ))
                          )}
                          <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={page >= totalPages}
                            onClick={() => setActivityPage((p) => Math.min(totalPages, p + 1))}
                          >
                            Next
                          </button>
                          {totalPages > 10 && (
                            <button
                              type="button"
                              className="btn btn-ghost"
                              disabled={page >= totalPages}
                              onClick={() => setActivityPage(totalPages)}
                            >
                              Last
                            </button>
                          )}
                        </div>
                      </>
                    )}
                    <ul style={{ listStyle: 'none', paddingLeft: 0, margin: 0 }}>
                      {activityToShow.map((act) => (
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
                                  <Link to={`/accounts/${accountId}`}>{row.character_name || row.char_id || '—'}</Link>
                                  {row.cost != null && row.cost !== '' && <> {MIDDLE_DOT} {row.cost} DKP</>}
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )
              })()}
            </>
          )}
        </div>
      )}
    </div>
  )
}
