import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseChannelList,
  generateEventId,
  resolveTicNames,
  raidDkpDelta,
  accountDkpAfterRaidChange,
  accountDkpAfterRaidDelete,
  accountDkpMatches,
} from './officerRaidParse.js'

const NAGDDRU_PASTE = `
[Fri Oct 09 09:08:00 2026] Channel Nagddru(9) members:
[Fri Oct 09 09:08:00 2026] Ezram, Hunted, Mcbeasty, Wizzie, Foodanddrink, Traidor

[Fri Oct 09 09:08:00 2026] Bhodistrader, Cherish, Ramessesll
`

const NAMES = [
  'Ezram',
  'Hunted',
  'Mcbeasty',
  'Wizzie',
  'Foodanddrink',
  'Traidor',
  'Bhodistrader',
  'Cherish',
  'Ramessesll',
]

describe('parseChannelList', () => {
  it('reads the Nagddru channel paste', () => {
    const { eventTime, names } = parseChannelList(NAGDDRU_PASTE)
    assert.equal(eventTime, 'Fri Oct 09 09:08:00 2026')
    assert.deepEqual(names, NAMES)
  })

  it('skips a members header and blank lines', () => {
    const { names } = parseChannelList('[Fri Oct 09 09:08:00 2026] Channel Nagddru(9) members:\n\n')
    assert.deepEqual(names, [])
  })
})

describe('generateEventId', () => {
  it('uses the channel timestamp', () => {
    const id = generateEventId('Fri Oct 09 09:08:00 2026')
    assert.match(id, /^tic-\d+$/)
    assert.notEqual(id, 'tic-NaN')
  })
})

describe('resolveTicNames', () => {
  const nameToChar = {
    ezram: { char_id: 'c-ezram', name: 'Ezram' },
    hunted: { char_id: 'c-hunted', name: 'Hunted' },
    althunted: { char_id: 'c-althunted', name: 'AltHunted' },
  }
  const charIdToAccountId = {
    'c-ezram': 'acc-ezram',
    'c-hunted': 'acc-hunted',
    'c-althunted': 'acc-hunted',
  }

  it('matches names case-insensitively', () => {
    const result = resolveTicNames(['ezram', 'HUNTED'], { nameToChar, charIdToAccountId })
    assert.deepEqual(result.matched, [
      { char_id: 'c-ezram', character_name: 'Ezram' },
      { char_id: 'c-hunted', character_name: 'Hunted' },
    ])
    assert.equal(result.noTic, false)
  })

  it('lists unknown names and does not create a tic when nothing matches', () => {
    const result = resolveTicNames(['NotAPlayer'], { nameToChar, charIdToAccountId })
    assert.deepEqual(result.unmatched, ['NotAPlayer'])
    assert.deepEqual(result.matched, [])
    assert.equal(result.noTic, true)
  })

  it('skips a second toon on the same account and a duplicate name', () => {
    const result = resolveTicNames(['Hunted', 'hunted', 'AltHunted', 'Missing'], { nameToChar, charIdToAccountId })
    assert.deepEqual(result.matched, [{ char_id: 'c-hunted', character_name: 'Hunted' }])
    assert.deepEqual(result.duplicates, ['hunted'])
    assert.deepEqual(result.sameAccount, ['AltHunted'])
    assert.deepEqual(result.unmatched, ['Missing'])
    assert.equal(result.noTic, false)
  })
})

describe('DKP snapshot', () => {
  it('credits tic value per matched attendee and adds loot cost', () => {
    const before = { earned: 40, spent: 5 }
    const delta = raidDkpDelta({ creditedCount: 9, ticValue: 1, lootCost: 2 })
    assert.deepEqual(delta, { earned: 9, spent: 2, net: 7 })
    const during = accountDkpAfterRaidChange(before, delta)
    assert.deepEqual(during, { earned: 49, spent: 7 })
    const restored = accountDkpAfterRaidDelete(during, delta)
    assert.equal(accountDkpMatches(restored, before), true)
  })
})
