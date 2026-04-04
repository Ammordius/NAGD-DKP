/**
 * Format "Account (Character)" for display. When account and character names match,
 * returns only the account name (e.g. "Adilene" not "Adilene (Adilene)").
 * Use for raid attendees, account lists, loot-recipients, and buyer columns.
 * Do NOT use on /loot (LootSearch) where we intentionally show both for character context.
 *
 * @param {string | null | undefined} accountName - Display name of the account
 * @param {string | null | undefined} characterName - Character name
 * @returns {string} Display label
 */
export function formatAccountCharacter(accountName, characterName) {
  const acc = (accountName ?? '').trim()
  const char = (characterName ?? '').trim()
  if (!acc) return char || '—'
  if (char === acc) return acc
  if (!char) return acc
  return `${acc} (${char})`
}

/**
 * Format "Account (Char1, Char2, ...)" for grouped attendees. Omits the account name
 * from the list when it appears so we don't show "Adilene (Adilene)" or "Barndog (Barndog, Othertoon)".
 *
 * @param {string | null | undefined} accountDisplayName - Display name of the account
 * @param {string[]} names - Character names in the group
 * @returns {string} Display label
 */
export function formatAccountCharacters(accountDisplayName, names) {
  const acc = (accountDisplayName ?? '').trim()
  const list = (names || []).map((n) => (n ?? '').trim()).filter(Boolean)
  if (!acc) return list[0] || '—'
  const other = list.filter((n) => n !== acc)
  if (other.length === 0) return acc
  return `${acc} (${other.join(', ')})`
}

const MAX_LEVEL_HIDE_IN_LABEL = 65

/**
 * Class / level + spent for account character rows (e.g. "Monk 265 spent", "54 monk 120 spent").
 * Omits level when it is 65; non-maxed levels use lowercase class to match roster style.
 *
 * @param {{ class_name?: string, level?: string | number }} c
 * @param {number} spent
 * @returns {string}
 */
export function formatCharacterClassSpentLine(c, spent) {
  const spentN = Math.round(Number(spent) || 0)
  const spentPart = `${spentN} spent`
  const rawLevel = c?.level
  const level = rawLevel != null && rawLevel !== '' ? Number(rawLevel) : null
  const cls = (c?.class_name || '').trim()
  const hasNumericLevel = level != null && !Number.isNaN(level)

  if (hasNumericLevel && level !== MAX_LEVEL_HIDE_IN_LABEL) {
    if (cls) return `${level} ${cls.toLowerCase()} ${spentPart}`
    return `${level} ${spentPart}`
  }
  if (cls) return `${cls} ${spentPart}`
  return spentPart
}

/**
 * Spent per assignee, scoped to loot rows whose buyer (raid_loot.char_id) belongs to that account.
 * Matches AccountDetail Characters tab: fetch uses .in('char_id', accountCharIds), then sum by assigned_*.
 *
 * @param {Array<{ char_id?: string, cost?: string | number, assigned_char_id?: string, assigned_character_name?: string }>} lootRows
 * @param {Record<string, string>} buyerCharIdToAccountId - char_id -> account_id from character_account
 * @returns {Record<string, Record<string, number>>} account_id -> (assignee key -> spent)
 */
export function buildSpentByAccountFromLoot(lootRows, buyerCharIdToAccountId) {
  /** @type {Record<string, Record<string, number>>} */
  const byAccount = {}
  for (const row of lootRows || []) {
    const buyer = String(row.char_id ?? '').trim()
    if (!buyer) continue
    const accountId = buyerCharIdToAccountId[buyer]
    if (!accountId) continue
    const k = (row.assigned_character_name || row.assigned_char_id || '').trim()
    if (!k) continue
    const cost = parseFloat(row.cost ?? 0)
    if (!Number.isFinite(cost)) continue
    if (!byAccount[accountId]) byAccount[accountId] = {}
    const m = byAccount[accountId]
    m[k] = (m[k] || 0) + cost
  }
  return byAccount
}

/**
 * Lookup spent for a characters row using name then char_id (matches AccountDetail list).
 *
 * @param {Record<string, number>} spentMap
 * @param {{ name?: string, char_id?: string }} c
 */
export function spentForCharacterFromLootMap(spentMap, c) {
  const name = (c.name || '').trim()
  const id = String(c.char_id ?? '').trim()
  return (name ? spentMap[name] : undefined) ?? spentMap[id] ?? 0
}
