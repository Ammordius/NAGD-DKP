/**
 * Smart target helpers for expedition battle UI and engine fallbacks.
 */

/**
 * Prefer a previous valid ally id; otherwise lowest HP% living ally (or first dead for rez).
 * @param {object[]} party
 * @param {string|undefined} preferredId
 * @param {{ dead?: boolean }} [opts]
 */
export function smartAllyTarget(party, preferredId, opts = {}) {
  const wantDead = Boolean(opts.dead)
  const pool = (party || []).filter((t) => (wantDead ? !t.alive : t.alive))
  if (!pool.length) return undefined
  if (preferredId && pool.some((t) => t.id === preferredId)) return preferredId
  if (wantDead) return pool[0]?.id
  const lowest = pool.slice().sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0]
  return lowest?.id
}

/**
 * Prefer a previous valid living enemy id; otherwise first living enemy.
 * @param {object[]} enemies
 * @param {string|undefined} preferredId
 */
export function smartEnemyTarget(enemies, preferredId) {
  const live = (enemies || []).filter((e) => e.alive)
  if (!live.length) return undefined
  if (preferredId && live.some((e) => e.id === preferredId)) return preferredId
  return live[0]?.id
}
