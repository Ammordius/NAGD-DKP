export const DEFAULT_SITE_TITLE = 'NAGD DKP - Development'

function readSiteTitleEnv() {
  const env = import.meta.env
  const raw = env && env.VITE_SITE_TITLE
  return typeof raw === 'string' ? raw : ''
}

/** Browser tab title from VITE_SITE_TITLE, so each deployment can name itself. */
export function siteTitle() {
  const value = readSiteTitleEnv().trim()
  return value || DEFAULT_SITE_TITLE
}

/**
 * Live production only when the raw title contains "production".
 * Blank, unset, development, and staging titles are not production.
 */
export function isProductionSite(raw = readSiteTitleEnv()) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return /production/i.test(value)
}
