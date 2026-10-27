/**
 * Quarm Expedition — ability definitions (data only; the engine interprets effects).
 *
 * Effect conventions
 *  - target:  'self' | 'target' | 'lowest_ally' | 'all_allies' | 'all_enemies' | 'pet'
 *  - power:   multiplier of the caster's attack (physical) or spell power (magic/heal).
 *  - pctMax:  flat fraction of the recipient's max HP (heal) or resource pool (modifyResource).
 *  - potency: strength of a status (fraction, e.g. 0.25 = 25%).
 *  - duration: rounds. bossDurationCap: max rounds when the target is a boss.
 *  - ratioOfDamage: fraction of damage just dealt (lifesteal, shields, etc.).
 *  - startCast wraps onResolve effects: the cast resolves `rounds` later and can be interrupted.
 */

// ---------------------------------------------------------------------------
// Effect builders
// ---------------------------------------------------------------------------

const fx = {
  damage: (power, o = {}) => ({ type: 'damage', target: 'target', power, school: 'physical', ...o }),
  heal: (target, o = {}) => ({ type: 'heal', target, ...o }),
  hot: (target, power, duration, o = {}) => ({ type: 'healOverTime', target, power, duration, ...o }),
  dot: (power, duration, o = {}) => ({
    type: 'damageOverTime',
    target: 'target',
    power,
    duration,
    school: 'magic',
    ...o,
  }),
  status: (target, status, duration, o = {}) => ({ type: 'applyStatus', target, status, duration, ...o }),
  cleanse: (target, statuses, o = {}) => ({ type: 'removeStatus', target, statuses, ...o }),
  threat: (target, amount, o = {}) => ({ type: 'modifyThreat', target, amount, ...o }),
  resource: (target, resource, o = {}) => ({ type: 'modifyResource', target, resource, ...o }),
  interrupt: (o = {}) => ({ type: 'interrupt', target: 'target', ...o }),
  summon: (kind, o = {}) => ({ type: 'summon', kind, ...o }),
  redirect: (from, to, o = {}) => ({ type: 'redirectAttack', from, to, ...o }),
  shield: (target, o = {}) => ({ type: 'shield', target, ...o }),
  cast: (rounds, onResolve, o = {}) => ({
    type: 'startCast',
    rounds,
    interruptible: true,
    onResolve,
    ...o,
  }),
  cooldown: (target, ability, delta) => ({ type: 'modifyCooldown', target, ability, delta }),
  command: (target, command, o = {}) => ({ type: 'grantCommand', target, command, ...o }),
};

// ---------------------------------------------------------------------------
// Ability factory
// ---------------------------------------------------------------------------

function toSnake(text) {
  return String(text)
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function make(classId, name, spec) {
  const {
    group,
    targetType,
    resource = 'none',
    cost = 0,
    cooldown = 0,
    castTime = 0,
    tags = [],
    effects,
    description,
  } = spec;
  return Object.freeze({
    id: `${toSnake(classId)}_${toSnake(name)}`,
    name,
    classId,
    group,
    targetType,
    resource,
    cost,
    cooldown,
    castTime,
    tags: Object.freeze([...tags]),
    effects: Object.freeze(effects),
    description,
  });
}

// ---------------------------------------------------------------------------
// Universal actions
// ---------------------------------------------------------------------------

export const UNIVERSAL_ACTIONS = Object.freeze([
  Object.freeze({
    id: 'basic_attack',
    name: 'Basic Attack',
    classId: 'Universal',
    group: 'offensive',
    targetType: 'single_enemy',
    resource: 'none',
    cost: 0,
    cooldown: 0,
    castTime: 0,
    tags: Object.freeze(['universal', 'attack']),
    effects: Object.freeze([fx.damage(1.0, { source: 'basic_attack' })]),
    description: 'A plain attack with your weapon or staff.',
  }),
  Object.freeze({
    id: 'defend',
    name: 'Defend',
    classId: 'Universal',
    group: 'defensive',
    targetType: 'self',
    resource: 'none',
    cost: 0,
    cooldown: 0,
    castTime: 0,
    tags: Object.freeze(['universal', 'defense']),
    effects: Object.freeze([
      fx.status('self', 'damage_reduction', 1, { potency: 0.35 }),
      fx.resource('self', 'endurance', { pctMax: 0.1 }),
    ]),
    description: 'Brace for impact: take 35% less damage this round and recover some endurance.',
  }),
  Object.freeze({
    id: 'focus',
    name: 'Focus',
    classId: 'Universal',
    group: 'support',
    targetType: 'self',
    resource: 'none',
    cost: 0,
    cooldown: 0,
    castTime: 0,
    tags: Object.freeze(['universal', 'resource']),
    effects: Object.freeze([fx.resource('self', 'focus', { pctMax: 0.2 })]),
    description: 'Meditate: restore 20% of your class resource (engine picks mana or endurance).',
  }),
  Object.freeze({
    id: 'use_consumable',
    name: 'Use Consumable',
    classId: 'Universal',
    group: 'support',
    targetType: 'self',
    resource: 'none',
    cost: 0,
    cooldown: 0,
    castTime: 0,
    tags: Object.freeze(['universal', 'consumable']),
    effects: Object.freeze([fx.heal('self', { pctMax: 0.3, source: 'consumable' })]),
    description: 'Use a carried consumable (potion, bandages) to heal.',
  }),
]);

// ---------------------------------------------------------------------------
// Class abilities
// ---------------------------------------------------------------------------

const WARRIOR = 'Warrior';
const PALADIN = 'Paladin';
const SHADOW_KNIGHT = 'Shadow Knight';
const CLERIC = 'Cleric';
const DRUID = 'Druid';
const SHAMAN = 'Shaman';
const ENCHANTER = 'Enchanter';
const BARD = 'Bard';
const WIZARD = 'Wizard';
const MAGICIAN = 'Magician';
const NECROMANCER = 'Necromancer';
const RANGER = 'Ranger';
const ROGUE = 'Rogue';
const MONK = 'Monk';
const BEASTLORD = 'Beastlord';

const warriorAbilities = [
  make(WARRIOR, 'Taunt', {
    group: 'defensive',
    targetType: 'single_enemy',
    resource: 'endurance',
    cost: 8,
    cooldown: 2,
    tags: ['taunt', 'threat'],
    effects: [
      fx.threat('target', 60, { mode: 'set_top' }),
      fx.status('target', 'taunt_lock', 2, { bossDurationCap: 1 }),
    ],
    description: 'Seize aggro and force the enemy to attack you.',
  }),
  make(WARRIOR, 'Defensive Discipline', {
    group: 'defensive',
    targetType: 'self',
    resource: 'endurance',
    cost: 15,
    cooldown: 4,
    tags: ['discipline', 'mitigation'],
    effects: [
      fx.status('self', 'damage_reduction', 2, { potency: 0.45 }),
      fx.heal('self', { pctMax: 0.08 }),
    ],
    description: 'Take 45% less damage for 2 rounds and recover a little health.',
  }),
  make(WARRIOR, 'Shield Bash', {
    group: 'offensive',
    targetType: 'single_enemy',
    resource: 'endurance',
    cost: 10,
    cooldown: 2,
    tags: ['melee', 'crowd_control', 'interrupt'],
    effects: [
      fx.damage(0.7),
      fx.interrupt(),
      fx.status('target', 'stun', 1, { bossDurationCap: 0, bossChance: 0.25 }),
    ],
    description: 'Bash for damage, interrupt a cast, and stun briefly.',
  }),
  make(WARRIOR, 'Rampage', {
    group: 'offensive',
    targetType: 'all_enemies',
    resource: 'endurance',
    cost: 20,
    cooldown: 3,
    tags: ['melee', 'aoe', 'threat'],
    effects: [
      fx.damage(0.7, { target: 'all_enemies' }),
      fx.threat('all_enemies', 25),
      fx.status('self', 'vulnerability', 1, { potency: 0.2 }),
    ],
    description: 'Strike every enemy and gain threat, but leave yourself exposed.',
  }),
  make(WARRIOR, 'Intercept', {
    group: 'defensive',
    targetType: 'single_ally',
    resource: 'endurance',
    cost: 12,
    cooldown: 3,
    tags: ['guard', 'redirect'],
    effects: [
      fx.status('self', 'intercept', 2, { guarding: 'target' }),
      fx.redirect('target', 'self', { share: 1.0, duration: 2 }),
    ],
    description: 'Step in front of an ally; attacks aimed at them hit you instead.',
  }),
  make(WARRIOR, 'Last Stand', {
    group: 'defensive',
    targetType: 'self',
    resource: 'endurance',
    cost: 25,
    cooldown: 5,
    tags: ['discipline', 'emergency'],
    effects: [
      fx.status('self', 'last_stand', 2, { minHp: 1 }),
      fx.heal('self', { pctMax: 0.15 }),
      fx.threat('all_enemies', 30),
    ],
    description: 'Cannot fall below 1 HP for 2 rounds. Heal a bit and draw aggro.',
  }),
];

const paladinAbilities = [
  make(PALADIN, 'Holy Strike', {
    group: 'offensive',
    targetType: 'single_enemy',
    resource: 'mana',
    cost: 12,
    cooldown: 1,
    tags: ['melee', 'holy', 'lifesteal'],
    effects: [
      fx.damage(1.1, { school: 'holy' }),
      fx.heal('self', { ratioOfDamage: 0.3 }),
    ],
    description: 'Smite for holy damage and heal yourself for part of it.',
  }),
  make(PALADIN, 'Stun', {
    group: 'support',
    targetType: 'single_enemy',
    resource: 'mana',
    cost: 15,
    cooldown: 3,
    tags: ['crowd_control', 'interrupt', 'holy'],
    effects: [
      fx.damage(0.4, { school: 'holy' }),
      fx.interrupt(),
      fx.status('target', 'stun', 1, { bossDurationCap: 0, bossChance: 0.2 }),
    ],
    description: 'Stun an enemy for a round and break its cast.',
  }),
  make(PALADIN, 'Lay on Hands', {
    group: 'support',
    targetType: 'single_ally',
    resource: 'mana',
    cost: 30,
    cooldown: 5,
    tags: ['heal', 'emergency', 'holy'],
    effects: [
      fx.heal('target', { pctMax: 0.6 }),
      fx.cleanse('target', ['poison', 'disease']),
    ],
    description: 'Emergency heal for 60% of max health and cleanse poison and disease.',
  }),
  make(PALADIN, 'Divine Aura', {
    group: 'defensive',
    targetType: 'self',
    resource: 'mana',
    cost: 35,
    cooldown: 5,
    tags: ['invulnerable', 'holy'],
    effects: [
      fx.status('self', 'damage_reduction', 1, { potency: 1.0 }),
      fx.cleanse('self', ['stun', 'slow', 'snare', 'fear']),
    ],
    description: 'Become immune to damage for 1 round and shake off control.',
  }),
  make(PALADIN, 'Flash of Light', {
    group: 'support',
    targetType: 'single_ally',
    resource: 'mana',
    cost: 14,
    cooldown: 0,
    tags: ['heal', 'holy', 'fast'],
    effects: [
      fx.heal('target', { power: 0.9 }),
      fx.cleanse('target', ['disease']),
    ],
    description: 'A quick modest heal that also cures disease.',
  }),
  make(PALADIN, 'Group Ward', {
    group: 'defensive',
    targetType: 'all_allies',
    resource: 'mana',
    cost: 28,
    cooldown: 4,
    tags: ['ward', 'aoe', 'holy'],
    effects: [
      fx.shield('all_allies', { absorbPct: 0.12, duration: 2 }),
      fx.status('all_allies', 'shield', 2, { potency: 0.12 }),
    ],
    description: 'Wrap the party in a holy shield that absorbs damage.',
  }),
];

const shadowKnightAbilities = [
  make(SHADOW_KNIGHT, 'Harm Touch', {
    group: 'offensive',
    targetType: 'single_enemy',
    resource: 'endurance',
    cost: 25,
    cooldown: 5,
    tags: ['melee', 'burst', 'sacrifice'],
    effects: [
      fx.damage(3.0, { school: 'shadow' }),
      fx.damage(0.0, { target: 'self', pctMaxHp: 0.1, school: 'sacrifice' }),
    ],
    description: 'Huge shadow strike that costs you 10% of your own health.',
  }),
  make(SHADOW_KNIGHT, 'Life Tap', {
    group: 'offensive',
    targetType: 'single_enemy',
    resource: 'mana',
    cost: 12,
    cooldown: 1,
    tags: ['drain', 'lifesteal'],
    effects: [
      fx.damage(0.9, { school: 'shadow' }),
      fx.heal('self', { ratioOfDamage: 0.6 }),
      fx.threat('target', 10),
    ],
    description: 'Drain life from an enemy, healing yourself and gaining threat.',
  }),
  make(SHADOW_KNIGHT, 'Disease Cloud', {
    group: 'offensive',
    targetType: 'all_enemies',
    resource: 'mana',
    cost: 20,
    cooldown: 3,
    tags: ['dot', 'aoe', 'disease'],
    effects: [
      fx.dot(0.35, 3, { target: 'all_enemies', school: 'disease' }),
      fx.status('all_enemies', 'disease', 3, { healingReceivedMod: -0.25 }),
    ],
    description: 'Poison the air: all enemies take disease damage and receive less healing.',
  }),
  make(SHADOW_KNIGHT, 'Shadow Taunt', {
    group: 'defensive',
    targetType: 'single_enemy',
    resource: 'mana',
    cost: 10,
    cooldown: 2,
    tags: ['taunt', 'threat', 'shadow'],
    effects: [
      fx.threat('target', 45, { mode: 'set_top' }),
      fx.status('target', 'taunt_lock', 2, { bossDurationCap: 1 }),
      fx.status('target', 'resist_down', 2, { potency: 0.1 }),
    ],
    description: 'Taunt with dark power, also lowering the enemy\u2019s resists.',
  }),
  make(SHADOW_KNIGHT, 'Feign Death', {
    group: 'defensive',
    targetType: 'self',
    resource: 'mana',
    cost: 8,
    cooldown: 4,
    tags: ['feign', 'threat_drop'],
    effects: [
      fx.status('self', 'feign', 1, { failChance: 0.2 }),
      fx.threat('all_enemies', -100, { mode: 'reduce_pct' }),
    ],
    description: 'Drop all threat. Can fail against some foes.',
  }),
  make(SHADOW_KNIGHT, 'Terror', {
    group: 'support',
    targetType: 'single_enemy',
    resource: 'mana',
    cost: 18,
    cooldown: 4,
    tags: ['crowd_control', 'fear'],
    effects: [
      fx.damage(0.4, { school: 'shadow' }),
      fx.status('target', 'fear', 2, { breaksOnDamage: false, bossDurationCap: 1, bossChance: 0.5 }),
    ],
    description: 'Terrify one enemy so it flees for a round or two.',
  }),
];

const clericAbilities = [
  make(CLERIC, 'Complete Heal', {
    group: 'support',
    targetType: 'single_ally',
    resource: 'mana',
    cost: 45,
    cooldown: 2,
    castTime: 1,
    tags: ['heal', 'delayed', 'big_heal'],
    effects: [fx.cast(1, [fx.heal('target', { pctMax: 1.0 })])],
    description: 'Cast for a round, then restore an ally to full health. Can be interrupted.',
  }),
  make(CLERIC, 'Fast Remedy', {
    group: 'support',
    targetType: 'single_ally',
    resource: 'mana',
    cost: 12,
    cooldown: 0,
    tags: ['heal', 'fast'],
    effects: [fx.heal('target', { power: 1.0 })],
    description: 'Instant small heal.',
  }),
  make(CLERIC, 'Group Heal', {
    group: 'support',
    targetType: 'all_allies',
    resource: 'mana',
    cost: 35,
    cooldown: 2,
    tags: ['heal', 'aoe'],
    effects: [fx.heal('all_allies', { power: 0.9 })],
    description: 'Heal the entire party.',
  }),
  make(CLERIC, 'Divine Barrier', {
    group: 'defensive',
    targetType: 'single_ally',
    resource: 'mana',
    cost: 30,
    cooldown: 4,
    tags: ['ward', 'prevention'],
    effects: [
      fx.shield('target', { absorbPct: 0.4, duration: 2 }),
      fx.status('target', 'shield', 2, { potency: 0.4 }),
    ],
    description: 'Place a barrier on an ally that absorbs 40% of their max health in damage.',
  }),
  make(CLERIC, 'Stun', {
    group: 'support',
    targetType: 'single_enemy',
    resource: 'mana',
    cost: 15,
    cooldown: 3,
    tags: ['crowd_control', 'interrupt', 'holy'],
    effects: [
      fx.damage(0.3, { school: 'holy' }),
      fx.interrupt(),
      fx.status('target', 'stun', 1, { bossDurationCap: 0, bossChance: 0.2 }),
    ],
    description: 'Stun an enemy and break its cast.',
  }),
  make(CLERIC, 'Resurrection', {
    group: 'support',
    targetType: 'single_ally',
    resource: 'mana',
    cost: 60,
    cooldown: 5,
    castTime: 1,
    tags: ['resurrect', 'delayed', 'targets_dead'],
    effects: [fx.cast(1, [{ type: 'resurrect', target: 'target', hpPct: 0.35 }])],
    description: 'Cast for a round to return a fallen ally with 35% health.',
  }),
];

const druidAbilities = [
  make(DRUID, 'Regrowth', {
    group: 'support',
    targetType: 'single_ally',
    resource: 'mana',
    cost: 16,
    cooldown: 1,
    tags: ['heal', 'hot', 'nature'],
    effects: [
      fx.heal('target', { power: 0.6 }),
      fx.hot('target', 0.35, 3),
      fx.status('target', 'hot', 3),
    ],
    description: 'A small heal plus a heal over time on one ally.',
  }),
  make(DRUID, "Nature's Wrath", {
    group: 'offensive',
    targetType: 'single_enemy',
    resource: 'mana',
    cost: 30,
    cooldown: 2,
    castTime: 1,
    tags: ['nuke', 'delayed', 'nature'],
    effects: [fx.cast(1, [fx.damage(2.4, { school: 'nature' })])],
    description: 'Call down a heavy nature strike after a round of casting.',
  }),
  make(DRUID, 'Snare', {
    group: 'support',
    targetType: 'single_enemy',
    resource: 'mana',
    cost: 12,
    cooldown: 2,
    tags: ['snare', 'debuff', 'nature'],
    effects: [
      fx.status('target', 'snare', 3, { potency: 0.3 }),
      fx.dot(0.2, 3, { school: 'nature' }),
    ],
    description: 'Entangle an enemy: it deals less damage and takes small nature damage.',
  }),
  make(DRUID, 'Thornshield', {
    group: 'defensive',
    targetType: 'single_ally',
    resource: 'mana',
    cost: 18,
    cooldown: 3,
    tags: ['buff', 'thorns', 'nature'],
    effects: [fx.status('target', 'thorns', 3, { potency: 0.4, school: 'nature' })],
    description: 'Attackers of this ally take nature damage for 3 rounds.',
  }),
  make(DRUID, 'Rejuvenation', {
    group: 'support',
    targetType: 'all_allies',
    resource: 'mana',
    cost: 30,
    cooldown: 3,
    tags: ['heal', 'hot', 'aoe', 'nature'],
    effects: [
      fx.hot('all_allies', 0.45, 4),
      fx.status('all_allies', 'hot', 4),
    ],
    description: 'A party-wide heal over time for 4 rounds.',
  }),
  make(DRUID, 'Evacuation', {
    group: 'defensive',
    targetType: 'all_allies',
    resource: 'mana',
    cost: 40,
    cooldown: 5,
    tags: ['escape', 'aoe', 'threat_drop'],
    effects: [
      fx.status('all_allies', 'evade', 1, { potency: 1.0 }),
      fx.threat('all_enemies', -50, { mode: 'reduce_pct' }),
      fx.cleanse('all_allies', ['snare', 'slow', 'fear']),
    ],
    description: 'Whisk the party out of harm: enemies miss for a round and threat drops.',
  }),
];

const shamanAbilities = [
  make(SHAMAN, 'Slow', {
    group: 'support',
    targetType: 'single_enemy',
    resource: 'mana',
    cost: 16,
    cooldown: 2,
    tags: ['debuff', 'slow'],
    effects: [fx.status('target', 'slow', 3, { potency: 0.3, bossPotencyMod: 0.67 })],
    description: 'Slow an enemy, cutting its damage and speed.',
  }),
  make(SHAMAN, 'Torpor', {
    group: 'support',
    targetType: 'single_ally',
    resource: 'mana',
    cost: 22,
    cooldown: 1,
    tags: ['heal', 'hot', 'spirit'],
    effects: [
      fx.hot('target', 0.7, 3),
      fx.status('target', 'hot', 3),
    ],
    description: 'A strong heal over time on one ally.',
  }),
  make(SHAMAN, 'Cannibalize', {
    group: 'support',
    targetType: 'self',
    resource: 'none',
    cost: 0,
    cooldown: 2,
    tags: ['resource', 'sacrifice'],
    effects: [
      fx.damage(0.0, { target: 'self', pctMaxHp: 0.12, school: 'sacrifice' }),
      fx.resource('self', 'mana', { pctMax: 0.3 }),
    ],
    description: 'Convert 12% of your health into 30% of your mana.',
  }),
  make(SHAMAN, 'Poison Cloud', {
    group: 'offensive',
    targetType: 'all_enemies',
    resource: 'mana',
    cost: 18,
    cooldown: 2,
    tags: ['dot', 'aoe', 'poison'],
    effects: [
      fx.dot(0.3, 3, { target: 'all_enemies', school: 'poison' }),
      fx.status('all_enemies', 'poison', 3),
    ],
    description: 'Poison all enemies for damage over time.',
  }),
  make(SHAMAN, 'Spirit Ward', {
    group: 'defensive',
    targetType: 'all_allies',
    resource: 'mana',
    cost: 26,
    cooldown: 4,
    tags: ['buff', 'aoe', 'cleanse', 'spirit'],
    effects: [
      fx.status('all_allies', 'damage_reduction', 2, { potency: 0.2 }),
      fx.cleanse('all_allies', ['poison', 'disease']),
    ],
    description: 'Spirits reduce party damage taken by 20% and cleanse poison and disease.',
  }),
  make(SHAMAN, 'Malo', {
    group: 'support',
    targetType: 'single_enemy',
    resource: 'mana',
    cost: 15,
    cooldown: 3,
    tags: ['debuff', 'resist_down'],
    effects: [
      fx.status('target', 'resist_down', 3, { potency: 0.25, enemyDamageMod: -0.15 }),
    ],
    description: 'Weaken an enemy: lower resists and reduce its damage output.',
  }),
];

const enchanterAbilities = [
  make(ENCHANTER, 'Mesmerize', {
    group: 'support',
    targetType: 'single_enemy',
    resource: 'mana',
    cost: 18,
    cooldown: 3,
    tags: ['crowd_control', 'mez'],
    effects: [
      fx.status('target', 'mez', 3, { breaksOnDamage: true, bossDurationCap: 1, bossChance: 0.5 }),
    ],
    description: 'Mesmerize an enemy until it takes damage. Bosses resist.',
  }),
  make(ENCHANTER, 'Clarity', {
    group: 'support',
    targetType: 'single_ally',
    resource: 'mana',
    cost: 12,
    cooldown: 3,
    tags: ['buff', 'mana'],
    effects: [fx.status('target', 'clarity', 4, { manaPerRound: 0.08 })],
    description: 'Ally regenerates mana each round for 4 rounds.',
  }),
  make(ENCHANTER, 'Rune', {
    group: 'defensive',
    targetType: 'single_ally',
    resource: 'mana',
    cost: 20,
    cooldown: 2,
    tags: ['ward', 'absorb'],
    effects: [
      fx.shield('target', { absorbPct: 0.28, duration: 3 }),
      fx.status('target', 'shield', 3, { potency: 0.28 }),
    ],
    description: 'A rune that soaks up damage for 3 rounds.',
  }),
  make(ENCHANTER, 'Tash', {
    group: 'support',
    targetType: 'single_enemy',
    resource: 'mana',
    cost: 14,
    cooldown: 3,
    tags: ['debuff', 'vulnerability'],
    effects: [fx.status('target', 'vulnerability', 3, { potency: 0.25 })],
    description: 'Enemy takes 25% more damage from all sources.',
  }),
  make(ENCHANTER, 'Charm', {
    group: 'support',
    targetType: 'single_enemy',
    resource: 'mana',
    cost: 35,
    cooldown: 5,
    tags: ['crowd_control', 'charm'],
    effects: [
      fx.status('target', 'mez', 2, {
        variant: 'charm',
        targetsEnemies: true,
        bossDurationCap: 0,
        bossChance: 0,
      }),
    ],
    description: 'Charm an enemy so it fights for you briefly. Fails on bosses.',
  }),
  make(ENCHANTER, 'Mana Sieve', {
    group: 'support',
    targetType: 'single_enemy',
    resource: 'mana',
    cost: 10,
    cooldown: 3,
    tags: ['resource', 'silence', 'drain'],
    effects: [
      fx.damage(0.4, { school: 'magic' }),
      fx.status('target', 'silence', 1, { bossDurationCap: 1 }),
      fx.resource('all_allies', 'mana', { pctMax: 0.1 }),
    ],
    description: 'Siphon an enemy\u2019s mana, silencing it and restoring mana to the party.',
  }),
];

const bardAbilities = [
  make(BARD, 'Battle Hymn', {
    group: 'support',
    targetType: 'all_allies',
    resource: 'endurance',
    cost: 14,
    cooldown: 3,
    tags: ['song', 'buff', 'aoe'],
    effects: [fx.status('all_allies', 'song_atk', 3, { potency: 0.2 })],
    description: 'A song that raises party damage by 20% for 3 rounds.',
  }),
  make(BARD, 'Mana Song', {
    group: 'support',
    targetType: 'all_allies',
    resource: 'endurance',
    cost: 14,
    cooldown: 3,
    tags: ['song', 'buff', 'mana', 'aoe'],
    effects: [fx.status('all_allies', 'song_mana', 3, { manaPerRound: 0.08 })],
    description: 'A song that restores mana to the party each round.',
  }),
  make(BARD, 'Lullaby', {
    group: 'support',
    targetType: 'all_enemies',
    resource: 'endurance',
    cost: 16,
    cooldown: 3,
    tags: ['song', 'crowd_control', 'mez', 'aoe'],
    effects: [
      fx.status('all_enemies', 'mez', 1, { breaksOnDamage: true, bossDurationCap: 1, bossChance: 0.3 }),
    ],
    description: 'Lull all enemies to sleep for a round. Breaks when they are hurt.',
  }),
  make(BARD, 'Resist Chant', {
    group: 'defensive',
    targetType: 'all_allies',
    resource: 'endurance',
    cost: 12,
    cooldown: 3,
    tags: ['song', 'buff', 'resist', 'aoe'],
    effects: [
      fx.status('all_allies', 'damage_reduction', 3, { potency: 0.2, school: 'magic' }),
      fx.cleanse('all_allies', ['poison', 'disease']),
    ],
    description: 'Party takes 20% less magic damage and sheds poison and disease.',
  }),
  make(BARD, "Selo's Step", {
    group: 'support',
    targetType: 'all_allies',
    resource: 'endurance',
    cost: 12,
    cooldown: 3,
    tags: ['song', 'buff', 'haste', 'aoe'],
    effects: [
      fx.status('all_allies', 'haste', 2, { potency: 0.25 }),
      fx.cleanse('all_allies', ['snare', 'slow']),
    ],
    description: 'Haste the party and break snares and slows.',
  }),
  make(BARD, 'Discordant Strike', {
    group: 'offensive',
    targetType: 'single_enemy',
    resource: 'endurance',
    cost: 14,
    cooldown: 2,
    tags: ['song', 'interrupt', 'silence'],
    effects: [
      fx.damage(1.2, { school: 'sonic' }),
      fx.interrupt(),
      fx.status('target', 'silence', 1, { bossDurationCap: 1 }),
    ],
    description: 'Jarring chord: damage, interrupt, and silence.',
  }),
];

const wizardAbilities = [
  make(WIZARD, 'Ice Comet', {
    group: 'offensive',
    targetType: 'single_enemy',
    resource: 'mana',
    cost: 40,
    cooldown: 2,
    castTime: 1,
    tags: ['nuke', 'delayed', 'cold'],
    effects: [
      fx.cast(1, [
        fx.damage(3.2, { school: 'cold' }),
        fx.status('target', 'snare', 2, { potency: 0.25 }),
      ]),
    ],
    description: 'Summon a comet after a round of casting for massive cold damage and a snare.',
  }),
  make(WIZARD, 'Firestorm', {
    group: 'offensive',
    targetType: 'all_enemies',
    resource: 'mana',
    cost: 30,
    cooldown: 2,
    tags: ['aoe', 'fire', 'dot'],
    effects: [
      fx.damage(1.0, { target: 'all_enemies', school: 'fire' }),
      fx.dot(0.3, 2, { target: 'all_enemies', school: 'fire' }),
    ],
    description: 'Fire rains on all enemies, then burns.',
  }),
  make(WIZARD, 'Manaburn', {
    group: 'offensive',
    targetType: 'single_enemy',
    resource: 'mana',
    cost: 25,
    cooldown: 1,
    tags: ['nuke', 'scaling'],
    effects: [fx.damage(1.2, { school: 'magic', scaleWith: 'caster_mana_pct', scaleMax: 1.0 })],
    description: 'Damage scales up to double with how much mana you have left.',
  }),
  make(WIZARD, 'Concussion', {
    group: 'support',
    targetType: 'single_enemy',
    resource: 'mana',
    cost: 14,
    cooldown: 3,
    tags: ['interrupt', 'threat_drop', 'crowd_control'],
    effects: [
      fx.damage(0.5, { school: 'magic' }),
      fx.interrupt(),
      fx.threat('target', -40, { mode: 'reduce_pct', owner: 'self' }),
    ],
    description: 'Interrupt a cast and shed 40% of your threat on the target.',
  }),
  make(WIZARD, 'Harvest', {
    group: 'support',
    targetType: 'self',
    resource: 'none',
    cost: 0,
    cooldown: 4,
    tags: ['resource', 'meditate'],
    effects: [
      fx.resource('self', 'mana', { pctMax: 0.35 }),
      fx.status('self', 'vulnerability', 1, { potency: 0.15 }),
    ],
    description: 'Harvest 35% of your mana but leave yourself exposed for a round.',
  }),
  make(WIZARD, 'Arcane Shield', {
    group: 'defensive',
    targetType: 'self',
    resource: 'mana',
    cost: 20,
    cooldown: 4,
    tags: ['ward', 'absorb'],
    effects: [
      fx.shield('self', { absorbPct: 0.3, duration: 3 }),
      fx.status('self', 'shield', 3, { potency: 0.3 }),
      fx.threat('all_enemies', -15, { mode: 'reduce_pct', owner: 'self' }),
    ],
    description: 'A personal ward that absorbs damage and lowers your threat.',
  }),
];

const magicianAbilities = [
  make(MAGICIAN, 'Summon Elemental', {
    group: 'offensive',
    targetType: 'none',
    resource: 'mana',
    cost: 35,
    cooldown: 5,
    castTime: 1,
    tags: ['pet', 'summon', 'delayed'],
    effects: [
      fx.cast(1, [fx.summon('elemental', { hpPct: 0.8, power: 0.9, replaceExisting: true })]),
    ],
    description: 'After a round of casting, summon an elemental pet to fight for you.',
  }),
  make(MAGICIAN, 'Elemental Bolt', {
    group: 'offensive',
    targetType: 'single_enemy',
    resource: 'mana',
    cost: 15,
    cooldown: 0,
    tags: ['nuke', 'pet_synergy'],
    effects: [
      fx.damage(1.3, { school: 'fire', bonusIf: { petActive: true }, bonusMult: 1.25 }),
    ],
    description: 'Fire bolt that deals 25% more damage while your pet is out.',
  }),
  make(MAGICIAN, 'Burnout', {
    group: 'support',
    targetType: 'self',
    resource: 'mana',
    cost: 18,
    cooldown: 3,
    tags: ['pet', 'buff', 'risk'],
    effects: [
      fx.status('pet', 'burnout', 3, { petDamageMod: 0.5, petHpDrainPctPerRound: 0.08 }),
    ],
    description: 'Your pet deals 50% more damage for 3 rounds but burns its own health.',
  }),
  make(MAGICIAN, 'Mana Rod', {
    group: 'support',
    targetType: 'single_ally',
    resource: 'none',
    cost: 0,
    cooldown: 4,
    tags: ['resource', 'mana', 'conjure'],
    effects: [fx.resource('target', 'mana', { pctMax: 0.3 })],
    description: 'Conjure a rod that restores 30% mana to an ally.',
  }),
  make(MAGICIAN, 'Damage Shield', {
    group: 'defensive',
    targetType: 'single_ally',
    resource: 'mana',
    cost: 18,
    cooldown: 3,
    tags: ['buff', 'thorns', 'fire', 'pet_synergy'],
    effects: [
      fx.status('target', 'thorns', 3, { potency: 0.35, school: 'fire' }),
      fx.status('pet', 'thorns', 3, { potency: 0.35, school: 'fire' }),
    ],
    description: 'Fire shield on an ally and your pet that burns attackers.',
  }),
  make(MAGICIAN, 'Reclaim Pet', {
    group: 'support',
    targetType: 'self',
    resource: 'none',
    cost: 0,
    cooldown: 3,
    tags: ['pet', 'resource'],
    effects: [
      fx.summon('elemental', { dismiss: true }),
      fx.resource('self', 'mana', { pctMax: 0.25, requiresPet: true }),
      fx.heal('self', { pctMax: 0.1, requiresPet: true }),
    ],
    description: 'Dismiss your pet to recover mana and health.',
  }),
];

const necromancerAbilities = [
  make(NECROMANCER, 'Life Tap', {
    group: 'offensive',
    targetType: 'single_enemy',
    resource: 'mana',
    cost: 14,
    cooldown: 1,
    tags: ['drain', 'lifesteal'],
    effects: [
      fx.damage(0.8, { school: 'shadow' }),
      fx.heal('self', { ratioOfDamage: 0.5 }),
      fx.dot(0.2, 2, { school: 'shadow' }),
    ],
    description: 'Drain an enemy, heal yourself, and leave a lingering curse.',
  }),
  make(NECROMANCER, 'Poison Curse', {
    group: 'offensive',
    targetType: 'single_enemy',
    resource: 'mana',
    cost: 20,
    cooldown: 2,
    tags: ['dot', 'poison', 'debuff'],
    effects: [
      fx.dot(0.55, 4, { school: 'poison' }),
      fx.status('target', 'poison', 4),
      fx.status('target', 'resist_down', 4, { potency: 0.1 }),
    ],
    description: 'A strong poison over 4 rounds that also lowers resists.',
  }),
  make(NECROMANCER, 'Fear', {
    group: 'support',
    targetType: 'all_enemies',
    resource: 'mana',
    cost: 22,
    cooldown: 4,
    tags: ['crowd_control', 'fear', 'aoe'],
    effects: [
      fx.status('all_enemies', 'fear', 1, { breaksOnDamage: false, bossDurationCap: 1, bossChance: 0.25 }),
    ],
    description: 'Send all enemies fleeing for a round. Bosses usually resist.',
  }),
  make(NECROMANCER, 'Feign Death', {
    group: 'defensive',
    targetType: 'self',
    resource: 'mana',
    cost: 8,
    cooldown: 4,
    tags: ['feign', 'threat_drop'],
    effects: [
      fx.status('self', 'feign', 1, { failChance: 0.15 }),
      fx.threat('all_enemies', -100, { mode: 'reduce_pct' }),
      fx.status('pet', 'feign', 1),
    ],
    description: 'Drop all threat, as does your pet. Slight chance to fail.',
  }),
  make(NECROMANCER, 'Lich Form', {
    group: 'support',
    targetType: 'self',
    resource: 'mana',
    cost: 30,
    cooldown: 5,
    tags: ['buff', 'risk', 'shadow'],
    effects: [
      fx.status('self', 'lich', 4, {
        spellPowerMod: 0.3,
        manaPerRound: 0.1,
        hpDrainPctPerRound: 0.05,
      }),
    ],
    description: 'For 4 rounds: +30% spell power and mana regen, but bleed health.',
  }),
  make(NECROMANCER, 'Shadow Pact', {
    group: 'defensive',
    targetType: 'single_ally',
    resource: 'mana',
    cost: 18,
    cooldown: 3,
    tags: ['ward', 'redirect', 'shadow'],
    effects: [
      fx.status('target', 'damage_reduction', 2, { potency: 0.3 }),
      fx.redirect('target', 'self', { share: 0.5, duration: 2 }),
    ],
    description: 'Bind to an ally: they take 30% less damage and you absorb half of what remains.',
  }),
];

const rangerAbilities = [
  make(RANGER, 'Trueshot', {
    group: 'offensive',
    targetType: 'single_enemy',
    resource: 'endurance',
    cost: 14,
    cooldown: 2,
    tags: ['ranged', 'crit'],
    effects: [
      fx.damage(1.8, { guaranteedCritIf: { targetHasAny: ['snare', 'slow', 'mez', 'stun'] } }),
    ],
    description: 'Powerful shot that always crits a snared, slowed, mezzed or stunned target.',
  }),
  make(RANGER, 'Snare Arrow', {
    group: 'support',
    targetType: 'single_enemy',
    resource: 'endurance',
    cost: 10,
    cooldown: 2,
    tags: ['ranged', 'snare', 'debuff'],
    effects: [
      fx.damage(0.6),
      fx.status('target', 'snare', 3, { potency: 0.3 }),
    ],
    description: 'Snaring shot that slows the enemy\u2019s damage output.',
  }),
  make(RANGER, 'Dual Strike', {
    group: 'offensive',
    targetType: 'single_enemy',
    resource: 'endurance',
    cost: 12,
    cooldown: 1,
    tags: ['melee', 'multi_hit'],
    effects: [fx.damage(0.8, { hits: 2 })],
    description: 'Two quick weapon strikes.',
  }),
  make(RANGER, 'Track Weakness', {
    group: 'support',
    targetType: 'single_enemy',
    resource: 'endurance',
    cost: 8,
    cooldown: 3,
    tags: ['debuff', 'setup'],
    effects: [
      fx.status('target', 'vulnerability', 3, { potency: 0.15 }),
      fx.command('self', 'precision_strike', { uses: 1, effect: 'next_attack_crit' }),
    ],
    description: 'Mark an enemy to take 15% more damage; your next attack crits.',
  }),
  make(RANGER, 'Weapon Shield', {
    group: 'defensive',
    targetType: 'self',
    resource: 'endurance',
    cost: 12,
    cooldown: 3,
    tags: ['mitigation', 'melee'],
    effects: [
      fx.status('self', 'damage_reduction', 2, { potency: 0.25, school: 'physical' }),
      fx.threat('all_enemies', -10, { mode: 'reduce_pct', owner: 'self' }),
    ],
    description: 'Parry incoming blows: 25% less physical damage for 2 rounds.',
  }),
  make(RANGER, 'Nature Mend', {
    group: 'support',
    targetType: 'single_ally',
    resource: 'mana',
    cost: 14,
    cooldown: 2,
    tags: ['heal', 'hot', 'nature'],
    effects: [
      fx.heal('target', { power: 0.6 }),
      fx.hot('target', 0.25, 2),
    ],
    description: 'A modest heal with a short heal over time.',
  }),
];

const rogueAbilities = [
  make(ROGUE, 'Backstab', {
    group: 'offensive',
    targetType: 'single_enemy',
    resource: 'endurance',
    cost: 10,
    cooldown: 1,
    tags: ['melee', 'positional', 'burst'],
    effects: [
      fx.damage(1.6, {
        bonusIf: { selfHasAny: ['evade', 'shadowstep'], targetHasAny: ['mez', 'stun', 'feign'] },
        bonusMult: 2.0,
        removeStatus: ['evade', 'shadowstep'],
      }),
    ],
    description: 'Strong strike that deals double from stealth or against a distracted foe.',
  }),
  make(ROGUE, 'Evade', {
    group: 'defensive',
    targetType: 'self',
    resource: 'endurance',
    cost: 8,
    cooldown: 3,
    tags: ['stealth', 'threat_drop'],
    effects: [
      fx.status('self', 'evade', 1),
      fx.threat('all_enemies', -50, { mode: 'reduce_pct', owner: 'self' }),
    ],
    description: 'Slip out of sight: lose threat and set up a Backstab.',
  }),
  make(ROGUE, 'Poison Blade', {
    group: 'offensive',
    targetType: 'self',
    resource: 'endurance',
    cost: 10,
    cooldown: 3,
    tags: ['buff', 'poison', 'weapon'],
    effects: [
      fx.status('self', 'poison', 3, {
        variant: 'weapon_coat',
        onHit: fx.dot(0.3, 3, { school: 'poison' }),
      }),
    ],
    description: 'Coat your blades: each hit for 3 rounds applies a poison.',
  }),
  make(ROGUE, 'Shadowstep', {
    group: 'support',
    targetType: 'self',
    resource: 'endurance',
    cost: 12,
    cooldown: 3,
    tags: ['stealth', 'mobility'],
    effects: [
      fx.status('self', 'shadowstep', 1),
      fx.cooldown('self', 'rogue_backstab', -1),
      fx.cleanse('self', ['snare', 'slow']),
    ],
    description: 'Vanish and reappear: break snares, refresh Backstab, empower your next strike.',
  }),
  make(ROGUE, 'Assassinate', {
    group: 'offensive',
    targetType: 'single_enemy',
    resource: 'endurance',
    cost: 30,
    cooldown: 5,
    tags: ['melee', 'execute', 'burst'],
    effects: [
      fx.damage(1.8, {
        executeBelowPct: 0.35,
        executeMult: 3.0,
        bossExecuteMult: 1.5,
      }),
    ],
    description: 'Finishing blow: triple damage on foes under 35% health.',
  }),
  make(ROGUE, 'Pickpocket', {
    group: 'support',
    targetType: 'single_enemy',
    resource: 'endurance',
    cost: 8,
    cooldown: 4,
    tags: ['utility', 'loot'],
    effects: [
      { type: 'stealCurrency', target: 'target', currency: 'gold', amount: 8, bossAmount: 4 },
      fx.threat('target', 10),
    ],
    description: 'Lift some coin from an enemy. Draws a bit of attention.',
  }),
];

const monkAbilities = [
  make(MONK, 'Flying Kick', {
    group: 'offensive',
    targetType: 'single_enemy',
    resource: 'endurance',
    cost: 12,
    cooldown: 1,
    tags: ['melee', 'momentum'],
    effects: [
      fx.damage(1.5),
      fx.resource('self', 'endurance', { amount: 4 }),
    ],
    description: 'Leaping kick that returns some endurance.',
  }),
  make(MONK, 'Mend', {
    group: 'defensive',
    targetType: 'self',
    resource: 'endurance',
    cost: 12,
    cooldown: 3,
    tags: ['heal', 'self'],
    effects: [
      fx.heal('self', { pctMax: 0.35 }),
      fx.cleanse('self', ['poison', 'disease']),
    ],
    description: 'Mend your wounds for 35% health and cure poison and disease.',
  }),
  make(MONK, 'Feign Death', {
    group: 'defensive',
    targetType: 'self',
    resource: 'endurance',
    cost: 10,
    cooldown: 4,
    tags: ['feign', 'threat_drop'],
    effects: [
      fx.status('self', 'feign', 1, { failChance: 0 }),
      fx.threat('all_enemies', -100, { mode: 'reduce_pct' }),
      fx.heal('self', { pctMax: 0.05 }),
    ],
    description: 'Reliably drop all threat and catch your breath.',
  }),
  make(MONK, 'Hundred Fists', {
    group: 'offensive',
    targetType: 'single_enemy',
    resource: 'endurance',
    cost: 24,
    cooldown: 4,
    tags: ['melee', 'multi_hit', 'burst'],
    effects: [
      fx.damage(0.4, { hits: 5 }),
      fx.status('self', 'haste', 1, { potency: 0.15 }),
    ],
    description: 'A flurry of five strikes that also speeds you up.',
  }),
  make(MONK, 'Counterattack', {
    group: 'defensive',
    targetType: 'self',
    resource: 'endurance',
    cost: 12,
    cooldown: 3,
    tags: ['stance', 'melee'],
    effects: [
      fx.status('self', 'counter', 2, { riposteDamage: 1.0, dodgeBonus: 0.15 }),
    ],
    description: 'For 2 rounds, melee attackers take a riposte and you dodge more.',
  }),
  make(MONK, 'Dragon Punch', {
    group: 'offensive',
    targetType: 'single_enemy',
    resource: 'endurance',
    cost: 18,
    cooldown: 3,
    tags: ['melee', 'crowd_control'],
    effects: [
      fx.damage(1.7),
      fx.status('target', 'stun', 1, { bossDurationCap: 0, bossChance: 0.2 }),
    ],
    description: 'A heavy punch that stuns for a round.',
  }),
];

const beastlordAbilities = [
  make(BEASTLORD, 'Spirit Companion', {
    group: 'support',
    targetType: 'none',
    resource: 'mana',
    cost: 30,
    cooldown: 5,
    tags: ['pet', 'summon'],
    effects: [fx.summon('warder', { hpPct: 1.0, power: 0.7, replaceExisting: true })],
    description: 'Call a spirit warder to fight beside you.',
  }),
  make(BEASTLORD, 'Savage Strike', {
    group: 'offensive',
    targetType: 'single_enemy',
    resource: 'endurance',
    cost: 12,
    cooldown: 1,
    tags: ['melee', 'pet_synergy'],
    effects: [
      fx.damage(1.2),
      fx.damage(0.6, { source: 'pet', requiresPet: true }),
    ],
    description: 'Strike, and your warder follows up with a bite.',
  }),
  make(BEASTLORD, 'Spiritual Recovery', {
    group: 'support',
    targetType: 'single_ally',
    resource: 'mana',
    cost: 22,
    cooldown: 2,
    tags: ['heal', 'cleanse', 'spirit'],
    effects: [
      fx.heal('target', { power: 1.1 }),
      fx.heal('pet', { pctMax: 0.25 }),
      fx.cleanse('target', ['poison', 'disease']),
    ],
    description: 'Heal an ally and your warder, cleansing poison and disease.',
  }),
  make(BEASTLORD, 'Feral Roar', {
    group: 'support',
    targetType: 'all_enemies',
    resource: 'endurance',
    cost: 16,
    cooldown: 3,
    tags: ['debuff', 'pet_synergy', 'aoe'],
    effects: [
      fx.status('all_enemies', 'vulnerability', 2, { potency: 0.15 }),
      fx.status('pet', 'pet_buff', 3, { petDamageMod: 0.3 }),
    ],
    description: 'Roar to expose enemies (+15% damage taken) and embolden your warder.',
  }),
  make(BEASTLORD, 'Spirit Ward', {
    group: 'defensive',
    targetType: 'self',
    resource: 'mana',
    cost: 20,
    cooldown: 4,
    tags: ['ward', 'pet_synergy', 'spirit'],
    effects: [
      fx.shield('self', { absorbPct: 0.25, duration: 3 }),
      fx.status('self', 'shield', 3, { potency: 0.25 }),
      fx.shield('pet', { absorbPct: 0.25, duration: 3 }),
      fx.redirect('self', 'pet', { share: 0.25, duration: 3, requiresPet: true }),
    ],
    description: 'Shield yourself and your warder; the warder soaks a quarter of your damage.',
  }),
  make(BEASTLORD, 'Bestial Rampage', {
    group: 'offensive',
    targetType: 'single_enemy',
    resource: 'endurance',
    cost: 28,
    cooldown: 5,
    tags: ['melee', 'burst', 'pet_synergy'],
    effects: [
      fx.damage(0.8, { hits: 3 }),
      fx.status('pet', 'pet_buff', 2, { petDamageMod: 0.5 }),
      fx.status('self', 'haste', 2, { potency: 0.2 }),
    ],
    description: 'Frenzied triple strike while you and your warder fight faster.',
  }),
];

export const CLASS_ABILITIES = Object.freeze({
  [WARRIOR]: Object.freeze(warriorAbilities),
  [PALADIN]: Object.freeze(paladinAbilities),
  [SHADOW_KNIGHT]: Object.freeze(shadowKnightAbilities),
  [CLERIC]: Object.freeze(clericAbilities),
  [DRUID]: Object.freeze(druidAbilities),
  [SHAMAN]: Object.freeze(shamanAbilities),
  [ENCHANTER]: Object.freeze(enchanterAbilities),
  [BARD]: Object.freeze(bardAbilities),
  [WIZARD]: Object.freeze(wizardAbilities),
  [MAGICIAN]: Object.freeze(magicianAbilities),
  [NECROMANCER]: Object.freeze(necromancerAbilities),
  [RANGER]: Object.freeze(rangerAbilities),
  [ROGUE]: Object.freeze(rogueAbilities),
  [MONK]: Object.freeze(monkAbilities),
  [BEASTLORD]: Object.freeze(beastlordAbilities),
});

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

const ABILITY_BY_ID = new Map();
for (const action of UNIVERSAL_ACTIONS) ABILITY_BY_ID.set(action.id, action);
for (const list of Object.values(CLASS_ABILITIES)) {
  for (const ability of list) {
    if (ABILITY_BY_ID.has(ability.id)) {
      throw new Error(`Duplicate ability id: ${ability.id}`);
    }
    ABILITY_BY_ID.set(ability.id, ability);
  }
}

export const ABILITY_COUNT = Object.values(CLASS_ABILITIES).reduce((sum, list) => sum + list.length, 0);

export function getAbility(id) {
  return ABILITY_BY_ID.get(id) ?? null;
}

export function getClassAbilities(className) {
  return CLASS_ABILITIES[className] ? [...CLASS_ABILITIES[className]] : [];
}

export function getUniversalActions() {
  return [...UNIVERSAL_ACTIONS];
}

export function listAllClassAbilityIds() {
  return Object.values(CLASS_ABILITIES).flatMap((list) => list.map((ability) => ability.id));
}
