import { useEffect, useState, useMemo, useCallback, Fragment } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useCharToAccountMap } from '../lib/useCharToAccountMap'
import AssignedLootDisclaimer from '../components/AssignedLootDisclaimer'

export default function RaidDetail({ isOfficer }) {
  const { raidId } = useParams()
  const { getAccountId, getAccountDisplayName } = useCharToAccountMap()
  const [raid, setRaid] = useState(null)
  const [events, setEvents] = useState([])
  const [loot, setLoot] = useState([])
  const [attendance, setAttendance] = useState([])
  const [eventAttendance, setEventAttendance] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expandedEvents, setExpandedEvents] = useState({})
  const [editingEventId, setEditingEventId] = useState(null)
  const [editingEventDkp, setEditingEventDkp] = useState('')
  const [editingEventTimeId, setEditingEventTimeId] = useState(null)
  const [editingEventTimeValue, setEditingEventTimeValue] = useState('')
  const [editingLootId, setEditingLootId] = useState(null)
  const [editingLootCost, setEditingLootCost] = useState('')
  const [mutating, setMutating] = useState(false)
  const [characters, setCharacters] = useState([])
  const [addToTicEventId, setAddToTicEventId] = useState('')
  const [addToTicCharQuery, setAddToTicCharQuery] = useState('')
  const [showCharDropdown, setShowCharDropdown] = useState(false)
  const [addToTicResult, setAddToTicResult] = useState(null)

  const loadData = useCallback(() => {
    if (!raidId) return
    setLoading(true)
    setError('')
    Promise.all([
      supabase.from('raids').select('*').eq('raid_id', raidId).single(),
      supabase.from('raid_events').select('*').eq('raid_id', raidId).order('event_order'),
      supabase.from('raid_loot').select('*').eq('raid_id', raidId),
      supabase.from('raid_attendance').select('*').eq('raid_id', raidId).order('character_name'),
      supabase.from('raid_event_attendance').select('event_id, char_id, character_name').eq('raid_id', raidId),
    ]).then(([r, e, l, a, ea]) => {
      if (r.error) setError(r.error.message)
      else setRaid(r.data)
      if (!e.error) setEvents(e.data || [])
      if (!l.error) setLoot(l.data || [])
      if (!a.error) setAttendance(a.data || [])
      if (!ea.error) setEventAttendance(ea.data || [])
      const attendanceList = a.data || []
      if (!r.error && r.data && attendanceList.length > 0) {
        const expected = String(attendanceList.length)
        const current = r.data.attendees
        if (current == null || current === '' || String(Math.round(Number(current))) !== expected) {
          supabase.from('raids').update({ attendees: expected }).eq('raid_id', raidId).then(() => {})
        }
      }
      setLoading(false)
    })
  }, [raidId])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    if (isOfficer && raidId) {
      supabase.from('characters').select('char_id, name').limit(5000).then(({ data }) => setCharacters(data || []))
    }
  }, [isOfficer, raidId])

  useEffect(() => {
    if (events.length > 0 && (!addToTicEventId || !events.some((e) => e.event_id === addToTicEventId))) {
      setAddToTicEventId(events[0].event_id)
    }
  }, [events, addToTicEventId])

  const nameToChar = useMemo(() => {
    const m = {}
    characters.forEach((c) => {
      const n = (c.name || '').trim()
      if (n) m[n.toLowerCase()] = { char_id: c.char_id, name: n }
    })
    return m
  }, [characters])
  const characterNamesList = useMemo(() => characters.map((c) => (c.name || '').trim()).filter(Boolean).sort((a, b) => a.localeCompare(b)), [characters])
  const filteredCharacterNames = useMemo(() => {
    const q = addToTicCharQuery.toLowerCase().trim()
    if (!q) return characterNamesList.slice(0, 200)
    return characterNamesList.filter((n) => n.toLowerCase().includes(q)).slice(0, 200)
  }, [characterNamesList, addToTicCharQuery])

  const attendeesByEvent = useMemo(() => {
    const byEvent = {}
    eventAttendance.forEach((row) => {
      const eid = String(row.event_id ?? '').trim()
      if (!eid) return
      if (!byEvent[eid]) byEvent[eid] = []
      byEvent[eid].push({ name: row.character_name || row.char_id || '—', char_id: row.char_id })
    })
    Object.keys(byEvent).forEach((id) => byEvent[id].sort((a, b) => (a.name || '').localeCompare(b.name || '')))
    return byEvent
  }, [eventAttendance])

  // When we have per-event attendance, derive attendees from current events only (excludes deleted tics).
  const currentEventIds = useMemo(() => new Set(events.map((e) => String(e.event_id ?? '').trim())), [events])
  const effectiveAttendance = useMemo(() => {
    if (!events.length || !eventAttendance.length) return null
    const seen = new Set()
    const list = []
    eventAttendance.forEach((row) => {
      const eid = String(row.event_id ?? '').trim()
      if (!currentEventIds.has(eid)) return
      const key = String(row.char_id ?? row.character_name ?? '').trim()
      if (!key || seen.has(key)) return
      seen.add(key)
      list.push({ char_id: row.char_id, character_name: row.character_name || row.char_id || '—' })
    })
    list.sort((a, b) => (a.character_name || '').localeCompare(b.character_name || ''))
    return list
  }, [events.length, eventAttendance, currentEventIds])

  // Attendee list and count to show: use event-derived list when available, else raid_attendance.
  const displayAttendance = effectiveAttendance ?? attendance
  const displayAttendeeCount = displayAttendance.length

  // When attendees are derived from current events only, keep raid.attendees and raid_attendance in sync (fixes count after a tic was deleted).
  useEffect(() => {
    if (!raid?.raid_id || effectiveAttendance == null) return
    const expectedCount = effectiveAttendance.length
    const currentCount = raid.attendees != null && raid.attendees !== '' ? Math.round(Number(raid.attendees)) : null
    const charIdsInCurrentEvents = new Set(effectiveAttendance.map((a) => String(a.char_id ?? '').trim()).filter(Boolean))
    const needsSync = currentCount !== expectedCount || attendance.some((a) => !charIdsInCurrentEvents.has(String(a.char_id ?? '').trim()))
    if (!needsSync) return
    const cleanup = async () => {
      for (const row of attendance) {
        const cid = String(row.char_id ?? '').trim()
        if (cid && !charIdsInCurrentEvents.has(cid)) {
          await supabase.from('raid_attendance').delete().eq('raid_id', raid.raid_id).eq('char_id', row.char_id)
        }
      }
      await supabase.from('raids').update({ attendees: String(expectedCount) }).eq('raid_id', raid.raid_id)
      loadData()
    }
    cleanup()
  }, [raid?.raid_id, raid?.attendees, effectiveAttendance, attendance, loadData])

  // Account-aware: an account is "present" for an event if any of its characters is in that event.
  // "Not present for all events" = accounts (or unlinked chars) that missed at least one event.
  const notPresentForAllEvents = useMemo(() => {
    if (!events.length || eventAttendance.length === 0) return []
    const eventAccountKeys = {}
    events.forEach((ev) => {
      const eid = String(ev.event_id ?? '').trim()
      const set = new Set()
      ;(attendeesByEvent[eid] || []).forEach((a) => {
        const accountId = getAccountId(a.char_id ?? a.name)
        const key = accountId != null ? `account:${accountId}` : `char:${String(a.char_id ?? a.name ?? '').trim()}`
        set.add(key)
      })
      eventAccountKeys[eid] = set
    })
    const missedByKey = new Map()
    const sourceList = effectiveAttendance ?? attendance
    sourceList.forEach((a) => {
      const accountId = getAccountId(a.character_name ?? a.char_id)
      const key = accountId != null ? `account:${accountId}` : `char:${String(a.char_id ?? a.character_name ?? '').trim()}`
      const missed = events.some((ev) => {
        const eid = String(ev.event_id ?? '').trim()
        const keys = eventAccountKeys[eid]
        if (!keys || keys.size === 0) return false
        return !keys.has(key)
      })
      if (missed && !missedByKey.has(key)) {
        missedByKey.set(key, { accountId, character_name: a.character_name, char_id: a.char_id })
      }
    })
    return [...missedByKey.values()]
  }, [attendance, effectiveAttendance, events, attendeesByEvent, eventAttendance.length, getAccountId])

  const handleSaveEventDkp = async (eventId) => {
    const val = String(editingEventDkp).trim()
    if (val === '') return
    setMutating(true)
    const { error: err } = await supabase.from('raid_events').update({ dkp_value: val }).eq('raid_id', raidId).eq('event_id', eventId)
    setMutating(false)
    if (err) setError(err.message)
    else {
      setEditingEventId(null)
      loadData()
    }
  }

  const handleSaveEventTime = async (eventId) => {
    const val = String(editingEventTimeValue).trim()
    setMutating(true)
    const { error: err } = await supabase.from('raid_events').update({ event_time: val || null }).eq('raid_id', raidId).eq('event_id', eventId)
    setMutating(false)
    if (err) setError(err.message)
    else {
      setEditingEventTimeId(null)
      loadData()
    }
  }

  const handleSaveLootCost = async (row) => {
    const val = String(editingLootCost).trim()
    setMutating(true)
    const { error: err } = await supabase.from('raid_loot').update({ cost: val }).eq('id', row.id)
    setMutating(false)
    if (err) setError(err.message)
    else {
      setEditingLootId(null)
      loadData()
    }
  }

  const handleDeleteLoot = async (row) => {
    const msg = `Are you sure you want to remove this loot?\n\n"${row.item_name || 'Item'}" from ${row.character_name || 'character'}\n\nThis cannot be undone.`
    if (!window.confirm(msg)) return
    setMutating(true)
    const { error: err } = await supabase.from('raid_loot').delete().eq('id', row.id)
    setMutating(false)
    if (err) setError(err.message)
    else loadData()
  }

  const handleAddAttendeeToTic = async () => {
    if (!raidId || !addToTicEventId) return
    const name = addToTicCharQuery.trim()
    const char = nameToChar[name.toLowerCase()]
    if (!char) {
      setError('Select a character from the list (name must match DKP list).')
      return
    }
    const alreadyInTic = eventAttendance.some((r) => String(r.event_id) === String(addToTicEventId) && String(r.char_id) === String(char.char_id))
    if (alreadyInTic) {
      setError(`${char.name} is already in this tic.`)
      return
    }
    setMutating(true)
    setAddToTicResult(null)
    setError('')
    const { error: attErr } = await supabase.from('raid_event_attendance').insert({
      raid_id: raidId,
      event_id: addToTicEventId,
      char_id: char.char_id,
      character_name: char.name,
    })
    if (attErr) {
      setError(attErr.message)
      setMutating(false)
      return
    }
    const existingCharIds = new Set(attendance.map((r) => String(r.char_id)))
    if (!existingCharIds.has(String(char.char_id))) {
      await supabase.from('raid_attendance').insert({
        raid_id: raidId,
        char_id: char.char_id,
        character_name: char.name,
      })
    }
    setAddToTicResult(char.name)
    setAddToTicCharQuery('')
    await supabase.rpc('refresh_dkp_summary')
    try { sessionStorage.removeItem('dkp_leaderboard_v2') } catch (_) {}
    const { count } = await supabase.from('raid_attendance').select('*', { count: 'exact', head: true }).eq('raid_id', raidId)
    if (count != null) await supabase.from('raids').update({ attendees: String(count) }).eq('raid_id', raidId)
    loadData()
    setMutating(false)
  }

  if (loading) return <div className="container">Loading…</div>
  if (error || !raid) return <div className="container"><span className="error">{error || 'Raid not found'}</span> <Link to="/raids">← Raids</Link></div>

  const totalDkp = events.reduce((sum, e) => sum + parseFloat(e.dkp_value || 0), 0)

  return (
    <div className="container">
      <p><Link to="/raids">← Raids</Link></p>
      <h1>{raid.raid_name || raidId}</h1>
      <p style={{ color: '#a1a1aa' }}>{raid.date_iso || raid.date} · {(displayAttendeeCount > 0 ? displayAttendeeCount : (raid.attendees ?? '—'))} attendees</p>

      <h2>DKP by event</h2>
      <div className="card">
        <p style={{ margin: '0 0 0.75rem 0', color: '#a1a1aa' }}>Total raid DKP (sum of event DKP): <strong>{Number(totalDkp).toFixed(1)}</strong></p>
        <table>
          <thead>
            <tr><th style={{ width: '2rem' }}></th><th>#</th><th>Event</th><th>DKP</th><th>Time</th><th>Attendees</th>{isOfficer && <th style={{ width: '6rem' }}></th>}</tr>
          </thead>
          <tbody>
            {events.map((e) => {
              const eid = String(e.event_id ?? '').trim()
              const attendees = attendeesByEvent[eid] || []
              const hasList = attendees.length > 0
              const isExpanded = expandedEvents[e.event_id]
              const isEditingDkp = isOfficer && editingEventId === e.event_id
              const isEditingTime = isOfficer && editingEventTimeId === e.event_id
              return (
                <Fragment key={e.event_id}>
                  <tr>
                    <td>
                      {hasList && (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          style={{ padding: '0.25rem', fontSize: '1rem' }}
                          onClick={() => setExpandedEvents((prev) => ({ ...prev, [e.event_id]: !prev[e.event_id] }))}
                          aria-expanded={isExpanded}
                          title={isExpanded ? 'Hide attendees' : 'Show attendees'}
                        >
                          {isExpanded ? '−' : '+'}
                        </button>
                      )}
                    </td>
                    <td>{e.event_order}</td>
                    <td>{e.event_name}</td>
                    <td>
                      {isEditingDkp ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                          <input
                            type="text"
                            value={editingEventDkp}
                            onChange={(ev) => setEditingEventDkp(ev.target.value)}
                            style={{ width: '4rem', padding: '0.2rem' }}
                          />
                          <button type="button" className="btn btn-ghost" onClick={() => handleSaveEventDkp(e.event_id)} disabled={mutating}>Save</button>
                          <button type="button" className="btn btn-ghost" onClick={() => { setEditingEventId(null) }}>Cancel</button>
                        </span>
                      ) : (
                        <>
                          {e.dkp_value}
                          {isOfficer && (
                            <button type="button" className="btn btn-ghost" style={{ marginLeft: '0.25rem', fontSize: '0.85rem' }} onClick={() => { setEditingEventId(e.event_id); setEditingEventDkp(e.dkp_value || '') }} title="Edit DKP">✎</button>
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      {isEditingTime ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                          <input type="text" value={editingEventTimeValue} onChange={(ev) => setEditingEventTimeValue(ev.target.value)} style={{ width: '12rem', padding: '0.2rem' }} placeholder="e.g. Sun Apr 14 10:17:09 2024" />
                          <button type="button" className="btn btn-ghost" onClick={() => handleSaveEventTime(e.event_id)} disabled={mutating}>Save</button>
                          <button type="button" className="btn btn-ghost" onClick={() => setEditingEventTimeId(null)}>Cancel</button>
                        </span>
                      ) : (
                        <>
                          {e.event_time || '—'}
                          {isOfficer && (
                            <button type="button" className="btn btn-ghost" style={{ marginLeft: '0.25rem', fontSize: '0.85rem' }} onClick={() => { setEditingEventTimeId(e.event_id); setEditingEventTimeValue(e.event_time || '') }} title="Edit tic time">✎</button>
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      {hasList ? (
                        <span>{attendees.length}{isExpanded ? '' : ' — click + to list'}</span>
                      ) : (
                        e.attendee_count ?? '—'
                      )}
                    </td>
                    {isOfficer && <td></td>}
                  </tr>
                  {hasList && isExpanded && (
                    <tr key={`${e.event_id}-attendees`}>
                      <td colSpan={isOfficer ? 7 : 6} style={{ padding: '0.5rem 1rem', verticalAlign: 'top', backgroundColor: 'rgba(0,0,0,0.2)', borderBottom: '1px solid #27272a' }}>
                        <div className="attendee-list">
                          {attendees.map((a, i) => {
                            const name = a.name || a.char_id || ''
                            const accountId = getAccountId(a.name || a.char_id)
                            const accountName = getAccountDisplayName?.(a.name || a.char_id)
                            const to = accountId ? `/accounts/${accountId}` : `/characters/${encodeURIComponent(name)}`
                            const label = accountName ? `${accountName} (${name})` : name
                            return <Link key={a.char_id || a.name || i} to={to}>{label}</Link>
                          })}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      {isOfficer && events.length > 0 && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <h3 style={{ marginTop: 0 }}>Add attendee to tic</h3>
          <p style={{ color: '#71717a', fontSize: '0.9rem' }}>Pick a tic and a character to add them (e.g. someone missed the paste).</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'flex-start' }}>
            <select
              value={addToTicEventId}
              onChange={(e) => { setAddToTicEventId(e.target.value); setAddToTicResult(null) }}
              style={{ padding: '0.5rem 0.6rem', fontSize: '1rem', minWidth: '200px' }}
            >
              {events.map((e) => (
                <option key={e.event_id} value={e.event_id}>
                  #{e.event_order} {e.event_name} ({e.dkp_value} DKP)
                </option>
              ))}
            </select>
            <div style={{ position: 'relative', minWidth: '200px' }}>
              <input
                type="text"
                value={addToTicCharQuery}
                onChange={(e) => { setAddToTicCharQuery(e.target.value); setAddToTicResult(null) }}
                onFocus={() => setShowCharDropdown(true)}
                onBlur={() => setTimeout(() => setShowCharDropdown(false), 150)}
                placeholder="Character name (type to filter)"
                style={{ padding: '0.5rem 0.6rem', fontSize: '1rem', width: '100%', minWidth: '180px', boxSizing: 'border-box' }}
              />
              {showCharDropdown && filteredCharacterNames.length > 0 && (
                <ul
                  className="card"
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    right: 0,
                    margin: 0,
                    marginTop: '2px',
                    padding: '0.25rem 0',
                    maxHeight: '240px',
                    overflowY: 'auto',
                    listStyle: 'none',
                    zIndex: 10,
                  }}
                >
                  {filteredCharacterNames.map((n) => (
                    <li
                      key={n}
                      style={{ padding: '0.4rem 0.6rem', cursor: 'pointer' }}
                      onMouseDown={(e) => { e.preventDefault(); setAddToTicCharQuery(n); setShowCharDropdown(false) }}
                    >
                      {n}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button type="button" className="btn" onClick={handleAddAttendeeToTic} disabled={mutating || !addToTicCharQuery.trim()}>
              Add to tic
            </button>
          </div>
          {addToTicResult && <p style={{ color: '#22c55e', marginTop: '0.5rem', marginBottom: 0 }}>Added {addToTicResult} to tic.</p>}
        </div>
      )}

      <h2>Loot</h2>
      <AssignedLootDisclaimer compact />
      <div className="card">
        {isOfficer && <p style={{ color: '#71717a', fontSize: '0.875rem', marginTop: 0 }}><Link to="/officer">Officer page</Link> to add more loot or tics.</p>}
        <table>
          <thead>
            <tr><th>Item</th><th>Buyer</th><th>Character</th><th>Cost</th>{isOfficer && <th style={{ width: '8rem' }}></th>}</tr>
          </thead>
          <tbody>
            {loot.length === 0 && <tr><td colSpan={isOfficer ? 5 : 4}>No loot recorded</td></tr>}
            {loot.map((row, i) => {
              const isEditingCost = isOfficer && editingLootId === row.id
              return (
                <tr key={row.id || i}>
                  <td><Link to={`/items/${encodeURIComponent(row.item_name || '')}`}>{row.item_name || '—'}</Link></td>
                  <td>
                    {(() => {
                      const charName = row.character_name || row.char_id || '—'
                      const accountId = getAccountId(row.character_name || row.char_id)
                      const accountName = getAccountDisplayName?.(row.character_name || row.char_id)
                      const label = accountName ? `${accountName} (${charName})` : charName
                      const to = accountId ? `/accounts/${accountId}` : `/characters/${encodeURIComponent(charName)}`
                      return <Link to={to}>{label}</Link>
                    })()}
                  </td>
                  <td style={{ color: '#a1a1aa', fontSize: '0.875rem' }}>
                    {(row.assigned_character_name || row.assigned_char_id) ? (
                      <Link to={`/characters/${encodeURIComponent(row.assigned_character_name || row.assigned_char_id)}`}>{row.assigned_character_name || row.assigned_char_id}</Link>
                    ) : (
                      <span style={{ color: '#71717a' }}>Unassigned</span>
                    )}
                  </td>
                  <td>
                    {isEditingCost ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <input type="text" value={editingLootCost} onChange={(ev) => setEditingLootCost(ev.target.value)} style={{ width: '4rem', padding: '0.2rem' }} />
                        <button type="button" className="btn btn-ghost" onClick={() => handleSaveLootCost(row)} disabled={mutating}>Save</button>
                        <button type="button" className="btn btn-ghost" onClick={() => setEditingLootId(null)}>Cancel</button>
                      </span>
                    ) : (
                      <>
                        {row.cost}
                        {isOfficer && (
                          <button type="button" className="btn btn-ghost" style={{ marginLeft: '0.25rem', fontSize: '0.85rem' }} onClick={() => { setEditingLootId(row.id); setEditingLootCost(row.cost ?? '') }} title="Edit cost">✎</button>
                        )}
                      </>
                    )}
                  </td>
                  {isOfficer && (
                    <td>
                      {!isEditingCost && (
                        <button type="button" className="btn btn-ghost" style={{ fontSize: '0.85rem', color: '#f87171' }} onClick={() => handleDeleteLoot(row)}>Remove</button>
                      )}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <h2>Attendees</h2>
      <div className="card">
        <div className="attendee-list">
          {displayAttendance.map((a) => {
            const name = a.character_name || a.char_id || ''
            const accountId = getAccountId(a.character_name || a.char_id)
            const to = accountId ? `/accounts/${accountId}` : `/characters/${encodeURIComponent(name)}`
            return <Link key={a.char_id || a.character_name} to={to}>{name}</Link>
          })}
        </div>
      </div>

      {notPresentForAllEvents.length > 0 && (
        <>
          <h2>Not present for all events</h2>
          <div className="card">
            <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginTop: 0 }}>Raiders who attended but missed one or more DKP events.</p>
            <div className="attendee-list">
              {notPresentForAllEvents.map((a) => {
                const name = a.character_name || a.char_id || ''
                const accountId = a.accountId ?? getAccountId(a.character_name || a.char_id)
                const accountName = getAccountDisplayName?.(a.character_name || a.char_id)
                const label = accountName ? `${accountName} (${name})` : name
                const to = accountId ? `/accounts/${accountId}` : `/characters/${encodeURIComponent(name)}`
                return <Link key={accountId || a.char_id || a.character_name} to={to}>{label}</Link>
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
