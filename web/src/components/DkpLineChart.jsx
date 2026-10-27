import { adaptiveDateTicks } from '../lib/chartDateTicks.js'

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Parse YYYY-MM-DD to timestamp; invalid returns NaN
function parseDate(s) {
  if (!s || typeof s !== 'string') return NaN
  const t = new Date(s.trim().slice(0, 10)).getTime()
  return isNaN(t) ? NaN : t
}

function formatIsoMonthYear(iso) {
  const [y, mo] = iso.slice(0, 10).split('-').map(Number)
  return `${MONTH_NAMES[mo - 1]} ${y}`
}

/** Date range only (no point count). */
function formatDateRangeFooter(dataOrDates) {
  const dates = Array.isArray(dataOrDates) && dataOrDates[0]?.date == null
    ? dataOrDates
    : (dataOrDates || []).map((d) => d.date).filter(Boolean).map((d) => d.slice(0, 10)).sort()
  if (dates.length === 0) return null
  const first = dates[0]
  const last = dates[dates.length - 1]
  if (first === last) return formatIsoMonthYear(first)
  return `${formatIsoMonthYear(first)} – ${formatIsoMonthYear(last)}`
}

function buildPolylinePoints(data, valueKey, xScale, yScale, padLeft) {
  return data.map((d) => {
    const ts = parseDate(d.date)
    const x = Number.isFinite(ts) ? xScale(ts) : padLeft
    const y = yScale(d[valueKey])
    return `${x},${y}`
  }).join(' ')
}

function computeChartScales(seriesInputs, valueKey) {
  const allDates = []
  const allValues = []
  for (const { data } of seriesInputs) {
    for (const d of data || []) {
      const ts = parseDate(d.date)
      if (Number.isFinite(ts)) allDates.push(ts)
      allValues.push(Number(d[valueKey]) || 0)
    }
  }
  if (allDates.length === 0) return null

  const minTs = Math.min(...allDates)
  const maxTs = Math.max(...allDates)
  const minVal = 0
  const maxVal = Math.max(...allValues, 1)
  const range = maxVal - minVal || 1
  const timeRange = maxTs - minTs || 1

  return { minTs, maxTs, minVal, maxVal, range, timeRange }
}

/**
 * Simple SVG line chart: linear X (date), linear Y (numeric value).
 * Single series: data + valueKey. Multi: series=[{ data, valueKey, label, color }].
 */
export default function DkpLineChart({
  data,
  valueKey,
  series,
  title,
  subtitle,
  height = 200,
  strokeColor = '#a78bfa',
  yAxisLabel = 'DKP',
  legendLabel,
  legendNote,
  rangeFooter,
}) {
  const isMulti = Array.isArray(series) && series.length > 0
  const seriesInputs = isMulti
    ? series.filter((s) => s.data?.length > 0)
    : data?.length
      ? [{ data, valueKey, label: legendLabel || yAxisLabel, color: strokeColor }]
      : []

  if (seriesInputs.length === 0) return null

  const vk = isMulti ? (seriesInputs[0].valueKey || 'invested') : valueKey
  const scales = computeChartScales(seriesInputs, vk)
  if (!scales) return null

  const { minTs, maxTs, minVal, maxVal, range, timeRange } = scales
  const w = 520
  const h = height
  const pad = { top: 12, right: 12, bottom: 36, left: 44 }
  const innerW = w - pad.left - pad.right
  const innerH = h - pad.top - pad.bottom

  const xScale = (ts) => pad.left + ((ts - minTs) / timeRange) * innerW
  const yScale = (val) => pad.top + innerH - ((Number(val) || 0) - minVal) / range * innerH

  const xTicks = adaptiveDateTicks(minTs, maxTs)
  const yTickCount = 5
  const yTicks = []
  for (let i = 0; i <= yTickCount; i++) {
    const t = minVal + (range * i) / yTickCount
    yTicks.push(Math.round(t))
  }
  const yTicksDedup = [...new Set(yTicks)].sort((a, b) => a - b)

  const totalPoints = seriesInputs.reduce((n, s) => n + (s.data?.length || 0), 0)
  const showMarkers = !isMulti && totalPoints <= 30

  const footerText = rangeFooter
    ?? (isMulti
      ? null
      : formatDateRangeFooter(seriesInputs[0].data))

  const ariaSeriesLabels = seriesInputs.map((s) => s.label).join(', ')

  return (
    <div className="card" style={{ overflow: 'auto', maxWidth: '100%' }}>
      {title && <h3 style={{ marginTop: 0 }}>{title}</h3>}
      {subtitle && (
        <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginBottom: '0.5rem' }}>{subtitle}</p>
      )}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '0.5rem 1rem',
          marginBottom: '0.5rem',
          fontSize: '0.875rem',
          color: '#d4d4d8',
        }}
        aria-label={`Legend: ${ariaSeriesLabels}`}
      >
        {seriesInputs.map((s) => (
          <span
            key={s.label}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 14,
                height: 14,
                borderRadius: 2,
                background: s.color,
                flexShrink: 0,
              }}
            />
            <span>{s.label}</span>
          </span>
        ))}
        {legendNote && (
          <span style={{ color: '#71717a', fontSize: '0.8rem' }}>{legendNote}</span>
        )}
      </div>
      <p style={{ color: '#71717a', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
        X = date · Y = {yAxisLabel} (cumulative)
      </p>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        width="100%"
        height={h}
        style={{ display: 'block', maxWidth: w }}
        role="img"
        aria-label={`${ariaSeriesLabels} over time`}
      >
        {yTicksDedup.map((costVal) => {
          const y = yScale(costVal)
          return (
            <g key={costVal}>
              <line x1={pad.left} y1={y} x2={pad.left + innerW} y2={y} stroke="#27272a" strokeWidth="1" strokeDasharray="2,2" />
              <text x={pad.left - 6} y={y + 4} fill="#71717a" fontSize="10" textAnchor="end">{costVal}</text>
            </g>
          )
        })}
        {xTicks.map(({ ts, label: tickLabel }) => (
          <g key={`${ts}-${tickLabel}`}>
            <line x1={xScale(ts)} y1={pad.top} x2={xScale(ts)} y2={pad.top + innerH} stroke="#27272a" strokeWidth="1" strokeDasharray="2,2" />
            <text x={xScale(ts)} y={h - 8} fill="#71717a" fontSize="10" textAnchor="middle">{tickLabel}</text>
          </g>
        ))}
        {seriesInputs.map((s) => {
          const key = s.label
          const vkLocal = s.valueKey || vk
          const points = buildPolylinePoints(s.data, vkLocal, xScale, yScale, pad.left)
          return (
            <g key={key}>
              <polyline fill="none" stroke={s.color} strokeWidth="2" points={points} />
              {showMarkers && s.data.map((d, i) => {
                const ts = parseDate(d.date)
                const x = Number.isFinite(ts) ? xScale(ts) : pad.left
                const y = yScale(d[vkLocal])
                return <circle key={i} cx={x} cy={y} r={4} fill={s.color} />
              })}
            </g>
          )
        })}
      </svg>
      {footerText && (
        <p style={{ color: '#52525b', fontSize: '0.75rem', marginTop: '0.35rem', marginBottom: 0 }}>
          {footerText}
        </p>
      )}
    </div>
  )
}
