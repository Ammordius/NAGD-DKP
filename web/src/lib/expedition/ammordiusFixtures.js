/**
 * Ammordius account toons for Expedition balance sims.
 * Names match Magelo sheets / combat-profiles.json keys (case-insensitive).
 */

/** @typedef {{ char_id: string, name: string, class_name: string, level: number }} PartyChar */

/** @type {Record<string, PartyChar>} */
export const AMMORDIUS_TOONS = {
  ammordius: { char_id: 'ammo_bard', name: 'Ammordius', class_name: 'Bard', level: 65 },
  tandiyen: { char_id: 'ammo_dru', name: 'Tandiyen', class_name: 'Druid', level: 65 },
  iaminae: { char_id: 'ammo_enc', name: 'Iaminae', class_name: 'Enchanter', level: 65 },
  ammomage: { char_id: 'ammo_mag', name: 'Ammomage', class_name: 'Magician', level: 65 },
  shadowammo: { char_id: 'ammo_shd', name: 'Shadowammo', class_name: 'Shadow Knight', level: 65 },
  healammo: { char_id: 'ammo_clr', name: 'Healammo', class_name: 'Cleric', level: 65 },
  ezram: { char_id: 'ammo_rng', name: 'Ezram', class_name: 'Ranger', level: 65 },
  animalammo: { char_id: 'ammo_bst', name: 'Animalammo', class_name: 'Beastlord', level: 65 },
  rezammo: { char_id: 'ammo_clr2', name: 'Rezammo', class_name: 'Cleric', level: 65 },
  malosammo: { char_id: 'ammo_shm', name: 'Malosammo', class_name: 'Shaman', level: 65 },
  badammo: { char_id: 'ammo_war', name: 'Badammo', class_name: 'Warrior', level: 65 },
  whammo: { char_id: 'ammo_wiz', name: 'Whammo', class_name: 'Wizard', level: 65 },
  tappyammo: { char_id: 'ammo_nec', name: 'Tappyammo', class_name: 'Necromancer', level: 65 },
}

/**
 * @param {...string} keys
 * @returns {PartyChar[]}
 */
export function partyOf(...keys) {
  return keys.map((k) => {
    const t = AMMORDIUS_TOONS[k.toLowerCase()]
    if (!t) throw new Error(`Unknown Ammordius toon key: ${k}`)
    return { ...t }
  })
}

/** Named party compositions used by the balance matrix. */
export const AMMORDIUS_PARTIES = {
  balanced: {
    id: 'balanced',
    label: 'WAR+CLR+WIZ (Badammo/Healammo/Whammo)',
    party: () => partyOf('badammo', 'healammo', 'whammo'),
  },
  altBalanced: {
    id: 'altBalanced',
    label: 'SHD+SHM+RNG (Shadowammo/Malosammo/Ezram)',
    party: () => partyOf('shadowammo', 'malosammo', 'ezram'),
  },
  allDps: {
    id: 'allDps',
    label: 'WIZ+MAG+NEC (Whammo/Ammomage/Tappyammo)',
    party: () => partyOf('whammo', 'ammomage', 'tappyammo'),
  },
  noHealer: {
    id: 'noHealer',
    label: 'WAR+BRD+WIZ (Badammo/Ammordius/Whammo)',
    party: () => partyOf('badammo', 'ammordius', 'whammo'),
  },
  supportHeavy: {
    id: 'supportHeavy',
    label: 'WAR+CLR+ENC (Badammo/Healammo/Iaminae)',
    party: () => partyOf('badammo', 'healammo', 'iaminae'),
  },
}

/**
 * Build a Map nameLower → profile from combat-profiles.json shape.
 * @param {object} json
 * @returns {Map<string, object>}
 */
export function profilesMapFromJson(json) {
  const map = new Map()
  const entries = json?.profiles || json || {}
  for (const [name, profile] of Object.entries(entries)) {
    if (name === 'version' || name === 'snapshotDate' || name === 'guild') continue
    if (!profile || typeof profile !== 'object') continue
    map.set(String(name).toLowerCase(), profile)
  }
  return map
}
