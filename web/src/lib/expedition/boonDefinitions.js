/** Temporary run-only boons offered between encounters. */

/** @type {Array<{ id: string, name: string, description: string, risk: boolean, effect: Record<string, number> }>} */
export const BOONS = [
  {
    id: 'emergency_healing',
    name: 'Emergency Healing',
    description: 'Restore 40% HP to all living party members.',
    risk: false,
    effect: { healPct: 0.4 },
  },
  {
    id: 'better_weapons',
    name: 'Better Weapons',
    description: '+20% attack for the rest of the run.',
    risk: false,
    effect: { atkMult: 0.2 },
  },
  {
    id: 'defensive_formation',
    name: 'Defensive Formation',
    description: 'Take 20% less damage for the rest of the run.',
    risk: false,
    effect: { defMult: 0.2 },
  },
  {
    id: 'dubious_strategy',
    name: 'Dubious Strategy',
    description: '+35% attack but −15% defense for the rest of the run.',
    risk: true,
    effect: { atkMult: 0.35, defPenalty: 0.15 },
  },
  {
    id: 'mana_cookies',
    name: 'Mana Cookies',
    description: 'Reduce all special cooldowns by 2.',
    risk: false,
    effect: { cooldownRelief: 2 },
  },
  {
    id: 'bard_inspiration',
    name: 'Bard Inspiration',
    description: '+10% attack and +10 max HP for the rest of the run.',
    risk: false,
    effect: { atkMult: 0.1, maxHpFlat: 10 },
  },
  {
    id: 'glass_ambition',
    name: 'Glass Ambition',
    description: '+50% attack this next fight only; −25% max HP for the run.',
    risk: true,
    effect: { nextFightAtk: 0.5, maxHpPenaltyPct: 0.25 },
  },
  {
    id: 'med_break',
    name: 'Forced Med Break',
    description: 'Full heal, but enemy in the next fight starts with +15% HP.',
    risk: true,
    effect: { fullHeal: 1, nextEnemyHp: 0.15 },
  },
]

/**
 * Pick three distinct boons using rng().
 * @param {() => number} rng
 * @param {string[]} [excludeIds]
 */
export function pickBoonChoices(rng, excludeIds = []) {
  const pool = BOONS.filter((b) => !excludeIds.includes(b.id))
  const choices = []
  const used = new Set()
  let guard = 0
  while (choices.length < 3 && guard++ < 40 && pool.length) {
    const idx = Math.floor(rng() * pool.length)
    const b = pool[idx]
    if (used.has(b.id)) continue
    used.add(b.id)
    choices.push(b)
  }
  return choices
}

/**
 * @param {string} id
 */
export function getBoon(id) {
  return BOONS.find((b) => b.id === id) || null
}
