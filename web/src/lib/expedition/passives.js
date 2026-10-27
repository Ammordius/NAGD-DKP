/**
 * Quarm Expedition — class passives (data only; the engine interprets hooks).
 *
 * Hooks hold arrays of effects (same effect vocabulary as abilities.js) and may carry a
 * `condition` the engine evaluates before applying:
 *   whileTanking        — owner currently holds top threat on at least one enemy
 *   targetHasAny        — [statusId] on the target
 *   targetDistracted    — target is mezzed/stunned/feigned-on/snared/slowed or not attacking owner
 *   ownerHasStatus      — statusId on the owner
 *   abilityTag / source — tag of the triggering ability, or 'dot' | 'pet' | 'basic_attack'
 *   allyBelowHpPct      — any ally under this fraction of max HP
 *   crit                — triggering hit was a critical
 *   controlStatus       — [statusId] of the control being applied (onApplyControl)
 *
 * `modifiers` are passive constants the engine reads directly (additive unless noted).
 */

const status = (target, id, duration, o = {}) => ({ type: 'applyStatus', target, status: id, duration, ...o });

const CLASS_PASSIVES = Object.freeze({
  Warrior: {
    id: 'warrior_plate_wall',
    name: 'Plate Wall',
    classId: 'Warrior',
    description: 'Heavy plate: 15% less damage while holding aggro, and each hit taken builds threat.',
    modifiers: { tankMitigation: 0.15 },
    hooks: {
      onEncounterStart: [
        status('self', 'damage_reduction', 1, { potency: 0.15, condition: { whileTanking: true } }),
      ],
      onRoundEnd: [
        status('self', 'damage_reduction', 1, { potency: 0.15, condition: { whileTanking: true } }),
      ],
      onDamageTaken: [{ type: 'modifyThreat', target: 'attacker', amount: 6 }],
    },
  },

  Paladin: {
    id: 'paladin_blessed_plate',
    name: 'Blessed Plate',
    classId: 'Paladin',
    description: 'Plate while tanking (10% less damage); your holy strikes mend the most wounded ally.',
    modifiers: { tankMitigation: 0.1 },
    hooks: {
      onEncounterStart: [
        status('self', 'damage_reduction', 1, { potency: 0.1, condition: { whileTanking: true } }),
      ],
      onRoundEnd: [
        status('self', 'damage_reduction', 1, { potency: 0.1, condition: { whileTanking: true } }),
      ],
      onDealDamage: [
        {
          type: 'heal',
          target: 'lowest_ally',
          ratioOfDamage: 0.15,
          condition: { abilityTag: 'holy' },
        },
      ],
    },
  },

  'Shadow Knight': {
    id: 'shadow_knight_dark_bulwark',
    name: 'Dark Bulwark',
    classId: 'Shadow Knight',
    description: 'Plate while tanking (10% less damage); drain attacks heal you for extra.',
    modifiers: { tankMitigation: 0.1, drainBonus: 0.2 },
    hooks: {
      onEncounterStart: [
        status('self', 'damage_reduction', 1, { potency: 0.1, condition: { whileTanking: true } }),
      ],
      onRoundEnd: [
        status('self', 'damage_reduction', 1, { potency: 0.1, condition: { whileTanking: true } }),
      ],
      onDealDamage: [
        {
          type: 'heal',
          target: 'self',
          ratioOfDamage: 0.1,
          condition: { abilityTag: 'drain' },
        },
      ],
    },
  },

  Cleric: {
    id: 'cleric_divine_efficiency',
    name: 'Divine Efficiency',
    classId: 'Cleric',
    description: 'Heals cost 15% less mana, and you regain mana as the party is wounded.',
    modifiers: { healCostMult: 0.85, healPower: 0.1 },
    hooks: {
      onEncounterStart: [{ type: 'modifyResource', target: 'self', resource: 'mana', pctMax: 0.05 }],
      onRoundEnd: [
        {
          type: 'modifyResource',
          target: 'self',
          resource: 'mana',
          pctMax: 0.04,
          condition: { allyBelowHpPct: 0.6 },
        },
      ],
    },
  },

  Druid: {
    id: 'druid_natures_bounty',
    name: "Nature's Bounty",
    classId: 'Druid',
    description: 'Heal-over-time effects are 20% stronger; the party starts each fight with a light regrowth.',
    modifiers: { hotPotency: 0.2 },
    hooks: {
      onEncounterStart: [
        status('all_allies', 'hot', 2, { potency: 0.03 }),
        { type: 'healOverTime', target: 'all_allies', pctMax: 0.03, duration: 2 },
      ],
      onRoundEnd: [
        {
          type: 'heal',
          target: 'self',
          pctMax: 0.03,
          condition: { ownerHasStatus: 'thorns' },
        },
      ],
    },
  },

  Shaman: {
    id: 'shaman_ancestral_vigor',
    name: 'Ancestral Vigor',
    classId: 'Shaman',
    description: 'Debuffs last 1 round longer, and each one you land refunds a little mana.',
    modifiers: { debuffDuration: 1 },
    hooks: {
      onApplyControl: [
        {
          type: 'modifyResource',
          target: 'self',
          resource: 'mana',
          pctMax: 0.04,
          condition: { controlStatus: ['slow', 'resist_down', 'snare'] },
        },
      ],
      onRoundEnd: [
        {
          type: 'heal',
          target: 'lowest_ally',
          pctMax: 0.03,
          condition: { allyBelowHpPct: 0.5 },
        },
      ],
    },
  },

  Enchanter: {
    id: 'enchanter_mind_mastery',
    name: 'Mind Mastery',
    classId: 'Enchanter',
    description: 'Crowd control lasts 1 round longer; each control spell refunds mana.',
    modifiers: { controlDuration: 1, bossControlDuration: 0 },
    hooks: {
      onApplyControl: [
        {
          type: 'modifyResource',
          target: 'self',
          resource: 'mana',
          pctMax: 0.05,
          condition: { controlStatus: ['mez', 'stun', 'fear', 'silence'] },
        },
      ],
      onEncounterStart: [status('self', 'clarity', 2, { manaPerRound: 0.04 })],
    },
  },

  Bard: {
    id: 'bard_twisted_rhythm',
    name: 'Twisted Rhythm',
    classId: 'Bard',
    description: 'Songs last 1 round longer; you recover endurance each round and open with a free hymn.',
    modifiers: { songDuration: 1 },
    hooks: {
      onEncounterStart: [
        status('all_allies', 'song_atk', 2, { potency: 0.1 }),
      ],
      onRoundEnd: [
        { type: 'modifyResource', target: 'self', resource: 'endurance', amount: 2 },
      ],
    },
  },

  Wizard: {
    id: 'wizard_arcane_surge',
    name: 'Arcane Surge',
    classId: 'Wizard',
    description: 'Spells crit 10% more often; each critical spell returns mana.',
    modifiers: { critChance: 0.1, spellPower: 0.1 },
    hooks: {
      onDealDamage: [
        {
          type: 'modifyResource',
          target: 'self',
          resource: 'mana',
          pctMax: 0.04,
          condition: { crit: true },
        },
      ],
      onDamageTaken: [{ type: 'modifyThreat', target: 'attacker', amount: -3, owner: 'self' }],
    },
  },

  Magician: {
    id: 'magician_elemental_mastery',
    name: 'Elemental Mastery',
    classId: 'Magician',
    description: 'Your pet hits 25% harder and the elemental mends itself each round.',
    modifiers: { petPower: 0.25 },
    hooks: {
      onEncounterStart: [status('pet', 'pet_buff', 2, { petDamageMod: 0.15 })],
      onRoundEnd: [{ type: 'heal', target: 'pet', pctMax: 0.05 }],
    },
  },

  Necromancer: {
    id: 'necromancer_unholy_vigor',
    name: 'Unholy Vigor',
    classId: 'Necromancer',
    description: 'Damage-over-time is 20% stronger, and each tick heals you slightly.',
    modifiers: { dotPotency: 0.2 },
    hooks: {
      onDealDamage: [
        {
          type: 'heal',
          target: 'self',
          ratioOfDamage: 0.2,
          condition: { source: 'dot' },
        },
      ],
      onRoundEnd: [
        {
          type: 'modifyResource',
          target: 'self',
          resource: 'mana',
          pctMax: 0.03,
          condition: { ownerHasStatus: 'lich' },
        },
      ],
    },
  },

  Ranger: {
    id: 'ranger_hunters_mark',
    name: "Hunter's Mark",
    classId: 'Ranger',
    description: 'Deal 20% extra damage to snared, slowed or mezzed enemies, and crit more against them.',
    modifiers: { critVsDistracted: 0.2 },
    hooks: {
      onDealDamage: [
        {
          type: 'damage',
          target: 'target',
          ratioOfDamage: 0.2,
          school: 'physical',
          source: 'passive',
          condition: { targetHasAny: ['snare', 'slow', 'mez'] },
        },
      ],
      onEncounterStart: [{ type: 'grantCommand', target: 'self', command: 'precision_strike', uses: 1 }],
    },
  },

  Rogue: {
    id: 'rogue_opportunist',
    name: 'Opportunist',
    classId: 'Rogue',
    description: 'Crit chance rises against distracted enemies; you open each fight unseen.',
    modifiers: { critVsDistracted: 0.3 },
    hooks: {
      onEncounterStart: [status('self', 'evade', 1)],
      onDealDamage: [
        {
          type: 'damage',
          target: 'target',
          ratioOfDamage: 0.3,
          school: 'physical',
          source: 'passive',
          condition: { targetDistracted: true },
        },
      ],
    },
  },

  Monk: {
    id: 'monk_inner_balance',
    name: 'Inner Balance',
    classId: 'Monk',
    description: 'Dodge 10% more attacks; pain focuses you, and you mend a little each round.',
    modifiers: { dodgeChance: 0.1 },
    hooks: {
      onDamageTaken: [{ type: 'modifyResource', target: 'self', resource: 'endurance', amount: 3 }],
      onRoundEnd: [{ type: 'heal', target: 'self', pctMax: 0.02 }],
    },
  },

  Beastlord: {
    id: 'beastlord_primal_bond',
    name: 'Primal Bond',
    classId: 'Beastlord',
    description: 'Your warder hits 15% harder, and you and it recover health together each round.',
    modifiers: { petPower: 0.15 },
    hooks: {
      onEncounterStart: [status('pet', 'pet_buff', 2, { petDamageMod: 0.1 })],
      onRoundEnd: [
        { type: 'heal', target: 'self', pctMax: 0.03 },
        { type: 'heal', target: 'pet', pctMax: 0.03 },
      ],
    },
  },
});

export { CLASS_PASSIVES };

export function getPassive(className) {
  return CLASS_PASSIVES[className] ?? null;
}
