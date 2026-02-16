/**
 * Shown on pages that display loot assigned to characters. Assignments are
 * derived automatically from Magelo and heuristics and may be inaccurate.
 */
export default function AssignedLootDisclaimer({ compact = false }) {
  if (compact) {
    return (
      <p style={{ color: '#71717a', fontSize: '0.8125rem', marginTop: 0, marginBottom: '0.75rem' }}>
        “On toon” / assigned character is set automatically from Magelo data and best-effort rules; it may be wrong.
      </p>
    )
  }
  return (
    <p style={{ color: '#71717a', fontSize: '0.875rem', marginTop: 0, marginBottom: '0.5rem' }}>
      Per-character assignment is derived automatically from Magelo exports and from assumptions about which character received each item. These assignments are indicative only and may be inaccurate.
    </p>
  )
}
