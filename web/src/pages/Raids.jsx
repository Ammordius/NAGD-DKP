import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function Raids() {
  const [raids, setRaids] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    supabase
      .from('raids')
      .select('raid_id, raid_name, date_iso, date, attendees')
      .order('date_iso', { ascending: false, nullsFirst: false })
      .order('raid_id', { ascending: false })
      .limit(200)
      .then(({ data, error: err }) => {
        if (err) setError(err.message)
        else setRaids(data || [])
        setLoading(false)
      })
  }, [])

  if (loading) return <div className="container">Loading raids…</div>
  if (error) return <div className="container"><span className="error">{error}</span></div>

  return (
    <div className="container">
      <h1>Raids</h1>
      <p style={{ color: '#71717a' }}>Recent raids (up to 200).</p>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Raid</th>
              <th>Attendees</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {raids.map((r) => (
              <tr key={r.raid_id}>
                <td>{r.date_iso || r.date || '—'}</td>
                <td>{r.raid_name || r.raid_id}</td>
                <td>{r.attendees ?? '—'}</td>
                <td><Link to={`/raids/${r.raid_id}`}>View</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
