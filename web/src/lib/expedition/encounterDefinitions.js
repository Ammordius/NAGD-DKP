/**
 * Six expedition encounters with distinct mechanics.
 * @typedef {{
 *   id: string,
 *   name: string,
 *   title: string,
 *   maxHp: number,
 *   atk: number,
 *   def: number,
 *   flavor: string,
 *   intents: Array<{ id: string, label: string, kind: string, power?: number, target?: string }>,
 *   mechanics?: Record<string, unknown>,
 * }} EncounterDef
 */

/** @type {EncounterDef[]} */
export const ENCOUNTERS = [
  {
    id: 'entrance_guards',
    name: 'Plane Entrance Guards',
    title: 'The Entrance Guards',
    maxHp: 120,
    atk: 16,
    def: 6,
    flavor: 'Two guards who definitely checked the raid calendar.',
    intents: [
      { id: 'swing', label: 'Heavy attack on front-line target', kind: 'single', power: 1, target: 'front' },
      { id: 'poke', label: 'Light poke at a random raider', kind: 'single', power: 0.7, target: 'random' },
    ],
    mechanics: { intro: true },
  },
  {
    id: 'endless_trash',
    name: 'Endless Trash Pull',
    title: 'The Endless Trash Pull',
    maxHp: 160,
    atk: 14,
    def: 4,
    flavor: 'A suspiciously large number of weakly motivated elementals.',
    intents: [
      { id: 'swarm', label: 'Area attack (trash swarm)', kind: 'aoe', power: 0.55 },
      { id: 'nibble', label: 'Focus fire on lowest HP', kind: 'single', power: 0.9, target: 'lowest' },
      { id: 'add', label: 'Summon additional trash (buff self ATK)', kind: 'buff_self', power: 4 },
    ],
    mechanics: { multi: true, aoeBias: true },
  },
  {
    id: 'mini_boss',
    name: 'Overconfident Mini-Boss',
    title: 'The Overconfident Mini-Boss',
    maxHp: 200,
    atk: 22,
    def: 10,
    flavor: 'Has a monologue prepared. It is not good.',
    intents: [
      { id: 'slam', label: 'Heavy attack on front-line target', kind: 'single', power: 1.2, target: 'front' },
      { id: 'prep', label: 'Prepare devastating attack next round', kind: 'telegraph', power: 1.8 },
      { id: 'devastate', label: 'Devastating slam!', kind: 'single', power: 1.8, target: 'front' },
      { id: 'weaken', label: 'Interrupt / weaken casters', kind: 'debuff_party', power: 0.15 },
    ],
    mechanics: { telegraph: true },
  },
  {
    id: 'loot_officer',
    name: "Loot Officer's Revenge",
    title: "The Loot Officer's Revenge",
    maxHp: 180,
    atk: 18,
    def: 8,
    flavor: 'Armed with spreadsheets and unresolved DKP trauma.',
    intents: [
      { id: 'audit', label: 'Apply audit poison (DoT)', kind: 'poison', power: 8, target: 'random' },
      { id: 'tax', label: 'Tax the healthiest raider', kind: 'single', power: 1.1, target: 'highest' },
      { id: 'argue', label: 'Area argument (mild AoE)', kind: 'aoe', power: 0.45 },
    ],
    mechanics: { resource: true, poison: true },
  },
  {
    id: 'final_prep',
    name: 'Final Preparation Gauntlet',
    title: 'The Final Preparation',
    maxHp: 220,
    atk: 24,
    def: 11,
    flavor: 'A survival check disguised as trash. Classic.',
    intents: [
      { id: 'pressure', label: 'Heavy attack on front-line target', kind: 'single', power: 1.15, target: 'front' },
      { id: 'spread', label: 'Area attack', kind: 'aoe', power: 0.65 },
      { id: 'silence', label: 'Interrupt casters (raise special CDs)', kind: 'silence', power: 1 },
      { id: 'execute', label: 'Finish the wounded', kind: 'single', power: 1.3, target: 'lowest' },
    ],
    mechanics: { survival: true },
  },
  {
    id: 'quarm',
    name: 'Quarm, the Four-Headed Audit',
    title: 'Quarm, the Four-Headed Audit',
    maxHp: 320,
    atk: 28,
    def: 12,
    flavor: 'Four heads. Four opinions. Zero mercy for bad loot decisions.',
    intents: [
      { id: 'bite', label: 'Head 1: Heavy bite (front)', kind: 'single', power: 1.25, target: 'front' },
      { id: 'breath', label: 'Head 2: Area breath', kind: 'aoe', power: 0.7 },
      { id: 'poison', label: 'Head 3: Apply poison', kind: 'poison', power: 10, target: 'random' },
      { id: 'audit_beam', label: 'Head 4: Audit beam (highest HP)', kind: 'single', power: 1.2, target: 'highest' },
      { id: 'rage', label: 'All heads: prepare devastation', kind: 'telegraph', power: 2.0 },
      { id: 'quad', label: 'Four-Headed Verdict!', kind: 'aoe', power: 1.1 },
    ],
    mechanics: { boss: true, heads: 4 },
  },
]

/**
 * @param {number} index
 * @returns {EncounterDef|null}
 */
export function getEncounter(index) {
  return ENCOUNTERS[index] || null
}

export const ENCOUNTER_COUNT = ENCOUNTERS.length
