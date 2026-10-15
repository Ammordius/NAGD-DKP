import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateLootSpent, lootSpentCharacterKey, sumCharacterSpent } from './characterSpent.js'

describe('lootSpentCharacterKey', () => {
  it('prefers the assigned character id, then the assigned name, then the buyer', () => {
    assert.equal(lootSpentCharacterKey({
      assigned_char_id: ' id-1 ',
      assigned_character_name: 'Named',
      char_id: 'buyer-id',
      character_name: 'Buyer',
    }), 'id-1')
    assert.equal(lootSpentCharacterKey({
      assigned_character_name: 'Legacy',
      char_id: 'buyer-id',
      character_name: 'Buyer',
    }), 'Legacy')
    assert.equal(lootSpentCharacterKey({
      char_id: 'buyer-id',
      character_name: 'Buyer',
    }), 'buyer-id')
    assert.equal(lootSpentCharacterKey({ character_name: 'Buyer' }), 'Buyer')
  })
})

describe('aggregateLootSpent', () => {
  it('adds several rows for one id and keeps a separate historical name bucket', () => {
    const spent = aggregateLootSpent([
      { assigned_char_id: 'id-1', assigned_character_name: 'Alpha', cost: '4' },
      { assigned_char_id: 'id-1', assigned_character_name: 'Alpha', cost: '6' },
      { assigned_character_name: 'Alpha', cost: '1' },
      { cost: '9' },
    ])
    assert.equal(spent['id-1'], 10)
    assert.equal(spent.Alpha, 1)
    assert.equal(spent['9'], undefined)
  })

  it('recomputes after an optimistic reassignment', () => {
    const before = [
      { id: 1, assigned_char_id: 'id-1', assigned_character_name: 'Alpha', cost: '5' },
    ]
    const after = before.map((row) => (
      row.id === 1
        ? { ...row, assigned_char_id: 'id-2', assigned_character_name: 'Beta' }
        : row
    ))
    assert.deepEqual(aggregateLootSpent(before), { 'id-1': 5 })
    assert.deepEqual(aggregateLootSpent(after), { 'id-2': 5 })
  })
})

describe('sumCharacterSpent', () => {
  it('adds the id bucket and a distinct historical name bucket once', () => {
    const spent = { 'id-1': 10, Alpha: 1 }
    assert.equal(sumCharacterSpent(spent, { char_id: 'id-1', name: 'Alpha' }), 11)
    assert.equal(sumCharacterSpent({ Alpha: 4 }, { char_id: 'Alpha', name: 'Alpha' }), 4)
  })
})
