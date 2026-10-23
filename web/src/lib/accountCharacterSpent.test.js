import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSpentByAccountFromLoot } from './formatAccountCharacter.js'
import { foldAccountCharacterSpentRows } from './accountCharacterSpent.js'
import { fetchAllRpcByRange } from './fetchAllRpcByRange.js'

/**
 * Mirror account_character_spent SQL row shape from loot fixtures.
 * Keeps guild semantics aligned with buildSpentByAccountFromLoot.
 */
function sqlLikeSpentRows(lootRows, buyerCharIdToAccountId) {
  const byAccount = buildSpentByAccountFromLoot(lootRows, buyerCharIdToAccountId)
  const rows = []
  for (const [account_id, map] of Object.entries(byAccount)) {
    for (const [character_key, total_spent] of Object.entries(map)) {
      rows.push({ account_id, character_key, total_spent })
    }
  }
  rows.sort((a, b) => {
    const byAcct = String(a.account_id).localeCompare(String(b.account_id))
    if (byAcct !== 0) return byAcct
    return String(a.character_key).localeCompare(String(b.character_key))
  })
  return rows
}

describe('account_character_spent parity', () => {
  const buyers = {
    '100': 'acct-1',
    Buyer: 'acct-1',
    '200': 'acct-2',
    Twin: 'acct-2',
    Ambiguous: 'acct-1',
  }

  const fixture = [
    { char_id: '100', character_name: 'Buyer', cost: '12', assigned_character_name: 'Alt' },
    { char_id: '100', character_name: 'Buyer', cost: 40 },
    { char_id: '', character_name: 'Buyer', cost: '5' },
    { char_id: '100', character_name: '', cost: 7 },
    { char_id: '200', character_name: 'Twin', cost: '3', assigned_char_id: '200' },
    { char_id: '200', character_name: 'Twin', cost: 'not-a-number' },
    { char_id: '', character_name: 'Ambiguous', cost: '11' },
    { char_id: '999', character_name: 'Stranger', cost: 9 },
  ]

  it('matches buildSpentByAccountFromLoot for buyer id, name fallback, assignee, and numeric costs', () => {
    const expected = buildSpentByAccountFromLoot(fixture, buyers)
    const sqlRows = sqlLikeSpentRows(fixture, buyers)
    const folded = foldAccountCharacterSpentRows(sqlRows)
    assert.deepEqual(folded, expected)
    assert.deepEqual(folded['acct-1'], { Alt: 12, Buyer: 45, '100': 7, Ambiguous: 11 })
    assert.deepEqual(folded['acct-2'], { '200': 3 })
    assert.equal(Object.keys(folded).length, 2)
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
