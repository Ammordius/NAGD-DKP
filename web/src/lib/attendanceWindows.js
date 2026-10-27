/**
 * Last-30 and last-60 raid-tic attendance for the DKP leaderboard.
 *
 * The cached earned_30d / earned_60d columns and dkp_period_totals sum DKP.
 * A tic worth 2 counts as 2 there, and the pool is rebuilt on raid-event edits
 * while account windows only move when that account's attendance changes.
 * Those two clocks produced 40 and 76, and let an account show 76/76 after
 * missing a raid that is still inside the 60-day window.
 *
 * This count uses one UTC day for both sides. Each distinct positive tic
 * counts once, including On-time and a tic worth more than 1 DKP. The day
 * `current_date - N` is included, matching raid_date_parsed(date_iso) >= current_date - N.
 */
import { distinctTicsByRaid, raidTicAttendance } from './raidTicIdentity.js'

export function utcIsoDate(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

/** First 10 characters when they are YYYY-MM-DD, otherwise null. */
export function parseRaidDate(iso) {
  if (iso == null) return null
  const text = String(iso).trim()
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null
  return text.slice(0, 10)
}

/** Calendar day `days` before a YYYY-MM-DD, in UTC. */
export function windowCutoff(todayIso, days) {
  const [year, month, day] = todayIso.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

function singleAccount(accounts) {
  if (!accounts || accounts.size !== 1) return null
  return [...accounts][0]
}

/**
 * Same account resolution as resolve_dkp_account_id:
 * stored account, else the character's only account, else the name's only
 * account when that character id is not linked.
 */
export function buildAccountResolver(characterAccounts, characters) {
  const accountsByChar = new Map()
  for (const row of characterAccounts || []) {
    const charId = String(row?.char_id ?? '').trim()
    const accountId = String(row?.account_id ?? '').trim()
    if (!charId || !accountId) continue
    let accounts = accountsByChar.get(charId)
    if (!accounts) {
      accounts = new Set()
      accountsByChar.set(charId, accounts)
    }
    accounts.add(accountId)
  }

  const nameByChar = new Map()
  for (const character of characters || []) {
    const name = String(character?.name ?? '').trim()
    if (character?.char_id != null && name) nameByChar.set(String(character.char_id), name)
  }
  const accountsByName = new Map()
  for (const [charId, accounts] of accountsByChar) {
    const name = nameByChar.get(charId)
    if (!name) continue
    let named = accountsByName.get(name)
    if (!named) {
      named = new Set()
      accountsByName.set(name, named)
    }
    for (const accountId of accounts) named.add(accountId)
  }

  return function resolveAccount(row) {
    const direct = String(row?.account_id ?? '').trim()
    if (direct) return direct
    const charId = String(row?.char_id ?? '').trim()
    if (charId && accountsByChar.has(charId)) return singleAccount(accountsByChar.get(charId))
    const name = String(row?.character_name ?? '').trim()
    if (!name) return null
    return singleAccount(accountsByName.get(name))
  }
}

function addTics(byAccount, accountId, in30, in60, ticEarned) {
  if (!ticEarned) return
  let row = byAccount[accountId]
  if (!row) {
    row = { earned_30d: 0, earned_60d: 0 }
    byAccount[accountId] = row
  }
  if (in30) row.earned_30d += ticEarned
  if (in60) row.earned_60d += ticEarned
}

/**
 * @param {{ raids: object[], events: object[], attendance: object[], characterAccounts?: object[], characters?: object[], now?: Date }} input
 * @returns {{ periodTotals: { '30d': number, '60d': number }, byAccount: Record<string, { earned_30d: number, earned_60d: number }> }}
 */
export function computeAttendanceWindows({
  raids,
  events,
  attendance,
  characterAccounts,
  characters,
  now = new Date(),
}) {
  const today = utcIsoDate(now)
  const cut30 = windowCutoff(today, 30)
  const cut60 = windowCutoff(today, 60)
  const raidDate = new Map()
  for (const raid of raids || []) {
    const id = String(raid?.raid_id ?? '').trim()
    if (!id) continue
    raidDate.set(id, parseRaidDate(raid.date_iso))
  }

  const ticsByRaid = distinctTicsByRaid(events)
  const resolveAccount = buildAccountResolver(characterAccounts, characters)
  const attendedByAccount = new Map()
  for (const row of attendance || []) {
    const accountId = resolveAccount(row)
    const raidId = String(row?.raid_id ?? '').trim()
    if (!accountId || !raidId) continue
    let raidsForAccount = attendedByAccount.get(accountId)
    if (!raidsForAccount) {
      raidsForAccount = new Map()
      attendedByAccount.set(accountId, raidsForAccount)
    }
    let eventIds = raidsForAccount.get(raidId)
    if (!eventIds) {
      eventIds = new Set()
      raidsForAccount.set(raidId, eventIds)
    }
    eventIds.add(String(row?.event_id ?? ''))
  }

  const periodTotals = { '30d': 0, '60d': 0 }
  const byAccount = {}
  for (const [raidId, tics] of ticsByRaid) {
    const date = raidDate.get(raidId)
    if (!date) continue
    const in30 = date >= cut30
    const in60 = date >= cut60
    if (!in30 && !in60) continue
    const total = raidTicAttendance(tics, new Set())
    if (in30) periodTotals['30d'] += total.ticTotal
    if (in60) periodTotals['60d'] += total.ticTotal
    for (const [accountId, raidsForAccount] of attendedByAccount) {
      const eventIds = raidsForAccount.get(raidId)
      if (!eventIds) continue
      const attended = raidTicAttendance(tics, eventIds)
      addTics(byAccount, accountId, in30, in60, attended.ticEarned)
    }
  }

  return { periodTotals, byAccount }
}

/** Overwrite cached DKP window sums on a leaderboard result. Balance, earned, and spent stay as they are. */
export function applyLeaderboardAttendanceWindows(result, payload) {
  const rows = payload?.attendance_window_rows
  if (!result || !rows) return result
  const windows = computeAttendanceWindows({
    raids: rows.raids,
    events: rows.events,
    attendance: rows.attendance,
    characterAccounts: payload.character_account,
    characters: payload.characters,
    now: payload.attendance_as_of ? new Date(payload.attendance_as_of) : new Date(),
  })
  result.periodTotals = windows.periodTotals
  const applyRow = (row) => {
    if (row?.account_id == null || row.account_id === '') return
    const counts = windows.byAccount[String(row.account_id)] || { earned_30d: 0, earned_60d: 0 }
    row.earned_30d = counts.earned_30d
    row.earned_60d = counts.earned_60d
  }
  ;(result.accountList || []).forEach(applyRow)
  if (result.fullAccountTotals) {
    for (const id of Object.keys(result.fullAccountTotals)) {
      const counts = windows.byAccount[id] || { earned_30d: 0, earned_60d: 0 }
      result.fullAccountTotals[id].earned_30d = counts.earned_30d
      result.fullAccountTotals[id].earned_60d = counts.earned_60d
    }
  }
  return result
}
