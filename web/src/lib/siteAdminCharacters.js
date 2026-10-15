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

function compareCharId(a, b) {
  return String(a.char_id).localeCompare(String(b.char_id), undefined, { numeric: true })
}

/**
 * Character credited for an account selection.
 * A typed character or alt name wins. Otherwise the character whose name matches
 * the account display name. Otherwise the lowest char_id. Duplicate historical
 * rows stay in the list and the lowest id is the stable write target.
 */
export function resolveAdminCharacter(characters, account, query) {
  const list = []
  const seen = new Set()
  for (const character of characters || []) {
    const charId = character?.char_id != null ? String(character.char_id).trim() : ''
    const name = (character?.name || '').trim()
    if (!charId || !name || seen.has(charId)) continue
    seen.add(charId)
    list.push({ char_id: charId, name })
  }
  if (list.length === 0) return null
  const q = (query || '').trim().toLowerCase()
  if (q) {
    const exact = list.filter((row) => row.name.toLowerCase() === q)
    if (exact.length > 0) return [...exact].sort(compareCharId)[0]
    const partial = list.filter((row) => row.name.toLowerCase().includes(q))
    if (partial.length > 0) return [...partial].sort(compareCharId)[0]
  }
  const display = (account?.display_name || '').trim().toLowerCase()
  if (display) {
    const named = list.filter((row) => row.name.toLowerCase() === display)
    if (named.length > 0) return [...named].sort(compareCharId)[0]
  }
  return [...list].sort(compareCharId)[0]
}

export function accountAdminLabel(accountLabel, accountId, characterName) {
  const id = accountId != null ? String(accountId) : ''
  const base = accountLabel && accountLabel !== id ? `${accountLabel} (${id})` : id
  if (!characterName) return base
  return `${base} · ${characterName}`
}

export function buildAccountAdminRows(characters, characterAccount, accounts) {
  const accountById = new Map()
  for (const account of accounts || []) {
    const accountId = account?.account_id != null ? String(account.account_id).trim() : ''
    if (accountId) accountById.set(accountId, account)
  }
  const charById = new Map()
  for (const character of characters || []) {
    const charId = character?.char_id != null ? String(character.char_id).trim() : ''
    const name = (character?.name || '').trim()
    if (!charId || !name || charById.has(charId)) continue
    charById.set(charId, { char_id: charId, name })
  }
  const charsByAccount = new Map()
  const linkedCharIds = new Set()
  for (const row of characterAccount || []) {
    const charId = row?.char_id != null ? String(row.char_id).trim() : ''
    const accountId = row?.account_id != null ? String(row.account_id).trim() : ''
    if (!charId || !accountId || linkedCharIds.has(charId) || !charById.has(charId)) continue
    linkedCharIds.add(charId)
    if (!charsByAccount.has(accountId)) charsByAccount.set(accountId, [])
    charsByAccount.get(accountId).push(charById.get(charId))
  }

  const rows = []
  const accountIds = new Set([...accountById.keys(), ...charsByAccount.keys()])
  for (const accountId of accountIds) {
    const account = accountById.get(accountId) || { account_id: accountId, display_name: '', toon_names: '' }
    const chars = charsByAccount.get(accountId) || []
    const chosen = resolveAdminCharacter(chars, account, '')
    const accountLabel = accountColumnLabel(account) || accountId
    const searchText = [
      accountLabel,
      account.display_name,
      account.toon_names,
      accountId,
      ...chars.map((row) => row.name),
    ].filter(Boolean).join(' ').toLowerCase()
    rows.push({
      key: `account:${accountId}`,
      account_id: accountId,
      accountLabel,
      display_name: (account.display_name || '').trim(),
      char_id: chosen?.char_id || null,
      characterName: chosen?.name || null,
      characters: chars,
      label: accountAdminLabel(accountLabel, accountId, chosen?.name || ''),
      searchText,
      unlinked: false,
    })
  }

  const unlinked = [...charById.values()].filter((row) => !linkedCharIds.has(row.char_id))
  const unlinkedCounts = new Map()
  for (const row of unlinked) {
    const label = `${row.name} (unlinked)`
    unlinkedCounts.set(label, (unlinkedCounts.get(label) || 0) + 1)
  }
  for (const row of unlinked) {
    let label = `${row.name} (unlinked)`
    if (unlinkedCounts.get(label) > 1) label = `${label} (${row.char_id})`
    rows.push({
      key: `unlinked:${row.char_id}`,
      account_id: null,
      accountLabel: '',
      display_name: '',
      char_id: row.char_id,
      characterName: row.name,
      characters: [row],
      label,
      searchText: `${row.name} ${row.char_id} unlinked`.toLowerCase(),
      unlinked: true,
    })
  }
  rows.sort((a, b) => a.label.localeCompare(b.label))
  return rows
}

export function accountAdminMatchesQuery(row, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return true
  if ((row.searchText || '').includes(q)) return true
  if ((row.account_id || '').toLowerCase().includes(q)) return true
  return (row.characters || []).some((character) => (
    character.name.toLowerCase().includes(q) || character.char_id.toLowerCase().includes(q)
  ))
}

export function withResolvedCharacter(row, query) {
  if (!row || row.unlinked) return row
  const chosen = resolveAdminCharacter(
    row.characters,
    { display_name: row.display_name, account_id: row.account_id },
    query,
  )
  if (!chosen) return { ...row, char_id: null, characterName: null, label: accountAdminLabel(row.accountLabel, row.account_id, '') }
  return {
    ...row,
    char_id: chosen.char_id,
    characterName: chosen.name,
    label: accountAdminLabel(row.accountLabel, row.account_id, chosen.name),
  }
}

export function filterAccountAdminRows(rows, query) {
  return (rows || [])
    .filter((row) => accountAdminMatchesQuery(row, query))
    .map((row) => withResolvedCharacter(row, query))
}

export function claimAccountDisplayName(account) {
  const name = (account?.display_name || '').trim()
  return name || (account?.account_id != null ? String(account.account_id) : '')
}

/** Named accounts first, A–Z by display name. Accounts with no display name follow, by id. */
export function sortClaimAccounts(accounts) {
  return [...(accounts || [])].sort((a, b) => {
    const aName = (a?.display_name || '').trim()
    const bName = (b?.display_name || '').trim()
    if (aName && !bName) return -1
    if (!aName && bName) return 1
    const byName = claimAccountDisplayName(a).localeCompare(claimAccountDisplayName(b), undefined, { sensitivity: 'base' })
    if (byName !== 0) return byName
    return String(a?.account_id ?? '').localeCompare(String(b?.account_id ?? ''), undefined, { numeric: true, sensitivity: 'base' })
  })
}

export function claimAccountMatchesQuery(account, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return true
  const name = (account?.display_name || '').trim().toLowerCase()
  const id = account?.account_id != null ? String(account.account_id).toLowerCase() : ''
  if (name && (name.includes(q) || q.startsWith(name))) return true
  return Boolean(id) && id.includes(q)
}

/** Sorted, filtered claim choices. Duplicate display names include the account id. */
export function claimAccountChoices(accounts, query) {
  const filtered = sortClaimAccounts(accounts).filter((account) => claimAccountMatchesQuery(account, query))
  const nameCounts = new Map()
  for (const account of filtered) {
    const name = (account?.display_name || '').trim().toLowerCase()
    if (!name) continue
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1)
  }
  return filtered.map((account) => {
    const name = (account?.display_name || '').trim()
    const id = account?.account_id != null ? String(account.account_id) : ''
    const duplicated = name && (nameCounts.get(name.toLowerCase()) || 0) > 1
    const label = !name ? id : (duplicated ? `${name} (${id})` : name)
    return { account, id, label }
  })
}

/**
 * Account id the Claim button submits.
 * The highlighted suggestion wins over an earlier click so moving from A to B
 * cannot claim A while the list shows B.
 */
export function resolveClaimSubmitAccountId({
  claimAccountId = '',
  claimQuery = '',
  claimChoices = [],
  claimActiveIndex = 0,
} = {}) {
  const choices = claimChoices || []
  const activeIndex = choices.length === 0
    ? 0
    : Math.min(Math.max(claimActiveIndex, 0), choices.length - 1)
  const queryKey = String(claimQuery || '').trim().toLowerCase()
  const exact = queryKey
    ? choices.filter((row) => (
      row.label.toLowerCase() === queryKey
      || String(row.id).toLowerCase() === queryKey
      || (row.account?.display_name || '').trim().toLowerCase() === queryKey
    ))
    : []
  const stored = claimAccountId && choices.some((row) => row.id === claimAccountId)
    ? claimAccountId
    : ''
  const resolved = stored || (exact.length === 1 ? exact[0].id : '')
  const indicated = (String(claimQuery || '').trim() || resolved)
    ? (choices[activeIndex]?.id || '')
    : ''
  return indicated || resolved || ''
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
