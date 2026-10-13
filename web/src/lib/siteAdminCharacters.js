/**
 * Character picker rows for Site Admin. Labels match Raid Admin Available Members:
 * "CharacterName (accounts.display_name)". Unlinked characters show the name only.
 * Duplicate labels append char_id.
 */

export function accountColumnLabel(account) {
  if (!account) return ''
  const display = (account.display_name || '').trim()
  const firstToon = (account.toon_names || '').split(',')[0]?.trim()
  return display || firstToon || account.account_id || ''
}

export function buildCharacterRows(characters, characterAccount, accounts) {
  const accountById = new Map()
  for (const account of accounts || []) {
    if (account?.account_id != null) accountById.set(String(account.account_id), account)
  }
  const charIdToAccountId = new Map()
  for (const row of characterAccount || []) {
    const charId = row?.char_id != null ? String(row.char_id).trim() : ''
    const accountId = row?.account_id != null ? String(row.account_id).trim() : ''
    if (charId && accountId) charIdToAccountId.set(charId, accountId)
  }
  const rows = []
  const seenCharId = new Set()
  for (const character of characters || []) {
    const charId = character?.char_id != null ? String(character.char_id).trim() : ''
    const name = (character?.name || '').trim()
    if (!charId || !name || seenCharId.has(charId)) continue
    seenCharId.add(charId)
    const accountId = charIdToAccountId.get(charId) || ''
    const account = accountId ? accountById.get(accountId) : null
    const displayName = (account?.display_name || '').trim()
    const mainName = displayName || (accountId ? accountId : '')
    rows.push({
      char_id: charId,
      name,
      account_id: accountId || null,
      label: mainName ? `${name} (${mainName})` : name,
    })
  }
  const counts = new Map()
  for (const row of rows) counts.set(row.label, (counts.get(row.label) || 0) + 1)
  return rows
    .map((row) => (counts.get(row.label) > 1 ? { ...row, label: `${row.label} (${row.char_id})` } : row))
    .sort((a, b) => a.label.localeCompare(b.label))
}

export function characterMatchesQuery(row, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return true
  if (row.name.toLowerCase().includes(q)) return true
  if ((row.label || '').toLowerCase().includes(q)) return true
  if (row.char_id.toLowerCase().includes(q)) return true
  return false
}

export function buildAccountColumnRows(accountIds, accountsById) {
  const rows = []
  const seen = new Set()
  for (const id of accountIds) {
    const accountId = id != null ? String(id).trim() : ''
    if (!accountId || seen.has(accountId)) continue
    seen.add(accountId)
    const account = accountsById.get(accountId)
    rows.push({
      account_id: accountId,
      label: account ? accountColumnLabel(account) : accountId,
    })
  }
  rows.sort((a, b) => a.label.localeCompare(b.label))
  return rows
}
