/** Lightweight optional events between encounters. */

/** @type {Array<{ id: string, title: string, description: string, choices: Array<{ id: string, label: string, effect: Record<string, number> }> }>} */
export const RANDOM_EVENTS = [
  {
    id: 'early_pull',
    title: 'Someone pulls early',
    description: 'A ranger insists the pack was "already aggro."',
    choices: [
      { id: 'charge', label: 'Charge in', effect: { nextEnemyAtk: 0.1, atkMult: 0.1 } },
      { id: 'wait', label: 'Wait and med', effect: { healPct: 0.15 } },
    ],
  },
  {
    id: 'cleric_afk',
    title: 'A cleric goes AFK',
    description: 'Something about pizza. Allegedly.',
    choices: [
      { id: 'cover', label: 'Cover with potions', effect: { healPct: 0.2, nextEnemyAtk: 0.05 } },
      { id: 'shame', label: 'Public channel shame', effect: { atkMult: 0.05 } },
    ],
  },
  {
    id: 'forgot_disc',
    title: 'Tank forgot a defensive',
    description: 'The cooldown was definitely available. In another timeline.',
    choices: [
      { id: 'brace', label: 'Brace for impact', effect: { defMult: 0.1 } },
      { id: 'risk', label: 'Play aggressive', effect: { atkMult: 0.15, defPenalty: 0.1 } },
    ],
  },
  {
    id: 'wiz_burn',
    title: 'Wizard announces burn',
    description: '"I\'m going to burn." Chat has opinions.',
    choices: [
      { id: 'let_burn', label: 'Let them cook', effect: { nextFightAtk: 0.25 } },
      { id: 'save', label: 'Save for boss', effect: { cooldownRelief: 1 } },
    ],
  },
  {
    id: 'loot_argument',
    title: 'Loot officer starts an argument',
    description: 'It involves "need before greed" and ancient grievances.',
    choices: [
      { id: 'mediate', label: 'Mediate poorly', effect: { healPct: 0.1 } },
      { id: 'ignore', label: 'Ignore and pull', effect: { atkMult: 0.1, nextEnemyHp: 0.05 } },
    ],
  },
  {
    id: 'train',
    title: 'Someone trains the group',
    description: 'Footsteps. Many footsteps. Behind you.',
    choices: [
      { id: 'gate', label: 'Emergency gate (heal, lose tempo)', effect: { healPct: 0.35, turnsPenalty: 1 } },
      { id: 'stand', label: 'Stand and fight', effect: { nextEnemyAtk: 0.15, atkMult: 0.1 } },
    ],
  },
  {
    id: 'bard_song',
    title: 'Bard insists song is optimal',
    description: 'It is not. Everyone knows. The bard does not.',
    choices: [
      { id: 'believe', label: 'Believe the bard', effect: { atkMult: 0.08, defMult: 0.05 } },
      { id: 'request', label: 'Request slow song', effect: { defMult: 0.12 } },
    ],
  },
]

/**
 * @param {() => number} rng
 * @param {number} [chance]
 */
export function maybePickEvent(rng, chance = 0.45) {
  if (rng() > chance) return null
  const idx = Math.floor(rng() * RANDOM_EVENTS.length)
  return RANDOM_EVENTS[idx]
}

/**
 * @param {string} eventId
 */
export function getEvent(eventId) {
  return RANDOM_EVENTS.find((e) => e.id === eventId) || null
}
