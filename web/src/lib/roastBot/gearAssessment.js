/**
 * Character gear assessment using public Magelo class_rankings + classCoverage helpers.
 * Never claims top-of-export is true BiS. Never invents scores without Magelo data.
 */

import {
  findRankingChar,
  buildMaxRawScoreByClass,
  normalizedGearPct,
  viabilityThresholdForClass,
  classNameToAbbrev,
  extractRawGearScore,
} from '../classCoverage.js'
import { computeCharacterUpgrades } from './upgrades.js'
import { gearBandRoast } from './bandRoasts.js'

/**
 * @param {{
 *   character: { char_id?: string, name?: string, class_name?: string },
 *   rankings: object|null,
 *   itemStats?: Record<string, object>|null,
 *   raidItemIds?: Set<number>|null,
 * }} args
 */
export function assessCharacterGear({ character, rankings, itemStats = null, raidItemIds = null }) {
  if (!character?.name) {
    return {
      ok: false,
      reason: 'missing_character',
      claims: [],
      referenced: { characters: [], items: [] },
    }
  }

  if (!rankings) {
    return {
      ok: false,
      reason: 'missing_magelo_export',
      claims: ['magelo_unavailable'],
      referenced: { characters: [character.name], items: [] },
      summary:
        `I cannot assess ${character.name}'s gear right now — the public Magelo rankings export is unavailable. No analysis was invented.`,
    }
  }

  const rankingsChars = rankings.characters || rankings.Chars || rankings.toons || []
  const magelo = findRankingChar(rankingsChars, character.name, character.class_name || '')
  if (!magelo) {
    return {
      ok: false,
      reason: 'character_not_in_magelo',
      claims: ['magelo_character_missing'],
      referenced: { characters: [character.name], items: [] },
      summary:
        `${character.name} is not in the current Magelo rankings export. I refuse to invent a gear score.`,
    }
  }

  const maxByClass = buildMaxRawScoreByClass(rankingsChars)
  const pct = normalizedGearPct(magelo, maxByClass)
  const abbrev = classNameToAbbrev(magelo.class || character.class_name)
  const threshold = viabilityThresholdForClass(abbrev)
  const raw = extractRawGearScore(magelo)
  const classMax = abbrev ? maxByClass.get(abbrev) : null

  if (pct == null || !Number.isFinite(pct)) {
    return {
      ok: false,
      reason: 'missing_gear_score',
      claims: ['magelo_score_missing'],
      referenced: { characters: [character.name], items: [] },
      summary:
        `${character.name} appears in Magelo, but no usable relative gear score is available. No verdict invented.`,
    }
  }

  const viable = threshold != null && pct > threshold
  const band = pct >= 92 ? 'strong' : pct > threshold ? 'viable' : 'under'
  const interpretation =
    band === 'strong'
      ? 'well geared'
      : band === 'viable'
        ? 'acceptably geared'
        : 'under-geared'
  const basis = `Relative gear score ${pct}% versus class export max.`
  const summary = gearBandRoast(band, { name: character.name, pct })

  /** @type {object[]} */
  let upgradeSuggestions = []
  /** @type {object[]} */
  let upgradeSlots = []
  let upgradeReason = null
  if (itemStats && rankings) {
    const up = computeCharacterUpgrades({
      character,
      rankings,
      itemStats,
      raidItemIds: raidItemIds || new Set(),
      limit: 3,
    })
    if (up.ok) {
      upgradeSuggestions = up.suggestions
      upgradeSlots = up.upgradeSlots || []
    } else {
      upgradeReason = up.reason
      upgradeSlots = up.upgradeSlots || []
    }
  } else {
    upgradeReason = 'upgrade_data_not_loaded'
  }

  const claims = ['gear_pct', 'comparison_basis', 'viability_interpretation']
  if (upgradeSuggestions.length) claims.push('upgrade_candidates')
  else if (upgradeReason) claims.push('upgrades_unavailable')

  return {
    ok: true,
    reason: null,
    character,
    magelo,
    gearPct: pct,
    viabilityThreshold: threshold,
    viable,
    band,
    interpretation,
    basis,
    rawScore: raw,
    classMax,
    classAbbrev: abbrev,
    upgradeSuggestions,
    upgradeSlots,
    upgradeReason,
    claims,
    referenced: {
      characters: [character.name],
      items: upgradeSuggestions.map((u) => u.itemName).filter(Boolean),
    },
    summary,
  }
}
