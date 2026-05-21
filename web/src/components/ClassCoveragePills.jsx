import { CLASS_ORDER } from '../lib/classCoverage'

/**
 * Compact class abbrev pills for raider roster flexibility.
 * @param {{ classes?: Array<{ abbrev: string, class_name?: string, gear_pct?: number, is_main?: boolean, char_name?: string }> }} props
 */
export default function ClassCoveragePills({ classes = [] }) {
  if (!classes.length) {
    return <span style={{ color: '#52525b', fontSize: '0.8rem' }}>—</span>
  }

  const sorted = [...classes].sort(
    (a, b) =>
      CLASS_ORDER.indexOf(a.abbrev) - CLASS_ORDER.indexOf(b.abbrev) ||
      String(a.abbrev).localeCompare(String(b.abbrev)),
  )

  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '0.25rem', alignItems: 'center' }}>
      {sorted.map((c) => {
        const main = c.is_main === true
        const label = (c.abbrev || '').trim() || '—'
        const tip = [
          c.class_name || label,
          c.gear_pct != null ? `${c.gear_pct}%` : null,
          c.char_name ? `(${c.char_name}${main ? ', main' : ', alt'})` : main ? '(main)' : '(alt)',
        ]
          .filter(Boolean)
          .join(' ')

        return (
          <span
            key={`${label}-${c.char_id || c.char_name || ''}`}
            title={tip}
            style={{
              display: 'inline-block',
              padding: '0.1rem 0.35rem',
              borderRadius: '4px',
              fontSize: '0.72rem',
              fontWeight: 700,
              letterSpacing: '0.02em',
              lineHeight: 1.3,
              background: main ? '#166534' : '#3f3f46',
              color: main ? '#bbf7d0' : '#a1a1aa',
              border: main ? '1px solid #22c55e' : '1px solid #52525b',
            }}
          >
            {label}
          </span>
        )
      })}
    </span>
  )
}
