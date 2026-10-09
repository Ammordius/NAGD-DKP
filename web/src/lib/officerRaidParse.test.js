import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseChannelList,
  parseRaidString,
  parseLootLogByMatch,
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

const NAGDDRU_1246_PASTE = `
[Fri Oct 09 12:46:52 2026] Channel Nagddru(8) members:
[Fri Oct 09 12:46:52 2026] Hugs, Ezram, Tuned, Freysa, Shortie, Traidor
[Fri Oct 09 12:46:52 2026] Cherish, Ramessesll
`

const NAGDDRU_1246_NAMES = [
  'Hugs',
  'Ezram',
  'Tuned',
  'Freysa',
  'Shortie',
  'Traidor',
  'Cherish',
  'Ramessesll',
]

describe('parseChannelList', () => {
  it('reads the Nagddru channel paste', () => {
    const { eventTime, names } = parseChannelList(NAGDDRU_PASTE)
    assert.equal(eventTime, 'Fri Oct 09 09:08:00 2026')
    assert.deepEqual(names, NAMES)
  })

  it('reads the 12:46 Nagddru paste and skips the members header', () => {
    const { eventTime, names } = parseChannelList(NAGDDRU_1246_PASTE)
    assert.equal(eventTime, 'Fri Oct 09 12:46:52 2026')
    assert.deepEqual(names, NAGDDRU_1246_NAMES)
    assert.equal(names.includes('Channel Nagddru(8) members:'), false)
  })

  it('keeps a repeated name so the caller can list it as a duplicate', () => {
    const paste = `${NAGDDRU_1246_PASTE.trim()}
[Fri Oct 09 12:46:52 2026] Ezram, ezram`
    const { names } = parseChannelList(paste)
    assert.deepEqual(names.slice(-2), ['Ezram', 'ezram'])
    assert.equal(names.filter((n) => n.toLowerCase() === 'ezram').length, 3)
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

  it('uses the 12:46 channel timestamp', () => {
    const id = generateEventId('Fri Oct 09 12:46:52 2026')
    const expected = new Date('Fri Oct 09 12:46:52 2026').getTime()
    assert.equal(id, `tic-${expected}`)
    assert.notEqual(id, 'tic-NaN')
  })
})

describe('parseRaidString', () => {
  it('reads the throwaway officer test raid line', () => {
    const line = 'Friday 10/09 12:46pm est: UI tic test - October 9, 2026 12:46 PM'
    const { raidName, dateIso } = parseRaidString(line)
    assert.equal(raidName, 'UI tic test')
    const expected = new Date('October 9, 2026 12:46 PM').toISOString().slice(0, 19).replace('T', ' ')
    assert.equal(dateIso, expected)
  })
})

describe('parseLootLogByMatch', () => {
  it('matches a character, a known item, and the DKP amount', () => {
    const line = "[Mon Feb 09 21:35:20 2026] Icbm says out of character, 'Earring of Eradication grats Ezram, 4 DKP!!!'"
    const [row] = parseLootLogByMatch(
      line,
      ['Ezram', 'Icbm'],
      ['Earring of Eradication', 'Earring'],
    )
    assert.equal(row.itemName, 'Earring of Eradication')
    assert.deepEqual(row.characterNames, ['Ezram'])
    assert.equal(row.cost, 4)
    assert.equal(row.hasDkp, true)
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

  it('credits the 12:46 paste once per account and lists repeats', () => {
    const chars = {
      hugs: { char_id: 'c-hugs', name: 'Hugs' },
      ezram: { char_id: 'c-ezram', name: 'Ezram' },
      tuned: { char_id: 'c-tuned', name: 'Tuned' },
      freysa: { char_id: 'c-freysa', name: 'Freysa' },
      shortie: { char_id: 'c-shortie', name: 'Shortie' },
      traidor: { char_id: 'c-traidor', name: 'Traidor' },
      cherish: { char_id: 'c-cherish', name: 'Cherish' },
      ramessesll: { char_id: 'c-ramessesll', name: 'Ramessesll' },
      altezram: { char_id: 'c-altezram', name: 'AltEzram' },
    }
    const accounts = {
      'c-hugs': 'acc-hugs',
      'c-ezram': 'acc-ezram',
      'c-tuned': 'acc-tuned',
      'c-freysa': 'acc-freysa',
      'c-shortie': 'acc-shortie',
      'c-traidor': 'acc-traidor',
      'c-cherish': 'acc-cherish',
      'c-ramessesll': 'acc-ram',
      'c-altezram': 'acc-ezram',
    }
    const { names } = parseChannelList(`${NAGDDRU_1246_PASTE.trim()}
[Fri Oct 09 12:46:52 2026] Ezram, ezram, AltEzram, NotARealPlayerXYZ`)
    const result = resolveTicNames(names, { nameToChar: chars, charIdToAccountId: accounts })
    assert.deepEqual(result.matched.map((m) => m.character_name), NAGDDRU_1246_NAMES)
    assert.deepEqual(result.duplicates, ['Ezram', 'ezram'])
    assert.deepEqual(result.sameAccount, ['AltEzram'])
    assert.deepEqual(result.unmatched, ['NotARealPlayerXYZ'])
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

  it('tracks earned and spent through each officer step and restores the baseline', () => {
    const baseline = { earned: 100, spent: 20 }
    const tic = raidDkpDelta({ creditedCount: 8, ticValue: 1, lootCost: 0 })
    let snap = accountDkpAfterRaidChange(baseline, tic)
    assert.deepEqual(snap, { earned: 108, spent: 20 })

    const extra = raidDkpDelta({ creditedCount: 1, ticValue: 1, lootCost: 0 })
    snap = accountDkpAfterRaidChange(snap, extra)
    assert.deepEqual(snap, { earned: 109, spent: 20 })

    const loot = raidDkpDelta({ creditedCount: 0, ticValue: 1, lootCost: 1 })
    snap = accountDkpAfterRaidChange(snap, loot)
    assert.deepEqual(snap, { earned: 109, spent: 21 })

    const costEdit = raidDkpDelta({ creditedCount: 0, ticValue: 0, lootCost: 1 })
    snap = accountDkpAfterRaidChange(snap, costEdit)
    assert.deepEqual(snap, { earned: 109, spent: 22 })

    snap = accountDkpAfterRaidDelete(snap, raidDkpDelta({ creditedCount: 0, ticValue: 0, lootCost: 2 }))
    assert.deepEqual(snap, { earned: 109, spent: 20 })

    snap = accountDkpAfterRaidDelete(snap, extra)
    assert.deepEqual(snap, { earned: 108, spent: 20 })

    snap = accountDkpAfterRaidDelete(snap, tic)
    assert.equal(accountDkpMatches(snap, baseline), true)
  })
})
