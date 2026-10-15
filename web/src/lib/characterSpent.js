/** Same order as loot_spent_character_key: assignment id, assignment name, buyer id, buyer name. */
export function lootSpentCharacterKey(row) {
  const assignedId = String(row?.assigned_char_id ?? '').trim()
  if (assignedId) return assignedId
  const assignedName = String(row?.assigned_character_name ?? '').trim()
  if (assignedName) return assignedName
  const buyerId = String(row?.char_id ?? '').trim()
  if (buyerId) return buyerId
  return String(row?.character_name ?? '').trim()
}

export function aggregateLootSpent(rows) {
  const spent = {}
  for (const row of rows || []) {
    const key = lootSpentCharacterKey(row)
    if (!key) continue
    const cost = parseFloat(row.cost || 0)
    if (!Number.isFinite(cost)) continue
    spent[key] = (spent[key] || 0) + cost
  }
  return spent
}

/**
 * Id-keyed total plus a distinct name-keyed total.
 * Historical rows stored under the character name still count, and a row keyed
 * by id is not added twice when the name equals the id.
 */
export function sumCharacterSpent(spentByKey, character) {
  const spent = spentByKey || {}
  const id = String(character?.char_id ?? '').trim()
  const name = String(character?.name ?? character?.character_name ?? '').trim()
  let total = 0
  if (id && Object.prototype.hasOwnProperty.call(spent, id)) total += Number(spent[id]) || 0
  if (name && name !== id && Object.prototype.hasOwnProperty.call(spent, name)) total += Number(spent[name]) || 0
  if (!id && !name) return 0
  return total
}
