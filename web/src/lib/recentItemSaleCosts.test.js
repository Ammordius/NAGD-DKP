import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDatedSalesByItem,
  buildItemLast3FromFullLoot,
  buildItemLast3FromSaleRows,
  selectEraPeerCosts,
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

describe('buildDatedSalesByItem', () => {
  it('keeps loot id, cost, and date for every sale row', () => {
    const map = buildDatedSalesByItem([
      { item_name: 'Edge of Eternity', loot_id: 1, cost: '18', sale_date: '2023-11-21' },
      { item_name: 'Edge of Eternity', loot_id: 2, cost: 19, sale_date: '2024-01-23' },
      { item_name: 'Other Blade', loot_id: 9, cost: 4, sale_date: '2026-01-01' },
    ])
    assert.equal(map['edge of eternity'].length, 2)
    assert.deepEqual(map['edge of eternity'][0], {
      lootId: 1,
      cost: '18',
      date: '2023-11-21',
    })
    assert.equal(map['other blade'].length, 1)
  })
})

describe('selectEraPeerCosts', () => {
  const sales = [
    { lootId: 1, cost: 18, date: '2023-11-21' },
    { lootId: 9001, cost: 19, date: '2024-01-23' },
    { lootId: 2, cost: 24, date: '2024-03-19' },
    { lootId: 3, cost: 24, date: '2024-03-19' },
    { lootId: 4, cost: 10, date: '2024-05-14' },
    { lootId: 5, cost: 4, date: '2026-08-01' },
    { lootId: 6, cost: 4, date: '2026-09-01' },
    { lootId: 7, cost: 5, date: '2026-10-01' },
  ]

  it('picks nearest sales by date and excludes the purchase by loot id', () => {
    const peers = selectEraPeerCosts(
      { purchaseId: '9001', saleDate: '2024-01-23' },
      sales,
      3,
    )
    // Nearest excluding self: two 24s (~56d after) then 18 (~63d before)
    assert.deepEqual(peers, [24, 24, 18])
  })

  it('returns fewer than three when history is thin (no current-market pad)', () => {
    const peers = selectEraPeerCosts(
      { purchaseId: '1', saleDate: '2024-01-01' },
      [
        { lootId: 1, cost: 50, date: '2024-01-01' },
        { lootId: 2, cost: 40, date: '2024-02-01' },
      ],
      3,
    )
    assert.deepEqual(peers, [40])
  })

  it('returns empty when the purchase has no parseable sale date', () => {
    assert.deepEqual(
      selectEraPeerCosts({ purchaseId: '1', saleDate: 'sometime' }, sales, 3),
      [],
    )
  })
})
