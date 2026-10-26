import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CHUNKED_IN_SIZE, CHUNKED_PAGE_SIZE, fetchChunkedIn } from './fetchChunkedIn.js'
import { raidMissingTics, ticFractionsByRaid } from './raidTicIdentity.js'

function pageClient(tableRows) {
  const calls = []
  return {
    calls,
    from(table) {
      const state = { table, orders: [], filters: [] }
      const chain = {
        select() { return chain },
        in(column, values) {
          state.filters.push({ column, values: values.map(String) })
          return chain
        },
        order(column, opts) {
          state.orders.push({ column, ascending: opts?.ascending !== false })
          return chain
        },
        range(from, to) {
          calls.push({
            table: state.table,
            from,
            to,
            orders: state.orders.map((order) => order.column),
            filters: state.filters.map((filter) => ({ column: filter.column, size: filter.values.length })),
          })
          let rows = tableRows[state.table] || []
          for (const filter of state.filters) {
            const allowed = new Set(filter.values)
            rows = rows.filter((row) => allowed.has(String(row[filter.column])))
          }
          const order = state.orders[0]
          if (!order) return Promise.resolve({ data: rows.slice(0, CHUNKED_PAGE_SIZE), error: null })
          rows = [...rows].sort((a, b) => {
            if (a[order.column] < b[order.column]) return order.ascending ? -1 : 1
            if (a[order.column] > b[order.column]) return order.ascending ? 1 : -1
            return 0
          })
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null })
        },
      }
      return chain
    },
  }
}

describe('fetchChunkedIn', () => {
  it('pages past the first 1000 attendance rows so a later tic still counts', async () => {
    const attendance = []
    const events = []
    for (let i = 1; i <= CHUNKED_PAGE_SIZE + 50; i += 1) {
      attendance.push({ id: i, raid_id: `r${i}`, event_id: `e${i}`, char_id: 'c1', character_name: 'Ada' })
      events.push({
        id: i,
        raid_id: `r${i}`,
        event_id: `e${i}`,
        event_order: 1,
        event_name: 'DKP tic',
        dkp_value: '1',
      })
    }
    const client = pageClient({ raid_event_attendance: attendance })
    const loaded = await fetchChunkedIn(
      client,
      'raid_event_attendance',
      'id, raid_id, event_id, char_id, character_name',
      'char_id',
      ['c1'],
      'id',
    )
    assert.equal(loaded.error, null)
    assert.equal(loaded.data.length, CHUNKED_PAGE_SIZE + 50)
    assert.deepEqual(client.calls.map((call) => call.from), [0, CHUNKED_PAGE_SIZE])
    assert.deepEqual(client.calls[0].orders, ['id'])

    const lastId = `r${CHUNKED_PAGE_SIZE + 50}`
    const fraction = ticFractionsByRaid(events, loaded.data).get(lastId)
    const status = raidMissingTics({
      ticEarned: fraction.ticEarned,
      ticTotal: fraction.ticTotal,
      dkpEarned: 1,
      dkpRaidTotal: fraction.totalDkp,
    })
    assert.equal(status.ticEarned, 1)
    assert.equal(status.ticTotal, 1)
    assert.equal(status.isMissingTics, false)
  })

  it('splits long id lists and stops when a page is short', async () => {
    const client = pageClient({ raids: [] })
    const ids = Array.from({ length: CHUNKED_IN_SIZE + 1 }, (_, i) => `raid-${i}`)
    const loaded = await fetchChunkedIn(client, 'raids', 'raid_id', 'raid_id', ids, 'raid_id')
    assert.equal(loaded.data.length, 0)
    assert.equal(client.calls.length, 2)
    assert.equal(client.calls[0].filters[0].size, CHUNKED_IN_SIZE)
    assert.equal(client.calls[1].filters[0].size, 1)
  })

  it('returns the query error instead of a partial page', async () => {
    const client = {
      from() {
        const chain = {
          select() { return chain },
          in() { return chain },
          order() { return chain },
          range() { return Promise.resolve({ data: null, error: { message: 'timeout' } }) },
        }
        return chain
      },
    }
    const loaded = await fetchChunkedIn(client, 'raid_events', 'id', 'raid_id', ['r1'], 'id')
    assert.equal(loaded.data, null)
    assert.equal(loaded.error.message, 'timeout')
  })
})
