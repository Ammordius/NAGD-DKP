import { useMemo } from 'react'
import DkpLineChart from './DkpLineChart'
import {
  buildAccountDkpTimeSeries,
  formatChartMonthYear,
} from '../lib/accountDkpTimeSeries'
import { usePersistedState } from '../lib/usePersistedState'

const HISTORY_MONTH_OPTIONS = [
  { value: 12, label: 'Last 12 months' },
  { value: 24, label: 'Last 24 months' },
  { value: 36, label: 'Last 36 months' },
  { value: 0, label: 'All activity' },
]

function chartWindowSubtitle(chartBounds) {
  const { start, end, months } = chartBounds || {}
  if (!start || !end) return null
  const range = `${formatChartMonthYear(start)} – ${formatChartMonthYear(end)}`
  if (!months || months === 0) {
    return `Charts: all account activity (${range})`
  }
  return `Charts: last ${months} months of account activity (${range})`
}

export default function AccountLootHistoryTab({ activityByRaid, dkpByCharacterKey, characters }) {
  const [months, setMonths] = usePersistedState('/accounts/history:months', 12)

  const charts = useMemo(
    () => buildAccountDkpTimeSeries(activityByRaid, characters, dkpByCharacterKey, { months }),
    [activityByRaid, characters, dkpByCharacterKey, months],
  )

  const { hasDatedRaids, netSeries, investedSeries, topCharCharts, chartBounds } = charts
  const windowSubtitle = chartWindowSubtitle(chartBounds)

  if (!hasDatedRaids) {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Loot history</h2>
        <p style={{ color: '#71717a' }}>No raid history to chart yet.</p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#a1a1aa', fontSize: '0.875rem' }}>
          Chart window
          <select
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
            style={{ padding: '0.35rem 0.5rem' }}
          >
            {HISTORY_MONTH_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      </div>
      {windowSubtitle && (
        <p style={{ color: '#71717a', fontSize: '0.875rem', margin: 0 }}>{windowSubtitle}</p>
      )}
      <p style={{ color: '#a1a1aa', fontSize: '0.875rem', margin: 0 }}>
        Cumulative DKP from raids with earn, tic, or loot on this account. Net = earned minus spent on loot attributed to this account.
      </p>

      {netSeries.length > 0 && (
        <DkpLineChart
          data={netSeries}
          valueKey="net"
          title="Net DKP over time"
          subtitle="Running balance (earned − spent) after each raid"
          legendLabel="Net DKP (cumulative)"
          strokeColor="#a78bfa"
          yAxisLabel="Net DKP"
        />
      )}

      {investedSeries.length > 0 && (
        <DkpLineChart
          data={investedSeries}
          valueKey="invested"
          title="DKP invested (account)"
          subtitle="Total DKP spent on loot for all characters on this account"
          legendLabel="DKP spent (cumulative)"
          strokeColor="#34d399"
          yAxisLabel="DKP spent"
        />
      )}

      {topCharCharts.length > 0 ? (
        <div>
          <h2 style={{ marginTop: 0, marginBottom: '0.75rem', fontSize: '1.125rem' }}>DKP invested by character</h2>
          <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginBottom: '1rem' }}>
            Top characters with more than 10 lifetime DKP spent (up to 5).
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {topCharCharts.map((ch) => (
              ch.series.length > 0 ? (
                <DkpLineChart
                  key={ch.canonical}
                  data={ch.series}
                  valueKey="invested"
                  title={ch.displayName}
                  subtitle={`Lifetime spent: ${Math.round(ch.lifetimeSpent)} DKP`}
                  legendLabel={`${ch.displayName} — DKP spent (cumulative)`}
                  strokeColor="#60a5fa"
                  yAxisLabel="DKP spent"
                />
              ) : (
                <div key={ch.canonical} className="card">
                  <h3 style={{ marginTop: 0 }}>{ch.displayName}</h3>
                  <p style={{ color: '#71717a', fontSize: '0.875rem' }}>
                    Lifetime spent {Math.round(ch.lifetimeSpent)} DKP — no dated loot events in this window.
                  </p>
                </div>
              )
            ))}
          </div>
        </div>
      ) : (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>DKP invested by character</h3>
          <p style={{ color: '#71717a', fontSize: '0.875rem' }}>
            No characters on this account have more than 10 lifetime DKP spent.
          </p>
        </div>
      )}
    </div>
  )
}
