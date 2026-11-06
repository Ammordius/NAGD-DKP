/**
 * Guild-wide character identity lookup: character name → account + last raid date.
 * Facts only — no invented accounts or dates.
 */

import { accountRaidDates } from '../siteAdminCharacters.js'
import { extractWhoIsCharacterName } from './intents.js'

/**
 * True when the message is a who-is identity question (not "who got").
 * @param {string} raw
 */
export function looksLikeWhoIs(raw) {
  return Boolean(extractWhoIsCharacterName(raw))
}

/** @param {string} raw */
export function extractWhoIsName(raw) {
  return extractWhoIsCharacterName(raw)
}

/**
 * Resolve character name → account display name + last raid date (Accounts-page parity).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} characterName
 * @returns {Promise<{
 *   status: 'ok'|'not_found'|'unlinked'|'no_name',
 *   characterName: string|null,
 *   accountId: string|null,
 *   accountName: string|null,
 *   lastRaidDate: string|null,
 *   charId: string|null,
 * }>}
 */
export async function lookupWhoIs(supabase, characterName) {
  const wanted = String(characterName || '').trim()
  if (!wanted) {
    return {
      status: 'no_name',
      characterName: null,
      accountId: null,
      accountName: null,
      lastRaidDate: null,
      charId: null,
    }
  }

  // Dynamic import keeps unit tests free of the supabase client module graph.
  const { fetchCharToAccountMap } = await import('../useCharToAccountMap.js')
  const mapData = await fetchCharToAccountMap()
  const lower = wanted.toLowerCase()
  const charToAccount = mapData.charToAccount || {}
  const accountIdToDisplayName = mapData.accountIdToDisplayName || {}
  const charIdToName = mapData.charIdToName || {}

  // Prefer exact / case-insensitive name → account_id from the map
  let accountId = charToAccount[wanted] ?? charToAccount[lower] ?? null
  let charId = null
  let resolvedName = wanted

  // Find canonical char_id + spelling from characters table
  for (const [id, name] of Object.entries(charIdToName)) {
    if (name && name.toLowerCase() === lower) {
      charId = id
      resolvedName = name
      if (!accountId) accountId = charToAccount[id] ?? null
      break
    }
  }

  // Character exists in guild roster but no character_account link
  if (!accountId) {
    const knownChar = Object.values(charIdToName).some((n) => n && n.toLowerCase() === lower)
    if (knownChar || charId) {
      return {
        status: 'unlinked',
        characterName: resolvedName,
        accountId: null,
        accountName: null,
        lastRaidDate: null,
        charId,
      }
    }
    return {
      status: 'not_found',
      characterName: wanted,
      accountId: null,
      accountName: null,
      lastRaidDate: null,
      charId: null,
    }
  }

  const accountName =
    accountIdToDisplayName[accountId] ??
    accountIdToDisplayName[String(accountId)] ??
    String(accountId)

  const lastRaidDate = await fetchLastRaidDateForAccount(supabase, {
    accountId,
    characters: mapData.characters,
    characterAccount: mapData.characterAccount,
  })

  return {
    status: 'ok',
    characterName: resolvedName,
    accountId: String(accountId),
    accountName,
    lastRaidDate,
    charId,
  }
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ accountId: string, characters: object[], characterAccount: object[] }} args
 */
async function fetchLastRaidDateForAccount(supabase, { accountId, characters, characterAccount }) {
  const aid = String(accountId).trim()
  const linkedCharIds = (characterAccount || [])
    .filter((r) => r?.account_id != null && String(r.account_id).trim() === aid)
    .map((r) => String(r.char_id).trim())
    .filter(Boolean)

  const [{ data: accountSummary, error: accErr }, { data: dkpSummary, error: dkpErr }] =
    await Promise.all([
      supabase
        .from('account_dkp_summary')
        .select('account_id, last_activity_date')
        .eq('account_id', aid),
      linkedCharIds.length
        ? supabase
            .from('dkp_summary')
            .select('character_key, character_name, last_activity_date')
            .in('character_key', linkedCharIds)
        : Promise.resolve({ data: [], error: null }),
    ])

  if (accErr) throw accErr
  if (dkpErr) throw dkpErr

  // Also pull name-keyed summary rows for linked chars (legacy keys)
  const linkedNames = (characters || [])
    .filter((c) => linkedCharIds.includes(String(c.char_id).trim()))
    .map((c) => (c.name || '').trim())
    .filter(Boolean)

  let extraByName = []
  if (linkedNames.length) {
    const { data, error } = await supabase
      .from('dkp_summary')
      .select('character_key, character_name, last_activity_date')
      .in('character_name', linkedNames)
    if (error) throw error
    extraByName = data || []
  }

  const dates = accountRaidDates({
    accountSummary: accountSummary || [],
    dkpSummary: [...(dkpSummary || []), ...extraByName],
    characters,
    characterAccount,
  })
  return dates.get(aid) || dates.get(String(Number(aid))) || null
}

/**
 * Pure resolver for tests — no network.
 * @param {{
 *   characterName: string,
 *   charToAccount: Record<string, string|number>,
 *   accountIdToDisplayName: Record<string, string>,
 *   charIdToName?: Record<string, string>,
 *   lastRaidByAccount?: Map<string, string>|Record<string, string>,
 * }} args
 */
export function resolveWhoIsFromMaps({
  characterName,
  charToAccount,
  accountIdToDisplayName,
  charIdToName = {},
  lastRaidByAccount = {},
}) {
  const wanted = String(characterName || '').trim()
  if (!wanted) {
    return {
      status: 'no_name',
      characterName: null,
      accountId: null,
      accountName: null,
      lastRaidDate: null,
      charId: null,
    }
  }
  const lower = wanted.toLowerCase()
  let accountId = charToAccount[wanted] ?? charToAccount[lower] ?? null
  let charId = null
  let resolvedName = wanted
  for (const [id, name] of Object.entries(charIdToName)) {
    if (name && name.toLowerCase() === lower) {
      charId = id
      resolvedName = name
      if (!accountId) accountId = charToAccount[id] ?? null
      break
    }
  }
  if (!accountId) {
    const knownChar = Object.values(charIdToName).some((n) => n && n.toLowerCase() === lower)
    if (knownChar || charId) {
      return {
        status: 'unlinked',
        characterName: resolvedName,
        accountId: null,
        accountName: null,
        lastRaidDate: null,
        charId,
      }
    }
    return {
      status: 'not_found',
      characterName: wanted,
      accountId: null,
      accountName: null,
      lastRaidDate: null,
      charId: null,
    }
  }
  const accountName =
    accountIdToDisplayName[accountId] ??
    accountIdToDisplayName[String(accountId)] ??
    String(accountId)
  const raidMap =
    lastRaidByAccount instanceof Map
      ? lastRaidByAccount
      : new Map(Object.entries(lastRaidByAccount || {}))
  const lastRaidDate =
    raidMap.get(String(accountId)) || raidMap.get(accountId) || null
  return {
    status: 'ok',
    characterName: resolvedName,
    accountId: String(accountId),
    accountName,
    lastRaidDate,
    charId,
  }
}
