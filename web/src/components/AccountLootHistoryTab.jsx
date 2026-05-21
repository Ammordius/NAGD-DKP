import { useMemo } from 'react'
import DkpLineChart from './DkpLineChart'
import {
  buildAccountDkpTimeSeries,
  formatChartMonthYear,
  formatInvestedChartFooter,
} from '../lib/accountDkpTimeSeries'
import { usePersistedState } from '../lib/usePersistedState'

const HISTORY_MONTH_OPTIONS = [
  { value: 12, label: 'Last 12 months' },
  { value: 24, label: 'Last 24 months' },
  { value: 36, label: 'Last 36 months' },
  { value: 0, label: 'All activity' },
]

const INVESTED_CHART_COLORS = ['#34d399', '#60a5fa', '#f472b6', '#fbbf24', '#c084fc']

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

  const { hasDatedRaids, netSeries, topCharCharts, investedWindowStats, chartBounds } = charts
  const windowSubtitle = chartWindowSubtitle(chartBounds)
  const investedFooter = formatInvestedChartFooter(investedWindowStats)

  const investedSeriesList = useMemo(
    () => topCharCharts.map((ch, i) => ({
      data: ch.series,
      valueKey: 'invested',
      label: ch.displayName,
      color: INVESTED_CHART_COLORS[i % INVESTED_CHART_COLORS.length],
    })),
    [topCharCharts],
  )

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

      {topCharCharts.length > 0 ? (
        <DkpLineChart
          series={investedSeriesList}
          title="DKP invested (account)"
          subtitle="Top characters by lifetime DKP spent on loot (up to 5)"
          yAxisLabel="DKP spent"
          rangeFooter={investedFooter}
        />
      ) : (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>DKP invested (account)</h3>
          <p style={{ color: '#71717a', fontSize: '0.875rem' }}>
            No characters on this account have more than 10 lifetime DKP spent.
          </p>
        </div>
      )}
    </div>
  )
}
