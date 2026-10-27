/**
 * JS mirror of public.resolve_dkp_account_id():
 * explicit account_id, then unique char_id link, then unique name
 * only when that char_id has no character_account row.
 */

function trimId(value) {
  if (value == null) return ''
  return String(value).trim()
}

function uniqueAccount(set) {
  if (!set || set.size !== 1) return null
  return [...set][0]
}

/**
 * @param {string|null|undefined} pAccountId
 * @param {string|null|undefined} pCharId
 * @param {string|null|undefined} pCharacterName
 * @param {{
 *   accountsByCharId?: Map<string, Set<string>>|Record<string, Iterable<string>>,
 *   accountsByName?: Map<string, Set<string>>|Record<string, Iterable<string>>,
 * }} [maps]
 * @returns {string|null}
 */
export function resolveDkpAccountId(pAccountId, pCharId, pCharacterName, maps = {}) {
  const explicit = trimId(pAccountId)
  if (explicit) return explicit

  const accountsByCharId = asSetMap(maps.accountsByCharId)
  const accountsByName = asSetMap(maps.accountsByName)
  const charId = trimId(pCharId)
  if (charId) {
    const fromChar = uniqueAccount(accountsByCharId.get(charId))
    if (fromChar) return fromChar
  }

  const name = trimId(pCharacterName)
  if (!name) return null
  if (charId && accountsByCharId.has(charId) && accountsByCharId.get(charId).size > 0) {
    return null
  }
  return uniqueAccount(accountsByName.get(name))
}

function asSetMap(raw) {
  const out = new Map()
  if (!raw) return out
  const entries = raw instanceof Map ? raw.entries() : Object.entries(raw)
  for (const [key, value] of entries) {
    const k = trimId(key)
    if (!k) continue
    const set = value instanceof Set ? value : new Set([...(value || [])].map(trimId).filter(Boolean))
    if (set.size > 0) out.set(k, set)
  }
  return out
}

/**
 * Build lookup maps from character_account + characters rows.
 * @param {Array<{ char_id?: string, account_id?: string }>} characterAccount
 * @param {Array<{ char_id?: string, name?: string }>} characters
 */
export function buildResolveAccountMaps(characterAccount, characters) {
  const accountsByCharId = new Map()
  for (const row of characterAccount || []) {
    const charId = trimId(row?.char_id)
    const accountId = trimId(row?.account_id)
    if (!charId || !accountId) continue
    let set = accountsByCharId.get(charId)
    if (!set) {
      set = new Set()
      accountsByCharId.set(charId, set)
    }
    set.add(accountId)
  }
  const nameByCharId = new Map()
  for (const row of characters || []) {
    const charId = trimId(row?.char_id)
    const name = trimId(row?.name)
    if (charId && name) nameByCharId.set(charId, name)
  }
  const accountsByName = new Map()
  for (const [charId, accountSet] of accountsByCharId) {
    const name = nameByCharId.get(charId)
    if (!name) continue
    let set = accountsByName.get(name)
    if (!set) {
      set = new Set()
      accountsByName.set(name, set)
    }
    for (const accountId of accountSet) set.add(accountId)
  }
  return { accountsByCharId, accountsByName }
}

/** Keep attendance rows whose resolved account matches accountId. */
export function filterAttendanceForAccount(rows, accountId, maps) {
  const target = trimId(accountId)
  if (!target) return []
  return (rows || []).filter((row) => (
    resolveDkpAccountId(row?.account_id, row?.char_id, row?.character_name, maps) === target
  ))
}
