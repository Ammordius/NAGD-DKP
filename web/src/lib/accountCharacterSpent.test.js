import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { foldAccountCharacterSpentRows } from './accountCharacterSpent.js'
import { fetchAllRpcByRange } from './fetchAllRpcByRange.js'

describe('foldAccountCharacterSpentRows', () => {
  it('folds RPC rows into spentByAccount maps', () => {
    const folded = foldAccountCharacterSpentRows([
      { account_id: 'acct-1', character_key: 'Alt', total_spent: 12 },
      { account_id: 'acct-1', character_key: 'Buyer', total_spent: '40' },
      { account_id: 'acct-2', character_key: '200', total_spent: 3 },
      { account_id: 'acct-1', character_key: '', total_spent: 9 },
      { account_id: 'acct-1', character_key: 'Buyer', total_spent: 'not-a-number' },
    ])
    assert.deepEqual(folded, {
      'acct-1': { Alt: 12, Buyer: 40 },
      'acct-2': { '200': 3 },
    })
  })

  it('paginates the full spent result without silent truncation', async () => {
    const many = []
    for (let i = 0; i < 1200; i++) {
      many.push({
        account_id: `acct-${String(i % 40).padStart(3, '0')}`,
        character_key: `char-${String(i).padStart(4, '0')}`,
        total_spent: i + 0.5,
      })
    }
    many.sort((a, b) => {
      const byAcct = a.account_id.localeCompare(b.account_id)
      if (byAcct !== 0) return byAcct
      return a.character_key.localeCompare(b.character_key)
    })
    const client = {
      rpc() {
        const q = {
          order() { return q },
          async range(from, to) {
            return { data: many.slice(from, to + 1), error: null }
          },
        }
        return q
      },
    }
    const paged = await fetchAllRpcByRange(client, 'account_character_spent')
    assert.equal(paged.length, 1200)
    const folded = foldAccountCharacterSpentRows(paged)
    let totalKeys = 0
    for (const map of Object.values(folded)) totalKeys += Object.keys(map).length
    assert.equal(totalKeys, 1200)
  })
})
