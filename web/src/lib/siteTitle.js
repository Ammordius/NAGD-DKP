export const DEFAULT_SITE_TITLE = 'NAGD DKP - Development'

const SITE_ENVS = new Set(['production', 'staging', 'development'])

function readEnvString(name) {
  const env = import.meta.env
  const raw = env && env[name]
  return typeof raw === 'string' ? raw : ''
}

function readSiteTitleEnv() {
  return readEnvString('VITE_SITE_TITLE')
}

function readSiteEnv() {
  return readEnvString('VITE_SITE_ENV')
}

/** Browser tab title from VITE_SITE_TITLE, so each deployment can name itself. */
export function siteTitle() {
  const value = readSiteTitleEnv().trim()
  return value || DEFAULT_SITE_TITLE
}

/**
 * Live production only when VITE_SITE_ENV is exactly "production".
 * Missing, blank, invalid, staging, and development are not production.
 * VITE_SITE_TITLE is display text only and does not affect this.
 */
export function isProductionSite(raw = readSiteEnv()) {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return value === 'production' && SITE_ENVS.has(value)
}

const PAGE_TITLES = {
  '/': 'Home',
  '/login': 'Sign in',
  '/auth/callback': 'Signing in',
  '/dkp': 'DKP',
  '/accounts': 'Game Accounts',
  '/raids': 'Raids',
  '/mobs': 'Raid Items',
  '/loot': 'Item History',
  '/loot-recipients': 'Character History',
  '/profile': 'My Site Profile',
  '/officer': 'Raid Admin',
  '/officer/RaidAdmin': 'Raid Admin',
  '/officer/dkp-changelog': 'DKP changelog',
  '/officer/who-parser': 'Officer /who parser',
  '/officer/claim-cooldowns': 'Site Admin',
  '/officer/SiteAdmin': 'Site Admin',
  '/officer/raider-activity': 'Raider Activity',
  '/tools/discord-schedule': 'Discord raid schedule',
}

function pageLabel(pathname) {
  const path = typeof pathname === 'string' ? pathname : ''
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  if (PAGE_TITLES[normalized]) return PAGE_TITLES[normalized]
  if (normalized.startsWith('/raids/')) return 'Raid'
  if (normalized.startsWith('/accounts/')) return 'Account'
  if (normalized.startsWith('/items/')) return 'Item'
  if (normalized.startsWith('/characters/')) return 'Character'
  return 'Page not found'
}

/** Tab title for a route, with the deployment name as the suffix. */
export function documentTitleForPath(pathname, title = siteTitle()) {
  return `${pageLabel(pathname)} · ${title}`
}
