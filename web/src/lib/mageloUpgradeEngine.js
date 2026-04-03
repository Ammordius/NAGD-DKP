/**
 * Magelo-style upgrade scoring for a single candidate item vs a character's equipped gear.
 * Extracted from magelo/deploy_local/class_rankings.html (computeUpgradesForCharacter / scoreItemForUpgrade).
 */

export const CLASS_TO_ABBREV = {
  Warrior: 'WAR',
  Cleric: 'CLR',
  Paladin: 'PAL',
  Ranger: 'RNG',
  'Shadow Knight': 'SHD',
  Druid: 'DRU',
  Monk: 'MNK',
  Bard: 'BRD',
  Rogue: 'ROG',
  Shaman: 'SHM',
  Necromancer: 'NEC',
  Wizard: 'WIZ',
  Magician: 'MAG',
  Enchanter: 'ENC',
  Beastlord: 'BST',
}

export const SLOT_ID_TO_EQ_SLOTS = {
  1: ['EAR'],
  2: ['HEAD'],
  3: ['FACE'],
  4: ['EAR'],
  5: ['NECK'],
  6: ['SHOULDER', 'SHOULDERS'],
  7: ['ARMS'],
  8: ['BACK'],
  9: ['WRIST'],
  10: ['WRIST'],
  11: ['RANGE'],
  12: ['HANDS'],
  13: ['PRIMARY', 'MAIN'],
  14: ['SECONDARY', 'OFF'],
  15: ['FINGER', 'FINGERS'],
  16: ['FINGER', 'FINGERS'],
  17: ['CHEST'],
  18: ['LEGS'],
  19: ['FEET'],
  20: ['WAIST'],
  21: ['POWER'],
  22: ['AMMO'],
}

export const SLOT_NAMES_FOR_UI = {
  1: 'Ear',
  2: 'Head',
  3: 'Face',
  4: 'Ear',
  5: 'Neck',
  6: 'Shoulder',
  7: 'Arms',
  8: 'Back',
  9: 'Wrist',
  10: 'Wrist',
  11: 'Range',
  12: 'Hands',
  13: 'Main Hand',
  14: 'Off Hand',
  15: 'Ring 1',
  16: 'Ring 2',
  17: 'Chest',
  18: 'Legs',
  19: 'Feet',
  20: 'Waist',
  21: 'Power Source',
  22: 'Ammo',
}

const FOCUS_OVERLAP_GROUPS = [
  ['Beneficial Spell Haste', 'Detrimental Spell Haste', 'Enhancement Spell Haste', 'Focus Affliction Haste'],
  ['Buff Spell Duration', 'Detrimental Spell Duration'],
]

const SPELL_DAMAGE_TYPE_MAP_JS = {
  'Anger of Druzzil': 'Magic',
  'Fury of Druzzil': 'Magic',
  'Wrath of Druzzil': 'Magic',
  'Anger of Ro': 'Fire',
  'Anger of Solusek': 'Fire',
  'Fury of Ro': 'Fire',
  'Fury of Solusek': 'All',
  'Wrath of Ro': 'Fire',
  'Burning Affliction': 'Fire',
  'Focus of Flame': 'Fire',
  'Fires of Sol': 'Fire',
  'Inferno of Sol': 'Fire',
  "Summer's Anger": 'Fire',
  "Summer's Vengeance": 'Fire',
  'Anger of E`ci': 'Cold',
  'Fury of E`ci': 'Cold',
  'Wrath of E`ci': 'Cold',
  'Chill of the Umbra': 'Cold',
  'Enchantment of Destruction': 'Magic',
  'Insidious Dreams': 'Magic',
  'Vengeance of Eternity': 'DoT',
  'Vengeance of Time': 'DoT',
  'Cursed Extension': 'DoT',
  'Improved Damage': 'All',
  "Gallenite's ____": 'All',
}

const SPELL_MANA_EFFICIENCY_CATEGORY_MAP_JS = {
  'Affliction Efficiency': 'Det',
  'Affliction Preservation': 'Det',
  'Enhancement Efficiency': 'Bene',
  'Enhancement Preservation': 'Bene',
  'Preservation of Mithaniel': 'Bene',
  'Reanimation Efficiency': 'Bene',
  'Reanimation Preservation': 'Bene',
  'Summoning Efficiency': 'Bene',
  'Summoning Preservation': 'Bene',
  'Alluring Preservation': 'Bene',
  'Mana Preservation': 'Nuke',
  'Preservation of Xegony': 'Nuke',
  'Preservation of Solusek': 'Nuke',
  'Preservation of Ro': 'Nuke',
  'Preservation of Druzzil': 'Nuke',
  'Conservation of Xegony': 'All',
  'Preservation of the Akheva': 'All',
  'Mana Preservation IV': 'All',
  'Conservation of Solusek': 'Det',
  'Conservation of Bertoxxulous': 'LDD',
  'Sanguine Preservation': 'Sanguine',
  'Sanguine Enchantment': 'Sanguine',
}

const SPELL_HASTE_CATEGORY_MAP_JS = {
  'Haste of Solusek': 'Det',
  'Quickening of Solusek': 'Det',
  'Blaze of the Lightbringer': 'Det',
  'Shade Stone Focus': 'Det',
  'Speed of Solusek': 'Det',
  'Affliction Haste': 'Affliction',
  'Enhancement Haste': 'Enhancement',
  'Reanimation Haste': 'Enhancement',
  'Summoning Haste': 'Enhancement',
  'Haste of Mithaniel': 'Bene',
  'Haste of Druzzil': 'All',
  'Blessing of Reverence': 'All',
  'Contemplative Alacrity': 'All',
  'Conundrum of Speed': 'All',
  "Naki's _______ Pernicity": 'All',
  'Quickening of Druzzil': 'All',
  'Quickening of Mithaniel': 'Bene',
  'Speed of Mithaniel': 'Bene',
  'Spell Haste': 'All',
  'Speeding Thought': 'All',
}

const SPELL_DURATION_CATEGORY_MAP_JS = {
  'Extended Affliction': 'Det',
  'Affliction Extension': 'Det',
  'Extended Enhancement': 'Bene',
  'Enhancement Extension': 'Bene',
  Chrononostrum: 'Bene',
  Eterninostrum: 'Bene',
  'Extended Reanimation': 'Bene',
  'Extended Summoning': 'Bene',
}

function normalizeFocusNameForMap(name) {
  if (!name || typeof name !== 'string') return name
  return name.replace(/\s+(?:I{1,3}|IV|V|VI{0,3}|VII)$/i, '').trim() || name
}

function focusMapGet(m, name, defaultVal) {
  if (name != null && m[name] !== undefined) return m[name]
  const n = normalizeFocusNameForMap(name)
  return n != null && m[n] !== undefined ? m[n] : defaultVal
}

export function itemMatchesSlot(slotId, itemSlotString) {
  if (!itemSlotString || typeof itemSlotString !== 'string') return false
  const eqSlots = SLOT_ID_TO_EQ_SLOTS[slotId]
  if (!eqSlots) return false
  const parts = itemSlotString.toUpperCase().split(/\s+/)
  return eqSlots.some((eq) => parts.some((p) => p === eq || p.startsWith(eq)))
}

export function isItemTwoHanded(stats) {
  if (!stats || typeof stats.slot !== 'string') return false
  const slotUpper = stats.slot.toUpperCase()
  const parts = slotUpper.split(/\s+/)
  if (parts.includes('PRIMARY') && parts.includes('SECONDARY')) return true
  const skill = stats.skill && typeof stats.skill === 'string' ? stats.skill.toUpperCase() : ''
  const isPrimarySlot = parts.includes('PRIMARY') || parts.includes('MAIN')
  const is2HSkill = skill.startsWith('2H') || skill.includes('2H ')
  return isPrimarySlot && is2HSkill
}

export function isItemLore(stats) {
  if (!stats) return false
  const flags = stats.flags
  if (Array.isArray(flags)) return flags.some((f) => String(f).toUpperCase().includes('LORE'))
  if (typeof flags === 'string' && flags.trim()) return flags.toUpperCase().includes('LORE')
  return false
}

export function itemUsableByClass(itemClasses, classAbbrev) {
  if (!classAbbrev) return true
  if (!itemClasses || typeof itemClasses !== 'string') return true
  const c = (itemClasses || '').trim().toUpperCase()
  if (c === 'ALL') return true
  return c.split(/\s+/).indexOf(classAbbrev) !== -1
}

function fociiRecordToCandidateKeyValues(focus) {
  const name = focus.name || ''
  const cat = focus.category || ''
  const pct = Number(focus.percentage) || 0
  const keys = []
  if (cat === 'Spell Damage') {
    const damageType = focusMapGet(SPELL_DAMAGE_TYPE_MAP_JS, name, 'All')
    keys.push({ key: `Spell Damage (${damageType})`, value: pct })
    return keys
  }
  if (cat === 'Spell Mana Efficiency') {
    const sub = focusMapGet(SPELL_MANA_EFFICIENCY_CATEGORY_MAP_JS, name, 'Nuke')
    if (sub === 'LDD') {
      keys.push({ key: 'Spell Mana Efficiency (Long Duration Debuff)', value: pct })
    } else if (sub === 'All') {
      ;[
        'Spell Mana Efficiency (Bene)',
        'Spell Mana Efficiency (Det)',
        'Spell Mana Efficiency (Nuke)',
        'Spell Mana Efficiency (Long Duration Debuff)',
      ].forEach((k) => keys.push({ key: k, value: pct }))
    } else {
      keys.push({ key: `Spell Mana Efficiency (${sub})`, value: pct })
    }
    return keys
  }
  if (cat === 'Long Duration Detrimental Mana Preservation') {
    keys.push({ key: 'Spell Mana Efficiency (Long Duration Debuff)', value: pct })
    return keys
  }
  if (cat === 'Spell Haste') {
    const sub = focusMapGet(SPELL_HASTE_CATEGORY_MAP_JS, name, 'Bene')
    if (sub === 'Det') keys.push({ key: 'Detrimental Spell Haste', value: pct })
    else if (sub === 'Affliction') keys.push({ key: 'Focus Affliction Haste', value: pct })
    else if (sub === 'All') {
      keys.push({ key: 'Beneficial Spell Haste', value: pct })
      keys.push({ key: 'Detrimental Spell Haste', value: pct })
    } else if (sub === 'Enhancement') keys.push({ key: 'Enhancement Spell Haste', value: pct })
    else keys.push({ key: 'Beneficial Spell Haste', value: pct })
    return keys
  }
  if (cat === 'Buff Spell Duration' || cat === 'Detrimental Spell Duration' || cat === 'All Spell Duration') {
    if (cat === 'All Spell Duration') {
      keys.push({ key: 'Buff Spell Duration', value: pct })
      keys.push({ key: 'Detrimental Spell Duration', value: pct })
    } else {
      const durCat = focusMapGet(SPELL_DURATION_CATEGORY_MAP_JS, name, cat === 'Buff Spell Duration' ? 'Bene' : 'Det')
      keys.push({ key: durCat === 'Bene' ? 'Buff Spell Duration' : 'Detrimental Spell Duration', value: pct })
    }
    return keys
  }
  keys.push({ key: cat, value: pct })
  return keys
}

function mergeSpellFociiIntoFocusValuesByItem(byItem, spellFociiList) {
  if (!spellFociiList || !Array.isArray(spellFociiList)) return
  for (const focus of spellFociiList) {
    const pairs = fociiRecordToCandidateKeyValues(focus)
    if (!pairs.length) continue
    for (const item of focus.items || []) {
      const id = item.id != null ? Number(item.id) : null
      if (id == null || Number.isNaN(id)) continue
      for (const { key, value } of pairs) {
        const val = Number(value) || 0
        if (!byItem[id]) byItem[id] = {}
        if (!byItem[id][key] || val > byItem[id][key]) byItem[id][key] = val
      }
    }
  }
}

function findSpellFociiRecordForItemId(spellFociiList, itemId) {
  if (!spellFociiList || !Array.isArray(spellFociiList)) return null
  const nid = Number(itemId)
  if (Number.isNaN(nid)) return null
  for (const focus of spellFociiList) {
    for (const item of focus.items || []) {
      if (item.id != null && Number(item.id) === nid) return focus
    }
  }
  return null
}

function inferFocusCategoryFromItemStatsName(focusName) {
  const n = normalizeFocusNameForMap(focusName)
  if (!n || typeof n !== 'string') return null
  const nLower = n.toLowerCase()
  const pctOverride = { 'speeding thought': 18, 'vengeance of time': 25, 'vengeance of eternity': 30 }
  const defaultPct = pctOverride[nLower] !== undefined ? pctOverride[nLower] : 15
  if (focusMapGet(SPELL_DAMAGE_TYPE_MAP_JS, focusName, undefined) !== undefined) {
    return { category: 'Spell Damage', defaultPct }
  }
  if (focusMapGet(SPELL_MANA_EFFICIENCY_CATEGORY_MAP_JS, focusName, undefined) !== undefined) {
    return { category: 'Spell Mana Efficiency', defaultPct }
  }
  if (focusMapGet(SPELL_HASTE_CATEGORY_MAP_JS, focusName, undefined) !== undefined) {
    return { category: 'Spell Haste', defaultPct }
  }
  const dur = focusMapGet(SPELL_DURATION_CATEGORY_MAP_JS, focusName, undefined)
  if (dur !== undefined) {
    return { category: dur === 'Det' ? 'Detrimental Spell Duration' : 'Buff Spell Duration', defaultPct }
  }
  if (nLower === 'improved healing') return { category: 'Healing Enhancement', defaultPct }
  return null
}

function mergeItemStatsFocusIntoFocusValuesByItemFull(byItem, itemStats, spellFociiList) {
  if (!itemStats || typeof itemStats !== 'object') return
  for (const [idStr, stats] of Object.entries(itemStats)) {
    if (!stats || typeof stats !== 'object') continue
    const id = Number(idStr)
    if (Number.isNaN(id)) continue
    const focusName = (stats.focusSpellName != null ? String(stats.focusSpellName) : '').trim()
      || (stats.focus != null ? String(stats.focus) : '').trim()
    if (!focusName) continue
    let record = null
    const rawPct = stats.focusPct != null ? stats.focusPct : stats.focusPercentage
    const rawPctNum = rawPct != null && rawPct !== '' ? Number(rawPct) : NaN
    if (!Number.isNaN(rawPctNum)) {
      const inf = inferFocusCategoryFromItemStatsName(focusName)
      if (!inf) continue
      record = { name: focusName, category: inf.category, percentage: rawPctNum }
    } else {
      const sf = findSpellFociiRecordForItemId(spellFociiList, id)
      if (sf) {
        record = {
          name: sf.name || focusName,
          category: sf.category || '',
          percentage: Number(sf.percentage) || 0,
        }
      } else {
        const inf = inferFocusCategoryFromItemStatsName(focusName)
        if (!inf) continue
        record = { name: focusName, category: inf.category, percentage: inf.defaultPct }
      }
    }
    const pairs = fociiRecordToCandidateKeyValues(record)
    for (const { key, value } of pairs) {
      const val = Number(value) || 0
      if (!byItem[id]) byItem[id] = {}
      if (!byItem[id][key] || val > byItem[id][key]) byItem[id][key] = val
    }
  }
}

export function buildFocusValuesByItem(itemStats, focusCandidates, spellFociiList) {
  const byItem = {}
  for (const [focusKey, list] of Object.entries(focusCandidates || {})) {
    if (!Array.isArray(list)) continue
    for (const it of list) {
      const id = it.item_id != null && it.item_id !== '' ? Number(it.item_id) : null
      if (id == null || Number.isNaN(id)) continue
      if (!byItem[id]) byItem[id] = {}
      const val = it.value != null && it.value !== '' ? Number(it.value) : 0
      if (!byItem[id][focusKey] || val > byItem[id][focusKey]) byItem[id][focusKey] = val
    }
  }
  mergeSpellFociiIntoFocusValuesByItem(byItem, spellFociiList)
  mergeItemStatsFocusIntoFocusValuesByItemFull(byItem, itemStats, spellFociiList)
  return byItem
}

function getWeightForFocusKey(focusKey, focusWeights) {
  if (!focusWeights) return 0
  const match = focusKey.match(/^(.+)\s+\(([^)]+)\)$/)
  if (match) {
    const [, parent, sub] = match
    const parentW = focusWeights[parent]
    if (typeof parentW === 'object' && parentW !== null && parentW[sub] !== undefined) return parentW[sub]
    return 0
  }
  const w = focusWeights[focusKey]
  return typeof w === 'number' ? w : 0
}

function getFocusScoreForItem(itemId, focusWeights, focusValuesByItem) {
  const vals = focusValuesByItem[itemId]
  if (!vals) return 0
  const keyToContrib = {}
  for (const [focusKey, value] of Object.entries(vals)) {
    const w = getWeightForFocusKey(focusKey, focusWeights)
    if (w > 0) keyToContrib[focusKey] = (value / 100) * w
  }
  let total = 0
  const used = new Set()
  for (const group of FOCUS_OVERLAP_GROUPS) {
    let maxInGroup = 0
    for (const k of group) {
      if (keyToContrib[k] != null) {
        maxInGroup = Math.max(maxInGroup, keyToContrib[k])
        used.add(k)
      }
    }
    total += maxInGroup
  }
  for (const [k, contrib] of Object.entries(keyToContrib)) {
    if (!used.has(k)) total += contrib
  }
  return total
}

const ITEM_SCORE_SCALES = { hp: 5000, mana: 4000, ac: 1200, resists: 400 }

function getResistCurveScoreForValue(resistValue) {
  if (resistValue <= 0) return 0
  const L = 220.0
  const H = 500.0
  const r = 0.35
  const p = 1.2
  const x = parseFloat(resistValue)
  let S_x
  if (x <= L) S_x = x
  else if (x < H) {
    const t = (x - L) / (H - L)
    S_x = L + (x - L) * (r + (1 - r) * (1 - t) ** p)
  } else {
    const S_500 = L + r * (H - L)
    S_x = S_500 + r * (x - H)
  }
  const S_500 = L + r * (H - L)
  return S_500 > 0 ? Math.min((S_x / S_500) * 100.0, 100.0) : 0
}

export function getStatScoreForItem(stats, norm) {
  if (!stats || !norm) return 0
  const mods = stats.mods || []
  let hp = 0
  let mana = 0
  mods.forEach((m) => {
    if ((m.label || '').toUpperCase() === 'HP') hp += Number(m.value) || 0
    if ((m.label || '').toUpperCase() === 'MANA') mana += Number(m.value) || 0
  })
  const ac = Number(stats.ac) || 0
  let resistCurveSum = 0
  ;(stats.resists || []).forEach((r) => {
    const val = Number(r.value) || 0
    if (val > 0) resistCurveSum += getResistCurveScoreForValue(val)
  })
  const scale = ITEM_SCORE_SCALES
  const resistContrib = (resistCurveSum / 500) * (norm.resists_pct || 0)
  return (
    (hp / scale.hp) * (norm.hp_pct || 0)
    + (mana / scale.mana) * (norm.mana_pct || 0)
    + (ac / scale.ac) * (norm.ac_pct || 0)
    + resistContrib
  )
}

const RESIST_LABEL_TO_ABBREV = { fire: 'FR', cold: 'CR', magic: 'MR', disease: 'DR', poison: 'PR' }
const RESIST_ORDER = ['FR', 'CR', 'MR', 'DR', 'PR']

function getItemRawStats(stats) {
  if (!stats) return { hp: 0, mana: 0, ac: 0, svAll: 0, svByType: {} }
  const mods = stats.mods || []
  let hp = 0
  let mana = 0
  mods.forEach((m) => {
    if ((m.label || '').toUpperCase() === 'HP') hp += Number(m.value) || 0
    if ((m.label || '').toUpperCase() === 'MANA') mana += Number(m.value) || 0
  })
  const ac = Number(stats.ac) || 0
  let svAll = 0
  const svByType = {}
  ;(stats.resists || []).forEach((r) => {
    const label = (r.label || '').toLowerCase()
    if (['magic', 'fire', 'cold', 'poison', 'disease'].includes(label)) {
      const val = Number(r.value) || 0
      svAll += val
      const abbrev = RESIST_LABEL_TO_ABBREV[label]
      if (abbrev) svByType[abbrev] = val
    }
  })
  return { hp, mana, ac, svAll, svByType }
}

function getItemStatDeltas(currentStats, candidateStats) {
  const cur = getItemRawStats(currentStats)
  const cand = getItemRawStats(candidateStats)
  const svDeltasByType = {}
  RESIST_ORDER.forEach((abbrev) => {
    const c = (cur.svByType && cur.svByType[abbrev]) || 0
    const n = (cand.svByType && cand.svByType[abbrev]) || 0
    svDeltasByType[abbrev] = n - c
  })
  return {
    hpDelta: cand.hp - cur.hp,
    manaDelta: cand.mana - cur.mana,
    acDelta: cand.ac - cur.ac,
    svAllDelta: cand.svAll - cur.svAll,
    svDeltasByType,
  }
}

function mergeRawStats(rawA, rawB) {
  const a = rawA || { hp: 0, mana: 0, ac: 0, svAll: 0, svByType: {} }
  const b = rawB || { hp: 0, mana: 0, ac: 0, svAll: 0, svByType: {} }
  const svByType = {}
  RESIST_ORDER.forEach((abbrev) => {
    svByType[abbrev] = ((a.svByType && a.svByType[abbrev]) || 0) + ((b.svByType && b.svByType[abbrev]) || 0)
  })
  return {
    hp: (a.hp || 0) + (b.hp || 0),
    mana: (a.mana || 0) + (b.mana || 0),
    ac: (a.ac || 0) + (b.ac || 0),
    svAll: (a.svAll || 0) + (b.svAll || 0),
    svByType,
  }
}

function getItemStatDeltasFromRaw(currentRaw, candidateStats) {
  const cur = currentRaw || { hp: 0, mana: 0, ac: 0, svAll: 0, svByType: {} }
  const cand = getItemRawStats(candidateStats)
  const svDeltasByType = {}
  RESIST_ORDER.forEach((abbrev) => {
    const c = (cur.svByType && cur.svByType[abbrev]) || 0
    const n = (cand.svByType && cand.svByType[abbrev]) || 0
    svDeltasByType[abbrev] = n - c
  })
  return {
    hpDelta: cand.hp - (cur.hp || 0),
    manaDelta: cand.mana - (cur.mana || 0),
    acDelta: cand.ac - (cur.ac || 0),
    svAllDelta: cand.svAll - (cur.svAll || 0),
    svDeltasByType,
  }
}

function sumFocusWeights(focusWeights) {
  if (!focusWeights || typeof focusWeights !== 'object') return 0
  let sum = 0
  for (const v of Object.values(focusWeights)) {
    if (typeof v === 'number') sum += v
    else if (v && typeof v === 'object') sum += Object.values(v).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0)
  }
  return sum
}

const STAT_TARGET = 0.65
const FOCUS_TARGET = 0.35

export function normalizeWeights(weights, focusMultiplier = 2.4, charClass = null) {
  const hp = Math.max(0, parseFloat(weights.hp_pct) || 0)
  const mana = Math.max(0, parseFloat(weights.mana_pct) || 0)
  const ac = Math.max(0, parseFloat(weights.ac_pct) || 0)
  const resists = Math.max(0, parseFloat(weights.resists_pct) || 0)
  const focusMult = Math.max(0, parseFloat(focusMultiplier) || 0)
  const focusWeights = weights.focus || {}

  const statSum = hp + mana + ac + resists
  const focusSubSum = sumFocusWeights(focusWeights)
  const focusSum = focusSubSum > 0 ? focusSubSum : focusMult

  const normalized = {
    hp_pct: 0,
    mana_pct: 0,
    ac_pct: 0,
    resists_pct: 0,
    focusTarget: 0,
    atk_pct: 0,
    haste_pct: 0,
    focus: {},
  }

  if (statSum <= 0 && focusSubSum <= 0) return normalized

  const statTarget = focusSubSum > 0 ? STAT_TARGET : 1.0
  const focusTarget = focusSubSum > 0 ? FOCUS_TARGET : 0

  if (statSum > 0) {
    const statScale = statTarget / statSum
    normalized.hp_pct = hp * statScale
    normalized.mana_pct = mana * statScale
    normalized.ac_pct = ac * statScale
    normalized.resists_pct = resists * statScale
  }
  if (focusSubSum > 0) {
    normalized.focusTarget = focusTarget
    const focusScale = focusTarget / (focusSubSum > 0 ? focusSubSum : focusMult || 1)
    if (focusSubSum > 0) {
      for (const [focusCat, focusValue] of Object.entries(focusWeights)) {
        if (focusCat === 'ATK' || focusCat === 'Haste') {
          const v = typeof focusValue === 'number' ? focusValue : 0
          if (v > 0) normalized.focus[focusCat] = v * focusScale
        } else if (typeof focusValue === 'object' && focusValue !== null) {
          const innerSum = Object.values(focusValue).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0)
          if (innerSum > 0) {
            normalized.focus[focusCat] = {}
            for (const [k, v] of Object.entries(focusValue)) {
              if (typeof v === 'number' && v > 0) {
                normalized.focus[focusCat][k] = (v / focusSubSum) * focusTarget
              }
            }
          }
        } else if (typeof focusValue === 'number' && focusValue > 0) {
          normalized.focus[focusCat] = focusValue * focusScale
        }
      }
    } else {
      if (focusWeights.ATK) normalized.focus.ATK = focusTarget * (parseFloat(focusWeights.ATK) || 0) / (focusMult || 1)
      if (focusWeights.Haste) normalized.focus.Haste = focusTarget * (parseFloat(focusWeights.Haste) || 0) / (focusMult || 1)
      if (focusWeights.FT) normalized.focus.FT = focusTarget * (parseFloat(focusWeights.FT) || 0) / (focusMult || 1)
    }
  }

  void charClass
  void focusSum
  return normalized
}

export function scoreItemForUpgrade(itemStats, itemId, norm, focusWeights, focusValuesByItem) {
  const statScore = getStatScoreForItem(itemStats, norm)
  const focusScore = getFocusScoreForItem(itemId, focusWeights, focusValuesByItem)
  return statScore + focusScore
}

/**
 * Shared class weights + focus maps for upgrade scoring (Magelo class_rankings parity).
 * @param {object} ctx - itemStats, classWeights, focusCandidates, optional spellFociiList, elementalDisplayNames, focusMultiplier
 * @returns {{ ok: true, norm, focusWeights, focusValuesByItem, charClass, classAbbrev, itemStats, elementalDisplayNames } | { ok: false, reason: string }}
 */
function prepareCharScoringOrNull(char, ctx) {
  const {
    itemStats,
    classWeights,
    focusCandidates = {},
    spellFociiList = null,
    focusMultiplier = 2.4,
  } = ctx
  const charClass = char?.class
  const weights = JSON.parse(JSON.stringify(classWeights[charClass] || {}))
  if (!weights || Object.keys(weights).length === 0) {
    return { ok: false, reason: 'no_class_weights' }
  }
  const norm = normalizeWeights(weights, focusMultiplier, charClass)
  const focusWeights = norm.focus || {}
  const focusValuesByItem = buildFocusValuesByItem(itemStats, focusCandidates, spellFociiList)
  const classAbbrev = CLASS_TO_ABBREV[charClass] || ''
  return {
    ok: true,
    norm,
    focusWeights,
    focusValuesByItem,
    charClass,
    classAbbrev,
    itemStats,
    elementalDisplayNames: ctx.elementalDisplayNames || {},
  }
}

/**
 * Per-slot upgrade candidates vs equipped gear (same algorithm as magelo/deploy_local/class_rankings.html computeUpgradesForCharacter).
 * @param {object} char - { class, inventory: [{ slot_id, item_id, item_name }] }
 * @param {number} maxPerSlot
 * @param {boolean} includeDowngrades
 * @param {object} ctx - same as evaluateItemUpgradeForCharacter
 * @returns {{ bySlot: Array, anyMissing: boolean, error?: string }}
 */
export function computeUpgradesForCharacter(char, maxPerSlot, includeDowngrades, ctx) {
  let m = maxPerSlot
  if (m == null || m < 1) m = 5
  if (includeDowngrades == null) includeDowngrades = false

  const prep = prepareCharScoringOrNull(char, ctx)
  if (!prep.ok) {
    return { bySlot: [], anyMissing: false, error: prep.reason }
  }

  const { norm, focusWeights, focusValuesByItem, classAbbrev, itemStats, elementalDisplayNames } = prep
  const equippedOnly = (char.inventory || []).filter((i) => i.slot_id >= 1 && i.slot_id <= 22)
  const bySlot = []
  let anyMissing = false

  for (const inv of equippedOnly) {
    const slotId = inv.slot_id
    const slotName = SLOT_NAMES_FOR_UI[slotId] || `Slot ${slotId}`
    const currentItemId =
      inv.item_id != null && inv.item_id !== '' ? Number(inv.item_id) : null
    const currentItemName =
      inv.item_name || (currentItemId ? `Item ${currentItemId}` : '')
    let currentScore = 0
    let currentInData = false
    const currentStats =
      currentItemId != null && !Number.isNaN(currentItemId) && itemStats[String(currentItemId)]
        ? itemStats[String(currentItemId)]
        : null
    if (currentStats) {
      currentInData = true
      currentScore = scoreItemForUpgrade(
        currentStats,
        currentItemId,
        norm,
        focusWeights,
        focusValuesByItem,
      )
    } else {
      anyMissing = true
    }

    let offhandStats = null
    let offhandScore = 0
    if (slotId === 13) {
      const offhandInv = equippedOnly.find((i) => i.slot_id === 14)
      const offhandItemId =
        offhandInv && offhandInv.item_id != null && offhandInv.item_id !== ''
          ? Number(offhandInv.item_id)
          : null
      if (offhandItemId != null && !Number.isNaN(offhandItemId) && itemStats[String(offhandItemId)]) {
        offhandStats = itemStats[String(offhandItemId)]
        offhandScore = scoreItemForUpgrade(
          offhandStats,
          offhandItemId,
          norm,
          focusWeights,
          focusValuesByItem,
        )
      }
    }

    const otherEquippedIds = new Set(
      equippedOnly
        .filter((i) => i.slot_id !== slotId)
        .map((i) => (i.item_id != null && i.item_id !== '' ? Number(i.item_id) : null))
        .filter((n) => n != null && !Number.isNaN(n)),
    )
    const candidates = []
    for (const [idStr, stats] of Object.entries(itemStats)) {
      const id = Number(idStr)
      if (Number.isNaN(id) || !stats) continue
      if (!itemMatchesSlot(slotId, stats.slot)) continue
      if (!itemUsableByClass(stats.classes, classAbbrev)) continue
      if (slotId === 14 && isItemTwoHanded(stats)) continue
      if (isItemLore(stats) && otherEquippedIds.has(id)) continue
      const score = scoreItemForUpgrade(stats, id, norm, focusWeights, focusValuesByItem)

      const is2her = isItemTwoHanded(stats)
      let baselineScore = currentScore
      let deltas
      if (slotId === 13 && is2her) {
        baselineScore = currentScore + offhandScore
        const currentRaw = mergeRawStats(getItemRawStats(currentStats), getItemRawStats(offhandStats))
        deltas = getItemStatDeltasFromRaw(currentRaw, stats)
      } else {
        deltas = getItemStatDeltas(currentStats, stats)
      }
      const delta = score - baselineScore
      if (!includeDowngrades && delta <= 0) continue

      const focusSpellName =
        stats.focusSpellName != null && stats.focusSpellName !== '' ? String(stats.focusSpellName) : ''
      candidates.push({
        itemId: id,
        itemName: stats.name || elementalDisplayNames[String(id)] || `Item ${id}`,
        score,
        delta,
        deltas,
        focusSpellName,
      })
    }
    candidates.sort((a, b) => b.delta - a.delta)
    const upgrades = candidates.slice(0, m)

    bySlot.push({
      slotId,
      slotName,
      currentItemName,
      currentItemId,
      currentScore,
      currentInData,
      upgrades,
    })
  }

  const hasSlot14 = bySlot.some((s) => s.slotId === 14)
  const slot13Entry = bySlot.find((s) => s.slotId === 13)
  const mainHandIs2H =
    slot13Entry &&
    slot13Entry.currentItemId != null &&
    itemStats[String(slot13Entry.currentItemId)] &&
    isItemTwoHanded(itemStats[String(slot13Entry.currentItemId)])

  if (!hasSlot14 && mainHandIs2H) {
    const slotId = 14
    const slotName = SLOT_NAMES_FOR_UI[slotId] || 'Off Hand'
    const currentItemId = null
    const currentItemName = ''
    const currentScore = 0
    const currentInData = true
    const otherEquippedIds = new Set(
      equippedOnly
        .filter((i) => i.slot_id !== slotId)
        .map((i) => (i.item_id != null && i.item_id !== '' ? Number(i.item_id) : null))
        .filter((n) => n != null && !Number.isNaN(n)),
    )
    const candidates = []
    for (const [idStr, stats] of Object.entries(itemStats)) {
      const id = Number(idStr)
      if (Number.isNaN(id) || !stats) continue
      if (!itemMatchesSlot(slotId, stats.slot)) continue
      if (!itemUsableByClass(stats.classes, classAbbrev)) continue
      if (slotId === 14 && isItemTwoHanded(stats)) continue
      if (isItemLore(stats) && otherEquippedIds.has(id)) continue
      const score = scoreItemForUpgrade(stats, id, norm, focusWeights, focusValuesByItem)
      const deltas = getItemStatDeltas(null, stats)
      const delta = score
      if (!includeDowngrades && delta <= 0) continue
      const focusSpellName =
        stats.focusSpellName != null && stats.focusSpellName !== '' ? String(stats.focusSpellName) : ''
      candidates.push({
        itemId: id,
        itemName: stats.name || elementalDisplayNames[String(id)] || `Item ${id}`,
        score,
        delta,
        deltas,
        focusSpellName,
      })
    }
    candidates.sort((a, b) => b.delta - a.delta)
    const upgrades = candidates
    bySlot.push({
      slotId,
      slotName,
      currentItemName,
      currentItemId,
      currentScore,
      currentInData,
      upgrades,
    })
  }

  return { bySlot, anyMissing }
}

/**
 * @param {object} char - { class, inventory: [{ slot_id, item_id, item_name }] }
 * @param {string|number} candidateItemId
 * @param {object} ctx - itemStats, classWeights (by class name), focusCandidates, optional spellFociiList, elementalDisplayNames
 */
export function evaluateItemUpgradeForCharacter(char, candidateItemId, ctx) {
  const { itemStats, elementalDisplayNames = {} } = ctx

  const idStr = String(candidateItemId)
  const candNum = Number(candidateItemId)
  if (Number.isNaN(candNum)) {
    return { eligible: false, reason: 'bad_item_id' }
  }

  const candidateStats = itemStats[idStr] || itemStats[candNum]
  if (!candidateStats) {
    return { eligible: false, reason: 'no_item_stats' }
  }

  const charClass = char.class
  const classAbbrev = CLASS_TO_ABBREV[charClass] || ''
  if (!itemUsableByClass(candidateStats.classes, classAbbrev)) {
    return { eligible: false, reason: 'class_mismatch' }
  }

  const prep = prepareCharScoringOrNull(char, ctx)
  if (!prep.ok) {
    return { eligible: false, reason: prep.reason }
  }

  const { norm, focusWeights, focusValuesByItem } = prep

  const equippedOnly = (char.inventory || []).filter((i) => i.slot_id >= 1 && i.slot_id <= 22)
  const getItemName = (itemIdNum) => {
    if (itemIdNum == null || Number.isNaN(itemIdNum)) return ''
    const st = itemStats[String(itemIdNum)]
    const n = st?.name || elementalDisplayNames[String(itemIdNum)]
    return n || `Item ${itemIdNum}`
  }

  let best = null

  for (let slotId = 1; slotId <= 22; slotId += 1) {
    if (!itemMatchesSlot(slotId, candidateStats.slot)) continue
    if (slotId === 14 && isItemTwoHanded(candidateStats)) continue

    const inv = equippedOnly.find((i) => i.slot_id === slotId)
    const currentItemId = inv && inv.item_id != null && inv.item_id !== '' ? Number(inv.item_id) : null
    const currentStats =
      currentItemId != null && !Number.isNaN(currentItemId) && itemStats[String(currentItemId)]
        ? itemStats[String(currentItemId)]
        : null

    let currentScore = 0
    if (currentStats) {
      currentScore = scoreItemForUpgrade(currentStats, currentItemId, norm, focusWeights, focusValuesByItem)
    }

    let offhandStats = null
    let offhandScore = 0
    if (slotId === 13) {
      const offhandInv = equippedOnly.find((i) => i.slot_id === 14)
      const offhandItemId =
        offhandInv && offhandInv.item_id != null && offhandInv.item_id !== '' ? Number(offhandInv.item_id) : null
      if (offhandItemId != null && !Number.isNaN(offhandItemId) && itemStats[String(offhandItemId)]) {
        offhandStats = itemStats[String(offhandItemId)]
        offhandScore = scoreItemForUpgrade(offhandStats, offhandItemId, norm, focusWeights, focusValuesByItem)
      }
    }

    const otherEquippedIds = new Set(
      equippedOnly
        .filter((i) => i.slot_id !== slotId)
        .map((i) => (i.item_id != null && i.item_id !== '' ? Number(i.item_id) : null))
        .filter((n) => n != null && !Number.isNaN(n)),
    )

    if (isItemLore(candidateStats) && otherEquippedIds.has(candNum)) {
      continue
    }

    const score = scoreItemForUpgrade(candidateStats, candNum, norm, focusWeights, focusValuesByItem)
    const is2her = isItemTwoHanded(candidateStats)
    let baselineScore = currentScore
    let deltas
    if (slotId === 13 && is2her) {
      baselineScore = currentScore + offhandScore
      const currentRaw = mergeRawStats(getItemRawStats(currentStats), getItemRawStats(offhandStats))
      deltas = getItemStatDeltasFromRaw(currentRaw, candidateStats)
    } else {
      deltas = getItemStatDeltas(currentStats, candidateStats)
    }
    const delta = score - baselineScore

    const candidateName =
      candidateStats.name || elementalDisplayNames[String(candNum)] || `Item ${candNum}`
    const row = {
      slotId,
      slotName: SLOT_NAMES_FOR_UI[slotId] || `Slot ${slotId}`,
      delta,
      deltas,
      currentItemId,
      currentItemName: inv?.item_name || getItemName(currentItemId),
      candidateName,
    }

    if (!best || row.delta > best.delta) best = row
  }

  if (!best) {
    return { eligible: false, reason: 'no_matching_slot' }
  }

  return {
    eligible: true,
    isUpgrade: best.delta > 0,
    slotId: best.slotId,
    slotName: best.slotName,
    scoreDelta: best.delta,
    hpDelta: best.deltas.hpDelta,
    deltas: best.deltas,
    currentItemId: best.currentItemId,
    currentItemName: best.currentItemName,
    candidateName: best.candidateName,
  }
}
