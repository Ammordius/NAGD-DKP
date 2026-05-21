/**
 * Raid class coverage from Magelo class_rankings.json.
 * Viability: >75% overall gear (general), >85% for PAL/WAR/SHD tanks.
 * Canonical gear field: overall_score (NAGD class_rankings.json); falls back to overall_pct, overall, etc.
 */

import { CLASS_TO_ABBREV } from './mageloUpgradeEngine.js'

export const TANK_CLASS_ABBREVS = new Set(['PAL', 'WAR', 'SHD'])

export const CLASS_ORDER = [
  'WAR',
  'CLR',
  'PAL',
  'RNG',
  'SHD',
  'BRD',
  'ROG',
  'SHM',
  'MNK',
  'NEC',
  'WIZ',
  'MAG',
  'ENC',
  'BST',
]

const GENERAL_VIABILITY_PCT = 75
const TANK_VIABILITY_PCT = 85

/** UI highlight threshold for class pills (strictly above). */
export const HIGHLIGHT_GEAR_PCT = 85

export function isHighlightedGearPct(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) return false
  return Number(pct) > HIGHLIGHT_GEAR_PCT
}

export function normName(s) {
  return (s || '').trim().toLowerCase()
}

export function classNameToAbbrev(className) {
  const trimmed = (className || '').trim()
  if (!trimmed) return ''
  const direct = CLASS_TO_ABBREV[trimmed]
  if (direct) return direct
  const upper = trimmed.toUpperCase()
  if (CLASS_ORDER.includes(upper)) return upper
  return ''
}

export function viabilityThresholdForClass(abbrev) {
  const a = (abbrev || '').trim().toUpperCase()
  return TANK_CLASS_ABBREVS.has(a) ? TANK_VIABILITY_PCT : GENERAL_VIABILITY_PCT
}

/**
 * @param {object} mageloChar - row from class_rankings.characters[]
 * @returns {number | null}
 */
export function extractGearPct(mageloChar) {
  if (!mageloChar || typeof mageloChar !== 'object') return null
  const candidates = [
    mageloChar.overall_score,
    mageloChar.overall_pct,
    mageloChar.overall,
    mageloChar.gear_score_pct,
    mageloChar.scores?.overall_score,
    mageloChar.scores?.overall,
    mageloChar.scores?.overall_pct,
  ]
  for (const raw of candidates) {
    const n = Number(raw)
    if (Number.isFinite(n)) return n
  }
  return null
}

export function isViableGearPct(pct, classAbbrev) {
  if (pct == null || !Number.isFinite(Number(pct))) return false
  return Number(pct) > viabilityThresholdForClass(classAbbrev)
}

/**
 * @param {string} dbClass
 * @param {string} mageloClass
 */
export function classesMatchForRanking(dbClass, mageloClass) {
  if (!normName(dbClass)) return true
  const aAbbrev = classNameToAbbrev(dbClass)
  const mAbbrev = classNameToAbbrev(mageloClass)
  if (aAbbrev && mAbbrev) return aAbbrev === mAbbrev
  return normName(dbClass) === normName(mageloClass)
}

/**
 * @param {object[]} rankingsChars
 * @param {string} attendeeName
 */
export function findRankingCharsByName(rankingsChars, attendeeName) {
  if (!rankingsChars || !attendeeName) return []
  const n = normName(attendeeName)
  return rankingsChars.filter((c) => normName(c.name) === n)
}

/**
 * @param {object[]} rankingsChars
 * @param {string} attendeeName
 * @param {string} attendeeClass
 */
export function findRankingChar(rankingsChars, attendeeName, attendeeClass) {
  if (!rankingsChars || !attendeeName) return null
  const n = normName(attendeeName)
  const cLower = normName(attendeeClass)

  if (cLower) {
    const strict = rankingsChars.find(
      (c) => normName(c.name) === n && classesMatchForRanking(attendeeClass, c.class),
    )
    if (strict) return strict
  }

  const byName = findRankingCharsByName(rankingsChars, attendeeName)
  if (byName.length === 0) return null
  if (byName.length === 1) return byName[0]
  return byName.reduce((best, c) => {
    const pct = extractGearPct(c)
    const bestPct = extractGearPct(best)
    if (pct == null) return best
    if (bestPct == null) return c
    return pct > bestPct ? c : best
  })
}

/**
 * @param {object} opts
 * @param {{ char_id: string, account_id: string }[]} opts.links - character_account rows
 * @param {{ char_id: string, name?: string, class_name?: string }[]} opts.characters
 * @param {object[]} opts.rankingsChars
 * @param {Record<string, number>} [opts.spendByCharId] - lifetime spend per char_id
 * @returns {Map<string, { main_char_id: string | null, classes: object[], meta: object }>}
 */
export function buildAccountCoverage({
  links = [],
  characters = [],
  rankingsChars = [],
  spendByCharId = {},
}) {
  const charById = new Map()
  for (const c of characters) {
    const id = (c.char_id || '').trim()
    if (id) charById.set(id, c)
  }

  /** @type {Map<string, { char_id: string, char_name: string, abbrev: string, class_name: string, gear_pct: number }[]>} */
  const candidatesByAccount = new Map()

  let matchedToons = 0
  let viableToons = 0
  let skippedUnmatched = 0

  for (const link of links) {
    const charId = (link.char_id || '').trim()
    const accountId = (link.account_id || '').trim()
    if (!charId || !accountId) continue

    const row = charById.get(charId)
    const name = (row?.name || '').trim()
    const className = (row?.class_name || '').trim()
    if (!name) continue

    const mageloChar = findRankingChar(rankingsChars, name, className)
    if (!mageloChar) {
      skippedUnmatched += 1
      continue
    }
    matchedToons += 1

    const gearPct = extractGearPct(mageloChar)
    const mageloClass = (mageloChar.class || '').trim()
    const abbrev = classNameToAbbrev(mageloClass || className)
    if (!abbrev || !isViableGearPct(gearPct, abbrev)) continue

    viableToons += 1
    const entry = {
      char_id: charId,
      char_name: name,
      abbrev,
      class_name: mageloClass || className || abbrev,
      gear_pct: Math.round(Number(gearPct) * 10) / 10,
    }
    if (!candidatesByAccount.has(accountId)) {
      candidatesByAccount.set(accountId, [])
    }
    candidatesByAccount.get(accountId).push(entry)
  }

  /** @type {Map<string, { main_char_id: string | null, classes: object[], meta: object }>} */
  const result = new Map()

  for (const [accountId, candidates] of candidatesByAccount) {
    let mainCharId = null
    let bestSpend = -1
    for (const c of candidates) {
      const spend = Number(spendByCharId[c.char_id]) || 0
      if (spend > bestSpend) {
        bestSpend = spend
        mainCharId = c.char_id
      }
    }
    if (mainCharId == null && candidates.length > 0) {
      mainCharId = candidates[0].char_id
    }

    /** @type {Map<string, object>} */
    const bestByClass = new Map()
    for (const c of candidates) {
      const prev = bestByClass.get(c.abbrev)
      if (!prev || c.gear_pct > prev.gear_pct) {
        bestByClass.set(c.abbrev, c)
      }
    }

    const classes = [...bestByClass.values()]
      .map((c) => ({
        abbrev: c.abbrev,
        class_name: c.class_name,
        gear_pct: c.gear_pct,
        is_main: mainCharId != null && c.char_id === mainCharId,
        char_id: c.char_id,
        char_name: c.char_name,
      }))
      .sort(
        (a, b) =>
          CLASS_ORDER.indexOf(a.abbrev) - CLASS_ORDER.indexOf(b.abbrev) ||
          a.abbrev.localeCompare(b.abbrev),
      )

    result.set(accountId, {
      main_char_id: mainCharId,
      classes,
      meta: {
        matched_toons: candidates.length,
        viable_classes: classes.length,
      },
    })
  }

  return {
    byAccount: result,
    stats: { matchedToons, viableToons, skippedUnmatched },
  }
}

/**
 * Build payload rows for Supabase upsert from buildAccountCoverage result.
 * @param {ReturnType<typeof buildAccountCoverage>} built
 */
export function coverageToUpsertRows(built) {
  const rows = []
  for (const [accountId, cov] of built.byAccount) {
    if (!cov.classes?.length) continue
    rows.push({
      account_id: accountId,
      main_char_id: cov.main_char_id,
      classes: cov.classes,
      meta: cov.meta,
    })
  }
  return rows
}

/**
 * @param {object[]} coverageRows - from account_class_coverage select
 * @returns {Map<string, { main_char_id: string | null, classes: object[], refreshed_at?: string }>}
 */
export function coverageRowsToMap(coverageRows) {
  const map = new Map()
  for (const row of coverageRows || []) {
    const id = (row.account_id || '').trim()
    if (!id) continue
    map.set(id, {
      main_char_id: row.main_char_id || null,
      classes: Array.isArray(row.classes) ? row.classes : [],
      refreshed_at: row.refreshed_at,
    })
  }
  return map
}
