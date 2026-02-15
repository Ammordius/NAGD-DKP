import { useEffect, useState, useMemo, useCallback, Fragment } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function RaidDetail({ isOfficer }) {
  const { raidId } = useParams()
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
  const [editingLootId, setEditingLootId] = useState(null)
  const [editingLootCost, setEditingLootCost] = useState('')
  const [mutating, setMutating] = useState(false)

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
      setLoading(false)
    })
  }, [raidId])

  useEffect(() => {
    loadData()
  }, [loadData])

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

  const notPresentForAllEvents = useMemo(() => {
    if (!events.length || eventAttendance.length === 0) return []
    const eventKeys = {}
    events.forEach((ev) => {
      const eid = String(ev.event_id ?? '').trim()
      const set = new Set()
      ;(attendeesByEvent[eid] || []).forEach((a) => {
        if (a.name) set.add(String(a.name).trim())
        if (a.char_id != null && a.char_id !== '') set.add(String(a.char_id).trim())
      })
      eventKeys[eid] = set
    })
    return attendance.filter((a) => {
      const name = (a.character_name || '').trim()
      const cid = a.char_id != null && a.char_id !== '' ? String(a.char_id).trim() : ''
      return events.some((ev) => {
        const eid = String(ev.event_id ?? '').trim()
        const keys = eventKeys[eid]
        if (!keys || keys.size === 0) return false
        return !keys.has(name) && !keys.has(cid)
      })
    })
  }, [attendance, events, attendeesByEvent, eventAttendance.length])

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
    if (!window.confirm(`Remove loot "${row.item_name}" from ${row.character_name}?`)) return
    setMutating(true)
    const { error: err } = await supabase.from('raid_loot').delete().eq('id', row.id)
    setMutating(false)
    if (err) setError(err.message)
    else loadData()
  }

  if (loading) return <div className="container">Loading…</div>
  if (error || !raid) return <div className="container"><span className="error">{error || 'Raid not found'}</span> <Link to="/raids">← Raids</Link></div>

  const totalDkp = events.reduce((sum, e) => sum + parseFloat(e.dkp_value || 0), 0)

  return (
    <div className="container">
      <p><Link to="/raids">← Raids</Link></p>
      <h1>{raid.raid_name || raidId}</h1>
      <p style={{ color: '#a1a1aa' }}>{raid.date_iso || raid.date} · {raid.attendees} attendees</p>

      <h2>DKP by event</h2>
      <div className="card">
        <p style={{ margin: '0 0 0.75rem 0', color: '#a1a1aa' }}>Total raid DKP (sum of event DKP): <strong>{Number(totalDkp).toFixed(1)}</strong></p>
        <table>
          <thead>
            <tr><th style={{ width: '2rem' }}></th><th>#</th><th>Event</th><th>DKP</th><th>Attendees</th>{isOfficer && <th style={{ width: '6rem' }}></th>}</tr>
          </thead>
          <tbody>
            {events.map((e) => {
              const eid = String(e.event_id ?? '').trim()
              const attendees = attendeesByEvent[eid] || []
              const hasList = attendees.length > 0
              const isExpanded = expandedEvents[e.event_id]
              const isEditingDkp = isOfficer && editingEventId === e.event_id
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
                      <td colSpan={isOfficer ? 6 : 5} style={{ padding: '0.5rem 1rem', verticalAlign: 'top', backgroundColor: 'rgba(0,0,0,0.2)', borderBottom: '1px solid #27272a' }}>
                        <div className="attendee-list">
                          {attendees.map((a, i) => (
                            <Link key={a.char_id || a.name || i} to={`/characters/${encodeURIComponent(a.name || '')}`}>
                              {a.name}
                            </Link>
                          ))}
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

      <h2>Loot</h2>
      <div className="card">
        {isOfficer && <p style={{ color: '#71717a', fontSize: '0.875rem', marginTop: 0 }}><Link to="/officer">Officer page</Link> to add more loot or tics.</p>}
        <table>
          <thead>
            <tr><th>Item</th><th>Character</th><th>Cost</th>{isOfficer && <th style={{ width: '8rem' }}></th>}</tr>
          </thead>
          <tbody>
            {loot.length === 0 && <tr><td colSpan={isOfficer ? 4 : 3}>No loot recorded</td></tr>}
            {loot.map((row, i) => {
              const isEditingCost = isOfficer && editingLootId === row.id
              return (
                <tr key={row.id || i}>
                  <td><Link to={`/items/${encodeURIComponent(row.item_name || '')}`}>{row.item_name || '—'}</Link></td>
                  <td><Link to={`/characters/${encodeURIComponent(row.character_name || row.char_id || '')}`}>{row.character_name || row.char_id || '—'}</Link></td>
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
          {attendance.map((a) => (
            <Link key={a.char_id || a.character_name} to={`/characters/${encodeURIComponent(a.character_name || a.char_id || '')}`}>
              {a.character_name || a.char_id}
            </Link>
          ))}
        </div>
      </div>

      {notPresentForAllEvents.length > 0 && (
        <>
          <h2>Not present for all events</h2>
          <div className="card">
            <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginTop: 0 }}>Raiders who attended but missed one or more DKP events.</p>
            <div className="attendee-list">
              {notPresentForAllEvents.map((a) => (
                <Link key={a.char_id || a.character_name} to={`/characters/${encodeURIComponent(a.character_name || a.char_id || '')}`}>
                  {a.character_name || a.char_id}
                </Link>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
