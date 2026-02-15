import { useEffect, useState, useMemo, Fragment } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function RaidDetail() {
  const { raidId } = useParams()
  const [raid, setRaid] = useState(null)
  const [events, setEvents] = useState([])
  const [loot, setLoot] = useState([])
  const [attendance, setAttendance] = useState([])
  const [eventAttendance, setEventAttendance] = useState([])
  const [classifications, setClassifications] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expandedEvents, setExpandedEvents] = useState({})

  useEffect(() => {
    if (!raidId) return
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
    supabase.from('raid_classifications').select('mob, zone').eq('raid_id', raidId).then(({ data }) => {
      if (data) setClassifications(data)
    })
  }, [raidId])

  const attendeesByEvent = useMemo(() => {
    const byEvent = {}
    eventAttendance.forEach((row) => {
      if (!byEvent[row.event_id]) byEvent[row.event_id] = []
      byEvent[row.event_id].push({ name: row.character_name || row.char_id || '—', char_id: row.char_id })
    })
    Object.keys(byEvent).forEach((id) => byEvent[id].sort((a, b) => (a.name || '').localeCompare(b.name || '')))
    return byEvent
  }, [eventAttendance])

  if (loading) return <div className="container">Loading…</div>
  if (error || !raid) return <div className="container"><span className="error">{error || 'Raid not found'}</span> <Link to="/raids">← Raids</Link></div>

  const totalDkp = events.reduce((sum, e) => sum + parseFloat(e.dkp_value || 0), 0)
  const mobLabels = [...new Set(classifications.map((c) => c.mob.replace(/^#/, '')))]

  return (
    <div className="container">
      <p><Link to="/raids">← Raids</Link></p>
      <h1>{raid.raid_name || raidId}</h1>
      <p style={{ color: '#a1a1aa' }}>{raid.date_iso || raid.date} · {raid.attendees} attendees</p>
      {mobLabels.length > 0 && (
        <p className="raid-badges" style={{ marginTop: '0.5rem' }}>
          <span style={{ marginRight: '0.5rem', color: '#71717a' }}>Kill types:</span>
          {mobLabels.map((m) => (
            <span key={m} className="badge" title={m}>{m}</span>
          ))}
        </p>
      )}

      <h2>DKP by event</h2>
      <div className="card">
        <p style={{ margin: '0 0 0.75rem 0', color: '#a1a1aa' }}>Total raid DKP (sum of event DKP): <strong>{Number(totalDkp).toFixed(1)}</strong></p>
        <table>
          <thead>
            <tr><th style={{ width: '2rem' }}></th><th>#</th><th>Event</th><th>DKP</th><th>Attendees</th></tr>
          </thead>
          <tbody>
            {events.map((e) => {
              const attendees = attendeesByEvent[e.event_id] || []
              const hasList = attendees.length > 0
              const isExpanded = expandedEvents[e.event_id]
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
                    <td>{e.dkp_value}</td>
                    <td>
                      {hasList ? (
                        <span>{attendees.length}{isExpanded ? '' : ' — click + to list'}</span>
                      ) : (
                        e.attendee_count ?? '—'
                      )}
                    </td>
                  </tr>
                  {hasList && isExpanded && (
                    <tr key={`${e.event_id}-attendees`}>
                      <td colSpan={5} style={{ padding: '0.5rem 1rem', verticalAlign: 'top', backgroundColor: 'rgba(0,0,0,0.2)', borderBottom: '1px solid #27272a' }}>
                        <div style={{ maxHeight: '200px', overflowY: 'auto', fontSize: '0.9rem' }}>
                          {attendees.map((a, i) => (
                            <Link key={a.char_id || a.name || i} to={`/characters/${encodeURIComponent(a.name || '')}`} style={{ marginRight: '0.5rem' }}>
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
        <table>
          <thead>
            <tr><th>Item</th><th>Character</th><th>Cost</th></tr>
          </thead>
          <tbody>
            {loot.length === 0 && <tr><td colSpan={3}>No loot recorded</td></tr>}
            {loot.map((row, i) => (
              <tr key={row.id || i}>
                <td><Link to={`/items/${encodeURIComponent(row.item_name || '')}`}>{row.item_name || '—'}</Link></td>
                <td><Link to={`/characters/${encodeURIComponent(row.character_name || row.char_id || '')}`}>{row.character_name || row.char_id || '—'}</Link></td>
                <td>{row.cost}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Attendees</h2>
      <div className="card">
        <p style={{ margin: 0 }}>
          {attendance.map((a) => (
            <Link key={a.char_id || a.character_name} to={`/characters/${encodeURIComponent(a.character_name || a.char_id || '')}`} style={{ marginRight: '0.5rem' }}>
              {a.character_name || a.char_id}
            </Link>
          ))}
        </p>
      </div>
    </div>
  )
}
