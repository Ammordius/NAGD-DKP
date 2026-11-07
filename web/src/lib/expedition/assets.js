/**
 * Presentational Expedition sprites. Public URLs under /expedition/assets/.
 * Gameplay modules must not depend on this file.
 */

/** @type {Record<string, string>} */
const ENEMY_SPRITE_BY_ID = {
  guard_a: '/expedition/assets/plane-guard.png',
  guard_b: '/expedition/assets/plane-guard.png',
  trash_1: '/expedition/assets/air-wisp.png',
  trash_2: '/expedition/assets/earth-clod.png',
  trash_3: '/expedition/assets/fire-spark.png',
  mini: '/expedition/assets/overconfident-lieutenant.png',
  loot_boss: '/expedition/assets/loot-officer.png',
  loot_support: '/expedition/assets/junior-auditor.png',
  prep_a: '/expedition/assets/attrition-elemental.png',
  prep_b: '/expedition/assets/resource-leech.png',
  quarm: '/expedition/assets/quarm.png',
}

/**
 * Canonical class display name → public sprite path.
 * Keys match CLASS_ORDER in classDefinitions.js.
 * @type {Record<string, string>}
 */
const CLASS_SPRITE_BY_NAME = {
  Warrior: '/expedition/assets/classes/warrior.png',
  Paladin: '/expedition/assets/classes/paladin.png',
  'Shadow Knight': '/expedition/assets/classes/shadow-knight.png',
  Cleric: '/expedition/assets/classes/cleric.png',
  Druid: '/expedition/assets/classes/druid.png',
  Shaman: '/expedition/assets/classes/shaman.png',
  Enchanter: '/expedition/assets/classes/enchanter.png',
  Bard: '/expedition/assets/classes/bard.png',
  Wizard: '/expedition/assets/classes/wizard.png',
  Magician: '/expedition/assets/classes/magician.png',
  Necromancer: '/expedition/assets/classes/necromancer.png',
  Ranger: '/expedition/assets/classes/ranger.png',
  Rogue: '/expedition/assets/classes/rogue.png',
  Monk: '/expedition/assets/classes/monk.png',
  Beastlord: '/expedition/assets/classes/beastlord.png',
}

/** Lowercase name → canonical CLASS_SPRITE_BY_NAME key */
const CLASS_SPRITE_LOOKUP = Object.fromEntries(
  Object.keys(CLASS_SPRITE_BY_NAME).map((name) => [name.toLowerCase(), name]),
)

/** Encounter-scoped emoji fallbacks (used when no sprite or image fails). */
export const ENEMY_SYMBOLS = {
  entrance_guards: '🛡',
  endless_trash: '👻',
  mini_boss: '😈',
  loot_officer: '📋',
  final_prep: '🔥',
  quarm: '🐉',
}

/**
 * @param {{ id?: string }|null|undefined} enemy
 * @returns {string|null}
 */
export function resolveEnemySprite(enemy) {
  if (!enemy?.id) return null
  return ENEMY_SPRITE_BY_ID[enemy.id] || null
}

/**
 * @param {{ id?: string }|null|undefined} enemy
 * @param {string|null|undefined} encounterId
 * @returns {string}
 */
export function resolveEnemyFallbackSymbol(enemy, encounterId) {
  if (encounterId && ENEMY_SYMBOLS[encounterId]) return ENEMY_SYMBOLS[encounterId]
  if (enemy?.id === 'quarm') return ENEMY_SYMBOLS.quarm
  return '⚔'
}

/**
 * @param {{ id?: string }|null|undefined} enemy
 * @returns {boolean}
 */
export function isBossSprite(enemy) {
  return enemy?.id === 'quarm'
}

/**
 * Normalize a class display name for sprite lookup.
 * @param {string|null|undefined} className
 * @returns {string|null}
 */
export function normalizeClassSpriteName(className) {
  if (typeof className !== 'string') return null
  const trimmed = className.trim()
  if (!trimmed) return null
  return CLASS_SPRITE_LOOKUP[trimmed.toLowerCase()] || null
}

/**
 * Resolve a party class sprite URL.
 * Accepts a class name string or an object with `class_name` / `className`.
 * Unknown classes return null (UI falls back to class badge).
 *
 * @param {string|{ class_name?: string, className?: string }|null|undefined} classOrUnit
 * @returns {string|null}
 */
export function resolveClassSprite(classOrUnit) {
  const raw = typeof classOrUnit === 'string'
    ? classOrUnit
    : (classOrUnit?.class_name || classOrUnit?.className)
  const key = normalizeClassSpriteName(raw)
  if (!key) return null
  return CLASS_SPRITE_BY_NAME[key] || null
}
