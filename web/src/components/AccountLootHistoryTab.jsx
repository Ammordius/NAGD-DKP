import { useMemo } from 'react'
import DkpLineChart from './DkpLineChart'
import { buildAccountDkpTimeSeries } from '../lib/accountDkpTimeSeries'

export default function AccountLootHistoryTab({ activityByRaid, dkpByCharacterKey, characters }) {
  const charts = useMemo(
    () => buildAccountDkpTimeSeries(activityByRaid, characters, dkpByCharacterKey),
    [activityByRaid, characters, dkpByCharacterKey],
  )

  const { hasDatedRaids, netSeries, investedSeries, topCharCharts } = charts

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
      <p style={{ color: '#a1a1aa', fontSize: '0.875rem', margin: 0 }}>
        Cumulative DKP from raid dates on this account. Net = earned minus spent on loot attributed to this account.
      </p>

      {netSeries.length > 0 && (
        <DkpLineChart
          data={netSeries}
          valueKey="net"
          title="Net DKP over time"
          subtitle="Running balance (earned − spent) after each raid"
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
                  strokeColor="#60a5fa"
                  yAxisLabel="DKP spent"
                />
              ) : (
                <div key={ch.canonical} className="card">
                  <h3 style={{ marginTop: 0 }}>{ch.displayName}</h3>
                  <p style={{ color: '#71717a', fontSize: '0.875rem' }}>
                    Lifetime spent {Math.round(ch.lifetimeSpent)} DKP — no dated loot events to plot.
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
