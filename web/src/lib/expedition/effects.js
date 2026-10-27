/**
 * Shared effect interpreter for expedition abilities, passives, and enemy intents.
 */

import { applyStatusToUnit, breakMezOnDamage, hasStatus, getStatus, removeStatus } from './statuses.js'
import { spendResource, restoreResource } from './resources.js'
import { addThreat, reduceThreat, clearThreat } from './threat.js'

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

function livingAllies(ctx) {
  return (ctx.state.party || []).filter((p) => p.alive && p.hp > 0)
}

function livingEnemies(ctx) {
  return (ctx.state.enemies || []).filter((e) => e.alive && e.hp > 0)
}

function resolveTargets(effect, ctx) {
  const t = effect.target || 'target'
  if (t === 'self') return ctx.source ? [ctx.source] : []
  if (t === 'target') return ctx.target ? [ctx.target] : []
  if (t === 'attacker') return ctx.attacker ? [ctx.attacker] : []
  if (t === 'lowest_ally') {
    const live = livingAllies(ctx).slice().sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)
    return live[0] ? [live[0]] : []
  }
  if (t === 'all_allies') return livingAllies(ctx)
  if (t === 'all_enemies') return livingEnemies(ctx)
  if (t === 'pet') return (ctx.state.pets || []).filter((p) => p.ownerId === ctx.source?.id && p.alive)
  return ctx.target ? [ctx.target] : []
}

function atkPower(unit) {
  return (unit?.atk || 10) * (1 + (unit?.tempAtkMult || 0)) * (1 + (unit?.runAtkMult || 0))
}

function spellPower(unit) {
  return (unit?.spellPower || unit?.atk || 10) * (1 + (unit?.tempSpellMult || 0))
}

function healPower(unit) {
  let m = 1 + (unit?.healMult || 0) + (unit?.runHealMult || 0)
  return spellPower(unit) * m
}

function mitigationMultiplier(target) {
  let m = 1
  const dr = getStatus(target, 'damage_reduction')
  if (dr) m *= 1 - (dr.power || 0.25)
  const ls = getStatus(target, 'last_stand')
  if (ls) m *= 1 - (ls.power || 0.5)
  if (hasStatus(target, 'evade')) return 0
  if (target.position === 'rear') m *= 0.9
  if (target.position === 'front') m *= 1.05
  m *= 1 - (target.armorMitigation || 0)
  return Math.max(0.25, m)
}

/**
 * @param {object} ctx
 * @param {object} effect
 * @param {object} [meta]
 */
export function applyEffect(ctx, effect, meta = {}) {
  if (!effect || !ctx?.state) return null
  if (effect.condition && !evaluateCondition(effect.condition, ctx, meta)) return null

  const log = (msg) => {
    ctx.state.log = [...(ctx.state.log || []).slice(-50), msg]
  }

  switch (effect.type) {
    case 'damage': {
      const targets = resolveTargets(effect, ctx)
      let total = 0
      for (const target of targets) {
        if (!target.alive) continue
        if (hasStatus(target, 'mez')) breakMezOnDamage(target)
        let base = (effect.school === 'magic' || effect.school === 'fire' || effect.school === 'cold'
          ? spellPower(ctx.source)
          : atkPower(ctx.source)) * (effect.power || 1)
        if (effect.hits) base *= effect.hits
        if (effect.executeBelow && target.hp / target.maxHp <= effect.executeBelow) {
          base *= effect.executeMult || 2
        }
        if (effect.stealthBonus && hasStatus(ctx.source, 'shadowstep')) base *= 1 + effect.stealthBonus
        if (effect.vsControlled && (hasStatus(target, 'mez') || hasStatus(target, 'stun') || hasStatus(target, 'slow') || hasStatus(target, 'snare') || hasStatus(target, 'vulnerability'))) {
          base *= 1 + effect.vsControlled
        }
        // synergies / focus fire
        if (hasStatus(target, 'focus_fire')) base *= 1.25
        if (hasStatus(target, 'vulnerability') || hasStatus(target, 'resist_down')) base *= 1.15
        if (hasStatus(ctx.source, 'song_atk')) base *= 1.15
        if (hasStatus(ctx.source, 'lich') && effect.school !== 'physical') base *= 1.1

        let crit = false
        const critChance = 0.1 + (ctx.source?.critBonus || 0)
        if (ctx.state.rng() < critChance) {
          crit = true
          base *= 1.5
        }

        let dmg = Math.max(1, Math.round(base * mitigationMultiplier(target)))
        // shield absorb
        const shield = getStatus(target, 'shield')
        if (shield && shield.power > 0) {
          const absorb = Math.min(shield.power, dmg)
          shield.power -= absorb
          dmg -= absorb
          if (shield.power <= 0) removeStatus(target, 'shield')
        }
        if (dmg <= 0) continue
        target.hp = clamp(target.hp - dmg, 0, target.maxHp)
        total += dmg
        if (ctx.source && !target.isEnemy) {
          /* party damaging? unlikely */
        }
        if (ctx.source && target.isEnemy !== false && (target.isEnemy || ctx.state.enemies?.includes(target))) {
          addThreat(ctx.state, target.id, ctx.source.id, Math.round(dmg * (effect.threatMult || 1)))
        }
        if (target.hp <= 0) {
          target.hp = 0
          target.alive = false
          if (!target.isEnemy) ctx.state.knockouts = (ctx.state.knockouts || 0) + 1
          log(`${target.name} is defeated.`)
        }
        // thorns
        const thorns = getStatus(target, 'thorns')
        if (thorns && ctx.source && ctx.source.alive) {
          const reflect = Math.round(dmg * (thorns.power || 0.2))
          ctx.source.hp = clamp(ctx.source.hp - reflect, 0, ctx.source.maxHp)
          if (ctx.source.hp <= 0) {
            ctx.source.alive = false
            ctx.source.hp = 0
          }
        }
        meta.lastDamage = dmg
        meta.crit = crit
        log(`${ctx.source?.name || 'Someone'} hits ${target.name} for ${dmg}${crit ? ' (CRIT)' : ''}.`)
      }
      return { damage: total, ...meta }
    }

    case 'heal': {
      const targets = resolveTargets(effect, ctx)
      let total = 0
      for (const target of targets) {
        if (!target.alive && !effect.allowDead) continue
        let amount = 0
        if (effect.ratioOfDamage != null && meta.lastDamage) {
          amount = meta.lastDamage * effect.ratioOfDamage
        } else if (effect.pctMax != null) {
          amount = target.maxHp * effect.pctMax
        } else {
          amount = healPower(ctx.source) * (effect.power || 1)
        }
        amount = Math.round(amount * (1 + (ctx.source?.healEfficiency || 0)))
        const before = target.hp
        target.hp = clamp(target.hp + amount, 0, target.maxHp)
        const actual = target.hp - before
        total += actual
        if (ctx.source && actual > 0) {
          // healing threat on primary enemy
          const foe = livingEnemies(ctx)[0]
          if (foe) addThreat(ctx.state, foe.id, ctx.source.id, Math.round(actual * 0.5))
        }
        log(`${ctx.source?.name || 'Heal'} restores ${actual} HP to ${target.name}.`)
      }
      return { healed: total }
    }

    case 'healOverTime': {
      for (const target of resolveTargets(effect, ctx)) {
        applyStatusToUnit(target, 'hot', {
          power: effect.power || effect.pctMax || 0.08,
          duration: effect.duration || 3,
          sourceId: ctx.source?.id,
        })
        log(`${target.name} gains regeneration.`)
      }
      return {}
    }

    case 'damageOverTime': {
      for (const target of resolveTargets(effect, ctx)) {
        const id = effect.status || (effect.school === 'disease' ? 'disease' : 'poison')
        applyStatusToUnit(target, id, {
          power: Math.round(spellPower(ctx.source) * (effect.power || 0.35)),
          duration: effect.duration || 3,
          sourceId: ctx.source?.id,
        })
        if (hasStatus(target, 'mez')) breakMezOnDamage(target)
        log(`${target.name} is afflicted (${id}).`)
      }
      return {}
    }

    case 'applyStatus': {
      for (const target of resolveTargets(effect, ctx)) {
        let duration = effect.duration
        if (target.isBoss && effect.bossDurationCap != null) {
          duration = Math.min(duration ?? 1, effect.bossDurationCap)
        }
        if (target.isBoss && effect.bossChance === 0) {
          log(`${target.name} resists ${effect.status}.`)
          continue
        }
        applyStatusToUnit(target, effect.status, {
          power: effect.potency ?? effect.power ?? 1,
          duration,
          sourceId: ctx.source?.id,
        })
        log(`${target.name} gains ${effect.status}.`)
      }
      return {}
    }

    case 'removeStatus': {
      const list = effect.statuses || (effect.status ? [effect.status] : [])
      for (const target of resolveTargets(effect, ctx)) {
        for (const id of list) removeStatus(target, id)
      }
      return {}
    }

    case 'modifyThreat': {
      const enemy = livingEnemies(ctx)[0] || ctx.target
      if (!enemy || !ctx.source) return {}
      const amount = effect.amount || 0
      if (effect.target === 'self' || effect.mode === 'taunt') {
        addThreat(ctx.state, enemy.id, ctx.source.id, Math.abs(amount) || 80)
        applyStatusToUnit(enemy, 'taunt_lock', { duration: effect.duration || 2, sourceId: ctx.source.id })
        log(`${ctx.source.name} draws threat.`)
      } else if (amount < 0 || effect.mode === 'drop') {
        reduceThreat(ctx.state, enemy.id, ctx.source.id, Math.abs(amount) || 50)
        log(`${ctx.source.name} drops threat.`)
      } else {
        addThreat(ctx.state, enemy.id, ctx.source.id, amount)
      }
      return {}
    }

    case 'modifyResource': {
      for (const target of resolveTargets(effect, ctx)) {
        let resource = effect.resource
        let amount = effect.amount ?? (effect.pctMax != null ? Math.round((resource === 'mana' ? target.maxMana : target.maxEndurance) * effect.pctMax) : 0)
        if (resource === 'focus') {
          restoreResource(target, 'focus', amount || 12)
          log(`${target.name} focuses and recovers resources.`)
          continue
        }
        if (effect.spend) {
          spendResource(target, resource, amount)
        } else if (effect.convertFrom === 'hp') {
          const cost = Math.round(target.maxHp * (effect.hpCostPct || 0.1))
          target.hp = clamp(target.hp - cost, 1, target.maxHp)
          restoreResource(target, resource || 'mana', amount || Math.round(cost * 1.5))
          log(`${target.name} cannibalizes health for mana.`)
        } else {
          restoreResource(target, resource, amount)
          log(`${target.name} recovers ${amount} ${resource}.`)
        }
      }
      return {}
    }

    case 'interrupt': {
      const target = ctx.target
      if (!target) return {}
      if (target.casting) {
        target.casting = null
        applyStatusToUnit(target, 'silence', { duration: 1 })
        log(`${ctx.source?.name} interrupts ${target.name}!`)
        return { interrupted: true }
      }
      applyStatusToUnit(target, 'silence', { duration: 1 })
      log(`${ctx.source?.name} attempts interrupt on ${target.name}.`)
      return {}
    }

    case 'summon': {
      if (!ctx.state.pets) ctx.state.pets = []
      // one pet per owner
      ctx.state.pets = ctx.state.pets.filter((p) => p.ownerId !== ctx.source.id)
      const petPower = Math.round(spellPower(ctx.source) * (effect.power || 0.7) * (1 + (ctx.source.petPower || 0)))
      const pet = {
        id: `pet-${ctx.source.id}`,
        ownerId: ctx.source.id,
        name: effect.kind === 'spirit' ? `${ctx.source.name}'s Warder` : `${ctx.source.name}'s Elemental`,
        atk: petPower,
        maxHp: 40 + petPower,
        hp: 40 + petPower,
        alive: true,
        kind: effect.kind || 'elemental',
      }
      ctx.state.pets.push(pet)
      log(`${ctx.source.name} summons ${pet.name}.`)
      return { pet }
    }

    case 'redirectAttack': {
      applyStatusToUnit(ctx.source, 'intercept', { duration: 1, power: effect.mitigation || 0.3 })
      log(`${ctx.source.name} prepares to intercept.`)
      return {}
    }

    case 'shield': {
      for (const target of resolveTargets(effect, ctx)) {
        const amount = effect.pctMax != null
          ? Math.round(target.maxHp * effect.pctMax)
          : Math.round(healPower(ctx.source) * (effect.power || 1))
        applyStatusToUnit(target, 'shield', { power: amount, duration: effect.duration || 3 })
        log(`${target.name} gains a ${amount} absorb shield.`)
      }
      return {}
    }

    case 'resurrect': {
      const target = ctx.target
      if (!target || target.alive) return { ok: false }
      if (ctx.state.rezzesUsed >= 1) {
        log('Resurrection already used this encounter.')
        return { ok: false }
      }
      target.alive = true
      target.hp = Math.round(target.maxHp * (effect.pctMax || 0.4))
      ctx.state.rezzesUsed = (ctx.state.rezzesUsed || 0) + 1
      log(`${ctx.source.name} resurrects ${target.name}!`)
      return { ok: true }
    }

    case 'startCast': {
      if (!ctx.source) return {}
      ctx.source.casting = {
        abilityId: ctx.ability?.id,
        abilityName: ctx.ability?.name,
        remaining: effect.rounds || ctx.ability?.castTime || 1,
        interruptible: effect.interruptible !== false,
        onResolve: effect.onResolve || ctx.ability?.effects?.filter((e) => e.type !== 'startCast') || [],
        targetId: ctx.target?.id,
        protected: hasStatus(ctx.source, 'protect_caster'),
      }
      log(`${ctx.source.name} begins casting ${ctx.ability?.name || 'a spell'}…`)
      return { casting: true }
    }

    case 'modifyCooldown': {
      for (const target of resolveTargets(effect, ctx)) {
        if (!target.cooldowns) target.cooldowns = {}
        if (effect.ability) {
          target.cooldowns[effect.ability] = Math.max(0, (target.cooldowns[effect.ability] || 0) + (effect.delta || -1))
        } else {
          for (const k of Object.keys(target.cooldowns)) {
            target.cooldowns[k] = Math.max(0, target.cooldowns[k] + (effect.delta || -1))
          }
        }
      }
      return {}
    }

    case 'grantCommand': {
      const { grantCommandPoints } = awaitImportCommands()
      grantCommandPoints(ctx.state, effect.amount || 1)
      return {}
    }

    case 'stealCurrency': {
      ctx.state.expeditionCurrency = (ctx.state.expeditionCurrency || 0) + (effect.amount || 1)
      log(`${ctx.source?.name} pickpockets fictional audit tokens (+${effect.amount || 1}).`)
      return {}
    }

    case 'changeFormation': {
      if (ctx.source && effect.position) {
        ctx.source.position = effect.position
        log(`${ctx.source.name} moves to the ${effect.position}.`)
      }
      return {}
    }

    default:
      return null
  }
}

function awaitImportCommands() {
  // inline to avoid circular import issues at module top in some bundlers
  return { grantCommandPoints: (state, n) => {
    state.commandPoints = Math.min(6, (state.commandPoints || 0) + n)
  } }
}

/**
 * @param {object} condition
 * @param {object} ctx
 * @param {object} meta
 */
export function evaluateCondition(condition, ctx, meta = {}) {
  if (!condition) return true
  if (condition.whileTanking) {
    // approximate: has taunt_lock applied to any enemy from self, or highest threat
    return Boolean(ctx.source)
  }
  if (condition.targetHasAny) {
    const ids = condition.targetHasAny
    return ids.some((id) => hasStatus(ctx.target, id))
  }
  if (condition.targetDistracted) {
    const t = ctx.target
    return hasStatus(t, 'mez') || hasStatus(t, 'stun') || hasStatus(t, 'slow') || hasStatus(t, 'snare') || hasStatus(t, 'vulnerability')
  }
  if (condition.ownerHasStatus) {
    return hasStatus(ctx.source, condition.ownerHasStatus)
  }
  if (condition.abilityTag) {
    return Boolean(ctx.ability?.tags?.includes(condition.abilityTag))
  }
  if (condition.crit) return Boolean(meta.crit)
  if (condition.allyBelowHpPct != null) {
    return livingAllies(ctx).some((a) => a.hp / a.maxHp < condition.allyBelowHpPct)
  }
  return true
}

/**
 * Apply a list of effects sequentially.
 * @param {object} ctx
 * @param {object[]} effects
 */
export function applyEffects(ctx, effects) {
  const meta = {}
  for (const effect of effects || []) {
    if (effect.type === 'startCast') {
      applyEffect(ctx, effect, meta)
      return meta // delay rest until cast resolves
    }
    const result = applyEffect(ctx, effect, meta)
    if (result?.lastDamage) meta.lastDamage = result.lastDamage
    if (result?.crit) meta.crit = true
    if (result?.interrupted) meta.interrupted = true
  }
  return meta
}

/**
 * Tick HoT/DoT on a unit.
 * @param {object} state
 * @param {object} unit
 */
export function tickDotsAndHots(state, unit) {
  if (!unit?.statuses || !unit.alive) return
  for (const s of [...unit.statuses]) {
    if (s.id === 'poison' || s.id === 'disease') {
      const dmg = Math.round(s.power || 8)
      unit.hp = clamp(unit.hp - dmg, 0, unit.maxHp)
      state.log = [...(state.log || []).slice(-50), `${unit.name} suffers ${dmg} from ${s.id}.`]
      if (unit.hp <= 0) {
        unit.alive = false
        unit.hp = 0
      }
    }
    if (s.id === 'hot') {
      const heal = Math.round(unit.maxHp * (typeof s.power === 'number' && s.power < 1 ? s.power : 0.08))
      unit.hp = clamp(unit.hp + heal, 0, unit.maxHp)
    }
  }
}
