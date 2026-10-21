import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseChannelList,
  parseRaidString,
  parseLootLogByMatch,
  generateEventId,
  resolveTicNames,
  indexCharactersByName,
  classifyTicAttendance,
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

  it('reads one name per line', () => {
    const { eventTime, names } = parseChannelList('Name1\nName2\nName3\nName4')
    assert.equal(eventTime, '')
    assert.deepEqual(names, ['Name1', 'Name2', 'Name3', 'Name4'])
  })

  it('reads a comma-separated list', () => {
    const { names } = parseChannelList('Name1, Name2, Name3, Name4')
    assert.deepEqual(names, ['Name1', 'Name2', 'Name3', 'Name4'])
  })

  it('reads a channel log and plain names together', () => {
    const paste = `${NAGDDRU_PASTE.trim()}\nExtraOne\nExtraTwo, ExtraThree`
    const { eventTime, names } = parseChannelList(paste)
    assert.equal(eventTime, 'Fri Oct 09 09:08:00 2026')
    assert.deepEqual(names, [...NAMES, 'ExtraOne', 'ExtraTwo', 'ExtraThree'])
  })

  it('skips a members header that has no timestamp', () => {
    const { names } = parseChannelList('Channel Nag(30) members:\nMeldrath, Fridge')
    assert.deepEqual(names, ['Meldrath', 'Fridge'])
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

  it('does not add a shorter name that sits inside the pasted character', () => {
    const line = "[Wed Oct 14 15:52:32 2026] Inacht says out of character, 'Belt of Temporal Bindings congrats DEEPMIND 5 dkp'"
    const [row] = parseLootLogByMatch(
      line,
      ['Mind', 'Deepmind', 'Inacht'],
      ['Belt of Temporal Bindings', 'Mind'],
    )
    assert.equal(row.itemName, 'Belt of Temporal Bindings')
    assert.deepEqual(row.characterNames, ['Deepmind'])
    assert.equal(row.cost, 5)
    assert.equal(row.hasDkp, true)
  })

  it('does not turn the pasted name into a shorter item', () => {
    const [row] = parseLootLogByMatch(
      "[Wed Oct 14 15:52:32 2026] Inacht says out of character, 'congrats DEEPMIND 5 dkp'",
      ['Deepmind', 'Mind'],
      ['Mind'],
    )
    assert.equal(row.itemName, '')
    assert.deepEqual(row.characterNames, ['Deepmind'])
  })

  it('credits bobby and bobbyson only when each full name is in the paste', () => {
    const [bobbyson] = parseLootLogByMatch(
      "[Wed Oct 14 15:52:32 2026] Inacht says out of character, 'Some Item congrats Bobbyson 3 dkp'",
      ['Bobby', 'Bobbyson'],
      ['Some Item'],
    )
    assert.deepEqual(bobbyson.characterNames, ['Bobbyson'])

    const [bobby] = parseLootLogByMatch(
      "[Wed Oct 14 15:52:32 2026] Inacht says out of character, 'Some Item congrats Bobby 3 dkp'",
      ['Bobby', 'Bobbyson'],
      ['Some Item'],
    )
    assert.deepEqual(bobby.characterNames, ['Bobby'])

    const [both] = parseLootLogByMatch(
      "[Wed Oct 14 15:52:32 2026] Inacht says out of character, 'Some Item congrats Bobby and Bobbyson 3 dkp'",
      ['Bobby', 'Bobbyson'],
      ['Some Item'],
    )
    assert.deepEqual(both.characterNames, ['Bobby', 'Bobbyson'])
    assert.deepEqual(both.awards.map((award) => [award.characterName, award.cost]), [
      ['Bobby', 3],
      ['Bobbyson', 3],
    ])
    assert.equal(both.awards.every((award) => award.hasDkp), true)
  })

  it('pairs names and prices in the order they are written', () => {
    const cases = [
      {
        line: "[Wed Oct 14 15:25:28 2026] Suppin says out of character, 'Bracer of Precision grats Kaerilai 6 dkp and grats Feels 5dkp'",
        characters: ['Kaerilai', 'Feels', 'Suppin'],
        items: ['Bracer of Precision'],
        awards: [['Kaerilai', 6], ['Feels', 5]],
        itemName: 'Bracer of Precision',
      },
      {
        line: "[Wed Oct 14 13:44:38 2026] Crushzilla tells Nagd:2, 'Tiny Jade Ring gratz to serro for 5dkp , muess 4dkp . '",
        characters: ['Serro', 'Muess', 'Crushzilla'],
        items: ['Tiny Jade Ring', 'Jade Ring'],
        awards: [['Serro', 5], ['Muess', 4]],
        itemName: 'Tiny Jade Ring',
      },
      {
        line: "[Wed Sep 30 15:52:46 2026] Crushzilla says out of character, 'Boots of Despair gratz to piama for 21dkp . necrophobia for 20dkp . '",
        characters: ['Piama', 'Necrophobia'],
        items: ['Boots of Despair'],
        awards: [['Piama', 21], ['Necrophobia', 20]],
        itemName: 'Boots of Despair',
      },
      {
        line: "[Fri Aug 14 14:17:19 2026] Voracious says out of character, 'grats Bhodi Yttrium Studded Mantle 2dkp, grats Oopp 0dkp'",
        characters: ['Bhodi', 'Oopp', 'Voracious'],
        items: ['Yttrium Studded Mantle', 'Mantle'],
        awards: [['Bhodi', 2], ['Oopp', 0]],
        itemName: 'Yttrium Studded Mantle',
      },
    ]
    for (const sample of cases) {
      const [row] = parseLootLogByMatch(sample.line, sample.characters, sample.items)
      assert.equal(row.itemName, sample.itemName, sample.line)
      assert.equal(row.hasDkp, true, sample.line)
      assert.deepEqual(
        row.awards.map((award) => [award.characterName, award.cost, award.hasDkp]),
        sample.awards.map(([name, cost]) => [name, cost, true]),
        sample.line,
      )
    }
  })

  it('pairs by written order when the second name sits nearer the first price', () => {
    const [row] = parseLootLogByMatch(
      "[Fri Aug 14 14:17:19 2026] Voracious says out of character, 'grats Bhodi Yttrium Studded Mantle 2dkp Oopp later on 0dkp'",
      ['Oopp', 'Bhodi'],
      ['Yttrium Studded Mantle'],
    )
    assert.equal(row.itemName, 'Yttrium Studded Mantle')
    assert.deepEqual(row.awards.map((award) => [award.characterName, award.cost]), [
      ['Bhodi', 2],
      ['Oopp', 0],
    ])
  })

  it('keeps a price that is written before the name with that name', () => {
    const [single] = parseLootLogByMatch(
      "[Mon Feb 09 21:35:20 2026] Icbm says out of character, 'Earring of Eradication 4 DKP grats Ezram'",
      ['Ezram'],
      ['Earring of Eradication'],
    )
    assert.equal(single.awards[0].cost, 4)

    const [pair] = parseLootLogByMatch(
      "[Mon Feb 09 21:35:20 2026] Icbm says out of character, 'Earring of Eradication 6 DKP grats Ezram and 5 DKP grats Feels'",
      ['Ezram', 'Feels'],
      ['Earring of Eradication'],
    )
    const byName = Object.fromEntries(pair.awards.map((award) => [award.characterName.toLowerCase(), award.cost]))
    assert.equal(byName.ezram, 6)
    assert.equal(byName.feels, 5)
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

describe('classifyTicAttendance', () => {
  const characters = [
    { char_id: 'c-ezram', name: 'Ezram' },
    { char_id: 'c-hunted', name: 'Hunted' },
    { char_id: 'c-althunted', name: 'AltHunted' },
    { char_id: 'c-cherish', name: 'Cherish' },
    { char_id: 'c-bob-a', name: 'Bob' },
    { char_id: 'c-bob-b', name: 'Bob' },
  ]
  const nameToChars = indexCharactersByName(characters)
  const charIdToAccountId = {
    'c-ezram': 'acc-ezram',
    'c-hunted': 'acc-hunted',
    'c-althunted': 'acc-hunted',
    'c-cherish': 'acc-cherish',
    'c-bob-a': 'acc-bob-a',
    'c-bob-b': 'acc-bob-b',
  }
  const lookup = { nameToChars, charIdToAccountId }

  it('matches resolveTicNames for a new tic when every name is unique', () => {
    const names = ['Hunted', 'hunted', 'AltHunted', 'Missing']
    const nameToChar = {
      hunted: { char_id: 'c-hunted', name: 'Hunted' },
      althunted: { char_id: 'c-althunted', name: 'AltHunted' },
    }
    const resolved = resolveTicNames(names, { nameToChar, charIdToAccountId })
    const classified = classifyTicAttendance(names, lookup)
    assert.deepEqual(classified.toAdd, resolved.matched)
    assert.deepEqual(classified.duplicates, resolved.duplicates)
    assert.deepEqual(classified.sameAccount.map((row) => row.pasteName), resolved.sameAccount)
    assert.deepEqual(classified.unmatched, resolved.unmatched)
    assert.deepEqual(classified.alreadyPresent, [])
    assert.deepEqual(classified.ambiguous, [])
  })

  it('puts every matched name on a new tic and leaves already-present empty', () => {
    const result = classifyTicAttendance(['Ezram', 'Cherish'], lookup)
    assert.deepEqual(result.toAdd, [
      { char_id: 'c-ezram', character_name: 'Ezram' },
      { char_id: 'c-cherish', character_name: 'Cherish' },
    ])
    assert.deepEqual(result.alreadyPresent, [])
    assert.equal(result.resolved.every((row) => row.selected), true)
  })

  it('keeps people already on the tic out of the insert set', () => {
    const result = classifyTicAttendance(['Ezram', 'Cherish'], {
      ...lookup,
      existingAttendees: [{ char_id: 'c-ezram', character_name: 'Ezram' }],
    })
    assert.deepEqual(result.toAdd, [{ char_id: 'c-cherish', character_name: 'Cherish' }])
    assert.deepEqual(result.alreadyPresent, [
      { pasteName: 'Ezram', char_id: 'c-ezram', character_name: 'Ezram' },
    ])
  })

  it('lists a repeated paste name once and skips the other toon on that account', () => {
    const result = classifyTicAttendance(['Hunted', 'hunted', 'AltHunted'], lookup)
    assert.deepEqual(result.toAdd, [{ char_id: 'c-hunted', character_name: 'Hunted' }])
    assert.deepEqual(result.duplicates, ['hunted'])
    assert.deepEqual(result.sameAccount.map((row) => row.character_name), ['AltHunted'])
  })

  it('skips another toon when that account is already on the tic', () => {
    const result = classifyTicAttendance(['AltHunted'], {
      ...lookup,
      existingAttendees: [{ char_id: 'c-hunted' }],
    })
    assert.deepEqual(result.toAdd, [])
    assert.equal(result.sameAccount[0].char_id, 'c-althunted')
    assert.deepEqual(result.alreadyPresent, [])
  })

  it('holds an ambiguous name until a character is chosen', () => {
    const waiting = classifyTicAttendance(['Bob', 'Cherish'], lookup)
    assert.equal(waiting.ambiguous.length, 1)
    assert.equal(waiting.ambiguous[0].pasteName, 'Bob')
    assert.deepEqual(waiting.ambiguous[0].candidates.map((c) => c.char_id), ['c-bob-a', 'c-bob-b'])
    assert.deepEqual(waiting.toAdd, [{ char_id: 'c-cherish', character_name: 'Cherish' }])

    const picked = classifyTicAttendance(['Bob'], {
      ...lookup,
      resolutions: { bob: 'c-bob-b' },
    })
    assert.deepEqual(picked.ambiguous, [])
    assert.deepEqual(picked.toAdd, [{ char_id: 'c-bob-b', character_name: 'Bob' }])
  })

  it('lists invalid names and does not credit them', () => {
    const result = classifyTicAttendance(['NotAPlayer', 'Cherish'], lookup)
    assert.deepEqual(result.unmatched, ['NotAPlayer'])
    assert.deepEqual(result.toAdd, [{ char_id: 'c-cherish', character_name: 'Cherish' }])
  })

  it('sends only the valid selected subset when the paste is mixed', () => {
    const result = classifyTicAttendance(
      ['Ezram', 'Hunted', 'hunted', 'AltHunted', 'Bob', 'NotAPlayer', 'Cherish'],
      {
        ...lookup,
        existingAttendees: [{ char_id: 'c-ezram' }],
        excludedCharIds: ['c-cherish'],
      },
    )
    assert.deepEqual(result.toAdd, [{ char_id: 'c-hunted', character_name: 'Hunted' }])
    assert.equal(result.alreadyPresent[0].char_id, 'c-ezram')
    assert.deepEqual(result.duplicates, ['hunted'])
    assert.equal(result.sameAccount[0].char_id, 'c-althunted')
    assert.equal(result.ambiguous[0].pasteName, 'Bob')
    assert.deepEqual(result.unmatched, ['NotAPlayer'])
    assert.equal(result.resolved.find((row) => row.char_id === 'c-cherish').selected, false)
  })

  it('credits characters picked from the member list, including one of two with the same name', () => {
    const result = classifyTicAttendance([], {
      ...lookup,
      explicitChars: [
        { char_id: 'c-ezram', name: 'Ezram' },
        { char_id: 'c-bob-a', name: 'Bob' },
      ],
    })
    assert.deepEqual(result.toAdd, [
      { char_id: 'c-ezram', character_name: 'Ezram' },
      { char_id: 'c-bob-a', character_name: 'Bob' },
    ])
    assert.deepEqual(result.ambiguous, [])
  })

  it('does not credit a picked character twice when the paste already has them', () => {
    const result = classifyTicAttendance(['Ezram'], {
      ...lookup,
      explicitChars: [{ char_id: 'c-ezram', name: 'Ezram' }],
    })
    assert.deepEqual(result.toAdd, [{ char_id: 'c-ezram', character_name: 'Ezram' }])
    assert.deepEqual(result.duplicates, ['Ezram'])
  })

  it('skips a picked toon when that account is already credited', () => {
    const result = classifyTicAttendance(['Hunted'], {
      ...lookup,
      explicitChars: [{ char_id: 'c-althunted', name: 'AltHunted' }],
    })
    assert.deepEqual(result.toAdd, [{ char_id: 'c-hunted', character_name: 'Hunted' }])
    assert.equal(result.sameAccount[0].char_id, 'c-althunted')
  })

  it('credits only new names at the existing tic value and adds nothing on a rerun', () => {
    const ticValue = 2
    const existing = [{ char_id: 'c-ezram', character_name: 'Ezram' }]
    const first = classifyTicAttendance(['Ezram', 'Hunted'], { ...lookup, existingAttendees: existing })
    const alreadyEarned = raidDkpDelta({ creditedCount: existing.length, ticValue }).earned
    const appendEarned = raidDkpDelta({ creditedCount: first.toAdd.length, ticValue }).earned
    assert.equal(alreadyEarned, 2)
    assert.equal(appendEarned, 2)
    assert.equal(alreadyEarned + appendEarned, raidDkpDelta({
      creditedCount: existing.length + first.toAdd.length,
      ticValue,
    }).earned)

    const second = classifyTicAttendance(['Ezram', 'Hunted'], {
      ...lookup,
      existingAttendees: [...existing, ...first.toAdd],
    })
    assert.deepEqual(second.toAdd, [])
    assert.equal(second.alreadyPresent.length, 2)
    assert.equal(raidDkpDelta({ creditedCount: second.toAdd.length, ticValue }).earned, 0)
    assert.equal(alreadyEarned + appendEarned, raidDkpDelta({
      creditedCount: existing.length + first.toAdd.length + second.toAdd.length,
      ticValue,
    }).earned)
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
