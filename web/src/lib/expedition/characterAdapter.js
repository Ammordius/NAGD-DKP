import { getClassDef, roleOf } from './classDefinitions.js'

export const FICTIONAL_STARTERS = [
  { char_id: 'fic-tank', name: 'Unpaid Tank', class_name: 'Warrior', level: 60, fictional: true },
  { char_id: 'fic-healer', name: 'Reluctant Healer', class_name: 'Cleric', level: 60, fictional: true },
  { char_id: 'fic-dps', name: 'Fire Hazard', class_name: 'Wizard', level: 60, fictional: true },
]

export const FICTIONAL_VOLUNTEERS = [
  { char_id: 'fic-vol-1', name: 'AFK Bard', class_name: 'Bard', level: 55, fictional: true },
  { char_id: 'fic-vol-2', name: 'Loot Officer Intern', class_name: 'Rogue', level: 52, fictional: true },
  { char_id: 'fic-vol-3', name: 'Temporary Monk', class_name: 'Monk', level: 58, fictional: true },
  { char_id: 'fic-vol-4', name: 'Borrowed Shaman', class_name: 'Shaman', level: 60, fictional: true },
  { char_id: 'fic-vol-5', name: 'Guest Enchanter', class_name: 'Enchanter', level: 57, fictional: true },
]

/**
 * @param {unknown} row
 * @returns {{ char_id: string, name: string, class_name: string, level: number|null, fictional: boolean, displayName: string }|null}
 */
export function normalizeCharacter(row) {
  if (!row || typeof row !== 'object') return null
  const r = /** @type {Record<string, unknown>} */ (row)
  const charId = r.char_id != null ? String(r.char_id) : ''
  if (!charId) return null
  const name = String(r.name || charId)
  const className = String(r.class_name || 'Warrior')
  const def = getClassDef(className)
  const levelRaw = r.level
  const level = typeof levelRaw === 'number' && Number.isFinite(levelRaw) ? levelRaw : (levelRaw != null && levelRaw !== '' ? Number(levelRaw) : null)
  return {
    char_id: charId,
    name,
    class_name: def.name,
    level: Number.isFinite(level) ? level : null,
    fictional: Boolean(r.fictional),
    displayName: name,
  }
}

/**
 * @param {unknown[]} rows
 * @returns {ReturnType<typeof normalizeCharacter>[]}
 */
export function normalizeRoster(rows) {
  const out = []
  const seen = new Set()
  for (const row of rows || []) {
    const n = normalizeCharacter(row)
    if (!n || seen.has(n.char_id)) continue
    seen.add(n.char_id)
    out.push(n)
  }
  return out
}

/**
 * Fill party to 3 with fictional guild volunteers.
 * @param {ReturnType<typeof normalizeCharacter>[]} selected
 * @returns {ReturnType<typeof normalizeCharacter>[]}
 */
export function fillPartyToThree(selected) {
  const party = normalizeRoster(selected).slice(0, 3)
  const used = new Set(party.map((c) => c.char_id))
  let i = 0
  while (party.length < 3 && i < FICTIONAL_VOLUNTEERS.length) {
    const v = normalizeCharacter(FICTIONAL_VOLUNTEERS[i++])
    if (!v || used.has(v.char_id)) continue
    used.add(v.char_id)
    party.push(v)
  }
  while (party.length < 3) {
    const idx = party.length
    const v = normalizeCharacter({
      ...FICTIONAL_STARTERS[idx % FICTIONAL_STARTERS.length],
      char_id: `fic-pad-${idx}`,
      name: `${FICTIONAL_STARTERS[idx % FICTIONAL_STARTERS.length].name} ${idx + 1}`,
    })
    if (v) party.push(v)
    else break
  }
  return party
}

/**
 * @param {ReturnType<typeof normalizeCharacter>[]} party
 */
export function partyComposition(party) {
  const counts = { tanking: 0, healing: 0, damage: 0, utility: 0 }
  for (const c of party || []) {
    const role = roleOf(c.class_name)
    if (role === 'tank') counts.tanking += 1
    else if (role === 'healer') counts.healing += 1
    else if (role === 'damage') counts.damage += 1
    else counts.utility += 1
    if (role === 'hybrid') {
      counts.damage += 1
      counts.utility += 1
    }
  }
  return counts
}

/**
 * @param {ReturnType<typeof normalizeCharacter>[]} party
 * @returns {string}
 */
export function compositionCommentary(party) {
  const classes = (party || []).map((c) => c.class_name)
  const healers = classes.filter((c) => roleOf(c) === 'healer').length
  const tanks = classes.filter((c) => roleOf(c) === 'tank').length
  const damage = classes.filter((c) => {
    const r = roleOf(c)
    return r === 'damage' || r === 'hybrid'
  }).length
  const wizards = classes.filter((c) => c === 'Wizard').length
  const allHealers = healers === classes.length && classes.length > 0
  const noHealer = healers === 0
  const noTank = tanks === 0

  if (wizards >= 3) return 'Three wizards and no healer. An ambitious interpretation of raid strategy.'
  if (allHealers) return 'Your entire party consists of healers. Eventually, the enemy may die of old age.'
  if (tanks >= 1 && noHealer && damage >= 2) return 'At least you brought a warrior. Somebody has to take responsibility for this disaster.'
  if (noHealer && noTank) return "You've chosen three damage dealers. I respect your commitment to dying quickly."
  if (noHealer) return 'No healer. The DKP Inquisitor has prepared the wipe paperwork in advance.'
  if (noTank) return 'No tank. The enemy will simply pick a wizard and file a formal complaint.'
  if (healers >= 2) return 'Two healers. Cautious. Suspiciously competent.'
  return 'A balanced party. I remain unconvinced this will help.'
}

/**
 * Build combatant from roster character + class stats.
 * @param {ReturnType<typeof normalizeCharacter>} character
 * @param {number} index
 */
export function toCombatant(character, index = 0) {
  const def = getClassDef(character.class_name)
  let maxHp = def.baseHp
  if (def.passive.id === 'modrod') maxHp += 8
  const level = character.level
  if (typeof level === 'number' && level > 0) {
    maxHp += Math.min(20, Math.floor((level - 50) / 2))
  }
  return {
    id: character.char_id,
    slot: index,
    name: character.name,
    class_name: def.name,
    fictional: Boolean(character.fictional),
    level: character.level,
    maxHp,
    hp: maxHp,
    atk: def.baseAtk,
    def: def.baseDef,
    alive: true,
    cooldowns: {},
    statuses: [],
    flags: {
      shamanFreeSpecial: def.passive.id === 'cani',
      mendUsed: false,
      skShield: def.passive.id === 'fearless' ? 10 : 0,
    },
  }
}
