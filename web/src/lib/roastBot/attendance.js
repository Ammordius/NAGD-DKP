/**
 * Account-level raid attendance facts for the DKP Inquisitor.
 *
 * CRITICAL: Attendance is account-scoped. Never treat a missing character-specific
 * attendance row as evidence that another linked character was neglected or not boxed.
 */

import { buildResolveAccountMaps, resolveDkpAccountId } from '../resolveDkpAccountId.js'
import { parseRaidDate, utcIsoDate, windowCutoff } from '../attendanceWindows.js'

/** Minimum distinct guild raids in the window before "sparse" claims are allowed. */
export const ATTENDANCE_COVERAGE_MIN_GUILD_RAIDS = 5

/** Days without a recorded account raid before "quiet" templates are eligible. */
export const SPARSE_DAYS_THRESHOLD = 21

/** Gap between consecutive account raids that counts as a return-after-absence. */
export const RETURN_GAP_DAYS = 30

/** Frequent participation threshold inside the observation window. */
export const FREQUENT_RAID_COUNT = 8

/** Default observation window in days. */
export const ATTENDANCE_WINDOW_DAYS = 60

/**
 * Build account-level attendance facts from raid presence rows.
 *
 * @param {{
 *   accountId: string,
 *   characters?: Array<{ char_id?: string, name?: string }>,
 *   characterAccount?: Array<{ char_id?: string, account_id?: string }>,
 *   attendanceRows?: Array<{ raid_id?: string|number, account_id?: string, char_id?: string, character_name?: string }>,
 *   raidsById?: Record<string, { raid_id?: string|number, raid_name?: string, date_iso?: string }>,
 *   guildRaidCountInWindow?: number|null,
 *   now?: Date,
 *   windowDays?: number,
 * }} input
 */
export function buildAccountAttendanceFacts(input) {
  const accountId = String(input.accountId || '').trim()
  const windowDays = input.windowDays ?? ATTENDANCE_WINDOW_DAYS
  const now = input.now || new Date()
  const today = utcIsoDate(now)
  const cutoff = windowCutoff(today, windowDays)

  const characters = input.characters || []
  const characterAccount =
    input.characterAccount ||
    characters.map((c) => ({ char_id: c.char_id, account_id: accountId }))
  const maps = buildResolveAccountMaps(characterAccount, characters)

  /** @type {Map<string, { raidId: string, raidName: string|null, date: string|null, recordedCharIds: Set<string> }>} */
  const byRaid = new Map()

  for (const row of input.attendanceRows || []) {
    const resolved = resolveDkpAccountId(row?.account_id, row?.char_id, row?.character_name, maps)
    if (!accountId || resolved !== accountId) continue
    const raidId = String(row?.raid_id ?? '').trim()
    if (!raidId) continue
    const raidMeta = input.raidsById?.[raidId] || {}
    const date = parseRaidDate(raidMeta.date_iso) || parseRaidDate(row?.date_iso) || null
    let entry = byRaid.get(raidId)
    if (!entry) {
      entry = {
        raidId,
        raidName: raidMeta.raid_name || row?.raid_name || null,
        date,
        recordedCharIds: new Set(),
      }
      byRaid.set(raidId, entry)
    }
    const charId = String(row?.char_id ?? '').trim()
    if (charId) entry.recordedCharIds.add(charId)
    if (!entry.date && date) entry.date = date
    if (!entry.raidName && (raidMeta.raid_name || row?.raid_name)) {
      entry.raidName = raidMeta.raid_name || row.raid_name
    }
  }

  const allRaids = [...byRaid.values()].sort((a, b) => {
    const da = a.date || '0000-00-00'
    const db = b.date || '0000-00-00'
    return da.localeCompare(db)
  })

  const windowRaids = allRaids.filter((r) => r.date && r.date >= cutoff && r.date <= today)
  const accountRaidHistory = windowRaids.map((r) => ({
    raidId: r.raidId,
    raidName: r.raidName,
    date: r.date,
    // Intentionally omit which characters attended — account presence only.
  }))

  const last = allRaids.length ? allRaids[allRaids.length - 1] : null
  const daysSince =
    last?.date != null ? daysBetween(last.date, today) : null

  let returnGapDays = null
  if (allRaids.length >= 2) {
    for (let i = allRaids.length - 1; i >= 1; i--) {
      const newer = allRaids[i]
      const older = allRaids[i - 1]
      if (!newer.date || !older.date) continue
      const gap = daysBetween(older.date, newer.date)
      if (gap >= RETURN_GAP_DAYS) {
        returnGapDays = gap
        break
      }
    }
  }

  const guildRaidCountInWindow =
    input.guildRaidCountInWindow == null ? null : Number(input.guildRaidCountInWindow)
  const coverage = classifyAttendanceCoverage({
    guildRaidCountInWindow,
    windowRaidCount: windowRaids.length,
    hasAnyDatedRaid: allRaids.some((r) => r.date),
  })

  return {
    accountRaidHistory,
    accountRaidCount: windowRaids.length,
    lastAccountRaid: last
      ? { raidId: last.raidId, raidName: last.raidName, date: last.date }
      : null,
    daysSince,
    returnGapDays,
    observationWindowDays: windowDays,
    observationCutoff: cutoff,
    dataCoverage: coverage,
    /** @deprecated never use for character-absence jokes — exposed only for tests */
    _debugRaidCharSets: Object.fromEntries(
      [...byRaid.entries()].map(([id, e]) => [id, [...e.recordedCharIds]]),
    ),
  }
}

/**
 * @param {{ guildRaidCountInWindow: number|null, windowRaidCount: number, hasAnyDatedRaid: boolean }} args
 * @returns {'sufficient'|'insufficient'|'unknown'}
 */
export function classifyAttendanceCoverage({ guildRaidCountInWindow, windowRaidCount, hasAnyDatedRaid }) {
  if (guildRaidCountInWindow == null || !Number.isFinite(guildRaidCountInWindow)) {
    // Without a guild-wide baseline we can still talk about positive participation,
    // but must not accuse absence.
    if (windowRaidCount > 0 || hasAnyDatedRaid) return 'insufficient'
    return 'unknown'
  }
  if (guildRaidCountInWindow < ATTENDANCE_COVERAGE_MIN_GUILD_RAIDS) return 'insufficient'
  return 'sufficient'
}

/**
 * Pure helpers used by response rules — never accuse a specific character of absence.
 * @param {ReturnType<typeof buildAccountAttendanceFacts>} facts
 */
export function attendanceRoastEligibility(facts) {
  const coverage = facts?.dataCoverage
  const count = facts?.accountRaidCount ?? 0
  const daysSince = facts?.daysSince
  const returnGap = facts?.returnGapDays

  return {
    canRoastFrequent: coverage === 'sufficient' && count >= FREQUENT_RAID_COUNT,
    canRoastSparse:
      coverage === 'sufficient' &&
      (count === 0 || (daysSince != null && daysSince >= SPARSE_DAYS_THRESHOLD)),
    canRoastReturn:
      coverage === 'sufficient' &&
      returnGap != null &&
      returnGap >= RETURN_GAP_DAYS &&
      count > 0,
    /** Always false — character absence from a raid row is not evidence. */
    canRoastCharacterAbsence: false,
  }
}

/**
 * Assert helpers for regression tests: responses must not claim linked toons were neglected.
 * @param {string} text
 * @param {string[]} characterNames
 */
export function responseImpliesCharacterAbsence(text, characterNames) {
  const t = String(text || '').toLowerCase()
  const patterns = [
    /never attend/,
    /aren'?t you bringing/,
    /why (don'?t|aren'?t) you (bring|raid|heal)/,
    /collecting dust/,
    /refuse to (heal|tank|dps)/,
    /abandoned your/,
    /while everyone dies/,
    /should have brought/,
    /never brings? (your|the)/,
  ]
  if (!patterns.some((p) => p.test(t))) return false
  for (const name of characterNames || []) {
    const n = String(name || '').toLowerCase()
    if (n && t.includes(n)) return true
  }
  if (/\b(cleric|warrior|wizard|shaman|your (alt|healer|tank))\b/.test(t) && patterns.some((p) => p.test(t))) {
    return true
  }
  return false
}

function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00Z`)
  const b = Date.parse(`${toIso}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / 86400000)
}
