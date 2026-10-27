/**
 * Pure turn-based expedition engine.
 * Round order: player actions (heals/buffs before damage) → enemy (if alive) → status ticks → cooldowns → next intent.
 * Deterministic for the same seed + action sequence.
 */

import { getClassDef } from './classDefinitions.js'
import { fillPartyToThree, toCombatant, compositionCommentary, partyComposition } from './characterAdapter.js'
import { ENCOUNTERS, ENCOUNTER_COUNT, getEncounter } from './encounterDefinitions.js'
import { pickBoonChoices, getBoon } from './boonDefinitions.js'
import { maybePickEvent, getEvent } from './eventDefinitions.js'
import { pickNarratorLine, tagForCombatEvent } from './narrator.js'
import { calculateScore, pickArtifact, sarcasticAssessment } from './scoring.js'

/** @param {number} seed */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function rng() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function clampHp(n, max) {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(max, Math.round(n)))
}

function living(party) {
  return party.filter((p) => p.alive && p.hp > 0)
}

function pushLog(state, text) {
  state.log = [...state.log.slice(-40), text]
}

function pushNarrator(state, tag, payload) {
  const line = pickNarratorLine(tagForCombatEvent(tag, payload), state.rng, state.recentNarrator)
  state.narrator = line
  state.recentNarrator = [...state.recentNarrator.slice(-8), line]
}

function partyAtkMult(state) {
  let m = 1 + (state.runBuffs.atkMult || 0) + (state.tempBuffs.atkMult || 0) + (state.nextFightAtk || 0)
  if (state.party.some((p) => p.alive && getClassDef(p.class_name).passive.id === 'march')) m += 0.05
  if (state.songAtk) m += state.songAtk
  return m
}

function partyDefMult(state) {
  let m = 1 + (state.runBuffs.defMult || 0) + (state.tempBuffs.defMult || 0) - (state.runBuffs.defPenalty || 0)
  if (state.guardPct) m += state.guardPct
  if (state.party.some((p) => p.alive && getClassDef(p.class_name).passive.id === 'aura')) m += 0.05
  return Math.max(0.4, m)
}

function hasPassive(party, id) {
  return party.some((p) => p.alive && getClassDef(p.class_name).passive.id === id)
}

function pickFront(party) {
  const live = living(party)
  if (!live.length) return null
  const tanks = live.filter((p) => {
    const r = getClassDef(p.class_name).role
    return r === 'tank' || r === 'hybrid'
  })
  return tanks[0] || live[0]
}

function pickBy(party, mode, rng) {
  const live = living(party)
  if (!live.length) return null
  if (mode === 'front') return pickFront(party)
  if (mode === 'lowest') return live.slice().sort((a, b) => a.hp - b.hp)[0]
  if (mode === 'highest') return live.slice().sort((a, b) => b.hp - a.hp)[0]
  return live[Math.floor(rng() * live.length)]
}

function applyDamageToCombatant(state, target, rawDamage, opts = {}) {
  if (!target || !target.alive) return 0
  let dmg = rawDamage
  if (target.flags?.skShield > 0) {
    const absorb = Math.min(target.flags.skShield, dmg)
    target.flags.skShield -= absorb
    dmg -= absorb
  }
  if (getClassDef(target.class_name).passive.id === 'plate') dmg *= 0.85
  if (getClassDef(target.class_name).passive.id === 'evasion' && state.rng() < 0.1) {
    pushLog(state, `${target.name} evades!`)
    return 0
  }
  if (target.flags?.mitigateNext) {
    dmg *= 0.5
    target.flags.mitigateNext = false
  }
  dmg = Math.max(1, Math.round(dmg))
  target.hp = clampHp(target.hp - dmg, target.maxHp)
  if (target.hp <= 0) {
    target.alive = false
    target.hp = 0
    state.knockouts += 1
    pushLog(state, `${target.name} is knocked out!`)
    pushNarrator(state, 'ko')
  } else if (
    getClassDef(target.class_name).passive.id === 'mend' &&
    !target.flags.mendUsed &&
    target.hp < target.maxHp * 0.4
  ) {
    target.flags.mendUsed = true
    target.hp = clampHp(target.hp + 8, target.maxHp)
    pushLog(state, `${target.name} Mends (+8).`)
  }
  if (opts.fromEnemy) state.lastDamageTaken = dmg
  return dmg
}

function healTarget(state, target, amount, healer) {
  if (!target || !target.alive) return 0
  let heal = amount
  if (healer && getClassDef(healer.class_name).passive.id === 'divine') heal *= 1.1
  heal = Math.round(heal)
  const before = target.hp
  target.hp = clampHp(target.hp + heal, target.maxHp)
  const actual = target.hp - before
  if (before < target.maxHp * 0.25 && actual > 0) pushNarrator(state, 'clutch_heal')
  return actual
}

function enemyDamageBase(state, power) {
  const enc = state.enemy
  let dmg = enc.atk * (power || 1)
  if (state.enemySlow) dmg *= 1 - state.enemySlow
  if (state.nextEnemyAtk) dmg *= 1 + state.nextEnemyAtk
  dmg /= partyDefMult(state)
  return dmg
}

/**
 * Build initial run state.
 * @param {object[]} selectedCharacters
 * @param {{ seed?: number }} [opts]
 */
export function startRun(selectedCharacters, opts = {}) {
  const seed = opts.seed != null ? opts.seed >>> 0 : (Date.now() ^ (Math.random() * 0x100000000)) >>> 0
  const rng = mulberry32(seed)
  const partyChars = fillPartyToThree(selectedCharacters)
  const party = partyChars.map((c, i) => toCombatant(c, i))
  const state = {
    seed,
    rng,
    phase: 'battle',
    encounterIndex: 0,
    round: 1,
    turns: 0,
    knockouts: 0,
    encountersCleared: 0,
    party,
    partyMeta: partyChars,
    enemy: null,
    intent: null,
    pendingTelegraph: null,
    log: [],
    narrator: '',
    recentNarrator: [],
    runBuffs: { atkMult: 0, defMult: 0, defPenalty: 0 },
    tempBuffs: {},
    songAtk: 0,
    songRounds: 0,
    guardPct: 0,
    enemySlow: 0,
    enemySlowRounds: 0,
    enemySkipped: false,
    enemyControlled: false,
    petDamage: 0,
    petRounds: 0,
    nextFightAtk: 0,
    nextEnemyHp: 0,
    nextEnemyAtk: 0,
    challengeBonus: 0,
    boonChoices: null,
    eventChoices: null,
    victory: false,
    defeated: false,
    report: null,
    compositionLine: compositionCommentary(partyChars),
  }
  pushNarrator(state, 'start')
  beginEncounter(state, 0)
  return state
}

function beginEncounter(state, index) {
  const def = getEncounter(index)
  if (!def) {
    finishRun(state, true)
    return
  }
  state.encounterIndex = index
  state.phase = 'battle'
  state.round = 1
  state.pendingTelegraph = null
  state.enemySkipped = false
  state.enemyControlled = false
  state.guardPct = 0
  let maxHp = def.maxHp
  if (state.nextEnemyHp) {
    maxHp = Math.round(maxHp * (1 + state.nextEnemyHp))
    state.nextEnemyHp = 0
  }
  state.enemy = {
    id: def.id,
    name: def.name,
    title: def.title,
    maxHp,
    hp: maxHp,
    atk: def.atk,
    def: def.def,
    flavor: def.flavor,
    intents: def.intents,
    mechanics: def.mechanics || {},
  }
  for (const p of state.party) {
    if (getClassDef(p.class_name).passive.id === 'fearless') p.flags.skShield = 10
    if (getClassDef(p.class_name).passive.id === 'cani') p.flags.shamanFreeSpecial = true
    p.flags.mendUsed = false
  }
  if (state.nextFightAtk) {
    // consumed via partyAtkMult then cleared after encounter
  }
  rollIntent(state)
  pushLog(state, `— ${def.title}: ${def.name} —`)
  pushLog(state, def.flavor)
}

function rollIntent(state) {
  const intents = state.enemy.intents
  let pool = intents
  if (state.pendingTelegraph) {
    const follow = intents.find((i) => i.kind !== 'telegraph' && (i.id === 'devastate' || i.id === 'quad' || i.power >= 1.5))
    state.intent = follow || intents[intents.length - 1]
    return
  }
  // Bias: after telegraph used last, avoid immediate re-telegraph sometimes
  pool = intents.filter((i) => i.kind !== 'devastate' && i.kind !== 'quad')
  if (!pool.length) pool = intents
  state.intent = pool[Math.floor(state.rng() * pool.length)]
  if (state.intent.kind === 'telegraph') pushNarrator(state, 'telegraph')
}

/**
 * Legal actions for a living combatant.
 * @param {object} state
 * @param {object} combatant
 */
export function availableActions(state, combatant) {
  if (!combatant?.alive) return []
  const def = getClassDef(combatant.class_name)
  const actions = [
    {
      id: 'standard',
      abilityId: def.standard.id,
      name: def.standard.name,
      kind: def.standard.kind,
      description: def.standard.description,
      needsAllyTarget: def.standard.kind === 'heal_ally' || def.standard.kind === 'heal_self_or_ally',
    },
  ]
  const cd = combatant.cooldowns[def.special.id] || 0
  const free = combatant.flags?.shamanFreeSpecial && def.passive.id === 'cani'
  if (cd <= 0 || free) {
    actions.push({
      id: 'special',
      abilityId: def.special.id,
      name: def.special.name,
      kind: def.special.kind,
      description: def.special.description,
      needsAllyTarget: def.special.kind === 'heal_ally' || def.special.kind === 'heal_self_or_ally',
    })
  }
  return actions
}

/**
 * Validate and normalize player action map: { [combatantId]: { actionId, targetId? } }
 * @param {object} state
 * @param {Record<string, { actionId: string, targetId?: string }>} actions
 */
export function validateActions(state, actions) {
  const errors = []
  for (const p of living(state.party)) {
    const a = actions?.[p.id]
    if (!a?.actionId) {
      errors.push(`${p.name} has no action`)
      continue
    }
    const opts = availableActions(state, p)
    const match = opts.find((o) => o.id === a.actionId)
    if (!match) {
      errors.push(`${p.name} cannot use ${a.actionId}`)
      continue
    }
    if (match.needsAllyTarget) {
      const t = state.party.find((x) => x.id === a.targetId && x.alive)
      if (!t) errors.push(`${p.name} needs a living ally target`)
    }
  }
  return errors
}

function resolvePlayerAction(state, combatant, action) {
  const def = getClassDef(combatant.class_name)
  const isSpecial = action.actionId === 'special'
  const ability = isSpecial ? def.special : def.standard
  const atk = combatant.atk * partyAtkMult(state)

  if (isSpecial) {
    if (combatant.flags?.shamanFreeSpecial && def.passive.id === 'cani') {
      combatant.flags.shamanFreeSpecial = false
    } else {
      combatant.cooldowns[ability.id] = ability.cooldown
    }
  }

  const kind = ability.kind
  let crit = false
  if (kind.includes('damage') || kind === 'lifesteal' || kind === 'damage_bonus_control') {
    const critChance = def.passive.id === 'glass' ? 0.22 : 0.1
    crit = state.rng() < critChance
  }

  if (kind === 'heal_ally' || kind === 'heal_self_or_ally') {
    const target = state.party.find((x) => x.id === action.targetId && x.alive) || combatant
    const healed = healTarget(state, target, ability.power, combatant)
    pushLog(state, `${combatant.name} uses ${ability.name} on ${target.name} (+${healed} HP).`)
    return
  }

  if (kind === 'guard') {
    state.guardPct = ability.power
    pushLog(state, `${combatant.name} enters Defensive Stance.`)
    return
  }

  if (kind === 'debuff_enemy') {
    state.enemySlow = ability.power
    state.enemySlowRounds = 2
    pushLog(state, `${combatant.name} Slows the enemy.`)
    return
  }

  if (kind === 'skip_enemy') {
    state.enemySkipped = true
    state.enemyControlled = true
    pushLog(state, `${combatant.name} Mesmerizes the enemy!`)
    pushNarrator(state, 'mez')
    return
  }

  if (kind === 'buff_party') {
    state.songAtk = ability.power
    state.songRounds = 2
    pushLog(state, `${combatant.name} sings Battle Song!`)
    return
  }

  if (kind === 'pet') {
    state.petDamage = ability.power
    state.petRounds = 2
    pushLog(state, `${combatant.name} summons an elemental.`)
    return
  }

  if (kind === 'pet_heal') {
    state.petDamage = ability.power
    state.petRounds = 1
    const lowest = pickBy(state.party, 'lowest', state.rng)
    if (lowest) healTarget(state, lowest, 16, combatant)
    pushLog(state, `${combatant.name} calls a Spirit Companion.`)
    return
  }

  // damage kinds
  let power = ability.power
  if (kind === 'damage_bonus_control' && (state.enemyControlled || state.enemySkipped || state.enemySlow)) {
    power *= 1.5
  }
  let dmg = atk * power - state.enemy.def * 0.35
  if (crit) {
    dmg *= 1.5
    pushNarrator(state, 'crit')
  }
  dmg = Math.max(1, Math.round(dmg))

  if (ability.id === 'manaburn') {
    applyDamageToCombatant(state, combatant, 12)
    pushNarrator(state, 'manaburn')
  }

  state.enemy.hp = clampHp(state.enemy.hp - dmg, state.enemy.maxHp)
  pushLog(state, `${combatant.name} ${ability.name} for ${dmg}${crit ? ' (CRIT)' : ''}.`)

  if (kind === 'lifesteal') {
    let heal = Math.round(dmg * 0.5)
    if (def.passive.id === 'lich') heal = Math.round(heal * 1.25)
    healTarget(state, combatant, heal, combatant)
    pushLog(state, `${combatant.name} drains ${heal} HP.`)
  }
}

function resolveEnemy(state) {
  if (!state.enemy || state.enemy.hp <= 0) return
  if (state.enemySkipped) {
    pushLog(state, `${state.enemy.name} is mezmerized and skips the turn.`)
    state.enemySkipped = false
    state.enemyControlled = false
    state.pendingTelegraph = null
    return
  }

  let intent = state.intent
  if (state.pendingTelegraph) {
    intent = state.pendingTelegraph
    state.pendingTelegraph = null
  }

  if (intent.kind === 'telegraph') {
    const follow = state.enemy.intents.find((i) => i.id === 'devastate' || i.id === 'quad') || {
      id: 'devastate',
      label: 'Devastating attack!',
      kind: 'aoe',
      power: intent.power || 1.8,
    }
    state.pendingTelegraph = follow
    pushLog(state, `${state.enemy.name} prepares a devastating attack!`)
    return
  }

  const power = intent.power || 1
  if (intent.kind === 'buff_self') {
    state.enemy.atk += power
    pushLog(state, `${state.enemy.name} summons adds (+ATK).`)
    return
  }

  if (intent.kind === 'debuff_party') {
    state.tempBuffs.atkMult = (state.tempBuffs.atkMult || 0) - power
    pushLog(state, `${state.enemy.name} weakens casters.`)
    return
  }

  if (intent.kind === 'silence') {
    for (const p of living(state.party)) {
      const def = getClassDef(p.class_name)
      p.cooldowns[def.special.id] = (p.cooldowns[def.special.id] || 0) + 1
    }
    pushLog(state, `${state.enemy.name} interrupts casters!`)
    return
  }

  if (intent.kind === 'poison') {
    const t = pickBy(state.party, intent.target || 'random', state.rng)
    if (t) {
      t.statuses = [...(t.statuses || []).filter((s) => s.id !== 'poison'), { id: 'poison', turns: 3, power: power }]
      pushLog(state, `${t.name} is poisoned.`)
    }
    return
  }

  if (intent.kind === 'aoe') {
    const dmgEach = enemyDamageBase(state, power)
    for (const p of living(state.party)) {
      applyDamageToCombatant(state, p, dmgEach, { fromEnemy: true })
    }
    pushLog(state, `${state.enemy.name} hits the party (AoE).`)
    return
  }

  // single
  const target = pickBy(state.party, intent.target || 'front', state.rng)
  if (target) {
    const dmg = enemyDamageBase(state, power)
    const dealt = applyDamageToCombatant(state, target, dmg, { fromEnemy: true })
    pushLog(state, `${state.enemy.name} hits ${target.name} for ${dealt}.`)
  }
}

function endOfRoundTicks(state) {
  state.guardPct = 0
  state.enemyControlled = state.enemySkipped

  if (state.songRounds > 0) {
    state.songRounds -= 1
    if (state.songRounds <= 0) state.songAtk = 0
  }
  if (state.enemySlowRounds > 0) {
    state.enemySlowRounds -= 1
    if (state.enemySlowRounds <= 0) state.enemySlow = 0
  }
  if (state.petRounds > 0 && state.petDamage > 0 && state.enemy.hp > 0) {
    const pd = Math.round(state.petDamage * partyAtkMult(state))
    state.enemy.hp = clampHp(state.enemy.hp - pd, state.enemy.maxHp)
    pushLog(state, `Pet strikes for ${pd}.`)
    state.petRounds -= 1
  }

  if (hasPassive(state.party, 'regen')) {
    for (const p of living(state.party)) {
      p.hp = clampHp(p.hp + 3, p.maxHp)
    }
  }

  for (const p of state.party) {
    if (!p.alive) continue
    // poison
    const poison = (p.statuses || []).find((s) => s.id === 'poison')
    if (poison) {
      applyDamageToCombatant(state, p, poison.power)
      poison.turns -= 1
      if (poison.turns <= 0) p.statuses = (p.statuses || []).filter((s) => s.id !== 'poison')
    }
    // cooldowns
    for (const k of Object.keys(p.cooldowns)) {
      if (p.cooldowns[k] > 0) p.cooldowns[k] -= 1
    }
    // enchanter clarity: every other round extra CD tick
    if (hasPassive(state.party, 'haste') && state.round % 2 === 0) {
      for (const k of Object.keys(p.cooldowns)) {
        if (p.cooldowns[k] > 0) p.cooldowns[k] -= 1
      }
    }
  }

  state.tempBuffs = {}
}

function checkEncounterEnd(state) {
  if (state.enemy && state.enemy.hp <= 0) {
    state.encountersCleared += 1
    state.nextFightAtk = 0
    pushLog(state, `${state.enemy.name} defeated!`)
    if (state.enemy.mechanics?.boss) {
      const survivors = living(state.party).length
      if (survivors <= 1) pushNarrator(state, 'near_wipe_win')
      else pushNarrator(state, 'victory')
      finishRun(state, true)
      return true
    }
    pushNarrator(state, 'encounter_clear')
    // offer event sometimes then boons
    const ev = maybePickEvent(state.rng, 0.4)
    if (ev) {
      state.phase = 'event'
      state.eventChoices = ev
    } else {
      state.phase = 'boon'
      state.boonChoices = pickBoonChoices(state.rng)
    }
    return true
  }
  if (!living(state.party).length) {
    pushNarrator(state, 'wipe')
    finishRun(state, false)
    return true
  }
  if (state.enemy && state.enemy.hp / state.enemy.maxHp < 0.25 && state.enemy.mechanics?.boss) {
    pushNarrator(state, 'boss_low')
  }
  return false
}

function finishRun(state, victory) {
  state.victory = victory
  state.defeated = !victory
  state.phase = 'rewards'
  const live = living(state.party)
  const hpPct = state.party.length
    ? live.reduce((s, p) => s + p.hp / p.maxHp, 0) / state.party.length
    : 0
  const score = calculateScore({
    encountersCleared: state.encountersCleared,
    totalEncounters: ENCOUNTER_COUNT,
    remainingHpPct: hpPct,
    knockouts: state.knockouts,
    turns: state.turns,
    victory,
    challengeBonus: state.challengeBonus,
  })
  const artifact = pickArtifact(score, victory)
  state.report = {
    victory,
    score,
    artifact,
    assessment: sarcasticAssessment(score, victory, live.length),
    encountersCleared: state.encountersCleared,
    turns: state.turns,
    knockouts: state.knockouts,
    party: state.partyMeta.map((c) => ({ name: c.name, class_name: c.class_name, fictional: c.fictional })),
    remainingHpPct: hpPct,
  }
}

/**
 * Commit one round of actions.
 * @param {object} state
 * @param {Record<string, { actionId: string, targetId?: string }>} actions
 */
export function commitRound(state, actions) {
  if (state.phase !== 'battle') return { ok: false, errors: ['Not in battle'] }
  const errors = validateActions(state, actions)
  if (errors.length) return { ok: false, errors }

  // Clone-friendly: mutate state in place (UI should treat as new via spread if needed)
  state.turns += 1
  state.enemySkipped = false

  const live = living(state.party)
  // Order: heals/buffs/guards/control first, then damage
  const ordered = live.slice().sort((a, b) => {
    const ka = actionPriority(actions[a.id], a)
    const kb = actionPriority(actions[b.id], b)
    return ka - kb
  })

  for (const p of ordered) {
    if (!p.alive) continue
    resolvePlayerAction(state, p, actions[p.id])
    if (state.enemy.hp <= 0) break
  }

  if (checkEncounterEnd(state)) return { ok: true, state }

  resolveEnemy(state)
  if (checkEncounterEnd(state)) return { ok: true, state }

  endOfRoundTicks(state)
  if (checkEncounterEnd(state)) return { ok: true, state }

  state.round += 1
  rollIntent(state)
  return { ok: true, state }
}

function actionPriority(action, combatant) {
  const def = getClassDef(combatant.class_name)
  const ability = action?.actionId === 'special' ? def.special : def.standard
  const kind = ability?.kind || 'damage'
  if (kind.startsWith('heal') || kind === 'guard' || kind === 'buff_party' || kind === 'skip_enemy' || kind === 'debuff_enemy') return 0
  if (kind === 'pet' || kind === 'pet_heal') return 1
  return 2
}

/**
 * @param {object} state
 * @param {string} boonId
 */
export function selectBoon(state, boonId) {
  if (state.phase !== 'boon') return { ok: false, errors: ['Not choosing boon'] }
  const boon = getBoon(boonId)
  if (!boon) return { ok: false, errors: ['Unknown boon'] }
  applyEffect(state, boon.effect)
  pushLog(state, `Boon taken: ${boon.name}`)
  pushNarrator(state, boon.risk ? 'risky_boon' : 'safe_boon')
  state.boonChoices = null
  advanceToNextEncounter(state)
  return { ok: true, state }
}

/**
 * @param {object} state
 * @param {string} choiceId
 */
export function selectEventChoice(state, choiceId) {
  if (state.phase !== 'event' || !state.eventChoices) return { ok: false, errors: ['Not in event'] }
  const choice = state.eventChoices.choices.find((c) => c.id === choiceId)
  if (!choice) return { ok: false, errors: ['Unknown choice'] }
  applyEffect(state, choice.effect)
  pushLog(state, `Event: ${state.eventChoices.title} → ${choice.label}`)
  state.eventChoices = null
  state.phase = 'boon'
  state.boonChoices = pickBoonChoices(state.rng)
  return { ok: true, state }
}

function applyEffect(state, effect) {
  if (!effect) return
  if (effect.healPct) {
    for (const p of living(state.party)) {
      p.hp = clampHp(p.hp + p.maxHp * effect.healPct, p.maxHp)
    }
  }
  if (effect.fullHeal) {
    for (const p of living(state.party)) p.hp = p.maxHp
  }
  if (effect.atkMult) state.runBuffs.atkMult = (state.runBuffs.atkMult || 0) + effect.atkMult
  if (effect.defMult) state.runBuffs.defMult = (state.runBuffs.defMult || 0) + effect.defMult
  if (effect.defPenalty) state.runBuffs.defPenalty = (state.runBuffs.defPenalty || 0) + effect.defPenalty
  if (effect.maxHpFlat) {
    for (const p of state.party) {
      p.maxHp += effect.maxHpFlat
      if (p.alive) p.hp = clampHp(p.hp + effect.maxHpFlat, p.maxHp)
    }
  }
  if (effect.maxHpPenaltyPct) {
    for (const p of state.party) {
      p.maxHp = Math.max(20, Math.round(p.maxHp * (1 - effect.maxHpPenaltyPct)))
      p.hp = clampHp(p.hp, p.maxHp)
    }
  }
  if (effect.cooldownRelief) {
    for (const p of state.party) {
      for (const k of Object.keys(p.cooldowns)) {
        p.cooldowns[k] = Math.max(0, (p.cooldowns[k] || 0) - effect.cooldownRelief)
      }
    }
  }
  if (effect.nextFightAtk) state.nextFightAtk = (state.nextFightAtk || 0) + effect.nextFightAtk
  if (effect.nextEnemyHp) state.nextEnemyHp = (state.nextEnemyHp || 0) + effect.nextEnemyHp
  if (effect.nextEnemyAtk) state.nextEnemyAtk = (state.nextEnemyAtk || 0) + effect.nextEnemyAtk
  if (effect.turnsPenalty) state.turns += effect.turnsPenalty
}

function advanceToNextEncounter(state) {
  const next = state.encounterIndex + 1
  if (next >= ENCOUNTER_COUNT) {
    finishRun(state, true)
    return
  }
  beginEncounter(state, next)
}

/**
 * Reset combat for Play Again with same party meta.
 * @param {object[]} selectedCharacters
 * @param {{ seed?: number }} [opts]
 */
export function restartRun(selectedCharacters, opts = {}) {
  return startRun(selectedCharacters, opts)
}

export function getPartyComposition(party) {
  return partyComposition(party)
}

export { ENCOUNTER_COUNT, ENCOUNTERS }
