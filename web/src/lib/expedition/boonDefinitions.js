/** Temporary run-only boons. */

export const BOONS = [
  { id: 'emergency_healing', name: 'Emergency Healing', description: 'Restore 40% HP to living party.', risk: false, effect: { healPct: 0.4 } },
  { id: 'better_weapons', name: 'Better Weapons', description: '+20% attack for the run.', risk: false, effect: { atkMult: 0.2 } },
  { id: 'defensive_formation', name: 'Defensive Formation', description: '+20% damage reduction buff value.', risk: false, effect: { defMult: 0.2 } },
  { id: 'dubious_strategy', name: 'Dubious Strategy', description: '+35% attack.', risk: true, effect: { atkMult: 0.35 } },
  { id: 'mana_cookies', name: 'Mana Cookies', description: 'Reduce special cooldowns by 1 permanently this run.', risk: false, effect: { cooldownRelief: 1 } },
  { id: 'bard_inspiration', name: 'Bard Inspiration', description: '+10% attack and +10 max HP.', risk: false, effect: { atkMult: 0.1, maxHpFlat: 10 } },
  { id: 'heal_efficiency', name: 'Field Triage Manual', description: '+15% healing for the run.', risk: false, effect: { healMult: 0.15 } },
  { id: 'pet_chow', name: 'Suspicious Pet Treats', description: '+20% pet power.', risk: false, effect: { petPower: 0.2 } },
  { id: 'glass_ambition', name: 'Glass Ambition', description: '+50% next-fight attack flavor via enemy weakness.', risk: true, effect: { nextFightAtk: 0.25 } },
  { id: 'med_break', name: 'Forced Med Break', description: 'Full heal; next enemy +15% HP.', risk: true, effect: { fullHeal: 1, nextEnemyHp: 0.15 } },
]

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

export function getBoon(id) {
  return BOONS.find((b) => b.id === id) || null
}
