import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { createCache } from '../lib/cache'

const CACHE_KEY = 'raids_list_v2'
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
    supabase
      .from('raids')
      .select('raid_id, raid_name, date_iso, date, attendees')
      .order('date_iso', { ascending: false, nullsFirst: false })
      .order('raid_id', { ascending: false })
      .limit(limit)
      .then((r) => {
        if (r.error) {
          setError(r.error.message)
          setLoading(false)
          return
        }
        const raidList = r.data || []
        setRaids(raidList)
        if (raidList.length === 0) {
          setEventsByRaid({})
          setLoading(false)
          return
        }
        const raidIds = raidList.map((row) => String(row.raid_id).trim()).filter(Boolean)
        const CHUNK = 80
        const fetchAllEvents = async () => {
          const all = []
          for (let i = 0; i < raidIds.length; i += CHUNK) {
            const chunk = raidIds.slice(i, i + CHUNK)
            const { data } = await supabase.from('raid_events').select('raid_id, dkp_value, event_order').in('raid_id', chunk)
            if (data?.length) all.push(...data)
          }
          return all
        }
        fetchAllEvents().then((eventRows) => {
          const byRaid = {}
          eventRows.forEach((ev) => {
            const rid = String(ev.raid_id ?? '').trim()
            if (!rid) return
            if (!byRaid[rid]) byRaid[rid] = { totalDkp: 0, events: [] }
            const v = parseFloat(ev.dkp_value || 0)
            byRaid[rid].totalDkp += v
            byRaid[rid].events.push({ ...ev, dkp_value: v })
          })
          setEventsByRaid(byRaid)
          setLoading(false)
          const classChunks = []
          for (let i = 0; i < raidIds.length; i += CHUNK) {
            classChunks.push(supabase.from('raid_classifications').select('raid_id, mob, zone').in('raid_id', raidIds.slice(i, i + CHUNK)))
          }
          Promise.all(classChunks).then((responses) => {
            const classByRaid = {}
            responses.forEach(({ data }) => {
              ;(data || []).forEach((row) => {
                const rid = String(row.raid_id ?? '').trim()
                if (!classByRaid[rid]) classByRaid[rid] = []
                classByRaid[rid].push({ mob: row.mob, zone: row.zone })
              })
            })
            setClassificationsByRaid(classByRaid)
            cache.set({ raids: raidList, eventsByRaid: byRaid, classificationsByRaid: classByRaid })
          })
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
              const ev = eventsByRaid[String(r.raid_id ?? '').trim()]
              const totalDkp = ev ? ev.totalDkp : null
              return (
                <tr key={r.raid_id}>
                  <td>{r.date_iso || r.date || '—'}</td>
                  <td><Link to={`/raids/${r.raid_id}`}>{r.raid_name || r.raid_id}</Link></td>
                  <td>{totalDkp != null ? Math.round(Number(totalDkp)) : '—'}</td>
                  <td>{r.attendees != null && r.attendees !== '' ? Math.round(Number(r.attendees)) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
