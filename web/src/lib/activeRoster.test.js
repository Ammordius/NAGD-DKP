import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { accountsForInput, charactersForInput, fetchActiveRoster, linksForInput } from './activeRoster.js'

const accounts = [
  { account_id: 'a1', display_name: 'Ada', inactive: false },
  { account_id: 'a2', display_name: 'Old', inactive: true },
]
const links = [
  { char_id: 'c1', account_id: 'a1' },
  { char_id: 'c2', account_id: 'a2' },
]
const characters = [
  { char_id: 'c1', name: 'Ada' },
  { char_id: 'c2', name: 'Oldmain' },
  { char_id: 'c3', name: 'Solo' },
]

describe('input roster filters', () => {
  it('keeps active-account characters and unlinked characters', () => {
    assert.deepEqual(
      charactersForInput(characters, links, accounts).map((row) => row.char_id),
      ['c1', 'c3'],
    )
    assert.deepEqual(linksForInput(links, accounts), [{ char_id: 'c1', account_id: 'a1' }])
    assert.deepEqual(accountsForInput(accounts).map((row) => row.account_id), ['a1'])
  })
})

function pageClient(tables) {
  const calls = []
  return {
    calls,
    from(table) {
      const state = { table, select: '', filters: [], orders: [] }
      const chain = {
        select(columns) {
          state.select = columns
          return chain
        },
        eq(column, value) {
          state.filters.push(['eq', column, value])
          return chain
        },
        in(column, values) {
          state.filters.push(['in', column, values])
          return chain
        },
        order(column) {
          state.orders.push(column)
          return chain
        },
        range(from, to) {
          const call = {
            table: state.table,
            select: state.select,
            filters: state.filters.map((filter) => [...filter]),
            orders: [...state.orders],
            from,
            to,
          }
          calls.push(call)
          const rows = tables(call)
          const page = rows.slice(from, to + 1)
          return Promise.resolve({ data: page, error: null })
        },
      }
      return chain
    },
  }
}

describe('fetchActiveRoster', () => {
  it('orders each page and skips characters on inactive accounts', async () => {
    const links = []
    for (let i = 0; i < 1001; i += 1) links.push({ char_id: `c${i}`, account_id: 'a1' })
    const client = pageClient((call) => {
      if (call.table === 'accounts' && call.filters.some((filter) => filter[2] === false)) {
        return [{ account_id: 'a1', display_name: 'Ada', inactive: false }]
      }
      if (call.table === 'accounts') return [{ account_id: 'a2' }]
      if (call.table === 'character_account' && call.filters.some((filter) => filter[0] === 'in' && filter[2].includes('a1'))) {
        return links
      }
      if (call.table === 'character_account') return [{ char_id: 'old', account_id: 'a2' }]
      if (call.select === 'char_id') {
        return [...links.map((row) => ({ char_id: row.char_id })), { char_id: 'old' }, { char_id: 'solo' }]
      }
      if (call.filters.some((filter) => filter[0] === 'in' && filter[2].includes('solo'))) {
        return [{ char_id: 'solo', name: 'Solo' }]
      }
      if (call.filters.some((filter) => filter[0] === 'in' && String(filter[2][0] || '').startsWith('c'))) {
        return call.filters[0][2].map((charId) => ({ char_id: charId, name: charId }))
      }
      return []
    })

    const roster = await fetchActiveRoster(client, {
      accountColumns: 'account_id, display_name, toon_names, inactive',
      characterColumns: 'char_id, name',
    })

    assert.equal(roster.accounts.length, 1)
    assert.equal(roster.characterAccount.length, 1001)
    assert.equal(roster.characters.some((row) => row.char_id === 'old'), false)
    assert.equal(roster.characters.some((row) => row.char_id === 'solo'), true)
    assert.equal(roster.characters.length, 1002)
    for (const call of client.calls) {
      assert.ok(call.orders.length > 0, `${call.table} was paged without an order`)
    }
    const linkCalls = client.calls.filter((call) => call.table === 'character_account' && call.filters.some((filter) => filter[2]?.includes?.('a1')))
    assert.equal(linkCalls.length, 2)
    assert.deepEqual(linkCalls[0].orders, ['char_id', 'account_id'])
    assert.equal(linkCalls[0].from, 0)
    assert.equal(linkCalls[1].from, 1000)
  })

  it('does not scan every character when unlinked names are not needed', async () => {
    const client = pageClient((call) => {
      if (call.table === 'accounts') return [{ account_id: 'a1', inactive: false }]
      if (call.table === 'character_account') return [{ char_id: 'c1', account_id: 'a1' }]
      return [{ char_id: 'c1', name: 'Ada', class_name: 'Cleric', level: 60 }]
    })

    const roster = await fetchActiveRoster(client, {
      accountColumns: 'account_id, toon_count, display_name, inactive',
      characterColumns: 'char_id, name, class_name, level',
      includeUnlinked: false,
    })

    assert.deepEqual(roster.characters.map((row) => row.name), ['Ada'])
    assert.equal(client.calls.some((call) => call.select === 'char_id'), false)
    assert.equal(client.calls.some((call) => call.filters.some((filter) => filter[2] === true)), false)
  })

  it('returns inactive accounts and their characters only when asked', async () => {
    const client = pageClient((call) => {
      if (call.table === 'accounts' && call.filters.some((filter) => filter[2] === false)) {
        return [{ account_id: 'a1', display_name: 'Ada', inactive: false }]
      }
      if (call.table === 'accounts') return [{ account_id: 'a2', display_name: 'Old' }]
      if (call.table === 'character_account' && call.filters.some((filter) => filter[0] === 'in' && filter[2].includes('a1'))) {
        return [{ char_id: 'c1', account_id: 'a1' }]
      }
      if (call.table === 'character_account') return [{ char_id: 'c2', account_id: 'a2' }]
      if (call.filters.some((filter) => filter[0] === 'in' && filter[2].includes('c2'))) {
        return [{ char_id: 'c2', name: 'Oldmain', class_name: 'Warrior', level: 60 }]
      }
      return [{ char_id: 'c1', name: 'Ada', class_name: 'Cleric', level: 60 }]
    })

    const hidden = await fetchActiveRoster(client, {
      accountColumns: 'account_id, toon_count, display_name, inactive',
      characterColumns: 'char_id, name, class_name, level',
      includeUnlinked: false,
    })
    assert.deepEqual(hidden.accounts.map((row) => row.account_id), ['a1'])
    assert.deepEqual(hidden.characterAccount.map((row) => row.char_id), ['c1'])
    assert.equal(hidden.characters.some((row) => row.char_id === 'c2'), false)

    client.calls.length = 0
    const shown = await fetchActiveRoster(client, {
      accountColumns: 'account_id, toon_count, display_name, inactive',
      characterColumns: 'char_id, name, class_name, level',
      includeUnlinked: false,
      includeInactive: true,
    })
    assert.deepEqual(shown.accounts.map((row) => [row.account_id, row.inactive]), [
      ['a1', false],
      ['a2', true],
    ])
    assert.deepEqual(shown.characterAccount.map((row) => row.char_id), ['c1', 'c2'])
    assert.deepEqual(shown.characters.map((row) => row.name).sort(), ['Ada', 'Oldmain'])
    assert.equal(client.calls.some((call) => call.table === 'characters' && call.select === 'char_id' && call.filters.length === 0), false)
  })
})
