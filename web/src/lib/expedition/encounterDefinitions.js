/**
 * Six encounters with multi-enemy support and Quarm phases.
 */

/** @typedef {{ id: string, name: string, maxHp: number, atk: number, def: number, isBoss?: boolean, role?: string, intents: object[] }} EnemyTemplate */

export const ENCOUNTERS = [
  {
    id: 'entrance_guards',
    title: 'The Entrance Guards',
    flavor: 'Two guards who definitely checked the raid calendar.',
    enemies: [
      {
        id: 'guard_a',
        name: 'Plane Guard A',
        maxHp: 90,
        atk: 14,
        def: 6,
        intents: [
          { id: 'swing', label: 'Heavy strike (front)', kind: 'single', power: 1, formation: true },
          { id: 'poke', label: 'Poke random raider', kind: 'single', power: 0.7, target: 'random' },
        ],
      },
      {
        id: 'guard_b',
        name: 'Plane Guard B',
        maxHp: 90,
        atk: 14,
        def: 6,
        intents: [
          { id: 'swing', label: 'Heavy strike (front)', kind: 'single', power: 1, formation: true },
          { id: 'shout', label: 'Call for focus fire', kind: 'buff_self', power: 3 },
        ],
      },
    ],
  },
  {
    id: 'endless_trash',
    title: 'The Endless Trash Pull',
    flavor: 'A suspiciously large number of weakly motivated elementals.',
    enemies: [
      {
        id: 'trash_1',
        name: 'Air Wisp',
        maxHp: 55,
        atk: 11,
        def: 3,
        intents: [
          { id: 'zap', label: 'Zap lowest HP', kind: 'single', power: 0.85, target: 'lowest' },
          { id: 'swarm', label: 'Swarm AoE', kind: 'aoe', power: 0.45 },
        ],
      },
      {
        id: 'trash_2',
        name: 'Earth Clod',
        maxHp: 70,
        atk: 13,
        def: 5,
        intents: [
          { id: 'slam', label: 'Slam frontliner', kind: 'single', power: 1, formation: true },
          { id: 'swarm', label: 'Swarm AoE', kind: 'aoe', power: 0.5 },
        ],
      },
      {
        id: 'trash_3',
        name: 'Fire Spark',
        maxHp: 50,
        atk: 15,
        def: 2,
        school: 'fire',
        intents: [
          { id: 'burn', label: 'Burn random', kind: 'single', power: 1.05, target: 'random', school: 'fire' },
          { id: 'swarm', label: 'Fire Nova', kind: 'aoe', power: 0.55, school: 'fire' },
        ],
      },
    ],
  },
  {
    id: 'mini_boss',
    title: 'The Overconfident Mini-Boss',
    flavor: 'Has a monologue prepared. It is not good.',
    enemies: [
      {
        id: 'mini',
        name: 'Overconfident Lieutenant',
        maxHp: 220,
        atk: 22,
        def: 10,
        isBoss: true,
        intents: [
          { id: 'slam', label: 'Heavy tank strike', kind: 'single', power: 1.15, formation: true },
          { id: 'prep', label: 'Prepare Cataclysm (interruptible)', kind: 'cast', power: 1.9, castName: 'Cataclysm', interruptible: true },
          { id: 'weaken', label: 'Weaken casters', kind: 'debuff_party', power: 0.15 },
        ],
      },
    ],
  },
  {
    id: 'loot_officer',
    title: "The Loot Officer's Revenge",
    flavor: 'Armed with spreadsheets and unresolved DKP trauma.',
    enemies: [
      {
        id: 'loot_boss',
        name: 'Loot Officer',
        maxHp: 200,
        atk: 18,
        def: 12,
        isBoss: true,
        intents: [
          { id: 'audit', label: 'Audit poison', kind: 'poison', power: 10, target: 'random' },
          { id: 'tax', label: 'Tax highest HP', kind: 'single', power: 1.1, target: 'highest' },
          { id: 'shield_up', label: 'Defensive paperwork', kind: 'self_shield', power: 40 },
        ],
      },
      {
        id: 'loot_support',
        name: 'Junior Auditor',
        maxHp: 80,
        atk: 12,
        def: 4,
        role: 'support',
        intents: [
          { id: 'buff', label: 'Buff boss defenses', kind: 'buff_ally_enemy', power: 0.2 },
          { id: 'paper', label: 'Paper cut', kind: 'single', power: 0.8, target: 'random' },
        ],
      },
    ],
  },
  {
    id: 'final_prep',
    title: 'The Final Preparation',
    flavor: 'A survival check disguised as trash. Classic.',
    enemies: [
      {
        id: 'prep_a',
        name: 'Attrition Elemental',
        maxHp: 150,
        atk: 20,
        def: 8,
        intents: [
          { id: 'pressure', label: 'Pressure front', kind: 'single', power: 1.1, formation: true },
          { id: 'dot', label: 'Lingering drain', kind: 'poison', power: 12, target: 'random' },
          { id: 'silence', label: 'Interrupt casters', kind: 'silence', power: 1 },
        ],
      },
      {
        id: 'prep_b',
        name: 'Resource Leech',
        maxHp: 130,
        atk: 18,
        def: 7,
        intents: [
          { id: 'spread', label: 'Area pressure', kind: 'aoe', power: 0.6 },
          { id: 'mana_burn', label: 'Burn mana (highest mana)', kind: 'mana_burn', power: 15 },
          { id: 'execute', label: 'Finish wounded', kind: 'single', power: 1.25, target: 'lowest' },
        ],
      },
    ],
  },
  {
    id: 'quarm',
    title: 'Quarm, the Four-Headed Audit',
    flavor: 'Four heads. Four opinions. Zero mercy for bad loot decisions.',
    enemies: [
      {
        id: 'quarm',
        name: 'Quarm',
        maxHp: 420,
        atk: 26,
        def: 12,
        isBoss: true,
        phases: ['physical', 'magical', 'debuff', 'burn'],
        intentsByPhase: {
          physical: [
            { id: 'bite', label: 'Physical assault (front)', kind: 'single', power: 1.3, formation: true },
            { id: 'sweep', label: 'Tail sweep AoE', kind: 'aoe', power: 0.65 },
          ],
          magical: [
            { id: 'beam', label: 'Magical audit beam', kind: 'single', power: 1.25, target: 'highest', school: 'magic' },
            { id: 'nova', label: 'Arcane nova', kind: 'aoe', power: 0.75, school: 'magic' },
            { id: 'cast', label: 'Prepare Verdict (interruptible)', kind: 'cast', power: 1.8, castName: 'Four-Headed Verdict', interruptible: true },
          ],
          debuff: [
            { id: 'poison', label: 'Apply audit poison', kind: 'poison', power: 14, target: 'random' },
            { id: 'fear', label: 'Terrorize rear line', kind: 'fear', power: 1, target: 'rear' },
            { id: 'slow', label: 'Bureaucratic slow', kind: 'debuff_party', power: 0.2 },
          ],
          burn: [
            { id: 'vuln', label: 'Expose vulnerability', kind: 'apply_vuln', power: 1 },
            { id: 'frenzy', label: 'Burn-phase frenzy', kind: 'aoe', power: 0.55 },
            { id: 'focus', label: 'Focus fire lowest', kind: 'single', power: 1.35, target: 'lowest' },
          ],
        },
        intents: [
          { id: 'bite', label: 'Physical assault (front)', kind: 'single', power: 1.2, formation: true },
        ],
      },
    ],
  },
]

export const ENCOUNTER_COUNT = ENCOUNTERS.length

export function getEncounter(index) {
  return ENCOUNTERS[index] || null
}
