/** Mana, endurance, and command-point helpers. */

const MANA_CLASSES = new Set([
  'Cleric', 'Druid', 'Shaman', 'Enchanter', 'Bard', 'Wizard', 'Magician',
  'Necromancer', 'Paladin', 'Shadow Knight', 'Ranger', 'Beastlord',
])

const ENDURANCE_CLASSES = new Set([
  'Warrior', 'Rogue', 'Monk', 'Ranger', 'Beastlord', 'Paladin', 'Shadow Knight', 'Bard',
])

export function usesMana(className) {
  return MANA_CLASSES.has(className)
}

export function usesEndurance(className) {
  return ENDURANCE_CLASSES.has(className)
}

/**
 * @param {object} combatant
 * @param {'mana'|'endurance'|'none'|'focus'} resource
 * @param {number} cost
 */
export function canPayResource(combatant, resource, cost) {
  if (!resource || resource === 'none' || !cost) return true
  if (resource === 'focus') {
    if (usesMana(combatant.class_name) && (combatant.mana ?? 0) >= 0) return true
    if (usesEndurance(combatant.class_name)) return true
    return true
  }
  if (resource === 'mana') return (combatant.mana ?? 0) >= cost
  if (resource === 'endurance') return (combatant.endurance ?? 0) >= cost
  return true
}

/**
 * @param {object} combatant
 * @param {'mana'|'endurance'|'none'|'focus'} resource
 * @param {number} amount positive spend
 */
export function spendResource(combatant, resource, amount) {
  if (!amount || !resource || resource === 'none') return
  if (resource === 'focus') return
  if (resource === 'mana') {
    combatant.mana = Math.max(0, (combatant.mana ?? 0) - amount)
  } else if (resource === 'endurance') {
    combatant.endurance = Math.max(0, (combatant.endurance ?? 0) - amount)
  }
}

/**
 * @param {object} combatant
 * @param {'mana'|'endurance'|'focus'|string} resource
 * @param {number} amount
 */
export function restoreResource(combatant, resource, amount) {
  if (!amount) return 0
  if (resource === 'focus') {
    let restored = 0
    if (usesMana(combatant.class_name)) {
      const before = combatant.mana ?? 0
      combatant.mana = Math.min(combatant.maxMana ?? before, before + amount)
      restored += combatant.mana - before
    }
    if (usesEndurance(combatant.class_name)) {
      const before = combatant.endurance ?? 0
      combatant.endurance = Math.min(combatant.maxEndurance ?? before, before + amount)
      restored += combatant.endurance - before
    }
    return restored
  }
  if (resource === 'mana') {
    const before = combatant.mana ?? 0
    combatant.mana = Math.min(combatant.maxMana ?? before, before + amount)
    return combatant.mana - before
  }
  if (resource === 'endurance') {
    const before = combatant.endurance ?? 0
    combatant.endurance = Math.min(combatant.maxEndurance ?? before, before + amount)
    return combatant.endurance - before
  }
  return 0
}

/** Passive regen each round end. */
export function tickResourceRegen(combatant) {
  if (!combatant?.alive) return
  if (usesMana(combatant.class_name)) {
    restoreResource(combatant, 'mana', 3)
  }
  if (usesEndurance(combatant.class_name)) {
    restoreResource(combatant, 'endurance', 5)
  }
}

export const COMMAND_CAP = 6
export const COMMAND_COST = 2

export function grantCommandPoints(state, amount) {
  state.commandPoints = Math.min(COMMAND_CAP, (state.commandPoints || 0) + Math.max(0, amount))
}

export function spendCommandPoints(state, amount = COMMAND_COST) {
  if ((state.commandPoints || 0) < amount) return false
  state.commandPoints -= amount
  return true
}
