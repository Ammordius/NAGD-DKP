/** Simple hate / threat table. */

export function ensureThreat(state, enemyId) {
  if (!state.threat) state.threat = {}
  if (!state.threat[enemyId]) state.threat[enemyId] = {}
  return state.threat[enemyId]
}

/**
 * @param {object} state
 * @param {string} enemyId
 * @param {string} combatantId
 * @param {number} amount
 */
export function addThreat(state, enemyId, combatantId, amount) {
  if (!amount) return
  const table = ensureThreat(state, enemyId)
  table[combatantId] = (table[combatantId] || 0) + amount
}

export function reduceThreat(state, enemyId, combatantId, amount) {
  const table = ensureThreat(state, enemyId)
  table[combatantId] = Math.max(0, (table[combatantId] || 0) - amount)
}

export function clearThreat(state, enemyId, combatantId) {
  const table = ensureThreat(state, enemyId)
  table[combatantId] = 0
}

/**
 * Highest threat living party member, respecting taunt_lock / feign.
 * @param {object} state
 * @param {object} enemy
 * @param {object[]} party
 */
export function pickThreatTarget(state, enemy, party) {
  const living = party.filter((p) => p.alive && p.hp > 0)
  if (!living.length) return null

  const taunted = living.find((p) => p.statuses?.some((s) => s.id === 'taunt_lock'))
  if (taunted) return taunted

  const visible = living.filter((p) => !p.statuses?.some((s) => s.id === 'feign'))
  const pool = visible.length ? visible : living

  const table = ensureThreat(state, enemy.id)
  let best = pool[0]
  let bestHate = -1
  for (const p of pool) {
    const hate = table[p.id] || 0
    // Front formation bias
    const posBonus = p.position === 'front' ? 15 : p.position === 'rear' ? -10 : 0
    const score = hate + posBonus
    if (score > bestHate) {
      bestHate = score
      best = p
    }
  }
  return best
}

export function decayThreat(state, factor = 0.95) {
  if (!state.threat) return
  for (const enemyId of Object.keys(state.threat)) {
    const table = state.threat[enemyId]
    for (const id of Object.keys(table)) {
      table[id] = Math.floor(table[id] * factor)
    }
  }
}
