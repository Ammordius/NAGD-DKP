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
 * Keep dated sale rows per item (loot id + cost + date) for era-relative outlier checks.
 * Does not truncate — callers pass RPC rows already limited by p_limit.
 *
 * @param {Array<{ item_name?: string, loot_id?: number|string, cost?: string|number, sale_date?: string }>} rows
 * @returns {Record<string, Array<{ lootId: number|string|null, cost: string|number, date: string }>>}
 */
export function buildDatedSalesByItem(rows) {
  /** @type {Record<string, Array<{ lootId: number|string|null, cost: string|number, date: string }>>} */
  const byItem = {}
  for (const row of rows || []) {
    const name = (row.item_name || '').trim().toLowerCase()
    if (!name) continue
    if (!byItem[name]) byItem[name] = []
    byItem[name].push({
      lootId: row.loot_id != null ? row.loot_id : null,
      cost: row.cost,
      date: row.sale_date || '',
    })
  }
  return byItem
}

/** @param {unknown} value */
export function parseIsoSaleDate(value) {
  const m = String(value || '')
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

/**
 * Absolute calendar-day distance between two YYYY-MM-DD dates.
 * @param {string} a
 * @param {string} b
 */
export function saleDateDayDistance(a, b) {
  const ta = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))
  const tb = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))
  return Math.abs(ta - tb) / 86_400_000
}

/**
 * Nearest same-item sale costs by calendar date, excluding the purchase itself by loot id.
 * Returns fewer than `peerCount` when history is thin — callers must not fall back to current-market prices.
 *
 * @param {{ purchaseId?: string|null, saleDate?: string|null }} purchase
 * @param {Array<{ lootId?: number|string|null, cost?: string|number, date?: string }>} datedSales
 * @param {number} [peerCount=3]
 * @returns {number[]}
 */
export function selectEraPeerCosts(purchase, datedSales, peerCount = 3) {
  const purchaseDate = parseIsoSaleDate(purchase?.saleDate)
  if (!purchaseDate || !(peerCount > 0)) return []

  const selfId = purchase?.purchaseId != null ? String(purchase.purchaseId) : null
  const peers = []
  for (const sale of datedSales || []) {
    const date = parseIsoSaleDate(sale?.date)
    if (!date) continue
    const lootId = sale?.lootId != null ? String(sale.lootId) : null
    if (selfId && lootId && lootId === selfId) continue
    const cost = Number(sale?.cost)
    if (!Number.isFinite(cost) || cost <= 0) continue
    peers.push({
      cost,
      dist: saleDateDayDistance(purchaseDate, date),
      idNum: lootId != null && Number.isFinite(Number(lootId)) ? Number(lootId) : 0,
    })
  }

  peers.sort((a, b) => {
    if (a.dist !== b.dist) return a.dist - b.dist
    return a.idNum - b.idNum
  })
  return peers.slice(0, peerCount).map((p) => p.cost)
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
