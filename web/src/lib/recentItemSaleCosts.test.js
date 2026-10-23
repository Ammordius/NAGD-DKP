import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildItemLast3FromFullLoot,
  buildItemLast3FromSaleRows,
} from './recentItemSaleCosts.js'
import { fetchAllRpcByRange } from './fetchAllRpcByRange.js'

describe('buildItemLast3FromSaleRows', () => {
  it('matches the previous full-loot last-three averages across page boundaries', async () => {
    // 2701 sale rows: many items with 3 sales each, plus names that straddle 1000-row pages.
    const fullLoot = []
    let lootId = 1
    for (let i = 0; i < 900; i++) {
      const name = `item-${String(i).padStart(4, '0')}`
      for (let n = 0; n < 3; n++) {
        fullLoot.push({
          id: lootId++,
          item_name: name,
          cost: String(10 + n),
          sale_date: `2025-0${(n % 9) + 1}-15`,
        })
      }
    }
    // Extra rows so total sales exceed 2700 and cross page boundaries on item_name order.
    for (let i = 0; i < 1; i++) {
      fullLoot.push({
        id: lootId++,
        item_name: 'zzz-cross-page',
        cost: '99',
        sale_date: '2025-12-01',
      })
    }
    assert.ok(fullLoot.length >= 2701)

    const rpcRows = fullLoot
      .map((row) => ({
        item_name: row.item_name.trim().toLowerCase(),
        loot_id: row.id,
        cost: row.cost,
        sale_date: row.sale_date,
      }))
      .sort((a, b) => {
        const byName = a.item_name.localeCompare(b.item_name)
        if (byName !== 0) return byName
        const byDate = b.sale_date.localeCompare(a.sale_date)
        if (byDate !== 0) return byDate
        return b.loot_id - a.loot_id
      })

    const client = {
      rpc() {
        const q = {
          order() { return q },
          async range(from, to) {
            return { data: rpcRows.slice(from, to + 1), error: null }
          },
        }
        return q
      },
    }
    const paged = await fetchAllRpcByRange(client, 'recent_item_sale_costs', { p_limit: 3 })
    assert.equal(paged.length, rpcRows.length)
    assert.ok(paged.length >= 2701)

    const fromRpc = buildItemLast3FromSaleRows(paged)
    const fromFull = buildItemLast3FromFullLoot(fullLoot)
    assert.deepEqual(fromRpc, fromFull)
    assert.ok(fromRpc['zzz-cross-page'])
    assert.deepEqual(fromRpc['zzz-cross-page'].values, ['99'])
    assert.equal(fromRpc['item-0000'].avg, fromFull['item-0000'].avg)
  })
})
