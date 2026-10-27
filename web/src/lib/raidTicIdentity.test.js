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

  it('names the missed tic by event order and event name', () => {
    const tics = distinctTicsByRaid(rows).get('r1')
    const attended = raidTicAttendance(tics, new Set(['e1']))
    assert.deepEqual(attended.missingTics, [{ eventOrder: 2, eventName: 'DKP tic' }])
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
      missingTics: fraction.missingTics,
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
    assert.deepEqual(onlyMissing[0].missingTics, [{ eventOrder: 4, eventName: 'DKP tic' }])
  })

  it('shows every tic as missed only when the account was not present', () => {
    const absent = raidMissingTics({ ticEarned: 0, ticTotal: 4, dkpEarned: 0, dkpRaidTotal: 4 })
    assert.equal(absent.isMissingTics, true)
    assert.equal(absent.missingCount, 4)
    assert.equal(absent.ticEarned, 0)
  })

  it('does not convert full DKP payment into verified full tic attendance', () => {
    const paid = raidMissingTics({
      ticEarned: 0,
      ticTotal: 4,
      dkpEarned: 4,
      dkpRaidTotal: 4,
      missingTics: [{ eventOrder: 1, eventName: 'On-time' }],
    })
    assert.equal(paid.isMissingTics, false)
    assert.equal(paid.ticEarned, 0)
    assert.equal(paid.observedTicEarned, 0)
    assert.equal(paid.attendanceSource, 'inferred-full-payment')
    assert.equal(paid.missingCount, 0)
    assert.deepEqual(paid.missingTics, [])
  })

  it('keeps observed attendance distinct from inferred full-payment credit', () => {
    const observed = raidMissingTics({
      ticEarned: 4,
      ticTotal: 4,
      dkpEarned: 4,
      dkpRaidTotal: 4,
    })
    assert.equal(observed.attendanceSource, 'observed')
    assert.equal(observed.ticEarned, 4)
    assert.equal(observed.isMissingTics, false)

    const partialNoEvents = raidMissingTics({
      ticEarned: 0,
      ticTotal: 4,
      dkpEarned: 2,
      dkpRaidTotal: 4,
      missingTics: [{ eventOrder: 1, eventName: 'On-time' }],
    })
    assert.equal(partialNoEvents.attendanceSource, 'observed')
    assert.equal(partialNoEvents.ticEarned, 0)
    assert.equal(partialNoEvents.isMissingTics, true)
    assert.equal(partialNoEvents.missingCount, 4)
  })

  it('keeps loot-only raids in normal history', () => {
    const lootOnly = {
      raid_id: 'loot-only',
      items: [{ item_name: 'Sword', cost: 10 }],
      ...raidMissingTics({ ticEarned: 0, ticTotal: 0, dkpEarned: 0, dkpRaidTotal: 0 }),
    }
    const visible = visibleMissingTicRows([lootOnly], {
      showMissingDetails: false,
      onlyMissingRaids: false,
    })
    assert.deepEqual(visible.map((row) => row.raid_id), ['loot-only'])
    const onlyMissing = visibleMissingTicRows([lootOnly], {
      showMissingDetails: true,
      onlyMissingRaids: true,
    })
    assert.equal(onlyMissing.length, 0)
  })

  it('only-missing lists partial tic gaps and not every raid the account never attended', () => {
    const partial = rows.find((row) => row.raid_id === 'r3')
    const absent = {
      raid_id: 'absent',
      ...raidMissingTics({ ticEarned: 0, ticTotal: 4, dkpEarned: 0, dkpRaidTotal: 4 }),
    }
    const present = rows.find((row) => row.raid_id === 'r1')
    assert.equal(absent.isMissingTics, true)
    assert.equal(
      visibleMissingTicRows([absent], { showMissingDetails: false, onlyMissingRaids: false }).length,
      0,
    )
    const onlyMissing = visibleMissingTicRows(
      [present, partial, absent],
      { showMissingDetails: true, onlyMissingRaids: true },
    )
    assert.deepEqual(onlyMissing.map((row) => row.raid_id), ['r3'])
    assert.equal(onlyMissing[0].missingCount, 1)
    assert.equal(onlyMissing[0].ticEarned, 3)
  })
})
