import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { createCache } from '../lib/cache'

const CACHE_KEY = 'raids_list_v1'
const CACHE_TTL = 10 * 60 * 1000

export default function Raids() {
  const [raids, setRaids] = useState([])
  const [eventsByRaid, setEventsByRaid] = useState({})
  const [classificationsByRaid, setClassificationsByRaid] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const cache = createCache(CACHE_KEY, CACHE_TTL)
    const cached = cache.get()
    if (cached?.raids?.length) {
      setRaids(cached.raids)
      setEventsByRaid(cached.eventsByRaid || {})
      setClassificationsByRaid(cached.classificationsByRaid || {})
      setLoading(false)
    }

    const limit = 200
    Promise.all([
      supabase
        .from('raids')
        .select('raid_id, raid_name, date_iso, date, attendees')
        .order('date_iso', { ascending: false, nullsFirst: false })
        .order('raid_id', { ascending: false })
        .limit(limit),
      supabase.from('raid_events').select('raid_id, dkp_value, event_order').limit(10000),
    ]).then(([r, e]) => {
      if (r.error) {
        setError(r.error.message)
        setLoading(false)
        return
      }
      const raidList = r.data || []
      const byRaid = {}
      ;(e.data || []).forEach((ev) => {
        if (!byRaid[ev.raid_id]) byRaid[ev.raid_id] = { totalDkp: 0, events: [] }
        const v = parseFloat(ev.dkp_value || 0)
        byRaid[ev.raid_id].totalDkp += v
        byRaid[ev.raid_id].events.push({ ...ev, dkp_value: v })
      })
      setRaids(raidList)
      setEventsByRaid(byRaid)
      setLoading(false)
      supabase.from('raid_classifications').select('raid_id, mob, zone').limit(10000).then(({ data }) => {
        const classByRaid = {}
        ;(data || []).forEach((row) => {
          if (!classByRaid[row.raid_id]) classByRaid[row.raid_id] = []
          classByRaid[row.raid_id].push({ mob: row.mob, zone: row.zone })
        })
        setClassificationsByRaid(classByRaid)
        cache.set({ raids: raidList, eventsByRaid: byRaid, classificationsByRaid: classByRaid })
      })
    })
  }, [])

  if (loading) return <div className="container">Loading raids…</div>
  if (error) return <div className="container"><span className="error">{error}</span></div>

  return (
    <div className="container">
      <h1>Raids</h1>
      <p style={{ color: '#71717a' }}>Recent raids with total DKP earned (sum of event DKP).</p>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Raid</th>
              <th>Total DKP</th>
              <th>Attendees</th>
            </tr>
          </thead>
          <tbody>
            {raids.map((r) => {
              const ev = eventsByRaid[r.raid_id]
              const totalDkp = ev ? ev.totalDkp : null
              return (
                <tr key={r.raid_id}>
                  <td>{r.date_iso || r.date || '—'}</td>
                  <td><Link to={`/raids/${r.raid_id}`}>{r.raid_name || r.raid_id}</Link></td>
                  <td>{totalDkp != null ? Math.round(Number(totalDkp)) : '—'}</td>
                  <td>{r.attendees ?? '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
