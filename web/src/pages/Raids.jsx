import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'

const OFFICER_ADD_RAID_HASH = '#add-raid'
import { supabase } from '../lib/supabase'
import { createCache } from '../lib/cache'

const CACHE_KEY = 'raids_list_v2'
const CACHE_TTL = 10 * 60 * 1000

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function getRaidDateKey(r) {
  const iso = (r.date_iso || r.date || '').toString().trim()
  return iso.length >= 10 ? iso.slice(0, 10) : null
}

function buildCalendarGrid(year, month, raidsByDate) {
  const first = new Date(year, month - 1, 1)
  const last = new Date(year, month, 0)
  const startDow = first.getDay()
  const daysInMonth = last.getDate()
  const cells = []
  // leading empty cells
  for (let i = 0; i < startDow; i++) cells.push({ dateKey: null, day: null, isCurrentMonth: false, raids: [] })
  for (let d = 1; d <= daysInMonth; d++) {
    const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    cells.push({ dateKey, day: d, isCurrentMonth: true, raids: raidsByDate[dateKey] || [] })
  }
  const trailing = 42 - cells.length
  for (let i = 0; i < trailing; i++) cells.push({ dateKey: null, day: null, isCurrentMonth: false, raids: [] })
  return cells
}

export default function Raids({ isOfficer }) {
  const [raids, setRaids] = useState([])
  const [eventsByRaid, setEventsByRaid] = useState({})
  const [classificationsByRaid, setClassificationsByRaid] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear())
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth() + 1)

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

  const raidsByDate = useMemo(() => {
    const byDate = {}
    for (const r of raids) {
      const key = getRaidDateKey(r)
      if (!key) continue
      if (!byDate[key]) byDate[key] = []
      byDate[key].push(r)
    }
    return byDate
  }, [raids])

  const calendarGrid = useMemo(
    () => buildCalendarGrid(viewYear, viewMonth, raidsByDate),
    [viewYear, viewMonth, raidsByDate]
  )

  const goPrevMonth = () => {
    if (viewMonth === 1) {
      setViewMonth(12)
      setViewYear((y) => y - 1)
    } else setViewMonth((m) => m - 1)
  }
  const goNextMonth = () => {
    if (viewMonth === 12) {
      setViewMonth(1)
      setViewYear((y) => y + 1)
    } else setViewMonth((m) => m + 1)
  }

  const todayKey = (() => {
    const t = new Date()
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
  })()

  // Group raids by year-month for table list (calendar order: newest month first)
  const raidsByMonth = (() => {
    const map = new Map()
    for (const r of raids) {
      const iso = (r.date_iso || r.date || '').toString().trim()
      const yyyyMm = iso.length >= 7 ? iso.slice(0, 7) : 'Unknown'
      if (!map.has(yyyyMm)) {
        if (yyyyMm === 'Unknown') {
          map.set(yyyyMm, { label: 'Unknown date', raids: [] })
        } else {
          const [y, m] = yyyyMm.split('-').map(Number)
          map.set(yyyyMm, { label: `${MONTH_NAMES[(m || 1) - 1]} ${y || '?'}`, raids: [] })
        }
      }
      map.get(yyyyMm).raids.push(r)
    }
    const keys = [...map.keys()].sort((a, b) => {
      if (a === 'Unknown') return 1
      if (b === 'Unknown') return -1
      return b.localeCompare(a)
    })
    return keys.map((k) => ({ key: k, ...map.get(k) }))
  })()

  if (loading) return <div className="container">Loading raids…</div>
  if (error) return <div className="container"><span className="error">{error}</span></div>

  return (
    <div className="container">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        <h1 style={{ margin: 0 }}>Raids</h1>
        {isOfficer && (
          <Link to={`/officer${OFFICER_ADD_RAID_HASH}`} className="btn btn-ghost" style={{ padding: '0.25rem 0.5rem', fontSize: '1.25rem', lineHeight: 1 }} title="Add raid">
            +
          </Link>
        )}
      </div>
      <p style={{ color: '#71717a', marginBottom: '1rem' }}>Calendar of raids by date. Use arrows to change month.</p>

      <div className="calendar-wrap card">
        <div className="calendar-header">
          <button type="button" className="calendar-nav" onClick={goPrevMonth} aria-label="Previous month">←</button>
          <h2 className="calendar-title">{MONTH_NAMES[viewMonth - 1]} {viewYear}</h2>
          <button type="button" className="calendar-nav" onClick={goNextMonth} aria-label="Next month">→</button>
        </div>
        <div className="calendar-grid">
          {DOW.map((d) => (
            <div key={d} className="calendar-dow">{d}</div>
          ))}
          {calendarGrid.map((cell, idx) => (
            <div
              key={idx}
              className={`calendar-day ${!cell.isCurrentMonth ? 'calendar-day-other' : ''} ${cell.dateKey === todayKey ? 'calendar-day-today' : ''} ${cell.raids?.length ? 'calendar-day-has-raids' : ''}`}
            >
              {cell.day != null && <span className="calendar-day-num">{cell.day}</span>}
              {cell.raids?.length > 0 && (
                <div className="calendar-day-raids">
                  {cell.raids.slice(0, 3).map((r) => (
                    <Link key={r.raid_id} to={`/raids/${r.raid_id}`} className="calendar-raid-link" title={r.raid_name || r.raid_id}>
                      {r.raid_name || r.raid_id}
                    </Link>
                  ))}
                  {cell.raids.length > 3 && <span className="calendar-day-more">+{cell.raids.length - 3}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <h3 style={{ marginTop: '2rem', marginBottom: '0.5rem', fontSize: '1rem', color: '#a1a1aa' }}>Raids by month</h3>
      {raidsByMonth.map(({ key, label, raids: monthRaids }) => (
        <div key={key} className="card" style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ margin: '0 0 0.75rem 0', fontSize: '1.125rem', fontWeight: 600, color: '#a1a1aa' }}>
            {label}
          </h2>
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
              {monthRaids.map((r) => {
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
      ))}
    </div>
  )
}
