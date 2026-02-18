import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'

const OFFICER_ADD_RAID_HASH = '#add-raid'
import { supabase } from '../lib/supabase'
import { createCache } from '../lib/cache'

const CACHE_KEY_PREFIX = 'raids_month_'
const CACHE_TTL = 15 * 60 * 1000 // 15 min per month

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function getRaidDateKey(r) {
  const iso = (r.date_iso || r.date || '').toString().trim()
  return iso.length >= 10 ? iso.slice(0, 10) : null
}

/** Returns 3 (year, month) pairs for the window ending at endYear/endMonth, oldest first. */
function getWindowMonths(endYear, endMonth) {
  const out = []
  for (let i = 2; i >= 0; i--) {
    let y = endYear
    let m = endMonth - i
    while (m < 1) {
      m += 12
      y -= 1
    }
    while (m > 12) {
      m -= 12
      y += 1
    }
    out.push({ year: y, month: m })
  }
  return out
}

function buildCalendarGrid(year, month, raidsByDate) {
  const first = new Date(year, month - 1, 1)
  const last = new Date(year, month, 0)
  const startDow = first.getDay()
  const daysInMonth = last.getDate()
  const cells = []
  for (let i = 0; i < startDow; i++) cells.push({ dateKey: null, day: null, isCurrentMonth: false, raids: [] })
  for (let d = 1; d <= daysInMonth; d++) {
    const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    cells.push({ dateKey, day: d, isCurrentMonth: true, raids: raidsByDate[dateKey] || [] })
  }
  const trailing = 42 - cells.length
  for (let i = 0; i < trailing; i++) cells.push({ dateKey: null, day: null, isCurrentMonth: false, raids: [] })
  return cells
}

/** Start (inclusive) and end (exclusive) for a calendar month for date_iso text comparison. */
function getMonthRange(year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`
  let endYear = year
  let endMonth = month + 1
  if (endMonth > 12) {
    endMonth = 1
    endYear += 1
  }
  const end = `${endYear}-${String(endMonth).padStart(2, '0')}-01`
  return { start, end }
}

const CHUNK = 80

async function fetchOneMonth(year, month) {
  const cacheKey = `${CACHE_KEY_PREFIX}${year}_${month}`
  const cache = createCache(cacheKey, CACHE_TTL)
  const cached = cache.get()
  if (cached?.raids?.length !== undefined) {
    return cached
  }

  const { start, end } = getMonthRange(year, month)
  const { data: raidList, error } = await supabase
    .from('raids')
    .select('raid_id, raid_name, date_iso, date, attendees')
    .gte('date_iso', start)
    .lt('date_iso', end)
    .order('date_iso', { ascending: false })
    .order('raid_id', { ascending: false })

  if (error) throw new Error(error.message)
  const raids = raidList || []

  let eventsByRaid = {}
  let classificationsByRaid = {}

  if (raids.length > 0) {
    const raidIds = raids.map((r) => String(r.raid_id).trim()).filter(Boolean)
    const allEvents = []
    for (let i = 0; i < raidIds.length; i += CHUNK) {
      const chunk = raidIds.slice(i, i + CHUNK)
      const { data } = await supabase.from('raid_events').select('raid_id, dkp_value, event_order').in('raid_id', chunk)
      if (data?.length) allEvents.push(...data)
    }
    allEvents.forEach((ev) => {
      const rid = String(ev.raid_id ?? '').trim()
      if (!rid) return
      if (!eventsByRaid[rid]) eventsByRaid[rid] = { totalDkp: 0, events: [] }
      const v = parseFloat(ev.dkp_value || 0)
      eventsByRaid[rid].totalDkp += v
      eventsByRaid[rid].events.push({ ...ev, dkp_value: v })
    })

    const classPromises = []
    for (let i = 0; i < raidIds.length; i += CHUNK) {
      classPromises.push(
        supabase.from('raid_classifications').select('raid_id, mob, zone').in('raid_id', raidIds.slice(i, i + CHUNK))
      )
    }
    const classResponses = await Promise.all(classPromises)
    classResponses.forEach(({ data }) => {
      ;(data || []).forEach((row) => {
        const rid = String(row.raid_id ?? '').trim()
        if (!classificationsByRaid[rid]) classificationsByRaid[rid] = []
        classificationsByRaid[rid].push({ mob: row.mob, zone: row.zone })
      })
    })
  }

  const result = { raids, eventsByRaid, classificationsByRaid }
  cache.set(result)
  return result
}

function mergeMonthData(arrays) {
  const raids = []
  const eventsByRaid = {}
  const classificationsByRaid = {}
  arrays.forEach(({ raids: r, eventsByRaid: e, classificationsByRaid: c }) => {
    raids.push(...r)
    Object.assign(eventsByRaid, e)
    Object.assign(classificationsByRaid, c)
  })
  raids.sort((a, b) => {
    const ai = (a.date_iso || a.date || '').toString().trim()
    const bi = (b.date_iso || b.date || '').toString().trim()
    if (bi !== ai) return bi.localeCompare(ai)
    return String(b.raid_id).localeCompare(String(a.raid_id))
  })
  return { raids, eventsByRaid, classificationsByRaid }
}

/** Check if (y, m) is in the window months list. */
function isInWindow(windowMonths, year, month) {
  return windowMonths.some((wm) => wm.year === year && wm.month === month)
}

export default function Raids({ isOfficer }) {
  const now = useMemo(() => new Date(), [])
  const [windowEndYear, setWindowEndYear] = useState(now.getFullYear())
  const [windowEndMonth, setWindowEndMonth] = useState(now.getMonth() + 1)
  const [viewYear, setViewYear] = useState(now.getFullYear())
  const [viewMonth, setViewMonth] = useState(now.getMonth() + 1)
  const [raids, setRaids] = useState([])
  const [eventsByRaid, setEventsByRaid] = useState({})
  const [classificationsByRaid, setClassificationsByRaid] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const windowMonths = useMemo(
    () => getWindowMonths(windowEndYear, windowEndMonth),
    [windowEndYear, windowEndMonth]
  )

  const isAtCurrentMonth = windowEndYear === now.getFullYear() && windowEndMonth === now.getMonth() + 1

  const viewIndex = useMemo(() => {
    const i = windowMonths.findIndex((wm) => wm.year === viewYear && wm.month === viewMonth)
    return i >= 0 ? i : 2
  }, [windowMonths, viewYear, viewMonth])

  const canGoPrevMonth = viewIndex > 0
  const canGoNextMonth = viewIndex < 2

  const loadWindow = useCallback(
    async (endYear, endMonth) => {
      setLoading(true)
      setError('')
      const months = getWindowMonths(endYear, endMonth)
      try {
        const results = await Promise.all(months.map(({ year, month }) => fetchOneMonth(year, month)))
        const merged = mergeMonthData(results)
        setRaids(merged.raids)
        setEventsByRaid(merged.eventsByRaid)
        setClassificationsByRaid(merged.classificationsByRaid)
      } catch (err) {
        setError(err?.message || 'Failed to load raids')
      } finally {
        setLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    loadWindow(windowEndYear, windowEndMonth)
  }, [windowEndYear, windowEndMonth, loadWindow])

  useEffect(() => {
    if (windowMonths.length === 0) return
    if (!isInWindow(windowMonths, viewYear, viewMonth)) {
      const newest = windowMonths[2]
      setViewYear(newest.year)
      setViewMonth(newest.month)
    }
  }, [windowMonths, viewYear, viewMonth])

  const goOlder = () => {
    if (windowEndMonth === 1) {
      setWindowEndYear((y) => y - 1)
      setWindowEndMonth(12)
    } else {
      setWindowEndMonth((m) => m - 1)
    }
  }

  const goNewer = () => {
    if (windowEndMonth === 12) {
      setWindowEndYear((y) => y + 1)
      setWindowEndMonth(1)
    } else {
      setWindowEndMonth((m) => m + 1)
    }
  }

  const goToCurrentMonth = () => {
    setWindowEndYear(now.getFullYear())
    setWindowEndMonth(now.getMonth() + 1)
  }

  const goPrevMonth = () => {
    if (canGoPrevMonth) {
      const prev = windowMonths[viewIndex - 1]
      setViewYear(prev.year)
      setViewMonth(prev.month)
    }
  }

  const goNextMonth = () => {
    if (canGoNextMonth) {
      const next = windowMonths[viewIndex + 1]
      setViewYear(next.year)
      setViewMonth(next.month)
    }
  }

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

  const todayKey = useMemo(() => {
    const t = new Date()
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
  }, [])

  const calendarGrid = useMemo(
    () => buildCalendarGrid(viewYear, viewMonth, raidsByDate),
    [viewYear, viewMonth, raidsByDate]
  )

  const loadMoreRef = useRef(null)
  const [loadMoreVisible, setLoadMoreVisible] = useState(false)
  const prevLoadMoreVisibleRef = useRef(false)
  useEffect(() => {
    const el = loadMoreRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([e]) => setLoadMoreVisible(e.isIntersecting),
      { root: null, rootMargin: '100px', threshold: 0 }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])
  useEffect(() => {
    const justBecameVisible = loadMoreVisible && !prevLoadMoreVisibleRef.current
    prevLoadMoreVisibleRef.current = loadMoreVisible
    if (justBecameVisible && !loading) goOlder()
  }, [loadMoreVisible, loading])

  const raidsByMonth = useMemo(() => {
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
  }, [raids])

  if (loading && raids.length === 0)
    return (
      <div className="container">
        <h1 style={{ margin: 0 }}>Raids</h1>
        <p>Loading raids…</p>
      </div>
    )
  if (error && raids.length === 0)
    return (
      <div className="container">
        <h1 style={{ margin: 0 }}>Raids</h1>
        <span className="error">{error}</span>
      </div>
    )

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
      <p style={{ color: '#71717a', marginBottom: '1rem' }}>
        One month shown; 3 months of data are loaded. Use <strong>← Older raids</strong> at the top or scroll to the bottom of the page to go back in time. Use <strong>→</strong> / <strong>←</strong> to switch between the 3 loaded months.
      </p>

      {error && <p className="error" style={{ marginBottom: '1rem' }}>{error}</p>}

      <div className="raids-time-nav card" style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
          <button
            type="button"
            className="calendar-nav calendar-nav-wide"
            onClick={goOlder}
            disabled={loading}
            aria-label="Older raids (go back in time)"
          >
            ← Older raids
          </button>
          <span style={{ color: '#71717a', fontSize: '0.875rem' }}>|</span>
          <button
            type="button"
            className="calendar-nav calendar-nav-wide"
            onClick={goNewer}
            disabled={isAtCurrentMonth}
            aria-label="Newer raids"
            style={isAtCurrentMonth ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
          >
            Newer raids →
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.875rem', color: '#a1a1aa', marginLeft: '0.5rem' }}>
            <span>Jump to month:</span>
            <input
              type="month"
              value={`${windowEndYear}-${String(windowEndMonth).padStart(2, '0')}`}
              max={`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`}
              onChange={(e) => {
                const v = e.target.value
                if (!v) return
                const [y, m] = v.split('-').map(Number)
                if (y != null && m != null) {
                  setWindowEndYear(y)
                  setWindowEndMonth(m)
                }
              }}
              style={{ padding: '0.35rem 0.5rem', maxWidth: '160px' }}
            />
          </label>
          {!isAtCurrentMonth && (
            <button type="button" className="btn btn-ghost" onClick={goToCurrentMonth} style={{ fontSize: '0.875rem' }}>
              Show current month
            </button>
          )}
        </div>
      </div>

      <div className="calendar-wrap card" style={{ marginBottom: '1rem' }}>
        <div className="calendar-header">
          <button
            type="button"
            className="calendar-nav"
            onClick={goPrevMonth}
            disabled={!canGoPrevMonth}
            aria-label="Previous month"
            style={!canGoPrevMonth ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
          >
            ←
          </button>
          <h2 className="calendar-title">{MONTH_NAMES[viewMonth - 1]} {viewYear}</h2>
          <button
            type="button"
            className="calendar-nav"
            onClick={goNextMonth}
            disabled={!canGoNextMonth}
            aria-label="Next month"
            style={!canGoNextMonth ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
          >
            →
          </button>
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

      <div className="raids-load-more card" style={{ marginBottom: '1rem' }}>
        <div style={{ textAlign: 'center' }}>
          <button
            type="button"
            className="btn"
            onClick={goOlder}
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Load older raids'}
          </button>
          <p style={{ fontSize: '0.75rem', color: '#71717a', marginTop: '0.35rem', marginBottom: 0 }}>Or scroll to the bottom of the page to load more</p>
        </div>
      </div>

      <h3 style={{ marginTop: '2rem', marginBottom: '0.5rem', fontSize: '1rem', color: '#a1a1aa' }}>Raids by month</h3>
      {raidsByMonth.length === 0 ? (
        <p style={{ color: '#71717a' }}>No raids in this window.</p>
      ) : (
        raidsByMonth.map(({ key, label, raids: monthRaids }) => (
          <div key={key} className="card" style={{ marginBottom: '1.5rem' }}>
            <h2 style={{ margin: '0 0 0.75rem 0', fontSize: '1.125rem', fontWeight: 600, color: '#a1a1aa' }}>{label}</h2>
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
        ))
      )}

      <div ref={loadMoreRef} style={{ height: 20, marginTop: '2rem' }} aria-hidden />
    </div>
  )
}
