/**
 * Raid class coverage from Magelo class_rankings.json.
 * Viability: >75% normalized gear (general), >85% for PAL/WAR/SHD tanks.
 * gear_pct = 100 * (raw overall_score / best raw in class in the export), same as Magelo rankings UI.
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

/** UI green-pill threshold for non-tanks (strictly above). */
export const HIGHLIGHT_GEAR_PCT = 85

/** UI green-pill threshold for PAL/WAR/SHD (strictly above viability minimum). */
export const TANK_HIGHLIGHT_GEAR_PCT = 92

export function highlightThresholdForClass(abbrev) {
  const a = (abbrev || '').trim().toUpperCase()
  return TANK_CLASS_ABBREVS.has(a) ? TANK_HIGHLIGHT_GEAR_PCT : HIGHLIGHT_GEAR_PCT
}

export function isHighlightedGearPct(pct, classAbbrev) {
  if (pct == null || !Number.isFinite(Number(pct))) return false
  return Number(pct) > highlightThresholdForClass(classAbbrev)
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
 * Raw Magelo gear power (not class-normalized). Do not use overall_pct here.
 * @param {object} mageloChar - row from class_rankings.characters[]
 * @returns {number | null}
 */
export function extractRawGearScore(mageloChar) {
  if (!mageloChar || typeof mageloChar !== 'object') return null
  const candidates = [
    mageloChar.overall_score,
    mageloChar.overall,
    mageloChar.gear_score_pct,
    mageloChar.scores?.overall_score,
    mageloChar.scores?.overall,
  ]
  for (const raw of candidates) {
    const n = Number(raw)
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * Max raw overall_score per class abbrev across the full rankings export.
 * @param {object[]} rankingsChars
 * @returns {Map<string, number>}
 */
export function buildMaxRawScoreByClass(rankingsChars) {
  /** @type {Map<string, number>} */
  const maxByClass = new Map()
  for (const c of rankingsChars || []) {
    const abbrev = classNameToAbbrev(c.class)
    const raw = extractRawGearScore(c)
    if (!abbrev || raw == null) continue
    const prev = maxByClass.get(abbrev)
    if (prev == null || raw > prev) maxByClass.set(abbrev, raw)
  }
  return maxByClass
}

/**
 * Class-normalized gear % (Magelo rankings table parity): 100 * raw / best-in-class raw.
 * @param {object} mageloChar
 * @param {Map<string, number>} maxByClass
 * @returns {number | null}
 */
export function normalizedGearPct(mageloChar, maxByClass) {
  if (!mageloChar || typeof mageloChar !== 'object') return null

  if (!maxByClass || maxByClass.size === 0) {
    const exported = mageloChar.overall_pct ?? mageloChar.scores?.overall_pct
    const n = Number(exported)
    if (Number.isFinite(n)) return Math.round(n * 10) / 10
    const abbrev = classNameToAbbrev(mageloChar.class)
    const raw = extractRawGearScore(mageloChar)
    if (!abbrev || raw == null) return null
    return 100
  }

  const abbrev = classNameToAbbrev(mageloChar.class)
  const raw = extractRawGearScore(mageloChar)
  if (!abbrev || raw == null) return null

  const max = maxByClass.get(abbrev)
  if (max == null || max <= 0) return null
  return Math.round((raw / max) * 1000) / 10
}

/**
 * @param {object} mageloChar
 * @param {Map<string, number>} [maxByClass]
 * @returns {number | null}
 */
export function extractGearPct(mageloChar, maxByClass) {
  return normalizedGearPct(mageloChar, maxByClass)
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
    const raw = extractRawGearScore(c)
    const bestRaw = extractRawGearScore(best)
    if (raw == null) return best
    if (bestRaw == null) return c
    return raw > bestRaw ? c : best
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
  const maxByClass = buildMaxRawScoreByClass(rankingsChars)

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

    const mageloClass = (mageloChar.class || '').trim()
    const abbrev = classNameToAbbrev(mageloClass || className)
    const gearPct = normalizedGearPct(mageloChar, maxByClass)
    if (!abbrev || !isViableGearPct(gearPct, abbrev)) continue

    viableToons += 1
    const entry = {
      char_id: charId,
      char_name: name,
      abbrev,
      class_name: mageloClass || className || abbrev,
      gear_pct: gearPct,
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
