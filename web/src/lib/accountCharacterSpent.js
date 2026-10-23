/**
 * Fold account_character_spent RPC rows into spentByAccount[accountId][characterKey].
 *
 * @param {Array<{ account_id?: string, character_key?: string, total_spent?: number|string }>} rows
 * @returns {Record<string, Record<string, number>>}
 */
export function foldAccountCharacterSpentRows(rows) {
  /** @type {Record<string, Record<string, number>>} */
  const spentByAccount = {}
  for (const row of rows || []) {
    const aid = row.account_id != null ? String(row.account_id) : ''
    const key = (row.character_key || '').trim()
    if (!aid || !key) continue
    const total = Number(row.total_spent)
    if (!Number.isFinite(total)) continue
    if (!spentByAccount[aid]) spentByAccount[aid] = {}
    spentByAccount[aid][key] = (spentByAccount[aid][key] || 0) + total
  }
  return spentByAccount
}
