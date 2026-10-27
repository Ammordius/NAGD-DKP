/**
 * Character combat identity: class+level baseline, optional Magelo snapshot merge.
 * Magelo numbers are transformed game values — not literal EQ stats.
 *
 * Transforms (documented):
 * - armor: clamp(ac / 20, 0, 25) → armorMitigation percent/100 capped ~0.25 contribution shared with level
 * - physicalPower: clamp(atk_item / 4, 0, 30) added to atk
 * - magicalPower: clamp((mana/20 + int/10), 0, 30) → spellPower bonus
 * - manaReserve: clamp(mana / 25, 0, 40) → maxMana bonus
 * - resists: each resist/4 capped 15 → elemental mitigation
 * Equipment contribution target ~10–25% of effective combat power vs peer class/level.
 */

import { getClassDef } from './classDefinitions.js'
import { usesMana, usesEndurance } from './resources.js'
import { defaultPosition } from './formation.js'
import { getPassive } from './passives.js'

/** @type {Map<string, object>|null} */
let profileCache = null
let profileLoadPromise = null

export function clearCombatProfileCache() {
  profileCache = null
  profileLoadPromise = null
}

/**
 * Bounded level factor: level 1 ≈ 0.7, 60 ≈ 1.0, 65 ≈ 1.08
 * @param {number|null} level
 */
export function levelFactor(level) {
  const lv = typeof level === 'number' && level > 0 ? level : 50
  return clamp(0.7 + (lv / 60) * 0.3 + Math.max(0, lv - 60) * 0.016, 0.65, 1.15)
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

/**
 * Transform Magelo sheet-ish stats into game combatStats.
 * @param {object} raw
 */
export function transformMageloStats(raw) {
  if (!raw || typeof raw !== 'object') return null
  const ac = Number(raw.ac ?? raw.ac_total ?? 0) || 0
  const atk = Number(raw.atk_item ?? raw.atk ?? 0) || 0
  const mana = Number(raw.mana ?? raw.mana_max ?? 0) || 0
  const hp = Number(raw.hp ?? raw.hp_max_total ?? 0) || 0
  const haste = Number(raw.haste ?? raw.haste_item ?? 0) || 0
  const intel = Number(raw.INT ?? raw.int ?? 0) || 0
  const resists = raw.resists || {}
  return {
    armor: clamp(ac / 20, 0, 25),
    physicalPower: clamp(atk / 4, 0, 30),
    magicalPower: clamp(mana / 20 + intel / 10, 0, 30),
    manaReserve: clamp(mana / 25, 0, 40),
    hpBonus: clamp(hp / 80, 0, 40),
    haste: clamp(haste / 100, 0, 0.2),
    resistances: {
      fire: clamp(Number(resists.fire || 0) / 4, 0, 15),
      cold: clamp(Number(resists.cold || 0) / 4, 0, 15),
      magic: clamp(Number(resists.magic || 0) / 4, 0, 15),
    },
  }
}

/**
 * Derive traits from inventory slot hints or haste.
 * @param {object} profile
 */
export function deriveTraits(profile) {
  const traits = []
  if (profile?.slots?.['8'] || profile?.traits?.includes?.('shield_equipped')) traits.push('shield_equipped')
  if ((profile?.combatStats?.haste || 0) >= 0.08 || profile?.raw?.haste >= 8) traits.push('haste_equipment')
  if ((profile?.combatStats?.magicalPower || 0) >= 15) traits.push('focus_healing')
  if ((profile?.combatStats?.manaReserve || 0) >= 20) traits.push('mana_gear')
  return [...new Set([...(profile?.traits || []), ...traits])]
}

/**
 * Build derived combatant stats from roster char + optional magelo profile.
 * @param {object} character
 * @param {object|null} mageloProfile
 */
export function buildCombatIdentity(character, mageloProfile = null) {
  const def = getClassDef(character.class_name)
  const lf = levelFactor(character.level)
  const equipmentKnown = Boolean(mageloProfile?.equipmentKnown && mageloProfile?.combatStats)
  const stats = equipmentKnown ? mageloProfile.combatStats : null
  const traits = equipmentKnown ? deriveTraits(mageloProfile) : []

  let maxHp = Math.round(def.baseHp * lf + (stats?.hpBonus || 0))
  let atk = Math.round(def.baseAtk * lf + (stats?.physicalPower || 0) * 0.5)
  let defense = Math.round(def.baseDef * lf + (stats?.armor || 0) * 0.15)
  let spellPower = Math.round((def.baseAtk * 0.9) * lf + (stats?.magicalPower || 0) * 0.6)
  let maxMana = usesMana(def.name) ? Math.round(80 * lf + (stats?.manaReserve || 0)) : 0
  let maxEndurance = usesEndurance(def.name) ? Math.round(70 * lf) : 0

  if (traits.includes('shield_equipped')) defense += 3
  if (traits.includes('haste_equipment')) atk += 2
  if (traits.includes('mana_gear')) maxMana += 10

  const armorMitigation = clamp((stats?.armor || 0) / 100, 0, 0.2)
  const passive = getPassive(def.name)

  return {
    base: {
      class_name: def.name,
      level: character.level,
      maxHp,
      atk,
      def: defense,
      spellPower,
      maxMana,
      maxEndurance,
    },
    derived: {
      armorMitigation,
      healMult: traits.includes('focus_healing') ? 0.08 : 0,
      critBonus: traits.includes('haste_equipment') ? 0.03 : 0,
      petPower: passive?.modifiers?.petPower || 0,
      healEfficiency: passive?.modifiers?.healEfficiency || 0,
      resistances: stats?.resistances || { fire: 0, cold: 0, magic: 0 },
    },
    equipmentKnown,
    traits,
    source: equipmentKnown ? 'magelo' : 'class_level',
    snapshotDate: mageloProfile?.snapshotDate || null,
    passive,
    role: def.role,
    position: defaultPosition(def.name, def.role),
  }
}

/**
 * @param {object} character
 * @param {object} identity from buildCombatIdentity
 * @param {number} index
 */
export function toCombatantFromIdentity(character, identity, index = 0) {
  const b = identity.base
  const d = identity.derived
  return {
    id: character.char_id,
    slot: index,
    name: character.name,
    class_name: b.class_name,
    fictional: Boolean(character.fictional),
    level: character.level,
    maxHp: b.maxHp,
    hp: b.maxHp,
    atk: b.atk,
    def: b.def,
    spellPower: b.spellPower,
    maxMana: b.maxMana,
    mana: b.maxMana,
    maxEndurance: b.maxEndurance,
    endurance: b.maxEndurance,
    alive: true,
    position: identity.position,
    cooldowns: {},
    statuses: [],
    casting: null,
    armorMitigation: d.armorMitigation,
    healMult: d.healMult,
    critBonus: d.critBonus,
    petPower: d.petPower,
    healEfficiency: d.healEfficiency,
    resistances: d.resistances,
    equipmentKnown: identity.equipmentKnown,
    traits: identity.traits,
    identitySource: identity.source,
    runAtkMult: 0,
    runHealMult: 0,
    tempAtkMult: 0,
    flags: {},
  }
}

/**
 * Load static profiles map once. Returns Map nameLower -> profile.
 * @param {typeof fetch} [fetchImpl]
 */
export async function loadCombatProfiles(fetchImpl = globalThis.fetch) {
  if (profileCache) return profileCache
  if (profileLoadPromise) return profileLoadPromise
  profileLoadPromise = (async () => {
    try {
      const res = await fetchImpl('/expedition/combat-profiles.json', { cache: 'force-cache' })
      if (!res.ok) {
        profileCache = new Map()
        return profileCache
      }
      const json = await res.json()
      const map = new Map()
      const entries = json.profiles || json
      for (const [name, profile] of Object.entries(entries)) {
        if (name === 'version' || name === 'snapshotDate' || name === 'guild') continue
        map.set(String(name).toLowerCase(), profile)
      }
      profileCache = map
      return map
    } catch {
      profileCache = new Map()
      return profileCache
    }
  })()
  return profileLoadPromise
}

/**
 * @param {string} name
 * @param {Map<string, object>} [map]
 */
export function lookupProfile(name, map = profileCache) {
  if (!map || !name) return null
  return map.get(String(name).toLowerCase()) || null
}

/**
 * Party radar scores 0-100 from abilities + identity.
 * @param {object[]} partyChars
 * @param {object[]} identities
 */
export function evaluatePartyRadar(partyChars, identities) {
  const classes = partyChars.map((c) => c.class_name)
  const has = (n) => classes.includes(n)
  let survivability = 30
  let healing = 10
  let burst = 25
  let sustained = 25
  let control = 10
  let manaSustain = 15

  if (has('Warrior') || has('Paladin') || has('Shadow Knight')) survivability += 25
  if (has('Cleric')) healing += 40
  if (has('Druid') || has('Shaman')) healing += 20
  if (has('Wizard') || has('Rogue')) burst += 25
  if (has('Necromancer') || has('Magician') || has('Bard')) sustained += 20
  if (has('Enchanter') || has('Bard')) control += 30
  if (has('Shaman')) control += 10
  if (has('Enchanter') || has('Bard') || has('Magician')) manaSustain += 25
  if (has('Wizard')) manaSustain -= 5

  for (const id of identities || []) {
    if (id.equipmentKnown) {
      survivability += 3
      burst += 2
    }
  }

  const clamp100 = (n) => clamp(n, 0, 100)
  return {
    survivability: clamp100(survivability),
    healing: clamp100(healing),
    burst: clamp100(burst),
    sustained: clamp100(sustained),
    control: clamp100(control),
    manaSustain: clamp100(manaSustain),
  }
}

/**
 * @param {object[]} partyChars
 */
export function partyLimitationLine(partyChars) {
  const classes = partyChars.map((c) => c.class_name)
  const healers = classes.filter((c) => c === 'Cleric' || c === 'Druid' || c === 'Shaman').length
  const tanks = classes.filter((c) => c === 'Warrior' || c === 'Paladin' || c === 'Shadow Knight').length
  const cc = classes.filter((c) => c === 'Enchanter' || c === 'Bard').length
  if (healers === 0) return 'No dedicated healer. This expedition will be either extremely fast or extremely short.'
  if (cc >= 2) return "Excellent crowd control. You've assembled a party specifically designed to avoid fighting."
  if (healers >= 2 && tanks === 0) return 'Strong sustained healing, low burst damage. Quarm may die of boredom before you defeat him.'
  if (tanks === 0) return 'No tank. Someone will invent the role through suffering.'
  return 'A workable composition. The Inquisitor remains unconvinced.'
}
