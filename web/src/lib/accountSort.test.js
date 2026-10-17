import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compareAccountsByName } from './accountSort.js'

describe('compareAccountsByName', () => {
  it('sorts by display name, not character count', () => {
    const accounts = [
      { account_id: '3', display_name: 'Zeb', characters: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] },
      { account_id: '1', display_name: 'amy', characters: [{ name: 'Only' }] },
      { account_id: '2', display_name: 'Mia', characters: [] },
    ]
    const sorted = [...accounts].sort(compareAccountsByName).map((a) => a.display_name)
    assert.deepEqual(sorted, ['amy', 'Mia', 'Zeb'])
  })

  it('uses the first character name, then account id, when display name is blank', () => {
    const accounts = [
      { account_id: '20', display_name: '  ', characters: [{ name: 'Norrath' }] },
      { account_id: '10', display_name: '', characters: [] },
      { account_id: '11', display_name: '', characters: [] },
    ]
    const sorted = [...accounts].sort(compareAccountsByName).map((a) => a.account_id)
    assert.deepEqual(sorted, ['10', '11', '20'])
  })
})
