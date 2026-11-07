/**
 * Deterministic action policies for Expedition balance simulations.
 */

import { availableActions } from './gameEngine.js'
import { smartAllyTarget, smartEnemyTarget } from './targeting.js'

function livingEnemies(state) {
  return (state.enemies || []).filter((e) => e.alive)
}

function livingParty(state) {
  return (state.party || []).filter((p) => p.alive && p.hp > 0)
}

function lowestHpPct(party) {
  const live = livingParty({ party })
  if (!live.length) return 1
  return Math.min(...live.map((p) => p.hp / p.maxHp))
}

function enemyCasting(state) {
  return livingEnemies(state).find((e) => e.casting?.interruptible)
}

function hasTag(opt, ...tags) {
  const t = opt.tags || []
  return tags.some((tag) => t.includes(tag))
}

function pickTarget(state, opt, preferredAllyId, preferredEnemyId) {
  if (opt.needsDeadAlly) {
    return { targetId: smartAllyTarget(state.party, preferredAllyId, { dead: true }) }
  }
  if (opt.needsAllyTarget) {
    return { targetId: smartAllyTarget(state.party, preferredAllyId) }
  }
  if (opt.needsEnemyTarget) {
    const casting = enemyCasting(state)
    const prefer =
      hasTag(opt, 'interrupt', 'crowd_control') && casting
        ? casting.id
        : preferredEnemyId
    return { targetId: smartEnemyTarget(state.enemies, prefer) }
  }
  return {}
}

/** Always basic_attack the first living enemy. */
export function basicSpam(state) {
  const actions = {}
  const enemyId = livingEnemies(state)[0]?.id
  for (const p of livingParty(state)) {
    const opts = availableActions(state, p)
    const basic = opts.find((o) => o.id === 'basic_attack') || opts[0]
    if (!basic) continue
    actions[p.id] = {
      actionId: basic.id,
      targetId: basic.needsEnemyTarget ? enemyId : undefined,
    }
  }
  return actions
}

/** Prefer class offense over basic; never heal/CC unless that is the only option. */
export function offenseOnly(state) {
  const actions = {}
  const enemyId = livingEnemies(state)[0]?.id
  for (const p of livingParty(state)) {
    const opts = availableActions(state, p)
    const prefer =
      opts.find((o) => o.group === 'offensive' && o.id !== 'basic_attack') ||
      opts.find((o) => o.id === 'basic_attack') ||
      opts[0]
    if (!prefer) continue
    actions[p.id] = {
      actionId: prefer.id,
      targetId: prefer.needsAllyTarget
        ? p.id
        : prefer.needsEnemyTarget
          ? enemyId
          : undefined,
    }
  }
  return actions
}

/**
 * Heuristic skilled play: interrupt → clutch heals/shields → utility CC/buffs → offense.
 */
export function skilledSupport(state) {
  const actions = {}
  const party = livingParty(state)
  const lowest = lowestHpPct(state.party)
  const casting = enemyCasting(state)
  const hurtAlly = party.slice().sort((a, b) => a.hp / a.maxHp - b.hp / b.hp)[0]
  const deadAlly = (state.party || []).find((p) => !p.alive)

  for (const p of party) {
    const opts = availableActions(state, p)
    if (!opts.length) continue

    let chosen = null

    // 1) Rez if someone is down
    if (deadAlly) {
      chosen = opts.find((o) => hasTag(o, 'resurrect'))
    }

    // 2) Interrupt enemy casts
    if (!chosen && casting) {
      chosen = opts.find((o) => hasTag(o, 'interrupt'))
    }

    // 3) Emergency prevention / big heals
    if (!chosen && lowest <= 0.45) {
      chosen =
        opts.find((o) => hasTag(o, 'ward', 'prevention')) ||
        opts.find((o) => hasTag(o, 'big_heal') || (hasTag(o, 'heal') && o.castTime > 0)) ||
        opts.find((o) => hasTag(o, 'heal', 'hot')) ||
        opts.find((o) => hasTag(o, 'heal'))
    }

    // 4) Mid damage — keep party topped / shielded
    if (!chosen && lowest <= 0.75) {
      chosen =
        opts.find((o) => hasTag(o, 'heal', 'fast') || (hasTag(o, 'heal') && !o.castTime)) ||
        opts.find((o) => hasTag(o, 'hot')) ||
        opts.find((o) => hasTag(o, 'ward', 'prevention')) ||
        opts.find((o) => hasTag(o, 'heal'))
    }

    // 5) Soft utility: slow / mez / party buffs / DR
    if (!chosen) {
      const enemy = livingEnemies(state)[0]
      const alreadyControlled =
        enemy &&
        (enemy.statuses || []).some((s) =>
          ['mez', 'stun', 'slow', 'snare', 'fear'].includes(s.id || s.status),
        )
      if (!alreadyControlled) {
        chosen = opts.find((o) => hasTag(o, 'crowd_control', 'slow', 'mez', 'fear'))
      }
    }
    if (!chosen) {
      chosen =
        opts.find((o) => hasTag(o, 'party_buff', 'song', 'buff') && o.group !== 'offensive') ||
        opts.find((o) => o.group === 'defensive' && hasTag(o, 'damage_reduction', 'ward'))
    }

    // 6) Class offense, then basic
    if (!chosen) {
      chosen =
        opts.find((o) => o.group === 'offensive' && o.id !== 'basic_attack') ||
        opts.find((o) => o.id === 'basic_attack') ||
        opts[0]
    }

    const allyPrefer = hurtAlly?.id
    const enemyPrefer = casting?.id || livingEnemies(state)[0]?.id
    actions[p.id] = {
      actionId: chosen.id,
      ...pickTarget(state, chosen, allyPrefer, enemyPrefer),
    }
  }
  return actions
}

export const POLICIES = {
  basicSpam,
  offenseOnly,
  skilledSupport,
}

export function getPolicy(name) {
  return POLICIES[name] || skilledSupport
}
