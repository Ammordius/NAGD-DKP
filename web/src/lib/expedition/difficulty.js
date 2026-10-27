/** Fixed expedition difficulty presets. Narrator remains sarcastic on all. */

export const DIFFICULTIES = {
  normal: {
    id: 'normal',
    name: 'Normal',
    enemyHp: 1,
    enemyAtk: 1,
    enemyBehavior: 'standard',
    startingConsumables: 1,
    commandGain: 1,
  },
  heroic: {
    id: 'heroic',
    name: 'Heroic',
    enemyHp: 1.25,
    enemyAtk: 1.15,
    enemyBehavior: 'aggressive',
    startingConsumables: 1,
    commandGain: 0.85,
  },
  reckless: {
    id: 'reckless',
    name: 'Reckless',
    enemyHp: 1.45,
    enemyAtk: 1.3,
    enemyBehavior: 'ruthless',
    startingConsumables: 0,
    commandGain: 0.7,
  },
}

export function getDifficulty(id) {
  return DIFFICULTIES[id] || DIFFICULTIES.normal
}
