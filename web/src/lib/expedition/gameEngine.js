/**
 * Quarm Expedition — turn orchestrator (data-driven abilities).
 *
 * Round order:
 * 1) Resolve delayed casts that reach 0
 * 2) Player actions (by priority) + optional raid command
 * 3) Pet actions
 * 4) Enemy intents
 * 5) DoT/HoT ticks, status durations, resource regen, cooldown ticks, threat decay
 */

import { getClassAbilities, getUniversalActions, getAbility } from './abilities.js'
import { getPassive } from './passives.js'
import { applyEffects, applyEffect, tickDotsAndHots } from './effects.js'
import { hasStatus, tickStatusDurations, applyStatusToUnit } from './statuses.js'
import {
  canPayResource, spendResource, restoreResource, tickResourceRegen,
  grantCommandPoints, spendCommandPoints, COMMAND_COST,
} from './resources.js'
import { pickThreatTarget, addThreat, decayThreat } from './threat.js'
import { pickFormationTarget } from './formation.js'
import { applyCostSynergies, applyDamageSynergies, listSynergyIds } from './synergies.js'
import { getDifficulty } from './difficulty.js'
import { ENCOUNTERS, ENCOUNTER_COUNT, getEncounter } from './encounterDefinitions.js'
import { pickBoonChoices, getBoon } from './boonDefinitions.js'
import { maybePickEvent } from './eventDefinitions.js'
import { pickNarratorLine, tagForCombatEvent } from './narrator.js'
import { calculateScore, pickArtifact, sarcasticAssessment } from './scoring.js'
import {
  buildCombatIdentity, toCombatantFromIdentity, lookupProfile,
} from './combatProfile.js'
import { fillPartyToThree, compositionCommentary } from './characterAdapter.js'
import { getClassDef } from './classDefinitions.js'

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

function pushLog(state, text) {
  state.log = [...state.log.slice(-50), text]
}

function pushNarrator(state, tag) {
  const line = pickNarratorLine(tagForCombatEvent(tag), state.rng, state.recentNarrator)
  state.narrator = line
  state.recentNarrator = [...state.recentNarrator.slice(-8), line]
}

function livingParty(state) {
  return state.party.filter((p) => p.alive && p.hp > 0)
}

function livingEnemies(state) {
  return (state.enemies || []).filter((e) => e.alive && e.hp > 0)
}

export const RAID_COMMANDS = [
  { id: 'focus_fire', name: 'Focus Fire', description: 'Party deals +25% to chosen enemy this round.', cost: COMMAND_COST },
  { id: 'brace', name: 'Brace', description: 'Party takes −30% AoE damage this round.', cost: COMMAND_COST },
  { id: 'protect_caster', name: 'Protect Caster', description: 'Next ally cast resists interrupt.', cost: COMMAND_COST },
  { id: 'regroup', name: 'Regroup', description: 'Small party heal; −15% damage dealt this round.', cost: COMMAND_COST },
  { id: 'coordinated_interrupt', name: 'Coordinated Interrupt', description: 'Interrupt an enemy cast if one is active.', cost: COMMAND_COST },
]

/**
 * @param {object[]} selectedCharacters
 * @param {{ seed?: number, difficulty?: string, profiles?: Map<string, object>|null }} [opts]
 */
export function startRun(selectedCharacters, opts = {}) {
  const seed = opts.seed != null ? opts.seed >>> 0 : (Date.now() ^ (Math.random() * 0x100000000)) >>> 0
  const rng = mulberry32(seed)
  const difficulty = getDifficulty(opts.difficulty || 'normal')
  const partyChars = fillPartyToThree(selectedCharacters)
  const identities = partyChars.map((c) => {
    const profile = opts.profiles ? lookupProfile(c.name, opts.profiles) : lookupProfile(c.name)
    return buildCombatIdentity(c, profile)
  })
  const party = partyChars.map((c, i) => toCombatantFromIdentity(c, identities[i], i))

  const state = {
    seed,
    rng,
    difficulty: difficulty.id,
    difficultyMods: difficulty,
    phase: 'battle',
    encounterIndex: 0,
    round: 1,
    turns: 0,
    knockouts: 0,
    encountersCleared: 0,
    party,
    partyMeta: partyChars,
    identities,
    enemies: [],
    enemy: null, // primary for UI compat
    intent: null,
    intents: {},
    log: [],
    narrator: '',
    recentNarrator: [],
    pets: [],
    threat: {},
    commandPoints: 1,
    commandUsedThisRound: false,
    expeditionCurrency: 0,
    consumables: {
      healing_potion: difficulty.startingConsumables,
      mana_draught: difficulty.startingConsumables,
      smoke_bomb: 0,
      defensive_tonic: 0,
      rez_scroll: 0,
    },
    inventory: [],
    rezzesUsed: 0,
    runBuffs: { atkMult: 0, defMult: 0, healMult: 0, cdRelief: 0, petPower: 0 },
    nextEncounterMods: { enemyHp: 0, enemyAtk: 0, easier: false },
    boonChoices: null,
    eventChoices: null,
    routeChoices: null,
    consumableOffer: null,
    victory: false,
    defeated: false,
    report: null,
    compositionLine: compositionCommentary(partyChars),
    pendingCommand: null,
  }

  for (const p of party) {
    p.runAtkMult = 0
    p.runHealMult = 0
  }

  pushNarrator(state, 'start')
  beginEncounter(state, 0)
  return state
}

function scaleEnemy(template, state) {
  const d = state.difficultyMods
  const nm = state.nextEncounterMods || {}
  const hpMult = (d.enemyHp || 1) * (1 + (nm.enemyHp || 0)) * (nm.easier ? 0.85 : 1)
  const atkMult = (d.enemyAtk || 1) * (1 + (nm.enemyAtk || 0)) * (nm.easier ? 0.9 : 1)
  return {
    ...template,
    id: template.id,
    name: template.name,
    maxHp: Math.round(template.maxHp * hpMult),
    hp: Math.round(template.maxHp * hpMult),
    atk: Math.round(template.atk * atkMult),
    def: template.def,
    alive: true,
    isEnemy: true,
    isBoss: Boolean(template.isBoss),
    role: template.role || null,
    school: template.school || null,
    statuses: [],
    casting: null,
    phaseIndex: 0,
    phases: template.phases || null,
    intentsByPhase: template.intentsByPhase || null,
    intents: template.intents || [],
  }
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
  state.rezzesUsed = 0
  state.pets = []
  state.threat = {}
  state.commandUsedThisRound = false
  state.enemies = (def.enemies || []).map((e) => scaleEnemy(e, state))
  state.enemy = state.enemies[0]
  state.nextEncounterMods = { enemyHp: 0, enemyAtk: 0, easier: false }

  for (const p of state.party) {
    if (p.alive) {
      p.casting = null
      // encounter-start passives
      const passive = getPassive(p.class_name)
      if (passive?.hooks?.onEncounterStart) {
        applyEffects({ state, source: p, ability: null, target: p }, passive.hooks.onEncounterStart)
      }
    }
  }

  rollAllIntents(state)
  pushLog(state, `— ${def.title} —`)
  pushLog(state, def.flavor)
}

function currentIntents(enemy) {
  if (enemy.phases && enemy.intentsByPhase) {
    const phase = enemy.phases[enemy.phaseIndex || 0] || enemy.phases[0]
    return enemy.intentsByPhase[phase] || enemy.intents || []
  }
  return enemy.intents || []
}

function rollAllIntents(state) {
  state.intents = {}
  for (const enemy of livingEnemies(state)) {
    updateQuarmPhase(enemy)
    const pool = currentIntents(enemy)
    if (!pool.length) continue
    const intent = pool[Math.floor(state.rng() * pool.length)]
    state.intents[enemy.id] = intent
    if (enemy.id === state.enemy?.id) state.intent = intent
  }
}

function updateQuarmPhase(enemy) {
  if (!enemy.phases || !enemy.isBoss) return
  const pct = enemy.hp / enemy.maxHp
  if (pct > 0.75) enemy.phaseIndex = 0
  else if (pct > 0.5) enemy.phaseIndex = 1
  else if (pct > 0.25) enemy.phaseIndex = 2
  else enemy.phaseIndex = 3
}

/**
 * @param {object} state
 * @param {object} combatant
 */
export function availableActions(state, combatant) {
  if (!combatant?.alive) return []
  const actions = []
  for (const u of getUniversalActions()) {
    if (u.id === 'use_consumable') {
      const has = Object.values(state.consumables || {}).some((n) => n > 0)
      if (!has) continue
    }
    actions.push({
      id: u.id,
      abilityId: u.id,
      name: u.name,
      group: u.group,
      kind: u.group,
      description: u.description,
      needsAllyTarget: u.targetType === 'single_ally',
      needsEnemyTarget: u.targetType === 'single_enemy',
      resource: u.resource,
      cost: u.cost,
      cooldown: 0,
      castTime: 0,
      tags: u.tags,
    })
  }
  for (const ab of getClassAbilities(combatant.class_name)) {
    const cd = combatant.cooldowns?.[ab.id] || 0
    if (cd > 0) continue
    if (!canPayResource(combatant, ab.resource, ab.cost)) continue
    actions.push({
      id: ab.id,
      abilityId: ab.id,
      name: ab.name,
      group: ab.group,
      kind: ab.group,
      description: ab.description,
      needsAllyTarget: ab.targetType === 'single_ally',
      needsEnemyTarget: ab.targetType === 'single_enemy',
      needsDeadAlly: ab.tags?.includes('resurrect'),
      resource: ab.resource,
      cost: ab.cost,
      cooldown: ab.cooldown,
      castTime: ab.castTime,
      tags: ab.tags,
    })
  }
  return actions
}

export function validateActions(state, actions) {
  const errors = []
  for (const p of livingParty(state)) {
    const a = actions?.[p.id]
    if (!a?.actionId) {
      errors.push(`${p.name} has no action`)
      continue
    }
    const opts = availableActions(state, p)
    const match = opts.find((o) => o.id === a.actionId || o.abilityId === a.actionId)
    if (!match) {
      errors.push(`${p.name} cannot use ${a.actionId}`)
      continue
    }
    if (match.needsAllyTarget) {
      const t = state.party.find((x) => x.id === a.targetId && (match.needsDeadAlly ? !x.alive : x.alive))
      if (!t && !match.needsDeadAlly) errors.push(`${p.name} needs an ally target`)
      if (match.needsDeadAlly && !state.party.find((x) => x.id === a.targetId && !x.alive)) {
        errors.push(`${p.name} needs a knocked-out ally`)
      }
    }
    if (match.needsEnemyTarget) {
      const t = livingEnemies(state).find((x) => x.id === a.targetId) || livingEnemies(state)[0]
      if (!t) errors.push(`${p.name} needs an enemy target`)
    }
  }
  return errors
}

function findAbility(actionId, combatant) {
  return getAbility(actionId) || getUniversalActions().find((u) => u.id === actionId) || null
}

function resolveUnitAction(state, combatant, action) {
  const ability = findAbility(action.actionId, combatant)
  if (!ability) return

  let cost = ability.cost || 0
  const ctx = {
    state,
    source: combatant,
    ability,
    target: null,
    meta: {},
  }

  // targets
  if (ability.targetType === 'single_ally' || ability.tags?.includes('resurrect')) {
    ctx.target = state.party.find((p) => p.id === action.targetId) || combatant
  } else if (ability.targetType === 'single_enemy') {
    ctx.target = livingEnemies(state).find((e) => e.id === action.targetId) || livingEnemies(state)[0]
  } else if (ability.targetType === 'self' || ability.targetType === 'none') {
    ctx.target = combatant
  } else if (ability.targetType === 'all_enemies') {
    ctx.target = livingEnemies(state)[0]
  } else {
    ctx.target = livingEnemies(state)[0] || combatant
  }

  cost = applyCostSynergies(ctx, cost)
  if (!canPayResource(combatant, ability.resource, cost)) {
    pushLog(state, `${combatant.name} lacks resources for ${ability.name}.`)
    return
  }
  spendResource(combatant, ability.resource, cost)

  if (ability.cooldown) {
    combatant.cooldowns[ability.id] = ability.cooldown - (state.runBuffs.cdRelief || 0)
    if (combatant.cooldowns[ability.id] < 0) combatant.cooldowns[ability.id] = 0
  }

  // consumable
  if (ability.id === 'use_consumable') {
    if ((state.consumables.healing_potion || 0) > 0) {
      state.consumables.healing_potion -= 1
      combatant.hp = Math.min(combatant.maxHp, combatant.hp + Math.round(combatant.maxHp * 0.35))
      pushLog(state, `${combatant.name} uses a healing potion.`)
    }
    return
  }

  if (ability.castTime > 0) {
    const onResolve = ability.effects.filter((e) => e.type !== 'startCast')
    applyEffect(ctx, {
      type: 'startCast',
      rounds: ability.castTime,
      interruptible: true,
      onResolve: onResolve.length ? onResolve : ability.effects,
    })
    return
  }

  // wrap damage through synergies via monkeypatch-ish: apply effects then adjust
  const effects = ability.effects || []
  // If first effect is damage, apply synergy multiplier into a cloned effect
  const cloned = effects.map((e) => {
    if (e.type !== 'damage') return e
    const syn = applyDamageSynergies(ctx, 100)
    const mult = syn.damage / 100
    return { ...e, power: (e.power || 1) * mult }
  })
  applyEffects(ctx, cloned)

  // shield bash bonus with shield trait
  if (ability.id?.includes('shield_bash') && combatant.traits?.includes('shield_equipped') && ctx.target) {
    applyEffect(ctx, { type: 'interrupt' })
  }

  const passive = getPassive(combatant.class_name)
  if (passive?.hooks?.onDealDamage) {
    applyEffects({ ...ctx, meta: { lastDamage: 20 } }, passive.hooks.onDealDamage)
  }
}

function resolvePendingCasts(state) {
  for (const p of state.party) {
    if (!p.alive || !p.casting) continue
    p.casting.remaining -= 1
    if (p.casting.remaining > 0) continue
    const cast = p.casting
    p.casting = null
    const target = state.party.find((x) => x.id === cast.targetId)
      || livingEnemies(state).find((x) => x.id === cast.targetId)
      || livingEnemies(state)[0]
    const ability = getAbility(cast.abilityId)
    applyEffects({
      state,
      source: p,
      target,
      ability,
    }, cast.onResolve || [])
    pushLog(state, `${p.name} completes ${cast.abilityName}.`)
    if (cast.abilityName?.includes('Complete Heal')) pushNarrator(state, 'clutch_heal')
  }
  for (const e of state.enemies) {
    if (!e.alive || !e.casting) continue
    e.casting.remaining -= 1
    if (e.casting.remaining > 0) continue
    const cast = e.casting
    e.casting = null
    // resolve enemy cast as heavy AoE/single
    const power = cast.power || 1.8
    for (const p of livingParty(state)) {
      dealEnemyDamage(state, e, p, power)
    }
    pushLog(state, `${e.name} unleashes ${cast.castName || 'a spell'}!`)
  }
}

function dealEnemyDamage(state, enemy, target, power, opts = {}) {
  if (!target?.alive) return 0
  // intercept
  let realTarget = target
  const interceptor = livingParty(state).find((p) => hasStatus(p, 'intercept') && p.id !== target.id)
  if (interceptor && !opts.aoe) {
    realTarget = interceptor
    pushLog(state, `${interceptor.name} intercepts for ${target.name}!`)
  }

  if (hasStatus(realTarget, 'feign') && state.rng() < 0.7) {
    pushLog(state, `${enemy.name} ignores feigned ${realTarget.name}.`)
    return 0
  }

  let dmg = enemy.atk * (power || 1)
  if (hasStatus(enemy, 'slow')) dmg *= 0.65
  if (opts.aoe && hasStatus(realTarget, 'brace')) dmg *= 0.7
  if (hasStatus(realTarget, 'regroup_penalty')) { /* noop */ }
  dmg *= 1 - (realTarget.armorMitigation || 0)
  const dr = realTarget.statuses?.find((s) => s.id === 'damage_reduction')
  if (dr) dmg *= 1 - (dr.power || 0.25)
  if (hasStatus(realTarget, 'last_stand')) dmg *= 0.5
  if (hasStatus(realTarget, 'evade')) {
    pushLog(state, `${realTarget.name} evades!`)
    return 0
  }
  // resists
  if (opts.school === 'fire') dmg *= 1 - ((realTarget.resistances?.fire || 0) / 100)
  if (opts.school === 'magic') dmg *= 1 - ((realTarget.resistances?.magic || 0) / 100)

  dmg = Math.max(1, Math.round(dmg))
  const shield = realTarget.statuses?.find((s) => s.id === 'shield')
  if (shield && shield.power > 0) {
    const absorb = Math.min(shield.power, dmg)
    shield.power -= absorb
    dmg -= absorb
  }
  realTarget.hp = Math.max(0, realTarget.hp - dmg)
  const passive = getPassive(realTarget.class_name)
  if (passive?.hooks?.onDamageTaken) {
    applyEffects({ state, source: realTarget, attacker: enemy, target: enemy }, passive.hooks.onDamageTaken)
  }
  if (realTarget.hp <= 0) {
    realTarget.hp = 0
    realTarget.alive = false
    state.knockouts += 1
    pushLog(state, `${realTarget.name} is knocked out!`)
    pushNarrator(state, 'ko')
  }
  return dmg
}

function resolveEnemyIntent(state, enemy) {
  if (!enemy.alive) return
  if (hasStatus(enemy, 'mez') || hasStatus(enemy, 'stun') || hasStatus(enemy, 'fear')) {
    pushLog(state, `${enemy.name} is controlled and skips.`)
    return
  }
  const intent = state.intents[enemy.id]
  if (!intent) return

  if (intent.kind === 'cast') {
    enemy.casting = {
      remaining: 1,
      interruptible: true,
      castName: intent.castName || 'Heavy Spell',
      power: intent.power || 1.8,
    }
    pushLog(state, `${enemy.name} begins casting ${enemy.casting.castName}!`)
    pushNarrator(state, 'telegraph')
    return
  }

  if (intent.kind === 'aoe') {
    for (const p of livingParty(state)) dealEnemyDamage(state, enemy, p, intent.power, { aoe: true, school: intent.school })
    pushLog(state, `${enemy.name} hits the party.`)
    return
  }

  if (intent.kind === 'poison') {
    const pool = livingParty(state)
    const t = pool[Math.floor(state.rng() * pool.length)]
    if (t) applyStatusToUnit(t, 'poison', { power: intent.power || 10, duration: 3 })
    return
  }

  if (intent.kind === 'silence') {
    for (const p of livingParty(state)) {
      if (p.casting && !p.casting.protected) {
        p.casting = null
        pushLog(state, `${enemy.name} interrupts ${p.name}!`)
      }
    }
    return
  }

  if (intent.kind === 'buff_self') {
    enemy.atk += intent.power || 3
    return
  }

  if (intent.kind === 'self_shield') {
    applyStatusToUnit(enemy, 'shield', { power: intent.power || 40, duration: 3 })
    return
  }

  if (intent.kind === 'buff_ally_enemy') {
    const boss = livingEnemies(state).find((e) => e.isBoss) || enemy
    applyStatusToUnit(boss, 'damage_reduction', { power: intent.power || 0.2, duration: 2 })
    return
  }

  if (intent.kind === 'debuff_party') {
    for (const p of livingParty(state)) {
      p.tempAtkMult = (p.tempAtkMult || 0) - (intent.power || 0.15)
    }
    return
  }

  if (intent.kind === 'mana_burn') {
    const caster = livingParty(state).slice().sort((a, b) => (b.mana || 0) - (a.mana || 0))[0]
    if (caster) {
      caster.mana = Math.max(0, (caster.mana || 0) - (intent.power || 15))
      pushLog(state, `${enemy.name} burns ${caster.name}'s mana.`)
    }
    return
  }

  if (intent.kind === 'fear') {
    const rear = livingParty(state).filter((p) => p.position === 'rear')
    const t = rear[0] || livingParty(state)[0]
    if (t) applyStatusToUnit(t, 'fear', { duration: 1 })
    return
  }

  if (intent.kind === 'apply_vuln') {
    applyStatusToUnit(enemy, 'vulnerability', { duration: 2, power: 1 })
    pushLog(state, `${enemy.name} exposes a weak point!`)
    return
  }

  // single target
  let target = null
  if (intent.formation) target = pickFormationTarget(state.party)
  else if (intent.target === 'lowest') target = livingParty(state).slice().sort((a, b) => a.hp - b.hp)[0]
  else if (intent.target === 'highest') target = livingParty(state).slice().sort((a, b) => b.hp - a.hp)[0]
  else if (intent.target === 'random') {
    const pool = livingParty(state)
    target = pool[Math.floor(state.rng() * pool.length)]
  } else target = pickThreatTarget(state, enemy, state.party)

  if (target) {
    const dmg = dealEnemyDamage(state, enemy, target, intent.power, { school: intent.school })
    pushLog(state, `${enemy.name} hits ${target.name} for ${dmg}.`)
  }
}

function applyRaidCommand(state, commandId, targetEnemyId) {
  if (state.commandUsedThisRound) return { ok: false, errors: ['Command already used'] }
  if (!spendCommandPoints(state, COMMAND_COST)) return { ok: false, errors: ['Not enough command points'] }
  state.commandUsedThisRound = true
  const enemies = livingEnemies(state)
  const target = enemies.find((e) => e.id === targetEnemyId) || enemies[0]

  switch (commandId) {
    case 'focus_fire':
      if (target) applyStatusToUnit(target, 'focus_fire', { duration: 1 })
      pushLog(state, 'Raid command: Focus Fire!')
      break
    case 'brace':
      for (const p of livingParty(state)) applyStatusToUnit(p, 'brace', { duration: 1 })
      pushLog(state, 'Raid command: Brace!')
      break
    case 'protect_caster':
      for (const p of livingParty(state)) applyStatusToUnit(p, 'protect_caster', { duration: 1 })
      pushLog(state, 'Raid command: Protect Caster!')
      break
    case 'regroup':
      for (const p of livingParty(state)) {
        p.hp = Math.min(p.maxHp, p.hp + Math.round(p.maxHp * 0.12))
        p.tempAtkMult = (p.tempAtkMult || 0) - 0.15
      }
      pushLog(state, 'Raid command: Regroup!')
      break
    case 'coordinated_interrupt': {
      let hit = false
      for (const e of enemies) {
        if (e.casting?.interruptible) {
          e.casting = null
          hit = true
          pushLog(state, `Coordinated interrupt stops ${e.name}!`)
        }
      }
      if (!hit) pushLog(state, 'Coordinated interrupt finds nothing to stop.')
      break
    }
    default:
      return { ok: false, errors: ['Unknown command'] }
  }
  return { ok: true }
}

function checkEncounterEnd(state) {
  if (!livingEnemies(state).length) {
    state.encountersCleared += 1
    grantCommandPoints(state, Math.round(1 * (state.difficultyMods.commandGain || 1)))
    pushLog(state, 'Encounter cleared!')
    if (state.encounterIndex >= ENCOUNTER_COUNT - 1) {
      const survivors = livingParty(state).length
      pushNarrator(state, survivors <= 1 ? 'near_wipe_win' : 'victory')
      finishRun(state, true)
      return true
    }
    pushNarrator(state, 'encounter_clear')
    // progression: route → event? → boon → consumable
    state.phase = 'route'
    state.routeChoices = [
      { id: 'safe', name: 'Safe Passage', description: 'Easier next fight, smaller reward.' },
      { id: 'treacherous', name: 'Treacherous Shortcut', description: 'Harder next fight, stronger reward.' },
      { id: 'shrine', name: 'Forgotten Shrine', description: 'Restore resources; random complication.' },
    ]
    return true
  }
  if (!livingParty(state).length) {
    pushNarrator(state, 'wipe')
    finishRun(state, false)
    return true
  }
  const boss = livingEnemies(state).find((e) => e.isBoss)
  if (boss && boss.hp / boss.maxHp < 0.25) pushNarrator(state, 'boss_low')
  return false
}

function finishRun(state, victory) {
  state.victory = victory
  state.defeated = !victory
  state.phase = 'rewards'
  const live = livingParty(state)
  const hpPct = state.party.length
    ? live.reduce((s, p) => s + p.hp / p.maxHp, 0) / state.party.length
    : 0
  const score = calculateScore({
    encountersCleared: state.encountersCleared,
    remainingHpPct: hpPct,
    knockouts: state.knockouts,
    turns: state.turns,
    victory,
    challengeBonus: state.difficulty === 'heroic' ? 400 : state.difficulty === 'reckless' ? 900 : 0,
  })
  state.report = {
    victory,
    score,
    artifact: pickArtifact(score, victory),
    assessment: sarcasticAssessment(score, victory, live.length),
    encountersCleared: state.encountersCleared,
    turns: state.turns,
    knockouts: state.knockouts,
    party: state.partyMeta.map((c) => ({ name: c.name, class_name: c.class_name, fictional: c.fictional })),
    remainingHpPct: hpPct,
    difficulty: state.difficulty,
  }
}

/**
 * @param {object} state
 * @param {Record<string, { actionId: string, targetId?: string }>} actions
 * @param {{ commandId?: string, commandTargetId?: string }} [extras]
 */
export function commitRound(state, actions, extras = {}) {
  if (state.phase !== 'battle') return { ok: false, errors: ['Not in battle'] }

  // Encounter may already be clear (e.g. last pet tick / scripted setup)
  if (!livingEnemies(state).length || !livingParty(state).length) {
    checkEncounterEnd(state)
    return { ok: true, state }
  }

  const errors = validateActions(state, actions)
  if (errors.length) return { ok: false, errors }

  state.turns += 1
  state.commandUsedThisRound = false

  if (extras.commandId) {
    const cmd = applyRaidCommand(state, extras.commandId, extras.commandTargetId)
    if (!cmd.ok) return cmd
  }

  resolvePendingCasts(state)
  if (checkEncounterEnd(state)) return { ok: true, state }

  const live = livingParty(state)
  const ordered = live.slice().sort((a, b) => actionPriority(actions[a.id], a) - actionPriority(actions[b.id], b))
  for (const p of ordered) {
    if (!p.alive) continue
    resolveUnitAction(state, p, actions[p.id])
    if (checkEncounterEnd(state)) return { ok: true, state }
  }

  // pets
  for (const pet of state.pets || []) {
    if (!pet.alive) continue
    const target = livingEnemies(state)[0]
    if (!target) break
    let dmg = pet.atk
    const syn = applyDamageSynergies({ state, source: pet, target, meta: { fromPet: true }, ability: { tags: ['pet'] } }, dmg)
    dmg = Math.round(syn.damage)
    target.hp = Math.max(0, target.hp - dmg)
    pushLog(state, `${pet.name} strikes for ${dmg}.`)
    if (target.hp <= 0) {
      target.alive = false
      pushLog(state, `${target.name} falls.`)
    }
  }
  if (checkEncounterEnd(state)) return { ok: true, state }

  for (const enemy of livingEnemies(state)) {
    resolveEnemyIntent(state, enemy)
    if (checkEncounterEnd(state)) return { ok: true, state }
  }

  // end round ticks
  for (const p of state.party) {
    if (p.alive) {
      tickDotsAndHots(state, p)
      tickStatusDurations(p)
      tickResourceRegen(p)
      for (const k of Object.keys(p.cooldowns || {})) {
        if (p.cooldowns[k] > 0) p.cooldowns[k] -= 1
      }
      p.tempAtkMult = 0
      const passive = getPassive(p.class_name)
      if (passive?.hooks?.onRoundEnd) {
        applyEffects({ state, source: p, target: p }, passive.hooks.onRoundEnd)
      }
    }
  }
  for (const e of state.enemies) {
    if (e.alive) {
      tickDotsAndHots(state, e)
      tickStatusDurations(e)
    }
  }
  decayThreat(state)
  if (checkEncounterEnd(state)) return { ok: true, state }

  // small CP drip
  if (state.rng() < 0.35) grantCommandPoints(state, 1)

  state.round += 1
  state.enemy = livingEnemies(state)[0] || state.enemy
  rollAllIntents(state)
  return { ok: true, state }
}

function actionPriority(action, combatant) {
  const ability = findAbility(action?.actionId, combatant)
  const g = ability?.group || 'offensive'
  if (g === 'defensive' || g === 'support') return 0
  return 1
}

export function selectRoute(state, routeId) {
  if (state.phase !== 'route') return { ok: false, errors: ['Not choosing route'] }
  if (routeId === 'safe') {
    state.nextEncounterMods = { enemyHp: -0.1, enemyAtk: -0.1, easier: true }
    state.expeditionCurrency += 1
  } else if (routeId === 'treacherous') {
    state.nextEncounterMods = { enemyHp: 0.15, enemyAtk: 0.1, easier: false }
    state.runBuffs.atkMult = (state.runBuffs.atkMult || 0) + 0.1
    for (const p of state.party) p.runAtkMult = state.runBuffs.atkMult
  } else if (routeId === 'shrine') {
    for (const p of livingParty(state)) {
      p.hp = Math.min(p.maxHp, p.hp + Math.round(p.maxHp * 0.3))
      restoreResource(p, 'focus', 20)
    }
    if (state.rng() < 0.5) {
      state.nextEncounterMods = { enemyHp: 0.08, enemyAtk: 0.05, easier: false }
      pushLog(state, 'The shrine exacts a complication.')
    }
  }
  state.routeChoices = null
  const ev = maybePickEvent(state.rng, 0.35)
  if (ev) {
    state.phase = 'event'
    state.eventChoices = ev
  } else {
    state.phase = 'boon'
    state.boonChoices = pickBoonChoices(state.rng)
  }
  return { ok: true, state }
}

export function selectEventChoice(state, choiceId) {
  if (state.phase !== 'event' || !state.eventChoices) return { ok: false, errors: ['Not in event'] }
  const choice = state.eventChoices.choices.find((c) => c.id === choiceId)
  if (!choice) return { ok: false, errors: ['Unknown choice'] }
  applyBoonLikeEffect(state, choice.effect)
  pushLog(state, `Event: ${state.eventChoices.title} → ${choice.label}`)
  state.eventChoices = null
  state.phase = 'boon'
  state.boonChoices = pickBoonChoices(state.rng)
  return { ok: true, state }
}

export function selectBoon(state, boonId) {
  if (state.phase !== 'boon') return { ok: false, errors: ['Not choosing boon'] }
  const boon = getBoon(boonId)
  if (!boon) return { ok: false, errors: ['Unknown boon'] }
  applyBoonLikeEffect(state, boon.effect)
  pushLog(state, `Boon: ${boon.name}`)
  pushNarrator(state, boon.risk ? 'risky_boon' : 'safe_boon')
  state.boonChoices = null
  // consumable offer
  state.phase = 'consumable'
  const offers = ['healing_potion', 'mana_draught', 'smoke_bomb', 'defensive_tonic']
  state.consumableOffer = offers[Math.floor(state.rng() * offers.length)]
  return { ok: true, state }
}

export function selectConsumable(state, take) {
  if (state.phase !== 'consumable') return { ok: false, errors: ['Not choosing consumable'] }
  if (take && state.consumableOffer) {
    state.consumables[state.consumableOffer] = (state.consumables[state.consumableOffer] || 0) + 1
    pushLog(state, `Took ${state.consumableOffer}.`)
  }
  state.consumableOffer = null
  advanceToNextEncounter(state)
  return { ok: true, state }
}

function applyBoonLikeEffect(state, effect) {
  if (!effect) return
  if (effect.healPct) {
    for (const p of livingParty(state)) p.hp = Math.min(p.maxHp, p.hp + p.maxHp * effect.healPct)
  }
  if (effect.fullHeal) for (const p of livingParty(state)) p.hp = p.maxHp
  if (effect.atkMult) {
    state.runBuffs.atkMult += effect.atkMult
    for (const p of state.party) p.runAtkMult = state.runBuffs.atkMult
  }
  if (effect.defMult) state.runBuffs.defMult += effect.defMult
  if (effect.healMult) {
    state.runBuffs.healMult += effect.healMult
    for (const p of state.party) p.runHealMult = state.runBuffs.healMult
  }
  if (effect.cooldownRelief) state.runBuffs.cdRelief += effect.cooldownRelief
  if (effect.petPower) state.runBuffs.petPower += effect.petPower
  if (effect.maxHpFlat) {
    for (const p of state.party) {
      p.maxHp += effect.maxHpFlat
      if (p.alive) p.hp = Math.min(p.maxHp, p.hp + effect.maxHpFlat)
    }
  }
  if (effect.nextFightAtk) state.nextEncounterMods.enemyAtk = (state.nextEncounterMods.enemyAtk || 0) - effect.nextFightAtk
  if (effect.nextEnemyHp) state.nextEncounterMods.enemyHp = (state.nextEncounterMods.enemyHp || 0) + effect.nextEnemyHp
  if (effect.nextEnemyAtk) state.nextEncounterMods.enemyAtk = (state.nextEncounterMods.enemyAtk || 0) + effect.nextEnemyAtk
}

function advanceToNextEncounter(state) {
  beginEncounter(state, state.encounterIndex + 1)
}

export function restartRun(selectedCharacters, opts = {}) {
  return startRun(selectedCharacters, opts)
}

export { ENCOUNTER_COUNT, ENCOUNTERS, listSynergyIds, getAbility, getClassAbilities }
