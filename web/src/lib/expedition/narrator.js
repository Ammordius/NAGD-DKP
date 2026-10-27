/** Authored DKP Inquisitor lines for expedition events. No LLM. */

/** @type {Record<string, string[]>} */
export const NARRATOR_LINES = {
  party_no_healer: [
    "You've chosen three damage dealers. I respect your commitment to dying quickly.",
    'No healer detected. I have prepared the wipe paperwork in triplicate.',
    'Your strategy has been reviewed and rejected by common sense.',
  ],
  party_no_tank: [
    'No tank. Someone will invent the role mid-fight through suffering.',
    'I admire your confidence in a strategy unsupported by mathematics.',
  ],
  party_all_healers: [
    'Your entire party consists of healers. Eventually, the enemy may die of old age.',
  ],
  party_has_warrior: [
    'At least you brought a warrior. Somebody has to take responsibility for this disaster.',
  ],
  party_weird: [
    'Three wizards and no healer. An ambitious interpretation of raid strategy.',
    'This composition belongs in a museum of questionable decisions.',
  ],
  critical_hit: [
    'A critical hit. File it under "accidental competence."',
    'Remarkably, the numbers briefly favored you.',
  ],
  knockout: [
    'Another raider horizontal. Proceeding according to expectations.',
    'The warrior survives through a combination of armor and poor judgment. This one did not.',
    'Down. The expedition remains on schedule.',
  ],
  clutch_heal: [
    'Remarkably, the cleric has discovered the healing button.',
    'Healed at death\'s door. Bureaucracy briefly delayed.',
  ],
  boss_low: [
    'Quarm has four heads and somehow still makes fewer mistakes than you.',
    'The boss is nearly defeated. Try not to invent a new failure mode.',
  ],
  risky_boon: [
    'A risky boon. I admire the optimism and dread the spreadsheet.',
    'You selected danger voluntarily. Noted for the permanent record.',
  ],
  safe_boon: [
    'A cautious choice. The audit board is mildly disappointed.',
  ],
  near_wipe_win: [
    'Your party survived. I\'m filing a bug report.',
    'One survivor. Technically a victory. Spiritually a memo.',
  ],
  wipe: [
    'Another wipe. The expedition is proceeding according to expectations.',
    'Total party failure. Efficient, in its way.',
  ],
  victory: [
    'The loot is imaginary, which makes it considerably safer in your hands.',
    'Quarm falls. The Inquisitor remains unimpressed.',
    'Victory recorded. Do not let it go to your head; there is no head durable enough.',
  ],
  encounter_clear: [
    'Encounter cleared. Try not to celebrate; it encourages them.',
    'This is the first competent decision you\'ve made all evening.',
  ],
  mez_success: [
    'Mesmerize landed. Even chaos occasionally files paperwork.',
  ],
  manaburn: [
    'Manaburn. Subtlety remains unavailable in your region.',
  ],
  start_run: [
    'Three characters. Terrible leadership. One questionable expedition.',
    'The expedition begins. Expectations are appropriately low.',
  ],
  enemy_telegraph: [
    'The enemy is winding up. This is the part where coordination would help.',
  ],
  default: [
    'Your strategy has been reviewed and rejected by common sense.',
    'I admire your confidence in a strategy unsupported by mathematics.',
    'Proceed. The audit continues.',
  ],
}

/**
 * @param {string} tag
 * @param {() => number} rng
 * @param {string[]} [recent]
 */
export function pickNarratorLine(tag, rng, recent = []) {
  const pool = NARRATOR_LINES[tag] || NARRATOR_LINES.default
  const fresh = pool.filter((l) => !recent.includes(l))
  const use = fresh.length ? fresh : pool
  const line = use[Math.floor(rng() * use.length)] || NARRATOR_LINES.default[0]
  return line
}

/**
 * Map engine events to narrator tags.
 * @param {string} eventType
 * @param {Record<string, unknown>} [payload]
 */
export function tagForCombatEvent(eventType, payload = {}) {
  switch (eventType) {
    case 'crit':
      return 'critical_hit'
    case 'ko':
      return 'knockout'
    case 'clutch_heal':
      return 'clutch_heal'
    case 'boss_low':
      return 'boss_low'
    case 'wipe':
      return 'wipe'
    case 'victory':
      return 'victory'
    case 'near_wipe_win':
      return 'near_wipe_win'
    case 'encounter_clear':
      return 'encounter_clear'
    case 'mez':
      return 'mez_success'
    case 'manaburn':
      return 'manaburn'
    case 'telegraph':
      return 'enemy_telegraph'
    case 'risky_boon':
      return 'risky_boon'
    case 'safe_boon':
      return 'safe_boon'
    case 'start':
      return 'start_run'
    case 'party_comment':
      return String(payload.tag || 'default')
    default:
      return 'default'
  }
}

export function countNarratorLines() {
  return Object.values(NARRATOR_LINES).reduce((n, arr) => n + arr.length, 0)
}
