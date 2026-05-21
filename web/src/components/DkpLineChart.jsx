// Parse YYYY-MM-DD to timestamp; invalid returns NaN
function parseDate(s) {
  if (!s || typeof s !== 'string') return NaN
  const t = new Date(s.trim().slice(0, 10)).getTime()
  return isNaN(t) ? NaN : t
}

// X ticks every 6 months for legibility; return [{ ts, label }]
function sixMonthTicks(minTs, maxTs) {
  if (minTs == null || maxTs == null || !Number.isFinite(minTs) || !Number.isFinite(maxTs) || maxTs <= minTs) return []
  const min = new Date(minTs)
  const max = new Date(maxTs)
  const ticks = []
  let y = min.getFullYear()
  let m = min.getMonth()
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  for (;;) {
    const d = new Date(y, m, 1)
    const ts = d.getTime()
    if (ts > maxTs) break
    if (ts >= minTs) ticks.push({ ts, label: `${monthNames[m]} ${y}` })
    m += 6
    if (m >= 12) { m -= 12; y += 1 }
  }
  if (ticks.length === 0) ticks.push({ ts: minTs, label: `${monthNames[min.getMonth()]} ${min.getFullYear()}` })
  return ticks
}

/**
 * Simple SVG line chart: linear X (date), linear Y (numeric value).
 * @param {Object} props
 * @param {{ date: string, [key: string]: number|string }[]} props.data
 * @param {string} props.valueKey - field on each point for Y value
 * @param {string} [props.title]
 * @param {string} [props.subtitle]
 * @param {number} [props.height]
 * @param {string} [props.strokeColor]
 * @param {string} [props.yAxisLabel]
 */
export default function DkpLineChart({
  data,
  valueKey,
  title,
  subtitle,
  height = 180,
  strokeColor = '#a78bfa',
  yAxisLabel = 'DKP',
}) {
  if (!data || data.length === 0) return null
  const values = data.map((d) => Number(d[valueKey]) || 0)
  const maxVal = Math.max(...values, 1)
  const minVal = Math.min(...values, 0)
  const range = maxVal - minVal || 1
  const w = 520
  const h = height
  const pad = { top: 12, right: 12, bottom: 28, left: 44 }
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

  const xTicks = sixMonthTicks(minTs, maxTs)
  const yTickCount = 5
  const yTicks = []
  for (let i = 0; i <= yTickCount; i++) {
    const t = minVal + (range * i) / yTickCount
    yTicks.push(Math.round(t))
  }
  const yTicksDedup = [...new Set(yTicks)].sort((a, b) => a - b)

  return (
    <div className="card" style={{ overflow: 'auto' }}>
      {title && <h3 style={{ marginTop: 0 }}>{title}</h3>}
      {subtitle && (
        <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginBottom: '0.5rem' }}>{subtitle}</p>
      )}
      <p style={{ color: '#71717a', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
        X = date · Y = {yAxisLabel} (cumulative)
      </p>
      <svg width={w} height={h} style={{ display: 'block' }}>
        {yTicksDedup.map((costVal) => {
          const y = yScale(costVal)
          return (
            <g key={costVal}>
              <line x1={pad.left} y1={y} x2={pad.left + innerW} y2={y} stroke="#27272a" strokeWidth="1" strokeDasharray="2,2" />
              <text x={pad.left - 6} y={y + 4} fill="#71717a" fontSize="10" textAnchor="end">{costVal}</text>
            </g>
          )
        })}
        {xTicks.map(({ ts, label }) => {
          const x = xScale(ts)
          return (
            <g key={label}>
              <line x1={x} y1={pad.top} x2={x} y2={pad.top + innerH} stroke="#27272a" strokeWidth="1" strokeDasharray="2,2" />
              <text x={x} y={h - 6} fill="#71717a" fontSize="10" textAnchor="middle">{label}</text>
            </g>
          )
        })}
        <polyline fill="none" stroke={strokeColor} strokeWidth="2" points={points} />
        {data.map((d, i) => {
          const ts = parseDate(d.date)
          const x = Number.isFinite(ts) ? xScale(ts) : pad.left
          const y = yScale(d[valueKey])
          return <circle key={i} cx={x} cy={y} r={4} fill={strokeColor} />
        })}
      </svg>
    </div>
  )
}
