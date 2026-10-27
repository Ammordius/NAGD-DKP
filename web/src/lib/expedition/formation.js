/** Abstract Front / Middle / Rear formation. */

export const POSITIONS = ['front', 'middle', 'rear']

/**
 * Default positions by role.
 * @param {string} className
 * @param {string} role
 */
export function defaultPosition(className, role) {
  if (role === 'tank') return 'front'
  if (role === 'healer' || className === 'Wizard' || className === 'Magician' || className === 'Enchanter') return 'rear'
  if (className === 'Rogue' || className === 'Ranger') return 'middle'
  return 'middle'
}

/**
 * Physical attacks prefer front, then middle, then rear unless bypass.
 * @param {object[]} party
 * @param {{ bypassFront?: boolean }} [opts]
 */
export function pickFormationTarget(party, opts = {}) {
  const living = party.filter((p) => p.alive && p.hp > 0 && !p.statuses?.some((s) => s.id === 'feign'))
  if (!living.length) return null
  if (opts.bypassFront) {
    const rear = living.filter((p) => p.position === 'rear')
    if (rear.length) return rear[0]
  }
  for (const pos of POSITIONS) {
    const at = living.filter((p) => p.position === pos)
    if (at.length) return at[0]
  }
  return living[0]
}

/**
 * @param {object} combatant
 * @param {'front'|'middle'|'rear'} position
 */
export function setPosition(combatant, position) {
  if (!POSITIONS.includes(position)) return
  combatant.position = position
}
