import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'

const OFFICER_ADD_RAID_HASH = '#add-raid'
import { supabase } from '../lib/supabase'
import { fetchAll } from '../lib/accountData'
import { createCache } from '../lib/cache'
import { usePersistedState } from '../lib/usePersistedState'
import { useScrollContentReady } from '../lib/routeScrollView'
import { floorNowEastern, formatRaidSchedule } from '../lib/ticDateTime'

const CACHE_KEY_PREFIX = 'raids_month_v5_'
const CACHE_TTL = 15 * 60 * 1000 // 15 min per month

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function shiftIsoDate(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number)
  const utc = new Date(Date.UTC(y, m - 1, d))
  utc.setUTCDate(utc.getUTCDate() + days)
  return utc.toISOString().slice(0, 10)
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
  return { start: shiftIsoDate(start, -1), end: shiftIsoDate(end, 1) }
}

const CHUNK = 80

const ORDER_BY_ID = { order: { column: 'id', ascending: true } }
/** raid_attendance_dkp has no id column (PK is raid_id + character_key). */
const ORDER_BY_RAD_DKP = {
  order: { column: 'raid_id', ascending: true },
  order2: { column: 'character_key', ascending: true },
}

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

  const paidOutByRaid = {}
  const ticsByRaid = {}
  const spentByRaid = {}

  if (raids.length > 0) {
    const raidIds = raids.map((r) => String(r.raid_id).trim()).filter(Boolean)
    const [paidRows, eventRows, lootRows] = await Promise.all([
      (async () => {
        const rows = []
        for (let i = 0; i < raidIds.length; i += CHUNK) {
          const chunk = raidIds.slice(i, i + CHUNK)
          const { data, error: attErr } = await fetchAll(
            'raid_attendance_dkp',
            'raid_id, dkp_earned',
            (q) => q.in('raid_id', chunk),
            ORDER_BY_RAD_DKP
          )
          if (attErr) throw new Error(attErr.message || 'Failed to load raid attendance DKP')
          rows.push(...(data || []))
        }
        return rows
      })(),
      (async () => {
        const rows = []
        for (let i = 0; i < raidIds.length; i += CHUNK) {
          const chunk = raidIds.slice(i, i + CHUNK)
          const { data, error: evErr } = await fetchAll('raid_events', 'raid_id', (q) => q.in('raid_id', chunk), ORDER_BY_ID)
          if (evErr) throw new Error(evErr.message || 'Failed to load raid events')
          rows.push(...(data || []))
        }
        return rows
      })(),
      (async () => {
        const rows = []
        for (let i = 0; i < raidIds.length; i += CHUNK) {
          const chunk = raidIds.slice(i, i + CHUNK)
          const { data, error: lootErr } = await fetchAll('raid_loot', 'raid_id, cost', (q) => q.in('raid_id', chunk), ORDER_BY_ID)
          if (lootErr) throw new Error(lootErr.message || 'Failed to load raid loot')
          rows.push(...(data || []))
        }
        return rows
      })(),
    ])
    paidRows.forEach((row) => {
      const rid = String(row.raid_id ?? '').trim()
      if (!rid) return
      const v = parseFloat(row.dkp_earned || 0) || 0
      paidOutByRaid[rid] = (paidOutByRaid[rid] || 0) + v
    })
    eventRows.forEach((row) => {
      const rid = String(row.raid_id ?? '').trim()
      if (!rid) return
      ticsByRaid[rid] = (ticsByRaid[rid] || 0) + 1
    })
    lootRows.forEach((row) => {
      const rid = String(row.raid_id ?? '').trim()
      if (!rid) return
      const c = parseFloat(row.cost || 0) || 0
      spentByRaid[rid] = (spentByRaid[rid] || 0) + c
    })
  }

  const result = { raids, paidOutByRaid, ticsByRaid, spentByRaid }
  cache.set(result)
  return result
}

function mergeMonthData(arrays) {
  const raids = []
  const seen = new Set()
  const paidOutByRaid = {}
  const ticsByRaid = {}
  const spentByRaid = {}
  arrays.forEach(({ raids: r, paidOutByRaid: p, ticsByRaid: t, spentByRaid: s }) => {
    for (const raid of r) {
      const id = String(raid.raid_id ?? '')
      if (seen.has(id)) continue
      seen.add(id)
      raids.push(raid)
    }
    Object.assign(paidOutByRaid, p)
    Object.assign(ticsByRaid, t)
    Object.assign(spentByRaid, s)
  })
  return { raids, paidOutByRaid, ticsByRaid, spentByRaid }
}

/** Check if (y, m) is in the window months list. */
function isInWindow(windowMonths, year, month) {
  return windowMonths.some((wm) => wm.year === year && wm.month === month)
}

export default function Raids({ isOfficer }) {
  const zoneToday = useMemo(() => floorNowEastern(), [])
  const zoneYear = Number(zoneToday.date.slice(0, 4))
  const zoneMonth = Number(zoneToday.date.slice(5, 7))
  const [windowEndYear, setWindowEndYear] = usePersistedState('/raids:windowEndYear', zoneYear)
  const [windowEndMonth, setWindowEndMonth] = usePersistedState('/raids:windowEndMonth', zoneMonth)
  const [viewYear, setViewYear] = usePersistedState('/raids:viewYear', zoneYear)
  const [viewMonth, setViewMonth] = usePersistedState('/raids:viewMonth', zoneMonth)
  const [raids, setRaids] = useState([])
  const [paidOutByRaid, setPaidOutByRaid] = useState({})
  const [ticsByRaid, setTicsByRaid] = useState({})
  const [spentByRaid, setSpentByRaid] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useScrollContentReady(!loading)

  const windowMonths = useMemo(
    () => getWindowMonths(windowEndYear, windowEndMonth),
    [windowEndYear, windowEndMonth]
  )

  const isAtCurrentMonth = windowEndYear === zoneYear && windowEndMonth === zoneMonth

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
        setPaidOutByRaid(merged.paidOutByRaid)
        setTicsByRaid(merged.ticsByRaid)
        setSpentByRaid(merged.spentByRaid)
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
    setWindowEndYear(zoneYear)
    setWindowEndMonth(zoneMonth)
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

  const visibleRaids = useMemo(() => {
    const out = []
    for (const r of raids) {
      const schedule = formatRaidSchedule(r.date_iso || r.date)
      if (schedule.dateKey) {
        const [y, m] = schedule.dateKey.split('-').map(Number)
        if (!isInWindow(windowMonths, y, m)) continue
      }
      out.push({ ...r, schedule })
    }
    out.sort((a, b) => {
      const ai = a.schedule.sortKey || ''
      const bi = b.schedule.sortKey || ''
      if (bi !== ai) return bi.localeCompare(ai)
      return String(b.raid_id).localeCompare(String(a.raid_id))
    })
    return out
  }, [raids, windowMonths])

  const raidsByDate = useMemo(() => {
    const byDate = {}
    for (const r of visibleRaids) {
      const key = r.schedule.dateKey
      if (!key) continue
      if (!byDate[key]) byDate[key] = []
      byDate[key].push(r)
    }
    return byDate
  }, [visibleRaids])

  const todayKey = zoneToday.date

  const calendarGrid = useMemo(
    () => buildCalendarGrid(viewYear, viewMonth, raidsByDate),
    [viewYear, viewMonth, raidsByDate]
  )

  const jumpToMonthInputRef = useRef(null)

  const raidsByMonth = useMemo(() => {
    const map = new Map()
    for (const r of visibleRaids) {
      const iso = r.schedule.dateKey || ''
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
  }, [visibleRaids])

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
          <Link to={`/officer/RaidAdmin${OFFICER_ADD_RAID_HASH}`} className="btn btn-ghost" style={{ padding: '0.35rem 0.75rem', fontSize: '0.875rem', lineHeight: 1.2 }} title="Add raid">
            + Add Raid
          </Link>
        )}
      </div>
      <p style={{ color: '#71717a', marginBottom: '1rem' }}>
        One month shown; 3 months of data are loaded. Use <strong>← Older raids</strong> or click the month name below to pick a date and load raids. Use <strong>→</strong> / <strong>←</strong> to switch between the 3 loaded months.
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
              ref={jumpToMonthInputRef}
              type="month"
              value={`${windowEndYear}-${String(windowEndMonth).padStart(2, '0')}`}
              max={`${zoneYear}-${String(zoneMonth).padStart(2, '0')}`}
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
          <h2
            className="calendar-title"
            role="button"
            tabIndex={0}
            onClick={() => {
              const el = jumpToMonthInputRef.current
              if (!el) return
              if (typeof el.showPicker === 'function') el.showPicker()
              else el.click()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                const el = jumpToMonthInputRef.current
                if (el && typeof el.showPicker === 'function') el.showPicker()
                else el?.click()
              }
            }}
            style={{ cursor: 'pointer', userSelect: 'none' }}
            title="Click to pick a month and load raids"
          >
            {MONTH_NAMES[viewMonth - 1]} {viewYear}
          </h2>
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
                  <th>DKP paid out</th>
                  <th>Tics</th>
                  <th>DKP spent</th>
                  <th>Attendees</th>
                </tr>
              </thead>
              <tbody>
                {monthRaids.map((r) => {
                  const rid = String(r.raid_id ?? '').trim()
                  const paidOut = paidOutByRaid[rid] ?? 0
                  const tics = ticsByRaid[rid] ?? 0
                  const spent = spentByRaid[rid] ?? 0
                  return (
                    <tr key={r.raid_id} data-scroll-anchor={String(r.raid_id)}>
                      <td>{r.schedule?.label || r.date_iso || r.date || '—'}</td>
                      <td><Link to={`/raids/${r.raid_id}`}>{r.raid_name || r.raid_id}</Link></td>
                      <td>{Math.round(Number(paidOut))}</td>
                      <td>{tics}</td>
                      <td>{Math.round(Number(spent))}</td>
                      <td>{r.attendees != null && r.attendees !== '' ? Math.round(Number(r.attendees)) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ))
      )}
    </div>
  )
}
