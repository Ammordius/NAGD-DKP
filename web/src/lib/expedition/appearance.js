/**
 * Cosmetic party appearance preference for Expedition.
 * Separate from save/scoring persistence.
 */

/** @typedef {'classic' | 'gnomes'} AppearanceMode */

export const APPEARANCE_PAGE_STATE_KEY = '/games/expedition:appearance'

/** @type {AppearanceMode} */
export const DEFAULT_APPEARANCE_MODE = 'classic'

/** @type {readonly AppearanceMode[]} */
export const APPEARANCE_MODES = Object.freeze(['classic', 'gnomes'])

/** @type {Record<AppearanceMode, string>} */
export const APPEARANCE_LABELS = Object.freeze({
  classic: 'Classic Adventurers',
  gnomes: 'Oops, All Gnomes!',
})

/**
 * @param {unknown} value
 * @returns {AppearanceMode}
 */
export function normalizeAppearanceMode(value) {
  if (value === 'gnomes' || value === 'classic') return value
  return DEFAULT_APPEARANCE_MODE
}

/**
 * @param {unknown} mode
 * @returns {boolean}
 */
export function isGnomeAppearance(mode) {
  return normalizeAppearanceMode(mode) === 'gnomes'
}
