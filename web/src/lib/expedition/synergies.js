/** Mechanical party synergies — real combat modifiers, not display badges. */

import { hasStatus } from './statuses.js'

/**
 * @typedef {{ id: string, name: string, description: string, test: Function, modifyDamage?: Function, modifyCast?: Function, modifyCost?: Function }} Synergy
 */

/** @type {Synergy[]} */
export const SYNERGIES = [
  {
    id: 'warrior_rogue',
    name: 'Tank Focus Backstab',
    description: 'Rogue Backstab deals +35% vs enemy taunt-locked on the warrior.',
    test: (ctx) => ctx.ability?.id?.includes('backstab') && hasStatus(ctx.target, 'taunt_lock'),
    modifyDamage: (dmg) => dmg * 1.35,
  },
  {
    id: 'paladin_wizard',
    name: 'Stunned Nuke Window',
    description: 'Wizard delayed casts gain protection when target is stunned/silenced.',
    test: (ctx) => ctx.ability?.classId === 'Wizard' && ctx.ability?.castTime > 0 && (hasStatus(ctx.target, 'stun') || hasStatus(ctx.target, 'silence')),
    modifyCast: (cast) => {
      cast.protected = true
      return cast
    },
  },
  {
    id: 'shaman_cleric',
    name: 'Slowed Complete Heal',
    description: 'Complete Heal is harder to interrupt while enemy is slowed.',
    test: (ctx) => ctx.ability?.id === 'cleric_complete_heal' && hasStatus(ctx.target || ctx.state?.enemies?.[0], 'slow'),
    modifyCast: (cast) => {
      cast.protected = true
      return cast
    },
  },
  {
    id: 'enc_rogue_assassinate',
    name: 'Mez Break Assassinate',
    description: 'Assassinate gains execute bonus when target was recently controlled.',
    test: (ctx) => ctx.ability?.id?.includes('assassinate') && (hasStatus(ctx.target, 'mez') || hasStatus(ctx.target, 'vulnerability') || hasStatus(ctx.target, 'stun')),
    modifyDamage: (dmg) => dmg * 1.4,
  },
  {
    id: 'bard_wizard_mana',
    name: 'Mana Song Burn',
    description: 'Manaburn costs 25% less mana under Mana Song.',
    test: (ctx) => ctx.ability?.id?.includes('manaburn') && hasStatus(ctx.source, 'song_mana'),
    modifyCost: (cost) => Math.floor(cost * 0.75),
  },
  {
    id: 'mage_sk_pets',
    name: 'Pet Aggro Split',
    description: 'Pets deal +20% while a Shadow Knight holds taunt_lock.',
    test: (ctx) => ctx.meta?.fromPet && ctx.state?.enemies?.some((e) => hasStatus(e, 'taunt_lock')),
    modifyDamage: (dmg) => dmg * 1.2,
  },
  {
    id: 'druid_ranger',
    name: 'Snare Trueshot',
    description: 'Ranger shots deal +25% to snared targets.',
    test: (ctx) => ctx.ability?.classId === 'Ranger' && hasStatus(ctx.target, 'snare'),
    modifyDamage: (dmg) => dmg * 1.25,
  },
  {
    id: 'necro_shaman_dots',
    name: 'Malo DoTs',
    description: 'DoTs gain +30% potency when target has resist_down.',
    test: (ctx) => (ctx.ability?.tags?.includes('dot') || ctx.meta?.isDot) && hasStatus(ctx.target, 'resist_down'),
    modifyDamage: (dmg) => dmg * 1.3,
  },
  {
    id: 'monk_warrior_feign',
    name: 'Feign Reset',
    description: 'After Monk feign, Warrior taunt gains bonus threat.',
    test: (ctx) => ctx.ability?.id?.includes('taunt') && ctx.state?.party?.some((p) => p.class_name === 'Monk' && hasStatus(p, 'feign')),
    modifyDamage: (dmg) => dmg,
    // threat handled via meta flag
    onApply: (ctx) => {
      ctx.meta = ctx.meta || {}
      ctx.meta.threatBonus = 40
    },
  },
  {
    id: 'bard_monk_fists',
    name: 'Hymn Fists',
    description: 'Hundred Fists deals +20% under Battle Hymn.',
    test: (ctx) => ctx.ability?.id?.includes('hundred_fists') && hasStatus(ctx.source, 'song_atk'),
    modifyDamage: (dmg) => dmg * 1.2,
  },
  {
    id: 'enc_cleric_clarity',
    name: 'Clarity Healing',
    description: 'Cleric heals cost 15% less mana under Clarity.',
    test: (ctx) => ctx.ability?.classId === 'Cleric' && ctx.ability?.tags?.includes('healing') && hasStatus(ctx.source, 'clarity'),
    modifyCost: (cost) => Math.floor(cost * 0.85),
  },
  {
    id: 'bst_mage_pets',
    name: 'Double Pet Pressure',
    description: 'When both Magician and Beastlord pets are alive, pet damage +15%.',
    test: (ctx) => {
      const pets = ctx.state?.pets || []
      const kinds = new Set(pets.filter((p) => p.alive).map((p) => p.kind))
      return ctx.meta?.fromPet && kinds.has('elemental') && kinds.has('spirit')
    },
    modifyDamage: (dmg) => dmg * 1.15,
  },
]

/**
 * @param {object} ctx
 * @param {number} damage
 */
export function applyDamageSynergies(ctx, damage) {
  let dmg = damage
  const active = []
  for (const s of SYNERGIES) {
    if (s.test(ctx) && s.modifyDamage) {
      dmg = s.modifyDamage(dmg)
      active.push(s.id)
      s.onApply?.(ctx)
    }
  }
  return { damage: dmg, active }
}

/**
 * @param {object} ctx
 * @param {number} cost
 */
export function applyCostSynergies(ctx, cost) {
  let c = cost
  for (const s of SYNERGIES) {
    if (s.test(ctx) && s.modifyCost) c = s.modifyCost(c)
  }
  return c
}

export function listSynergyIds() {
  return SYNERGIES.map((s) => s.id)
}
