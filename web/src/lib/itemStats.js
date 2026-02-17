/**
 * Item stats for hover cards. Magelo-style structure (flags, slot, stats, effect/focus with spell ids).
 * Can be replaced with API or static JSON later.
 */

const TAKP_ITEM_BASE = 'https://www.takproject.net/allaclone/item.php?id='
const TAKP_SPELL_BASE = 'https://www.takproject.net/allaclone/spell.php?id='

// Magelo-style mock: Hammer of Hours (id 21886) — matches Magelo HTML
const MOCK_STATS = {
  21886: {
    flags: ['MAGIC ITEM', 'LORE ITEM', 'NO TRADE'],
    slot: 'PRIMARY',
    skill: '1H Blunt',
    atkDelay: 30,
    dmg: 30,
    dmgBonus: 13,
    dmgBonusNote: '(lvl 65)',
    ac: 15,
    mods: [
      { label: 'STA', value: 15 },
      { label: 'AGI', value: 25 },
      { label: 'WIS', value: 20 },
      { label: 'CHA', value: 15 },
      { label: 'HP', value: 165 },
      { label: 'MANA', value: 180 },
    ],
    resists: [
      { label: 'Fire', value: 18 },
      { label: 'Cold', value: 18 },
      { label: 'Magic', value: 18 },
    ],
    levelType: 'required', // 'required' | 'recommended'
    requiredLevel: 65,
    effectSpellId: 3630,
    effectSpellName: 'Time Lapse',
    effectNote: '(Combat) (Level 0)',
    focusSpellId: 3843,
    focusSpellName: 'Timeburn',
    weight: 2.7,
    size: 'MEDIUM',
    classes: 'CLR DRU SHM',
    races: 'ALL',
    droppedBy: ['Plane of Time', 'Terris Thule (20%)', 'Terris Thule (15%)'],
  },
  // Shroud of Provocation — bard instrument mod
  13673: {
    flags: ['MAGIC ITEM', 'LORE ITEM', 'NO TRADE'],
    slot: 'SHOULDERS',
    ac: 30,
    mods: [
      { label: 'STA', value: 15 },
      { label: 'AGI', value: 25 },
      { label: 'DEX', value: 15 },
      { label: 'WIS', value: 20 },
      { label: 'INT', value: 20 },
      { label: 'HP', value: 170 },
      { label: 'MANA', value: 175 },
    ],
    resists: [{ label: 'Cold', value: 25 }, { label: 'Poison', value: 25 }],
    instrumentMods: [{ label: 'Wind Instruments', value: 22, pct: '+120%' }],
    requiredLevel: 65,
    effectSpellId: 2194,
    effectSpellName: 'Vengeance IV',
    effectNote: '(Worn) (Level 0)',
    focusSpellId: 3530,
    focusSpellName: "Quickening of Solusek",
    weight: 1.2,
    size: 'MEDIUM',
    classes: 'PAL RNG SHD BRD BST',
    races: 'ALL',
  },
  // The Binden Concerrentia — no AC, has Light
  28296: {
    flags: ['MAGIC ITEM', 'LORE ITEM', 'NO TRADE'],
    slot: 'NECK',
    mods: [
      { label: 'STR', value: 15 },
      { label: 'STA', value: 15 },
      { label: 'AGI', value: 15 },
      { label: 'WIS', value: 15 },
      { label: 'INT', value: 15 },
      { label: 'HP', value: 75 },
      { label: 'MANA', value: 75 },
    ],
    resists: [
      { label: 'Fire', value: 15 },
      { label: 'Disease', value: 15 },
      { label: 'Cold', value: 15 },
      { label: 'Magic', value: 15 },
      { label: 'Poison', value: 15 },
    ],
    effectSpellId: 3046,
    effectSpellName: 'Talisman Gate',
    effectNote: '(Must Equip, Casting Time: 20.0) (Level 0)',
    weight: 1.0,
    size: 'SMALL',
    classes: 'ALL',
    races: 'ALL',
    light: 7,
  },
  // Edge of Eternity — weapon + percussion instrument mod
  22986: {
    flags: ['MAGIC ITEM', 'LORE ITEM', 'NO TRADE'],
    slot: 'PRIMARY SECONDARY',
    skill: '1H Slashing',
    atkDelay: 20,
    dmg: 20,
    dmgBonus: 13,
    dmgBonusNote: '(lvl 65)',
    ac: 20,
    mods: [
      { label: 'STR', value: 20 },
      { label: 'AGI', value: 18 },
      { label: 'DEX', value: 25 },
      { label: 'WIS', value: 10 },
      { label: 'INT', value: 10 },
      { label: 'HP', value: 180 },
      { label: 'MANA', value: 165 },
    ],
    resists: [{ label: 'Fire', value: 18 }, { label: 'Cold', value: 18 }, { label: 'Poison', value: 18 }],
    instrumentMods: [{ label: 'Percussion Instruments', value: 25, pct: '+150%' }],
    requiredLevel: 65,
    effectSpellId: 3648,
    effectSpellName: 'Time Snap',
    effectNote: '(Combat) (Level 0)',
    weight: 1.0,
    size: 'MEDIUM',
    classes: 'WAR RNG BRD ROG',
    races: 'ALL',
  },
  // Abalone Engraved Tribal Mask — instrument mod with optional label (e.g. Singing: 20 +100%)
  9488: {
    flags: ['MAGIC ITEM', 'LORE ITEM', 'NO TRADE'],
    slot: 'FACE',
    ac: 20,
    mods: [
      { label: 'STA', value: 15 },
      { label: 'AGI', value: 12 },
      { label: 'DEX', value: 20 },
      { label: 'INT', value: 12 },
      { label: 'CHA', value: 25 },
      { label: 'HP', value: 150 },
      { label: 'MANA', value: 125 },
    ],
    resists: [
      { label: 'Fire', value: 12 },
      { label: 'Disease', value: 12 },
      { label: 'Cold', value: 12 },
      { label: 'Poison', value: 12 },
    ],
    instrumentMods: [{ label: 'Singing', value: 20, pct: '+100%' }],
    requiredLevel: 65,
    effectSpellId: 1300,
    effectSpellName: 'Flowing Thought III',
    effectNote: '(Worn) (Level 0)',
    weight: 1.0,
    size: 'SMALL',
    classes: 'PAL RNG SHD BRD BST',
    races: 'ALL',
  },
}

const cache = new Map()

export function getItemStats(itemId) {
  if (itemId == null) return Promise.resolve(null)
  const id = Number(itemId)
  if (cache.has(id)) return Promise.resolve(cache.get(id))
  const stats = MOCK_STATS[id] ?? null
  if (stats) cache.set(id, stats)
  return Promise.resolve(stats)
}

export function getItemStatsCached(itemId) {
  if (itemId == null) return null
  return cache.get(Number(itemId)) ?? MOCK_STATS[Number(itemId)] ?? null
}

export { TAKP_ITEM_BASE, TAKP_SPELL_BASE }
