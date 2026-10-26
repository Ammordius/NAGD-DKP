import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  distinctTicsByRaid,
  raidMissingTics,
  raidTicAttendance,
  ticFractionsByRaid,
  visibleMissingTicRows,
} from './raidTicIdentity.js'

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

  it('trims event ids so attendance still matches the tic', () => {
    const tics = distinctTicsByRaid([
      { id: 1, raid_id: ' r1 ', event_id: ' e1 ', event_order: 1, event_name: 'DKP tic', dkp_value: '1' },
    ]).get('r1')
    const attended = raidTicAttendance(tics, new Set(['e1']))
    assert.equal(attended.ticEarned, 1)
    assert.equal(attended.ticTotal, 1)
  })
})

describe('missed attendance tics', () => {
  const events = []
  const attendance = []
  for (let raid = 1; raid <= 3; raid += 1) {
    for (let tic = 1; tic <= 4; tic += 1) {
      const eventId = `r${raid}-e${tic}`
      events.push({
        id: raid * 10 + tic,
        raid_id: `r${raid}`,
        event_id: eventId,
        event_order: tic,
        event_name: tic === 1 ? 'On-time' : 'DKP tic',
        dkp_value: '1',
      })
      attendance.push({ raid_id: `r${raid}`, event_id: eventId, char_id: 'c1' })
    }
  }
  attendance.pop()

  const rows = [...ticFractionsByRaid(events, attendance).entries()].map(([raidId, fraction]) => ({
    raid_id: raidId,
    ...raidMissingTics({
      ticEarned: fraction.ticEarned,
      ticTotal: fraction.ticTotal,
      dkpEarned: fraction.ticEarned,
      dkpRaidTotal: fraction.totalDkp,
    }),
  }))

  it('keeps a full attendee off the missing-tic list', () => {
    const present = rows.filter((row) => row.raid_id === 'r1' || row.raid_id === 'r2')
    assert.equal(present.length, 2)
    for (const row of present) {
      assert.equal(row.ticEarned, row.ticTotal)
      assert.equal(row.isMissingTics, false)
    }
    const onlyMissing = visibleMissingTicRows(rows, { showMissingDetails: true, onlyMissingRaids: true })
    assert.deepEqual(onlyMissing.map((row) => row.raid_id), ['r3'])
    assert.equal(onlyMissing[0].missingCount, 1)
    assert.equal(onlyMissing[0].ticEarned, 3)
    assert.equal(onlyMissing[0].ticTotal, 4)
  })

  it('shows every tic as missed only when the account was not present', () => {
    const absent = raidMissingTics({ ticEarned: 0, ticTotal: 4, dkpEarned: 0, dkpRaidTotal: 4 })
    assert.equal(absent.isMissingTics, true)
    assert.equal(absent.missingCount, 4)
    assert.equal(absent.ticEarned, 0)
  })

  it('does not call a fully paid raid a total absence when tic rows did not match', () => {
    const paid = raidMissingTics({ ticEarned: 0, ticTotal: 4, dkpEarned: 4, dkpRaidTotal: 4 })
    assert.equal(paid.isMissingTics, false)
    assert.equal(paid.ticEarned, 4)
    assert.equal(paid.missingCount, 0)
  })

  it('still lists a partial miss when details are hidden until the filter is on', () => {
    const partial = rows.find((row) => row.raid_id === 'r3')
    assert.deepEqual(
      visibleMissingTicRows([partial], { showMissingDetails: false, onlyMissingRaids: false }).map((row) => row.raid_id),
      ['r3'],
    )
    const absent = {
      raid_id: 'absent',
      ...raidMissingTics({ ticEarned: 0, ticTotal: 2, dkpEarned: 0, dkpRaidTotal: 2 }),
    }
    assert.equal(
      visibleMissingTicRows([absent], { showMissingDetails: false, onlyMissingRaids: false }).length,
      0,
    )
    assert.deepEqual(
      visibleMissingTicRows([absent], { showMissingDetails: true, onlyMissingRaids: true }).map((row) => row.raid_id),
      ['absent'],
    )
  })
})
