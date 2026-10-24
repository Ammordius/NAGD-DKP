/** Visual ambiance themes. Purely presentational — no DKP logic. */

export const DEFAULT_THEME_ID = 'default'

export const AMBIANCE_PREFS_DEFAULTS = {
  ambianceEnabled: false,
  selectedTheme: DEFAULT_THEME_ID,
}

export const AMBIANCE_PAGE_STATE_KEY = '/site:ambiance'

const DEFAULT_THEME = {
  id: 'default',
  label: 'Default',
  backgroundImage: '/themes/default.jpg',
  primary: '#7c3aed',
  secondary: '#a78bfa',
  border: '#3f3f46',
  cardBackground: '#18181b',
  pageBackground: '#0f0f12',
  overlay: { color: '#0f0f12', opacity: 0, blendMode: 'normal' },
}

/** @type {Record<string, typeof DEFAULT_THEME>} */
export const THEMES = {
  default: DEFAULT_THEME,
  good: {
    id: 'good',
    label: 'Good',
    backgroundImage: '/themes/good.jpg',
    primary: '#ca8a04',
    buttonBackground: '#9a6903',
    secondary: '#fde68a',
    border: '#854d0e',
    cardBackground: 'rgba(28, 25, 23, 0.92)',
    pageBackground: '#1c1917',
    overlay: { color: '#1c1917', opacity: 0.72, blendMode: 'multiply' },
  },
  evil: {
    id: 'evil',
    label: 'Evil',
    backgroundImage: '/themes/evil.jpg',
    primary: '#dc2626',
    secondary: '#f87171',
    border: '#7f1d1d',
    cardBackground: 'rgba(23, 10, 12, 0.92)',
    pageBackground: '#170a0c',
    overlay: { color: '#450a0a', opacity: 0.75, blendMode: 'multiply' },
  },
  martial: {
    id: 'martial',
    label: 'Martial',
    backgroundImage: '/themes/martial.jpg',
    primary: '#92400e',
    secondary: '#d6b37a',
    border: '#5b4636',
    cardBackground: 'rgba(26, 20, 16, 0.92)',
    pageBackground: '#1a1410',
    overlay: { color: '#1a1410', opacity: 0.7, blendMode: 'multiply' },
  },
  enchanter: {
    id: 'enchanter',
    label: 'Enchanter',
    backgroundImage: '/themes/enchanter.jpg',
    primary: '#c026d3',
    secondary: '#f0abfc',
    border: '#86198f',
    cardBackground: 'rgba(24, 16, 32, 0.92)',
    pageBackground: '#181020',
    overlay: { color: '#4a044e', opacity: 0.7, blendMode: 'multiply' },
  },
  wizard: {
    id: 'wizard',
    label: 'Wizard',
    backgroundImage: '/themes/wizard.jpg',
    primary: '#2563eb',
    secondary: '#93c5fd',
    border: '#1e3a8a',
    cardBackground: 'rgba(15, 23, 42, 0.92)',
    pageBackground: '#0c1222',
    overlay: { color: '#1e3a8a', opacity: 0.68, blendMode: 'multiply' },
  },
  knight: {
    id: 'knight',
    label: 'Knight',
    backgroundImage: '/themes/knight.jpg',
    primary: '#d97706',
    buttonBackground: '#ae5f05',
    secondary: '#cbd5e1',
    border: '#64748b',
    cardBackground: 'rgba(24, 24, 27, 0.92)',
    pageBackground: '#18181b',
    overlay: { color: '#27272a', opacity: 0.68, blendMode: 'multiply' },
  },
  gnome: {
    id: 'gnome',
    label: 'Gnome',
    backgroundImage: '/themes/gnome.jpg',
    primary: '#b45309',
    secondary: '#5eead4',
    border: '#78716c',
    cardBackground: 'rgba(28, 25, 23, 0.92)',
    pageBackground: '#1c1917',
    overlay: { color: '#292524', opacity: 0.7, blendMode: 'multiply' },
  },
}

export const THEME_IDS = Object.keys(THEMES)

export function getTheme(id) {
  if (typeof id === 'string' && Object.prototype.hasOwnProperty.call(THEMES, id)) {
    return THEMES[id]
  }
  return THEMES[DEFAULT_THEME_ID]
}

export function normalizeAmbiancePrefs(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const selected =
    typeof src.selectedTheme === 'string' && Object.prototype.hasOwnProperty.call(THEMES, src.selectedTheme)
      ? src.selectedTheme
      : DEFAULT_THEME_ID
  return {
    ambianceEnabled: src.ambianceEnabled === true,
    selectedTheme: selected,
  }
}

/** Theme that should drive CSS: default when ambiance is off. */
export function resolveActiveTheme(prefs) {
  const normalized = normalizeAmbiancePrefs(prefs)
  if (!normalized.ambianceEnabled) return THEMES[DEFAULT_THEME_ID]
  return getTheme(normalized.selectedTheme)
}

function mixWithBlack(hex, portion) {
  const n = Number.parseInt(hex.slice(1), 16)
  const channel = (shift) => Math.round(((n >> shift) & 255) * portion)
    .toString(16)
    .padStart(2, '0')
  return `#${channel(16)}${channel(8)}${channel(0)}`
}

function buttonCssColors(theme) {
  const background = theme.buttonBackground || theme.primary || DEFAULT_THEME.primary
  const hover = theme.id === DEFAULT_THEME_ID ? '#6d28d9' : mixWithBlack(background, 0.82)
  return { background, hover }
}

export function themeToCssVars(theme) {
  const t = theme && typeof theme === 'object' ? theme : THEMES[DEFAULT_THEME_ID]
  const overlay = t.overlay && typeof t.overlay === 'object' ? t.overlay : DEFAULT_THEME.overlay
  const opacity = typeof overlay.opacity === 'number' ? overlay.opacity : 0
  const bgImage =
    typeof t.backgroundImage === 'string' && t.backgroundImage && opacity > 0
      ? `url(${t.backgroundImage})`
      : 'none'
  const buttons = buttonCssColors(t)
  return {
    '--dkp-page-bg': t.pageBackground || DEFAULT_THEME.pageBackground,
    '--dkp-card-bg': t.cardBackground || DEFAULT_THEME.cardBackground,
    '--dkp-nav-bg': t.cardBackground || DEFAULT_THEME.cardBackground,
    '--dkp-accent': t.primary || DEFAULT_THEME.primary,
    '--dkp-accent-secondary': t.secondary || DEFAULT_THEME.secondary,
    '--dkp-border': t.border || DEFAULT_THEME.border,
    '--dkp-btn-bg': buttons.background,
    '--dkp-btn-hover': buttons.hover,
    '--dkp-bg-image': bgImage,
    '--dkp-overlay-color': overlay.color || DEFAULT_THEME.overlay.color,
    '--dkp-overlay-opacity': String(opacity),
    '--dkp-overlay-blend': overlay.blendMode || 'normal',
  }
}

export function applyThemeCssVars(theme, root = typeof document !== 'undefined' ? document.documentElement : null) {
  if (!root || typeof root.style?.setProperty !== 'function') return
  const t = theme && typeof theme === 'object' ? theme : THEMES[DEFAULT_THEME_ID]
  const vars = themeToCssVars(t)
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value)
  }
  if (root.dataset) {
    root.dataset.ambianceTheme = t.id || DEFAULT_THEME_ID
  }
}

export function clearThemeCssVars(root = typeof document !== 'undefined' ? document.documentElement : null) {
  applyThemeCssVars(THEMES[DEFAULT_THEME_ID], root)
}
