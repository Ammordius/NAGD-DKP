import { isProductionSite } from '../lib/siteTitle'

/**
 * Shown on the DKP leaderboard and account pages when this deployment is not production.
 */
export default function DkpSiteDisclaimer() {
  if (isProductionSite()) return null
  return (
    <p role="alert" className="dkp-site-disclaimer">
      <strong>!DEVELOPMENT / MIRROR SITE!</strong> This is not the live Production site! Your DKP balance and other information may be inaccurate and should not be relied upon.
    </p>
  )
}
