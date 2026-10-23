const PAGE_SIZE = 1000
const IN_CHUNK = 150

/**
 * Page a filtered read in a stable order. PostgREST caps each response, and
 * .range() without ORDER BY can skip or repeat rows past the first page.
 */
async function fetchPaged(client, table, columns, applyFilter, orderColumns) {
  const merged = []
  let from = 0
  for (;;) {
    let query = client.from(table).select(columns)
    if (applyFilter) query = applyFilter(query)
    for (const column of orderColumns) query = query.order(column, { ascending: true })
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(error.message || `Failed to load ${table}`)
    const rows = data || []
    merged.push(...rows)
    if (rows.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return merged
}

async function fetchInPaged(client, table, columns, column, values, orderColumns) {
  if (!values.length) return []
  const merged = []
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const chunk = values.slice(i, i + IN_CHUNK)
    const rows = await fetchPaged(
      client,
      table,
      columns,
      (query) => query.in(column, chunk),
      orderColumns,
    )
    merged.push(...rows)
  }
  return merged
}

function idList(rows, column) {
  const ids = []
  const seen = new Set()
  for (const row of rows || []) {
    const id = row?.[column]
    if (id == null || id === '') continue
    const key = String(id)
    if (seen.has(key)) continue
    seen.add(key)
    ids.push(id)
  }
  return ids
}

function inactiveAccountIdSet(accounts) {
  const ids = new Set()
  for (const account of accounts || []) {
    if (account?.inactive === true && account.account_id != null && account.account_id !== '') {
      ids.add(String(account.account_id).trim())
    }
  }
  return ids
}

function linksByCharacter(characterAccount) {
  const byChar = new Map()
  for (const row of characterAccount || []) {
    const charId = row?.char_id != null ? String(row.char_id).trim() : ''
    const accountId = row?.account_id != null ? String(row.account_id).trim() : ''
    if (!charId || !accountId) continue
    if (!byChar.has(charId)) byChar.set(charId, [])
    byChar.get(charId).push(accountId)
  }
  return byChar
}

/** Accounts an officer has not marked inactive. */
export function accountsForInput(accounts) {
  return (accounts || []).filter((account) => account?.inactive !== true)
}

/** Links that belong to an active account. */
export function linksForInput(characterAccount, accounts) {
  const inactive = inactiveAccountIdSet(accounts)
  return (characterAccount || []).filter((row) => {
    const accountId = row?.account_id != null ? String(row.account_id).trim() : ''
    return accountId && !inactive.has(accountId)
  })
}

/**
 * Characters an officer can pick for a new tic or loot row.
 * A character with no account stays available. A character linked only to
 * inactive accounts does not.
 */
export function charactersForInput(characters, characterAccount, accounts) {
  const inactive = inactiveAccountIdSet(accounts)
  const byChar = linksByCharacter(characterAccount)
  return (characters || []).filter((character) => {
    const charId = character?.char_id != null ? String(character.char_id).trim() : ''
    if (!charId) return false
    const links = byChar.get(charId) || []
    if (links.length === 0) return true
    return links.some((accountId) => !inactive.has(accountId))
  })
}

/**
 * Active accounts, their character links, and the characters officers can type
 * into raid and loot entry. Characters with no account link are included.
 * Characters on Site Admin inactive accounts are not downloaded.
 *
 * `includeInactive` also returns those inactive accounts and their characters
 * for the Accounts list. It does not write `accounts.inactive`. Raid and loot
 * entry leave the flag off.
 */
export async function fetchActiveRoster(client, {
  accountColumns,
  characterColumns,
  includeUnlinked = true,
  includeInactive = false,
} = {}) {
  if (!client?.from) throw new Error('fetchActiveRoster requires a Supabase client')
  const db = client
  const activeAccounts = await fetchPaged(
    db,
    'accounts',
    accountColumns,
    (query) => query.eq('inactive', false),
    ['account_id'],
  )
  const activeIds = idList(activeAccounts, 'account_id')
  const activeLinks = await fetchInPaged(
    db,
    'character_account',
    'char_id, account_id',
    'account_id',
    activeIds,
    ['char_id', 'account_id'],
  )
  const activeCharIds = idList(activeLinks, 'char_id')
  const activeCharacters = await fetchInPaged(
    db,
    'characters',
    characterColumns,
    'char_id',
    activeCharIds,
    ['char_id'],
  )

  let inactiveAccounts = []
  let inactiveLinks = []
  let inactiveCharacters = []
  if (includeUnlinked || includeInactive) {
    inactiveAccounts = await fetchPaged(
      db,
      'accounts',
      includeInactive ? accountColumns : 'account_id',
      (query) => query.eq('inactive', true),
      ['account_id'],
    )
    inactiveLinks = await fetchInPaged(
      db,
      'character_account',
      'char_id, account_id',
      'account_id',
      idList(inactiveAccounts, 'account_id'),
      ['char_id', 'account_id'],
    )
  }
  if (includeInactive) {
    inactiveCharacters = await fetchInPaged(
      db,
      'characters',
      characterColumns,
      'char_id',
      idList(inactiveLinks, 'char_id'),
      ['char_id'],
    )
    inactiveAccounts = inactiveAccounts.map((row) => (
      row?.inactive === true ? row : { ...row, inactive: true }
    ))
  }

  let unlinkedCharacters = []
  if (includeUnlinked) {
    const linkedIds = new Set([
      ...activeLinks.map((row) => (row?.char_id != null ? String(row.char_id) : '')),
      ...inactiveLinks.map((row) => (row?.char_id != null ? String(row.char_id) : '')),
    ])
    linkedIds.delete('')
    const idRows = await fetchPaged(db, 'characters', 'char_id', null, ['char_id'])
    const unlinkedIds = idRows
      .map((row) => row?.char_id)
      .filter((id) => id != null && id !== '' && !linkedIds.has(String(id)))
    unlinkedCharacters = await fetchInPaged(
      db,
      'characters',
      characterColumns,
      'char_id',
      unlinkedIds,
      ['char_id'],
    )
  }

  const seen = new Set()
  const characters = []
  for (const row of [...activeCharacters, ...inactiveCharacters, ...unlinkedCharacters]) {
    const id = row?.char_id != null ? String(row.char_id) : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    characters.push(row)
  }

  return {
    accounts: includeInactive ? [...activeAccounts, ...inactiveAccounts] : activeAccounts,
    characterAccount: includeInactive ? [...activeLinks, ...inactiveLinks] : activeLinks,
    characters,
  }
}
