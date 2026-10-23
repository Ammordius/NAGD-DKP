/**
 * Fold recent_item_sale_costs RPC rows into the Raid Items last-three map.
 * Matches the previous client grouping (ISO date then loot id, newest first).
 *
 * @param {Array<{ item_name?: string, loot_id?: number, cost?: string|number, sale_date?: string }>} rows
 * @returns {Record<string, { values: Array<string|number>, avg: string|null }>}
 */
export function buildItemLast3FromSaleRows(rows) {
  const byItem = {}
  for (const row of rows || []) {
    const name = (row.item_name || '').trim().toLowerCase()
    if (!name) continue
    if (!byItem[name]) byItem[name] = []
    byItem[name].push({ id: row.loot_id, cost: row.cost, date: row.sale_date || '' })
  }
  const last3Map = {}
  for (const [key, arr] of Object.entries(byItem)) {
    arr.sort((a, b) => {
      const da = /^\d{4}-\d{2}-\d{2}/.test(String(a.date || '').trim()) ? String(a.date).slice(0, 10) : '9999-99-99'
      const db = /^\d{4}-\d{2}-\d{2}/.test(String(b.date || '').trim()) ? String(b.date).slice(0, 10) : '9999-99-99'
      const cmp = db.localeCompare(da)
      if (cmp !== 0) return cmp
      return (b.id ?? 0) - (a.id ?? 0)
    })
    const recent = arr.slice(0, 3)
    const costs = recent.map((r) => Number(r.cost))
    const avg = costs.length ? (costs.reduce((s, c) => s + c, 0) / costs.length).toFixed(1) : null
    last3Map[key] = { values: recent.map((r) => r.cost ?? '—'), avg }
  }
  return last3Map
}

/**
 * Previous Raid Items client logic: group full loot history by item, take last 3.
 * Used only in regression tests to compare against RPC-folded results.
 */
export function buildItemLast3FromFullLoot(lootRows) {
  const byItem = {}
  for (const row of lootRows || []) {
    const name = (row.item_name || '').trim().toLowerCase()
    if (!name) continue
    if (!byItem[name]) byItem[name] = []
    byItem[name].push({
      id: row.id ?? row.loot_id,
      cost: row.cost,
      date: row.sale_date || row.date_iso || row.date || '',
    })
  }
  return buildItemLast3FromSaleRows(
    Object.entries(byItem).flatMap(([item_name, arr]) =>
      arr.map((r) => ({ item_name, loot_id: r.id, cost: r.cost, sale_date: r.date })),
    ),
  )
}
