/** Standardized expedition status definitions and stacking rules. */

/** @typedef {{ id: string, name: string, category: string, maxStacks: number, defaultDuration: number, breaksOnDamage?: boolean, bossResist?: boolean, tick?: 'dot'|'hot'|null }} StatusDef */

/** @type {Record<string, StatusDef>} */
export const STATUS_DEFS = {
  stun: { id: 'stun', name: 'Stunned', category: 'control', maxStacks: 1, defaultDuration: 1, bossResist: true },
  slow: { id: 'slow', name: 'Slowed', category: 'debuff', maxStacks: 1, defaultDuration: 2, bossResist: false },
  snare: { id: 'snare', name: 'Snared', category: 'debuff', maxStacks: 1, defaultDuration: 2 },
  mez: { id: 'mez', name: 'Mesmerized', category: 'control', maxStacks: 1, defaultDuration: 2, breaksOnDamage: true, bossResist: true },
  poison: { id: 'poison', name: 'Poisoned', category: 'dot', maxStacks: 2, defaultDuration: 3, tick: 'dot' },
  disease: { id: 'disease', name: 'Diseased', category: 'dot', maxStacks: 1, defaultDuration: 3, tick: 'dot' },
  hot: { id: 'hot', name: 'Regeneration', category: 'hot', maxStacks: 1, defaultDuration: 3, tick: 'hot' },
  shield: { id: 'shield', name: 'Absorb Shield', category: 'defense', maxStacks: 1, defaultDuration: 3 },
  damage_reduction: { id: 'damage_reduction', name: 'Mitigation', category: 'defense', maxStacks: 1, defaultDuration: 2 },
  thorns: { id: 'thorns', name: 'Damage Shield', category: 'defense', maxStacks: 1, defaultDuration: 3 },
  resist_down: { id: 'resist_down', name: 'Resistances Lowered', category: 'debuff', maxStacks: 1, defaultDuration: 3 },
  vulnerability: { id: 'vulnerability', name: 'Vulnerable', category: 'debuff', maxStacks: 1, defaultDuration: 2 },
  silence: { id: 'silence', name: 'Interrupted', category: 'control', maxStacks: 1, defaultDuration: 1, bossResist: true },
  fear: { id: 'fear', name: 'Feared', category: 'control', maxStacks: 1, defaultDuration: 1, bossResist: true },
  feign: { id: 'feign', name: 'Feign Death', category: 'defense', maxStacks: 1, defaultDuration: 1 },
  lich: { id: 'lich', name: 'Lich Form', category: 'buff', maxStacks: 1, defaultDuration: 4 },
  haste: { id: 'haste', name: 'Haste', category: 'buff', maxStacks: 1, defaultDuration: 3 },
  song_atk: { id: 'song_atk', name: 'Battle Hymn', category: 'buff', maxStacks: 1, defaultDuration: 3 },
  song_mana: { id: 'song_mana', name: 'Mana Song', category: 'buff', maxStacks: 1, defaultDuration: 3 },
  clarity: { id: 'clarity', name: 'Clarity', category: 'buff', maxStacks: 1, defaultDuration: 4 },
  taunt_lock: { id: 'taunt_lock', name: 'Taunted', category: 'threat', maxStacks: 1, defaultDuration: 2 },
  evade: { id: 'evade', name: 'Evading', category: 'defense', maxStacks: 1, defaultDuration: 1 },
  intercept: { id: 'intercept', name: 'Intercept Ready', category: 'defense', maxStacks: 1, defaultDuration: 1 },
  last_stand: { id: 'last_stand', name: 'Last Stand', category: 'defense', maxStacks: 1, defaultDuration: 2 },
  burnout: { id: 'burnout', name: 'Burnout', category: 'buff', maxStacks: 1, defaultDuration: 3 },
  pet_buff: { id: 'pet_buff', name: 'Pet Empowered', category: 'buff', maxStacks: 1, defaultDuration: 3 },
  shadowstep: { id: 'shadowstep', name: 'Shadowstep', category: 'buff', maxStacks: 1, defaultDuration: 1 },
  counter: { id: 'counter', name: 'Counter Stance', category: 'defense', maxStacks: 1, defaultDuration: 2 },
  focus_fire: { id: 'focus_fire', name: 'Focus Fire', category: 'buff', maxStacks: 1, defaultDuration: 1 },
  brace: { id: 'brace', name: 'Brace', category: 'defense', maxStacks: 1, defaultDuration: 1 },
  protect_caster: { id: 'protect_caster', name: 'Protected Cast', category: 'buff', maxStacks: 1, defaultDuration: 1 },
  torpor_drawback: { id: 'torpor_drawback', name: 'Torpor Lethargy', category: 'debuff', maxStacks: 1, defaultDuration: 2 },
}

/**
 * @param {object} unit
 * @param {string} statusId
 * @param {{ power?: number, duration?: number, sourceId?: string }} [opts]
 */
export function applyStatusToUnit(unit, statusId, opts = {}) {
  const def = STATUS_DEFS[statusId]
  if (!def || !unit) return false
  if (unit.isBoss && def.bossResist && (statusId === 'mez' || statusId === 'charm' || statusId === 'fear')) {
    // Bosses: shortened/partial — apply as vulnerability or short slow instead of full lock
    return applyStatusToUnit(unit, statusId === 'fear' ? 'vulnerability' : 'slow', {
      power: (opts.power || 1) * 0.5,
      duration: 1,
      sourceId: opts.sourceId,
    })
  }
  if (unit.isBoss && def.bossResist && statusId === 'stun') {
    return applyStatusToUnit(unit, 'silence', { power: 1, duration: 1, sourceId: opts.sourceId })
  }

  const duration = opts.duration ?? def.defaultDuration
  const power = opts.power ?? 1
  const list = unit.statuses || (unit.statuses = [])
  const existing = list.filter((s) => s.id === statusId)
  if (existing.length >= def.maxStacks) {
    // refresh oldest
    const oldest = existing[0]
    oldest.remaining = duration
    oldest.power = Math.max(oldest.power || 0, power)
    oldest.sourceId = opts.sourceId || oldest.sourceId
    return true
  }
  list.push({
    id: statusId,
    remaining: duration,
    power,
    sourceId: opts.sourceId || null,
  })
  return true
}

/**
 * @param {object} unit
 * @param {string} statusId
 */
export function hasStatus(unit, statusId) {
  return Boolean(unit?.statuses?.some((s) => s.id === statusId && s.remaining > 0))
}

/**
 * @param {object} unit
 * @param {string} statusId
 */
export function getStatus(unit, statusId) {
  return unit?.statuses?.find((s) => s.id === statusId && s.remaining > 0) || null
}

/**
 * @param {object} unit
 * @param {string} statusId
 */
export function removeStatus(unit, statusId) {
  if (!unit?.statuses) return
  unit.statuses = unit.statuses.filter((s) => s.id !== statusId)
}

/**
 * Break mez when unit takes damage.
 * @param {object} unit
 */
export function breakMezOnDamage(unit) {
  if (hasStatus(unit, 'mez')) removeStatus(unit, 'mez')
}

/**
 * Tick durations down; return expired.
 * @param {object} unit
 */
export function tickStatusDurations(unit) {
  if (!unit?.statuses) return []
  const expired = []
  for (const s of unit.statuses) {
    s.remaining -= 1
    if (s.remaining <= 0) expired.push(s.id)
  }
  unit.statuses = unit.statuses.filter((s) => s.remaining > 0)
  return expired
}

export const STATUS_IDS = Object.keys(STATUS_DEFS)
