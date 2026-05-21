// Parse YYYY-MM-DD to timestamp; invalid returns NaN
function parseDate(s) {
  if (!s || typeof s !== 'string') return NaN
  const t = new Date(s.trim().slice(0, 10)).getTime()
  return isNaN(t) ? NaN : t
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatTickLabel(ts) {
  const d = new Date(ts)
  return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`
}

// X ticks every 6 months; return [{ ts, label }]
function sixMonthTicks(minTs, maxTs) {
  if (minTs == null || maxTs == null || !Number.isFinite(minTs) || !Number.isFinite(maxTs) || maxTs <= minTs) return []
  const min = new Date(minTs)
  const max = new Date(maxTs)
  const ticks = []
  let y = min.getFullYear()
  let m = min.getMonth()
  for (;;) {
    const d = new Date(y, m, 1)
    const ts = d.getTime()
    if (ts > maxTs) break
    if (ts >= minTs) ticks.push({ ts, label: formatTickLabel(ts) })
    m += 6
    if (m >= 12) { m -= 12; y += 1 }
  }
  if (ticks.length === 0) ticks.push({ ts: minTs, label: formatTickLabel(minTs) })
  return ticks
}

function monthlyTicks(minTs, maxTs, maxCount = 8) {
  if (!Number.isFinite(minTs) || !Number.isFinite(maxTs) || maxTs <= minTs) return []
  const min = new Date(minTs)
  const max = new Date(maxTs)
  const rangeMonths = (max.getFullYear() - min.getFullYear()) * 12 + (max.getMonth() - min.getMonth())
  const step = Math.max(1, Math.ceil((rangeMonths + 1) / maxCount))
  const ticks = []
  let y = min.getFullYear()
  let m = min.getMonth()
  const seen = new Set()
  for (;;) {
    const d = new Date(y, m, 1)
    const ts = d.getTime()
    if (ts > maxTs) break
    if (ts >= minTs) {
      const label = formatTickLabel(ts)
      if (!seen.has(label)) {
        seen.add(label)
        ticks.push({ ts, label })
      }
    }
    m += step
    while (m >= 12) { m -= 12; y += 1 }
    if (y > max.getFullYear() + 1) break
  }
  if (ticks.length === 0) ticks.push({ ts: minTs, label: formatTickLabel(minTs) })
  return ticks
}

function quarterlyTicks(minTs, maxTs) {
  return monthlyTicks(minTs, maxTs, 8).filter((_, i, arr) => {
    if (arr.length <= 6) return true
    return i % 2 === 0 || i === arr.length - 1
  })
}

/** Adaptive X ticks from span: monthly (≤90d), quarterly (≤2y), else 6-month. */
function adaptiveDateTicks(minTs, maxTs) {
  const dayMs = 86400000
  const rangeDays = (maxTs - minTs) / dayMs
  if (rangeDays <= 90) return monthlyTicks(minTs, maxTs, 6)
  if (rangeDays <= 730) return quarterlyTicks(minTs, maxTs)
  return sixMonthTicks(minTs, maxTs)
}

function formatRangeFooter(data) {
  if (!data?.length) return null
  const dates = data.map((d) => d.date).filter(Boolean).sort()
  if (dates.length === 0) return null
  const first = dates[0].slice(0, 10)
  const last = dates[dates.length - 1].slice(0, 10)
  const n = data.length
  const fmt = (iso) => {
    const [y, mo] = iso.split('-').map(Number)
    return `${MONTH_NAMES[mo - 1]} ${y}`
  }
  if (first === last) return `${n} point${n !== 1 ? 's' : ''} · ${fmt(first)}`
  return `${n} point${n !== 1 ? 's' : ''} · ${fmt(first)} – ${fmt(last)}`
}

/**
 * Simple SVG line chart: linear X (date), linear Y (numeric value).
 */
export default function DkpLineChart({
  data,
  valueKey,
  title,
  subtitle,
  height = 200,
  strokeColor = '#a78bfa',
  yAxisLabel = 'DKP',
  legendLabel,
  legendNote,
}) {
  if (!data || data.length === 0) return null
  const values = data.map((d) => Number(d[valueKey]) || 0)
  const maxVal = Math.max(...values, 1)
  const minVal = Math.min(...values, 0)
  const range = maxVal - minVal || 1
  const w = 520
  const h = height
  const pad = { top: 12, right: 12, bottom: 36, left: 44 }
  const innerW = w - pad.left - pad.right
  const innerH = h - pad.top - pad.bottom

  const dates = data.map((d) => parseDate(d.date)).filter(Number.isFinite)
  const minTs = dates.length ? Math.min(...dates) : Date.now()
  const maxTs = dates.length ? Math.max(...dates) : Date.now()
  const timeRange = maxTs - minTs || 1

  const xScale = (ts) => pad.left + ((ts - minTs) / timeRange) * innerW
  const yScale = (val) => pad.top + innerH - ((Number(val) || 0) - minVal) / range * innerH

  const points = data.map((d) => {
    const ts = parseDate(d.date)
    const x = Number.isFinite(ts) ? xScale(ts) : pad.left
    const y = yScale(d[valueKey])
    return `${x},${y}`
  }).join(' ')

  const xTicks = adaptiveDateTicks(minTs, maxTs)
  const yTickCount = 5
  const yTicks = []
  for (let i = 0; i <= yTickCount; i++) {
    const t = minVal + (range * i) / yTickCount
    yTicks.push(Math.round(t))
  }
  const yTicksDedup = [...new Set(yTicks)].sort((a, b) => a - b)
  const showMarkers = data.length <= 30
  const rangeFooter = formatRangeFooter(data)
  const label = legendLabel || yAxisLabel

  return (
    <div className="card" style={{ overflow: 'auto', maxWidth: '100%' }}>
      {title && <h3 style={{ marginTop: 0 }}>{title}</h3>}
      {subtitle && (
        <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginBottom: '0.5rem' }}>{subtitle}</p>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          marginBottom: '0.5rem',
          fontSize: '0.875rem',
          color: '#d4d4d8',
        }}
        aria-label={`Legend: ${label}`}
      >
        <span
          style={{
            display: 'inline-block',
            width: 14,
            height: 14,
            borderRadius: 2,
            background: strokeColor,
            flexShrink: 0,
          }}
        />
        <span>{label}</span>
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
        aria-label={`${label} over time`}
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
        <polyline fill="none" stroke={strokeColor} strokeWidth="2" points={points} />
        {showMarkers && data.map((d, i) => {
          const ts = parseDate(d.date)
          const x = Number.isFinite(ts) ? xScale(ts) : pad.left
          const y = yScale(d[valueKey])
          return <circle key={i} cx={x} cy={y} r={4} fill={strokeColor} />
        })}
      </svg>
      {rangeFooter && (
        <p style={{ color: '#52525b', fontSize: '0.75rem', marginTop: '0.35rem', marginBottom: 0 }}>
          {rangeFooter}
        </p>
      )}
    </div>
  )
}
