/**
 * Configurable zone / phase / item / boss aliases for discovery parsing.
 * Zone aliases resolve to canonical zone strings used in raid_classifications / item_sources.
 */

/** @type {Record<string, string>} */
export const ZONE_ALIASES = {
  pof: 'Plane of Fire',
  'po fire': 'Plane of Fire',
  'plane of fire': 'Plane of Fire',
  fire: 'Plane of Fire',
  potime: 'Plane of Time',
  'po time': 'Plane of Time',
  'plane of time': 'Plane of Time',
  time: 'Plane of Time',
  pot: 'Plane of Time',
  pow: 'Plane of Water',
  'plane of water': 'Plane of Water',
  water: 'Plane of Water',
  poe: 'Plane of Earth',
  'plane of earth': 'Plane of Earth',
  earth: 'Plane of Earth',
  poa: 'Plane of Air',
  'plane of air': 'Plane of Air',
  air: 'Plane of Air',
  vt: 'Vex Thal',
  'vex thal': 'Vex Thal',
  vexthal: 'Vex Thal',
}

/** Phase labels are NOT zones. P3 ⊂ Plane of Time. */
export const PHASE_ALIASES = {
  p1: 'P1',
  'phase 1': 'P1',
  'phase one': 'P1',
  p3: 'P3',
  'phase 3': 'P3',
  'phase three': 'P3',
  'p3 guardian': 'P3 Guardian',
  'phase 3 guardian': 'P3 Guardian',
}

/** Mobs treated as Phase-3 identifiable loot labels (item_sources / classifications). */
export const P3_MOBS = Object.freeze(['P3', 'P3 Guardian'])

/** Placeholder / unreliable mob keys when they conflict with classification overrides. */
export const UNRELIABLE_MOB_KEYS = new Set([
  'a_deadly_warboar',
  'a deadly warboar',
  'a_raging_warboar',
  'a raging warboar',
  'wave 1',
  'wave1',
  'anar_of_water',
  'anar of water',
  'avatar_of_the_elements',
  'avatar of the elements',
])

/**
 * Item phrase aliases → preferred canonical name or constrained query tokens.
 * Constrained queries (slot/classes/phase) are resolved in resolve.js.
 * @type {Record<string, { name?: string, slot?: string, classesHint?: string, phase?: string }>}
 */
export const ITEM_ALIASES = {
  'caster shoulders': { slot: 'SHOULDERS', classesHint: 'caster', phase: 'P3' },
  'p3 caster shoulders': { name: 'Pauldrons of Purity', slot: 'SHOULDERS', classesHint: 'caster', phase: 'P3' },
  'pauldrons of purity': { name: 'Pauldrons of Purity' },
  ossein: { name: 'Ossein of Limitless Time' },
  'cloak of wishes': { name: 'Cloak of Wishes' },
}

/** Common boss display aliases → canonical mob string for classifications / sources. */
export const BOSS_ALIASES = {
  quarm: 'Quarm',
  fennin: 'Fennin_Ro_the_Tyrant_of_Fire',
  'fennin ro': 'Fennin_Ro_the_Tyrant_of_Fire',
  bertox: 'Bertoxxulous',
  bertoxxulous: 'Bertoxxulous',
  cazic: 'Cazic_Thule',
  'cazic thule': 'Cazic_Thule',
  innoruuk: 'Innoruuk',
  saryrn: 'Saryrn',
  tallon: 'Tallon_Zek',
  'tallon zek': 'Tallon_Zek',
  vallon: 'Vallon_Zek',
  'vallon zek': 'Vallon_Zek',
  tribunal: 'The_Tribunal',
  'the tribunal': 'The_Tribunal',
  rallos: 'Rallos_Zek',
  'rallos zek': 'Rallos_Zek',
}

export const CASTER_CLASS_TOKENS = new Set([
  'clr', 'dru', 'shm', 'nec', 'wiz', 'mag', 'enc',
  'cleric', 'druid', 'shaman', 'necromancer', 'wizard', 'magician', 'enchanter',
])

/**
 * @param {string} raw
 */
export function normAliasKey(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * @param {string} text
 * @returns {string|null}
 */
export function resolveZoneAlias(text) {
  const key = normAliasKey(text)
  if (!key) return null
  if (ZONE_ALIASES[key]) return ZONE_ALIASES[key]
  // Prefer longer alias keys contained as whole phrases
  const entries = Object.entries(ZONE_ALIASES).sort((a, b) => b[0].length - a[0].length)
  for (const [alias, zone] of entries) {
    if (alias.length < 3 && alias !== 'vt') continue
    if (new RegExp(`\\b${escapeRe(alias)}\\b`).test(key)) return zone
  }
  return null
}

/**
 * @param {string} text
 * @returns {string|null}
 */
export function resolvePhaseAlias(text) {
  const key = normAliasKey(text)
  if (!key) return null
  if (PHASE_ALIASES[key]) return PHASE_ALIASES[key]
  const entries = Object.entries(PHASE_ALIASES).sort((a, b) => b[0].length - a[0].length)
  for (const [alias, phase] of entries) {
    if (new RegExp(`\\b${escapeRe(alias)}\\b`).test(key)) return phase
  }
  return null
}

/**
 * @param {string} text
 * @returns {string|null}
 */
export function resolveBossAlias(text) {
  const key = normAliasKey(text)
  if (!key) return null
  if (BOSS_ALIASES[key]) return BOSS_ALIASES[key]
  const entries = Object.entries(BOSS_ALIASES).sort((a, b) => b[0].length - a[0].length)
  for (const [alias, boss] of entries) {
    if (new RegExp(`\\b${escapeRe(alias)}\\b`).test(key)) return boss
  }
  return null
}

/**
 * @param {string} text
 */
export function lookupItemAlias(text) {
  const key = normAliasKey(text)
  if (!key) return null
  if (ITEM_ALIASES[key]) return { ...ITEM_ALIASES[key], alias: key }
  const entries = Object.entries(ITEM_ALIASES).sort((a, b) => b[0].length - a[0].length)
  for (const [alias, spec] of entries) {
    if (new RegExp(`\\b${escapeRe(alias)}\\b`).test(key)) return { ...spec, alias }
  }
  return null
}

/**
 * @param {string} mob
 */
export function isPhaseMob(mob) {
  const n = normAliasKey(mob).replace(/_/g, ' ')
  return n === 'p1' || n === 'p3' || n === 'p3 guardian'
}

/**
 * @param {string} mob
 */
export function isUnreliableMob(mob) {
  return UNRELIABLE_MOB_KEYS.has(normAliasKey(mob).replace(/_/g, ' ')) ||
    UNRELIABLE_MOB_KEYS.has(normAliasKey(mob))
}

/**
 * Prefer classification / item_sources phase labels over conflicting dkp_mob_loot placeholders.
 * @param {Array<{ mob?: string, zone?: string }>} sources
 * @returns {{ mob?: string, zone?: string }|null}
 */
export function preferAuthoritativeSource(sources) {
  const list = Array.isArray(sources) ? sources.filter((s) => s?.mob || s?.zone) : []
  if (!list.length) return null
  const phase = list.find((s) => isPhaseMob(s.mob))
  if (phase) return phase
  const reliable = list.filter((s) => !isUnreliableMob(s.mob || ''))
  if (reliable.length === 1) return reliable[0]
  if (reliable.length > 1) {
    // Prefer populated zone
    const withZone = reliable.filter((s) => s.zone)
    return withZone[0] || reliable[0]
  }
  // Only unreliable sources — return null so callers qualify/omit boss
  return null
}

/**
 * Item names whose sources include a phase mob label (P3 / P3 Guardian / P1).
 * Phase labels in item_sources win even when unreliable mob rows also exist.
 * @param {Record<string, { displayName?: string, sources?: Array<{ mob?: string, zone?: string }> }>} knownItemSources
 * @param {string[]} phaseMobs
 * @returns {Set<string>}
 */
export function itemNamesForPhaseMobs(knownItemSources, phaseMobs = P3_MOBS) {
  const want = new Set(phaseMobs.map((m) => normAliasKey(m)))
  /** @type {Set<string>} */
  const out = new Set()
  for (const entry of Object.values(knownItemSources || {})) {
    const sources = entry?.sources || []
    const hit = sources.some((s) => want.has(normAliasKey(s.mob || '')))
    if (hit && entry.displayName) out.add(String(entry.displayName).trim())
  }
  return out
}

/**
 * Item names whose authoritative source zone matches (client-side join key for zone raids).
 * @param {Record<string, { displayName?: string, sources?: Array<{ mob?: string, zone?: string }> }>} knownItemSources
 * @param {string} zone
 * @returns {Set<string>}
 */
export function itemNamesForZone(knownItemSources, zone) {
  const want = normAliasKey(zone)
  /** @type {Set<string>} */
  const out = new Set()
  if (!want) return out
  for (const entry of Object.values(knownItemSources || {})) {
    if (!entry?.displayName) continue
    const auth = preferAuthoritativeSource(entry.sources || [])
    if (auth?.zone && normAliasKey(auth.zone) === want) {
      out.add(String(entry.displayName).trim())
      continue
    }
    // Phase-labeled Time items still count for Plane of Time zone joins
    const phaseHit = (entry.sources || []).some(
      (s) => isPhaseMob(s.mob) && normAliasKey(s.zone || '') === want,
    )
    if (phaseHit) out.add(String(entry.displayName).trim())
  }
  return out
}

/**
 * Item names whose authoritative source mob matches a boss (not unreliable placeholders).
 * @param {Record<string, { displayName?: string, sources?: Array<{ mob?: string, zone?: string }> }>} knownItemSources
 * @param {string} boss
 * @returns {Set<string>}
 */
export function itemNamesForBoss(knownItemSources, boss) {
  const want = normAliasKey(String(boss || '').replace(/_/g, ' '))
  /** @type {Set<string>} */
  const out = new Set()
  if (!want) return out
  for (const entry of Object.values(knownItemSources || {})) {
    const auth = preferAuthoritativeSource(entry.sources || [])
    if (!auth?.mob || !entry.displayName) continue
    if (normAliasKey(String(auth.mob).replace(/_/g, ' ')) === want) {
      out.add(String(entry.displayName).trim())
    }
  }
  return out
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
