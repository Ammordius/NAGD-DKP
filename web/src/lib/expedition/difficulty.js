/** Fixed expedition difficulty presets. Narrator remains sarcastic on all. */

export const DIFFICULTIES = {
  normal: {
    id: 'normal',
    name: 'Normal',
    enemyHp: 1.15,
    enemyAtk: 1.12,
    enemyAoeMult: 1.0,
    enemyBehavior: 'standard',
    startingConsumables: 1,
    commandGain: 1,
    scoreMult: 1.0,
  },
  heroic: {
    id: 'heroic',
    name: 'Heroic',
    enemyHp: 1.55,
    enemyAtk: 1.4,
    enemyAoeMult: 1.25,
    enemyBehavior: 'aggressive',
    startingConsumables: 1,
    commandGain: 0.85,
    scoreMult: 1.35,
  },
  reckless: {
    id: 'reckless',
    name: 'Reckless',
    // Tuned so Magelo-geared glass (all-DPS / no tank) struggles,
    // while tank+healer+dps with skilled support remains achievable but hard.
    enemyHp: 1.85,
    enemyAtk: 1.68,
    enemyAoeMult: 1.65,
    enemyBehavior: 'ruthless',
    startingConsumables: 0,
    commandGain: 0.7,
    scoreMult: 1.7,
  },
}

export function getDifficulty(id) {
  return DIFFICULTIES[id] || DIFFICULTIES.normal
}
