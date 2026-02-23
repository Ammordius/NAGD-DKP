/**
 * Shown on DKP leaderboard and account pages. The new site is under development;
 * users must use the old DKP site for current balance.
 */
export default function DkpSiteDisclaimer() {
  return (
    <p
      role="alert"
      style={{
        background: 'rgba(245, 158, 11, 0.15)',
        border: '1px solid rgba(245, 158, 11, 0.5)',
        borderRadius: '6px',
        color: '#fbbf24',
        fontSize: '0.875rem',
        margin: '0 0 1rem 0',
        padding: '0.75rem 1rem',
      }}
    >
      <strong>Under development.</strong> Please use the old DKP site for your current DKP balance. The information here may be out of date and should not be relied upon.
    </p>
  )
}
