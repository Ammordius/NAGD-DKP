import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { distinctTicsByRaid, raidTicAttendance } from './raidTicIdentity.js'

describe('raid tic identity', () => {
  const rows = [
    { id: 1, raid_id: 'r1', event_id: 'e1', event_order: 0, event_name: 'On-time', dkp_value: '1' },
    { id: 2, raid_id: 'r1', event_id: 'e1', event_order: 1, event_name: 'DKP tic', dkp_value: '1' },
    { id: 3, raid_id: 'r1', event_id: 'e1', event_order: 1, event_name: 'DKP tic', dkp_value: '99' },
    { id: 4, raid_id: 'r1', event_id: 'e2', event_order: 2, event_name: 'DKP tic', dkp_value: '1' },
  ]

  it('keeps On-time and the DKP tic, and drops the duplicate', () => {
    const tics = distinctTicsByRaid(rows).get('r1')
    const attended = raidTicAttendance(tics, new Set(['e1']))
    assert.equal(attended.totalDkp, 3)
    assert.equal(attended.ticTotal, 3)
    assert.equal(attended.ticEarned, 2)
  })

  it('full attendance of the paid tics matches the raid total', () => {
    const tics = distinctTicsByRaid(rows).get('r1')
    const attended = raidTicAttendance(tics, new Set(['e1', 'e2']))
    assert.equal(attended.ticEarned, attended.ticTotal)
    assert.equal(attended.totalDkp, 3)
  })
})
