export const DEFAULT_SITE_TITLE = 'NAGD DKP - Development'

/** Browser tab title from VITE_SITE_TITLE, so each deployment can name itself. */
export function siteTitle() {
  const raw = import.meta.env.VITE_SITE_TITLE
  const value = typeof raw === 'string' ? raw.trim() : ''
  return value || DEFAULT_SITE_TITLE
}
