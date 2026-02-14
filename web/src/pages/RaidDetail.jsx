import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function RaidDetail() {
  const { raidId } = useParams()
  const [raid, setRaid] = useState(null)
  const [events, setEvents] = useState([])
  const [loot, setLoot] = useState([])
  const [attendance, setAttendance] = useState([])
  const [classifications, setClassifications] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!raidId) return
    Promise.all([
      supabase.from('raids').select('*').eq('raid_id', raidId).single(),
      supabase.from('raid_events').select('*').eq('raid_id', raidId).order('event_order'),
      supabase.from('raid_loot').select('*').eq('raid_id', raidId),
      supabase.from('raid_attendance').select('*').eq('raid_id', raidId).order('character_name'),
    ]).then(([r, e, l, a]) => {
      if (r.error) setError(r.error.message)
      else setRaid(r.data)
      if (!e.error) setEvents(e.data || [])
      if (!l.error) setLoot(l.data || [])
      if (!a.error) setAttendance(a.data || [])
      setLoading(false)
    })
    supabase.from('raid_classifications').select('mob, zone').eq('raid_id', raidId).then(({ data }) => {
      if (data) setClassifications(data)
    })
  }, [raidId])

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
            <tr><th>#</th><th>Event</th><th>DKP</th><th>Attendees</th></tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.event_id}>
                <td>{e.event_order}</td>
                <td>{e.event_name}</td>
                <td>{e.dkp_value}</td>
                <td>{e.attendee_count}</td>
              </tr>
            ))}
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
                <td>{row.item_name || '—'}</td>
                <td>{row.character_name}</td>
                <td>{row.cost}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Attendees</h2>
      <div className="card">
        <p style={{ margin: 0 }}>{attendance.map((a) => a.character_name).join(', ')}</p>
      </div>
    </div>
  )
}
