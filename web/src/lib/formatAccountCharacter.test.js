import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSpentByAccountFromLoot,
  spentForCharacterFromLootMap,
} from './formatAccountCharacter.js'

const buyers = {
  '100': 'acct-1',
  Buyer: 'acct-1',
}

describe('buildSpentByAccountFromLoot', () => {
  it('keeps an assignee when the row has one', () => {
    const spent = buildSpentByAccountFromLoot(
      [{ char_id: '100', character_name: 'Buyer', cost: '12', assigned_character_name: 'Alt' }],
      buyers,
    )
    assert.deepEqual(spent['acct-1'], { Alt: 12 })
  })

  it('counts unassigned loot on the buyer name, matching the account page', () => {
    const spent = buildSpentByAccountFromLoot(
      [{ char_id: '100', character_name: 'Buyer', cost: 40 }],
      buyers,
    )
    assert.deepEqual(spent['acct-1'], { Buyer: 40 })
  })

  it('matches a name-only buyer and falls back to char_id when there is no name', () => {
    const spent = buildSpentByAccountFromLoot(
      [
        { char_id: '', character_name: 'Buyer', cost: '5' },
        { char_id: '100', character_name: '', cost: 7 },
      ],
      buyers,
    )
    assert.deepEqual(spent['acct-1'], { Buyer: 5, '100': 7 })
    assert.equal(spentForCharacterFromLootMap(spent['acct-1'], { name: 'Buyer', char_id: '100' }), 5)
    assert.equal(spentForCharacterFromLootMap(spent['acct-1'], { name: '', char_id: '100' }), 7)
  })

  it('skips a row that cannot be tied to an account or a character', () => {
    const spent = buildSpentByAccountFromLoot(
      [
        { char_id: '999', character_name: 'Stranger', cost: 9 },
        { char_id: '', character_name: '', cost: 3 },
      ],
      buyers,
    )
    assert.deepEqual(spent, {})
  })
})
