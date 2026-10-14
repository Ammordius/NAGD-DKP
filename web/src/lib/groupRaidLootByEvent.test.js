import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { groupRaidLootByEvent } from './groupRaidLootByEvent.js'

describe('groupRaidLootByEvent', () => {
  it('titles a placeholder tic from its clock', () => {
    const [section] = groupRaidLootByEvent(
      [{ id: 1, event_id: 'tic-1', item_name: 'Belt' }],
      [{ event_id: 'tic-1', event_order: 1, event_name: 'DKP tic', event_time: 'Wed Oct 14 21:00:00 2026' }],
    )
    assert.equal(section.title, '9:00pm on-time')
  })
})
