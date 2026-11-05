/** Fixed expedition difficulty presets. Narrator remains sarcastic on all. */

export const DIFFICULTIES = {
  normal: {
    id: 'normal',
    name: 'Normal',
    enemyHp: 1.15,
    enemyAtk: 1.1,
    enemyBehavior: 'standard',
    startingConsumables: 1,
    commandGain: 1,
    scoreMult: 1.0,
  },
  heroic: {
    id: 'heroic',
    name: 'Heroic',
    enemyHp: 1.4,
    enemyAtk: 1.25,
    enemyBehavior: 'aggressive',
    startingConsumables: 1,
    commandGain: 0.85,
    scoreMult: 1.35,
  },
  reckless: {
    id: 'reckless',
    name: 'Reckless',
    enemyHp: 1.65,
    enemyAtk: 1.45,
    enemyBehavior: 'ruthless',
    startingConsumables: 0,
    commandGain: 0.7,
    scoreMult: 1.7,
  },
}

export function getDifficulty(id) {
  return DIFFICULTIES[id] || DIFFICULTIES.normal
}
