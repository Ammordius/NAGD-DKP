import { useEffect, useState, useMemo, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { usePersistedState } from '../lib/usePersistedState'
import ClassCoveragePills from '../components/ClassCoveragePills'
import {
  buildAccountCoverage,
  coverageRowsToMap,
  coverageToUpsertRows,
} from '../lib/classCoverage'
import {
  buildRaiderActivityRows,
  buildActivitySummary,
  buildWatchlists,
  filterAndSortRows,
  formatRaPercent,
  formatTrendDelta,
  formatAttendancePattern,
  STATUS_LABELS,
  STATUS_COLORS,
} from '../lib/raiderActivity'

const CLASS_RANKINGS_URL = import.meta.env.VITE_CLASS_RANKINGS_URL || '/class_rankings.json'

const PERIOD_OPTIONS = [
  { value: 30, label: '30 days' },
  { value: 60, label: '60 days' },
  { value: 90, label: '90 days' },
]

const SORT_OPTIONS = [
  { value: 'displayName', label: 'Name' },
  { value: 'ra30', label: 'Recent RA (30d)' },
  { value: 'trendDelta', label: 'Trend delta' },
  { value: 'lastAttended', label: 'Last attended' },
  { value: 'attendedCount', label: 'Raids attended' },
  { value: 'status', label: 'Status' },
]

function StatusBadge({ status }) {
  if (!status) return <span style={{ color: '#71717a' }}>—</span>
  const style = STATUS_COLORS[status] || { bg: '#27272a', color: '#a1a1aa' }
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0.15rem 0.5rem',
        borderRadius: '4px',
        fontSize: '0.8rem',
        fontWeight: 600,
        background: style.bg,
        color: style.color,
      }}
    >
      {status}
    </span>
  )
}

function TrendCell({ delta }) {
  const { text, direction } = formatTrendDelta(delta)
  if (direction === 'up') {
    return <span style={{ color: '#22c55e' }}>↑ {text}</span>
  }
  if (direction === 'down') {
    return <span style={{ color: '#f87171' }}>↓ {text}</span>
  }
  return <span style={{ color: '#71717a' }}>{text}</span>
}

function SummaryCard({ label, value, hint }) {
  return (
    <div
      className="card"
      style={{
        flex: '1 1 140px',
        minWidth: '140px',
        marginBottom: 0,
        padding: '0.75rem 1rem',
      }}
    >
      <div style={{ fontSize: '0.8rem', color: '#71717a', marginBottom: '0.25rem' }}>{label}</div>
      <div style={{ fontSize: '1.35rem', fontWeight: 700 }}>{value}</div>
      {hint ? (
        <div style={{ fontSize: '0.75rem', color: '#52525b', marginTop: '0.25rem' }}>{hint}</div>
      ) : null}
    </div>
  )
}

function WatchlistBlock({ title, rows, emptyText }) {
  return (
    <div className="card" style={{ flex: '1 1 220px', minWidth: '200px' }}>
      <h3 style={{ marginTop: 0, fontSize: '1rem' }}>{title}</h3>
      {rows.length === 0 ? (
        <p style={{ color: '#71717a', fontSize: '0.9rem', margin: 0 }}>{emptyText}</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.9rem' }}>
          {rows.map((r) => (
            <li key={r.accountId} style={{ marginBottom: '0.35rem' }}>
              <Link to={`/accounts/${encodeURIComponent(r.accountId)}`}>{r.displayName}</Link>
              {' '}
              <span style={{ color: '#71717a' }}>
                RA30 {formatRaPercent(r.ra30)}
                {r.trendDelta != null ? ` · Δ ${formatTrendDelta(r.trendDelta).text}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function OfficerRaiderActivity({ isOfficer }) {
  const navigate = useNavigate()
  const [snapshot, setSnapshot] = useState(null)
  const [coverageMap, setCoverageMap] = useState(() => new Map())
  const [coverageRefreshedAt, setCoverageRefreshedAt] = useState(null)
  const [coverageError, setCoverageError] = useState('')
  const [loading, setLoading] = useState(true)
  const [coverageLoading, setCoverageLoading] = useState(false)
  const [coverageRebuildLoading, setCoverageRebuildLoading] = useState(false)
  const [error, setError] = useState('')

  const [periodDays, setPeriodDays] = usePersistedState('/officer/raider-activity:periodDays', 90)
  const [search, setSearch] = usePersistedState('/officer/raider-activity:search', '')
  const [statusFilter, setStatusFilter] = usePersistedState('/officer/raider-activity:status', '')
  const [sortBy, setSortBy] = usePersistedState('/officer/raider-activity:sortBy', 'ra30')
  const [absentRaids, setAbsentRaids] = usePersistedState('/officer/raider-activity:absentRaids', 5)

  const loadCoverage = useCallback(async () => {
    setCoverageLoading(true)
    setCoverageError('')
    const { data, error: covErr } = await supabase
      .from('account_class_coverage')
      .select('account_id, main_char_id, classes, refreshed_at')
    setCoverageLoading(false)
    if (covErr) {
      const msg = covErr.message || 'Failed to load class coverage'
      if (msg.includes('account_class_coverage') || msg.includes('schema cache')) {
        setCoverageError(
          `${msg} — Deploy docs/supabase-account-class-coverage.sql, run CI build_account_class_coverage, then retry.`,
        )
      } else {
        setCoverageError(msg)
      }
      setCoverageMap(new Map())
      setCoverageRefreshedAt(null)
      return
    }
    const map = coverageRowsToMap(data || [])
    setCoverageMap(map)
    let latest = null
    for (const row of data || []) {
      const t = row.refreshed_at
      if (t && (!latest || t > latest)) latest = t
    }
    setCoverageRefreshedAt(latest)
  }, [])

  const loadData = useCallback(async () => {
    setLoading(true)
    setError('')
    const [activityRes] = await Promise.all([
      supabase.rpc('officer_raider_activity', {
        p_lookback_days: 120,
        p_absent_raid_count: Math.max(1, Number(absentRaids) || 5),
      }),
      loadCoverage(),
    ])
    setLoading(false)
    const { data, error: rpcErr } = activityRes
    if (rpcErr) {
      const msg = rpcErr.message || 'Failed to load raider activity'
      if (msg.includes('officer_raider_activity') || msg.includes('schema cache')) {
        setError(
          `${msg} — Deploy docs/supabase-officer-raider-activity.sql in Supabase SQL Editor, then retry.`,
        )
      } else {
        setError(msg)
      }
      setSnapshot(null)
      return
    }
    setSnapshot(data)
  }, [absentRaids, loadCoverage])

  const rebuildCoverageFromRankings = useCallback(async () => {
    setCoverageRebuildLoading(true)
    setCoverageError('')
    try {
      const rankingsRes = await fetch(CLASS_RANKINGS_URL)
      if (!rankingsRes.ok) {
        throw new Error(`Magelo rankings fetch failed: ${rankingsRes.status}`)
      }
      const rankingsData = await rankingsRes.json()
      const rankingsChars = rankingsData.characters || []

      const [{ data: links, error: linkErr }, { data: characters, error: charErr }] =
        await Promise.all([
          supabase.from('character_account').select('char_id, account_id'),
          supabase.from('characters').select('char_id, name, class_name'),
        ])
      if (linkErr) throw new Error(linkErr.message)
      if (charErr) throw new Error(charErr.message)

      const built = buildAccountCoverage({
        links: links || [],
        characters: characters || [],
        rankingsChars,
        spendByCharId: {},
      })
      const rows = coverageToUpsertRows(built)
      const rankingsHash = await crypto.subtle
        .digest('SHA-256', new TextEncoder().encode(JSON.stringify(rankingsData)))
        .then((buf) =>
          Array.from(new Uint8Array(buf))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
            .slice(0, 16),
        )

      const { error: upsertErr } = await supabase.rpc('officer_upsert_account_class_coverage', {
        p_payload: { rankings_hash: rankingsHash, rows },
      })
      if (upsertErr) {
        if (
          upsertErr.message?.includes('officer_upsert_account_class_coverage') ||
          upsertErr.message?.includes('schema cache')
        ) {
          throw new Error(
            `${upsertErr.message} — Deploy docs/supabase-account-class-coverage.sql in Supabase SQL Editor.`,
          )
        }
        throw new Error(upsertErr.message)
      }
      await loadCoverage()
    } catch (e) {
      setCoverageError(e.message || 'Failed to rebuild class coverage')
    } finally {
      setCoverageRebuildLoading(false)
    }
  }, [loadCoverage])

  useEffect(() => {
    if (!isOfficer) {
      navigate('/', { replace: true })
      return
    }
    loadData()
  }, [isOfficer, navigate, loadData])

  const computed = useMemo(() => {
    if (!snapshot) return null
    const now = new Date()
    const { rows, raidsSorted } = buildRaiderActivityRows(snapshot, { periodDays, now })
    const rosterIds = new Set((snapshot.roster_account_ids || []).map(String))
    const summary = buildActivitySummary(rows, rosterIds, raidsSorted, periodDays, now)
    const watchlists = buildWatchlists(rows, { absentRaids: Number(absentRaids) || 5, now, raidsSorted })
    const filtered = filterAndSortRows(rows, { search, statusFilter, sortBy }).map((r) => {
      const cov = coverageMap.get(String(r.accountId))
      return {
        ...r,
        classCoverage: cov?.classes || [],
      }
    })
    return { rows, raidsSorted, summary, watchlists, filtered, rosterIds }
  }, [snapshot, periodDays, search, statusFilter, sortBy, absentRaids, coverageMap])

  if (!isOfficer) return null

  if (loading && !snapshot) {
    return <div className="container">Loading raider activity…</div>
  }

  return (
    <div className="container">
      <h1>Raider Activity</h1>
      <p style={{ color: '#a1a1aa', marginBottom: '0.5rem' }}>
        Officer-only roster health by account (one row per raider/DKP account). Raid attendance % uses all guild raids in each window as eligible.
        {' '}
        <Link to="/officer">← Officer</Link>
      </p>
      <p style={{ color: '#71717a', fontSize: '0.85rem', marginBottom: '1rem' }}>
        Per-raid attendance is still visible on raid pages for all signed-in members; this page aggregates roster trends for officers.
      </p>

      {error && (
        <p className="error" style={{ marginBottom: '1rem' }}>
          {error}
          {' '}
          <button type="button" className="btn btn-ghost" onClick={loadData}>
            Retry
          </button>
        </p>
      )}

      {coverageError && (
        <p className="error" style={{ marginBottom: '1rem' }}>
          {coverageError}
          {' '}
          <button type="button" className="btn btn-ghost" onClick={loadCoverage} disabled={coverageLoading}>
            Retry coverage
          </button>
        </p>
      )}

      <p style={{ color: '#71717a', fontSize: '0.8rem', marginBottom: '1rem' }}>
        Class coverage (viable geared alts):{' '}
        {coverageRefreshedAt
          ? `updated ${new Date(coverageRefreshedAt).toLocaleString()}`
          : coverageLoading
            ? 'loading…'
            : 'not loaded yet — run CI or Reload coverage'}
        . Green = main toon; muted = alt. Thresholds: &gt;75% overall (&gt;85% PAL/WAR/SHD).
      </p>

      {computed && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
            <SummaryCard label="Tracked raiders" value={computed.summary.totalTracked} />
            <SummaryCard
              label="Active (30d)"
              value={computed.summary.activeLast30}
              hint="Roster with RA30 > 0 or raid in last 30d"
            />
            <SummaryCard label="Core" value={computed.summary.core} />
            <SummaryCard label="Rotational" value={computed.summary.rotational} />
            <SummaryCard label="At risk" value={computed.summary.atRisk} />
            <SummaryCard
              label="Avg raid size"
              value={
                computed.summary.avgRaidSize != null
                  ? computed.summary.avgRaidSize
                  : '—'
              }
              hint={`${periodDays}d period · ${computed.summary.periodRaidCount} raids`}
            />
          </div>

          <div
            className="card"
            style={{
              marginBottom: '1rem',
              display: 'flex',
              flexWrap: 'wrap',
              gap: '1rem',
              alignItems: 'center',
            }}
          >
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span>Period:</span>
              <select
                value={periodDays}
                onChange={(e) => setPeriodDays(Number(e.target.value))}
                style={{ padding: '0.35rem 0.5rem' }}
              >
                {PERIOD_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span>Absent if last</span>
              <input
                type="number"
                min={1}
                max={30}
                value={absentRaids}
                onChange={(e) => setAbsentRaids(Number(e.target.value) || 5)}
                style={{ width: '3rem', padding: '0.35rem 0.5rem' }}
              />
              <span>raids missed</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: '1 1 160px' }}>
              <span>Search:</span>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Raider name"
                style={{ flex: 1, padding: '0.35rem 0.5rem', minWidth: '120px' }}
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span>Status:</span>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                style={{ padding: '0.35rem 0.5rem' }}
              >
                <option value="">All</option>
                {STATUS_LABELS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span>Sort:</span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                style={{ padding: '0.35rem 0.5rem' }}
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn btn-ghost" onClick={loadData} disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={rebuildCoverageFromRankings}
              disabled={coverageRebuildLoading || coverageLoading}
              title="Fetch Magelo rankings once and update cached coverage in the database"
            >
              {coverageRebuildLoading ? 'Rebuilding coverage…' : 'Reload coverage'}
            </button>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', marginBottom: '1rem' }}>
            <WatchlistBlock
              title="Declining"
              rows={computed.watchlists.declining}
              emptyText="No declining raiders (long-term ≥70%, recent ≤50%)."
            />
            <WatchlistBlock
              title="Returning / ramping"
              rows={computed.watchlists.returning}
              emptyText="No returning raiders (long-term <50%, recent ≥70%)."
            />
            <WatchlistBlock
              title="Recently absent"
              rows={computed.watchlists.recentlyAbsent}
              emptyText="No tracked raiders absent 30d+ or last N raids."
            />
          </div>

          <div className="card" style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Raider</th>
                  <th title="Viable raid-ready classes from Magelo gear rankings">Class coverage</th>
                  <th>RA 30d</th>
                  <th>RA 60d</th>
                  <th>RA 90d</th>
                  <th>Trend</th>
                  <th>Last raid</th>
                  <th>
                    Attended ({periodDays}d)
                  </th>
                  <th>Status</th>
                  <th title="Last 10 guild raids">Recent</th>
                </tr>
              </thead>
              <tbody>
                {computed.filtered.length === 0 && (
                  <tr>
                    <td colSpan={10} style={{ color: '#71717a' }}>
                      No raiders match filters.
                    </td>
                  </tr>
                )}
                {computed.filtered.map((r) => (
                  <tr key={r.accountId}>
                    <td>
                      <Link to={`/accounts/${encodeURIComponent(r.accountId)}`}>
                        {r.displayName}
                      </Link>
                      {!r.isTracked ? (
                        <span style={{ color: '#52525b', fontSize: '0.75rem', marginLeft: '0.35rem' }}>
                          (off roster)
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <ClassCoveragePills classes={r.classCoverage} />
                    </td>
                    <td>{formatRaPercent(r.ra30)}</td>
                    <td>{formatRaPercent(r.ra60)}</td>
                    <td>{formatRaPercent(r.ra90)}</td>
                    <td>
                      <TrendCell delta={r.trendDelta} />
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {r.lastAttendedRaidDate || '—'}
                    </td>
                    <td>
                      {r.attendedCount}/{r.eligibleCount}
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td
                      style={{
                        fontFamily: 'monospace',
                        letterSpacing: '0.05em',
                        fontSize: '0.85rem',
                        color: '#a1a1aa',
                      }}
                      title="Last 10 raids (✓ attended)"
                    >
                      {formatAttendancePattern(r.recentAttendancePattern) || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
