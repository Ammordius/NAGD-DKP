/** Label shown in the Game Accounts "Account" column. */
export function accountListLabel(account) {
  const display = (account?.display_name || '').trim()
  if (display) return display
  const first = (account?.characters?.[0]?.name || '').trim()
  if (first) return first
  return account?.account_id != null ? String(account.account_id) : ''
}

/** Ascending account name. Same names stay in account id order. */
export function compareAccountsByName(a, b) {
  const byName = accountListLabel(a).localeCompare(accountListLabel(b), undefined, { sensitivity: 'base' })
  if (byName !== 0) return byName
  return String(a?.account_id ?? '').localeCompare(String(b?.account_id ?? ''))
}
