import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fetchAllRpcByRange, RPC_PAGE_SIZE } from './fetchAllRpcByRange.js'

function mockRpcClient(allRows, { failAtFrom } = {}) {
  return {
    rpc(_fn, _params) {
      const state = { orders: [], from: 0, to: 0 }
      const query = {
        order(column, opts) {
          state.orders.push({ column, ascending: opts?.ascending !== false })
          return query
        },
        async range(from, to) {
          if (failAtFrom != null && from === failAtFrom) {
            return { data: null, error: { message: `failed at ${from}` } }
          }
          state.from = from
          state.to = to
          return { data: allRows.slice(from, to + 1), error: null }
        },
      }
      query._state = state
      return query
    },
  }
}

describe('fetchAllRpcByRange', () => {
  it('collects every page when the result exceeds the PostgREST cap', async () => {
    const total = 2701
    const rows = Array.from({ length: total }, (_, i) => ({
      item_name: i < 1000 ? 'alpha-item' : i < 2000 ? 'mid-boundary' : 'zeta-item',
      loot_id: total - i,
      cost: String((i % 50) + 1),
      sale_date: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`,
    }))
    const client = mockRpcClient(rows)
    const merged = await fetchAllRpcByRange(client, 'recent_item_sale_costs', { p_limit: 3 })
    assert.equal(merged.length, total)
    assert.equal(merged[0].item_name, 'alpha-item')
    assert.equal(merged[999].item_name, 'alpha-item')
    assert.equal(merged[1000].item_name, 'mid-boundary')
    assert.equal(merged[1999].item_name, 'mid-boundary')
    assert.equal(merged[2000].item_name, 'zeta-item')
    assert.equal(merged[2700].item_name, 'zeta-item')
    assert.ok(RPC_PAGE_SIZE <= 1000)
  })

  it('surfaces an error and does not return a partial result', async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: i }))
    const client = mockRpcClient(rows, { failAtFrom: 1000 })
    await assert.rejects(
      () => fetchAllRpcByRange(client, 'account_character_spent'),
      (err) => {
        assert.match(String(err.message || err), /failed at 1000/)
        return true
      },
    )
  })
})
