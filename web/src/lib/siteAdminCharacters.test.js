import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  accountColumnLabel,
  accountRaidDates,
  buildAccountAdminRows,
  buildAccountColumnRows,
  buildCharacterRows,
  characterMatchesQuery,
  claimAccountChoices,
  classifiedAccountIdSet,
  filterAccountAdminRows,
  normalizeSiteAdminSort,
  omitClassifiedPickerRows,
  resolveAdminCharacter,
  resolveClaimSubmitAccountId,
  sortClaimAccounts,
  sortSiteAdminRows,
  withAccountLastRaidDates,
  withPickerLastRaidDates,
} from './siteAdminCharacters.js'

const accounts = [
  { account_id: 'a1', display_name: 'Ezram', toon_names: 'Ezram, Altman', inactive: false },
  { account_id: 'a2', display_name: '', toon_names: 'Solo', inactive: true },
  { account_id: 'a3', display_name: 'Mira', toon_names: 'Mira', inactive: true },
]

const characters = [
  { char_id: '1', name: 'Altman' },
  { char_id: '2', name: 'Ezram' },
  { char_id: '3', name: 'Unlinked' },
  { char_id: '4', name: 'Altman' },
  { char_id: '', name: 'Skip' },
  { char_id: '5', name: '  ' },
]

const characterAccount = [
  { char_id: '1', account_id: 'a1' },
  { char_id: '2', account_id: 'a1' },
  { char_id: '4', account_id: 'a3' },
]

describe('buildCharacterRows', () => {
  const rows = buildCharacterRows(characters, characterAccount, accounts)

  it('labels a character with the account display name', () => {
    const altman = rows.find((row) => row.char_id === '1')
    assert.equal(altman.label, 'Altman (Ezram)')
    assert.equal(altman.account_id, 'a1')
    const main = rows.find((row) => row.char_id === '2')
    assert.equal(main.label, 'Ezram (Ezram)')
  })

  it('shows an unlinked character as the name only', () => {
    const row = rows.find((row) => row.char_id === '3')
    assert.equal(row.label, 'Unlinked')
    assert.equal(row.account_id, null)
  })

  it('appends char_id when two characters share a label', () => {
    const rowsDup = buildCharacterRows(
      [
        { char_id: '10', name: 'Same' },
        { char_id: '11', name: 'Same' },
      ],
      [
        { char_id: '10', account_id: 'a1' },
        { char_id: '11', account_id: 'a1' },
      ],
      accounts,
    )
    assert.deepEqual(rowsDup.map((row) => row.label), ['Same (Ezram) (10)', 'Same (Ezram) (11)'])
  })

  it('falls back to account_id when display_name is empty', () => {
    const rowsFallback = buildCharacterRows(
      [{ char_id: '9', name: 'Solo' }],
      [{ char_id: '9', account_id: 'a2' }],
      accounts,
    )
    assert.equal(rowsFallback[0].label, 'Solo (a2)')
  })

  it('drops characters with no id or name', () => {
    assert.equal(rows.some((row) => row.name === 'Skip'), false)
    assert.equal(rows.length, 4)
  })
})

describe('characterMatchesQuery', () => {
  const row = { char_id: '1', name: 'Altman', label: 'Altman (Ezram)' }

  it('matches character name, main name, and char_id', () => {
    assert.equal(characterMatchesQuery(row, ''), true)
    assert.equal(characterMatchesQuery(row, 'alt'), true)
    assert.equal(characterMatchesQuery(row, 'EZR'), true)
    assert.equal(characterMatchesQuery(row, '1'), true)
    assert.equal(characterMatchesQuery(row, 'nope'), false)
  })
})

describe('account columns', () => {
  it('prefers display name, then the first toon, then account id', () => {
    assert.equal(accountColumnLabel(accounts[0]), 'Ezram')
    assert.equal(accountColumnLabel(accounts[1]), 'Solo')
    assert.equal(accountColumnLabel({ account_id: 'a9' }), 'a9')
  })

  it('lists each account once, sorted by label', () => {
    const byId = new Map(accounts.map((account) => [account.account_id, account]))
    const rows = buildAccountColumnRows(['a3', 'a1', 'a1', '  '], byId)
    assert.deepEqual(rows.map((row) => row.label), ['Ezram', 'Mira'])
  })
})

describe('account admin rows', () => {
  const rows = buildAccountAdminRows(characters, characterAccount, accounts)

  it('lists one row per account and keeps an unlinked character', () => {
    const linked = rows.filter((row) => !row.unlinked)
    assert.deepEqual(linked.map((row) => row.account_id).sort(), ['a1', 'a2', 'a3'])
    const unlinked = rows.find((row) => row.char_id === '3')
    assert.equal(unlinked.unlinked, true)
    assert.equal(unlinked.account_id, null)
    assert.equal(unlinked.label, 'Unlinked (unlinked)')
  })

  it('collapses duplicate character records onto one account', () => {
    const collapsed = buildAccountAdminRows(
      [
        { char_id: '20', name: 'Same' },
        { char_id: '11', name: 'Same' },
      ],
      [
        { char_id: '20', account_id: 'a1' },
        { char_id: '11', account_id: 'a1' },
      ],
      accounts,
    )
    const matches = collapsed.filter((row) => row.account_id === 'a1')
    assert.equal(matches.length, 1)
    assert.equal(matches[0].characters.length, 2)
    assert.equal(matches[0].char_id, '11')
  })

  it('finds an account by alt name, display name, or account id', () => {
    const byAlt = filterAccountAdminRows(rows, 'Altman')
    assert.deepEqual(byAlt.map((row) => row.account_id).sort(), ['a1', 'a3'])
    assert.ok(byAlt.every((row) => row.characterName === 'Altman'))
    const ezram = byAlt.find((row) => row.account_id === 'a1')
    assert.match(ezram.label, /Ezram \(a1\) · Altman/)
    assert.equal(ezram.characters.length, 2)
    const byAccount = filterAccountAdminRows(rows, 'a3')
    assert.deepEqual(byAccount.map((row) => row.account_id), ['a3'])
    const byDisplay = filterAccountAdminRows(rows, 'Mira')
    assert.equal(byDisplay[0].account_id, 'a3')
    assert.equal(byDisplay[0].characterName, 'Altman')
  })
})

describe('resolveAdminCharacter', () => {
  const chars = [
    { char_id: '20', name: 'Same' },
    { char_id: '11', name: 'Alt' },
    { char_id: '4', name: 'Ezram' },
  ]

  it('uses the typed name, then the display name, then the lowest char id', () => {
    assert.equal(resolveAdminCharacter(chars, { display_name: 'Ezram' }, 'Alt').char_id, '11')
    assert.equal(resolveAdminCharacter(chars, { display_name: 'Ezram' }, '').char_id, '4')
    assert.equal(resolveAdminCharacter(
      [{ char_id: '20', name: 'Same' }, { char_id: '11', name: 'Same' }],
      { display_name: '' },
      'Same',
    ).char_id, '11')
    assert.equal(resolveAdminCharacter(
      [{ char_id: '20', name: 'Other' }, { char_id: '3', name: 'Zed' }],
      { display_name: 'Missing' },
      '',
    ).char_id, '3')
  })
})

describe('sortClaimAccounts', () => {
  it('sorts by display name and leaves unnamed accounts last', () => {
    const sorted = sortClaimAccounts([
      { account_id: '30', display_name: 'Sexy' },
      { account_id: '10', display_name: '' },
      { account_id: '20', display_name: 'bees' },
      { account_id: '40', display_name: 'Vegan' },
    ])
    assert.deepEqual(sorted.map((account) => account.account_id), ['20', '30', '40', '10'])
  })

  it('filters by typed display name and marks duplicate names', () => {
    const choices = claimAccountChoices([
      { account_id: '2', display_name: 'Sexy' },
      { account_id: '1', display_name: 'Bees' },
      { account_id: '3', display_name: 'sexy' },
    ], 'sex')
    assert.deepEqual(choices.map((row) => row.label), ['Sexy (2)', 'sexy (3)'])
    assert.deepEqual(claimAccountChoices([
      { account_id: '2', display_name: 'Sexy' },
      { account_id: '1', display_name: 'Bees' },
    ], '').map((row) => row.label), ['Bees', 'Sexy'])
  })

  it('claims the highlighted account after moving from A to B', () => {
    const choices = claimAccountChoices([
      { account_id: 'acct-a', display_name: 'Alpha' },
      { account_id: 'acct-b', display_name: 'Alpha Two' },
    ], 'Alpha')
    const indexA = choices.findIndex((row) => row.id === 'acct-a')
    const indexB = choices.findIndex((row) => row.id === 'acct-b')
    assert.equal(indexA, 0)
    assert.ok(indexB > indexA)
    const submitted = resolveClaimSubmitAccountId({
      claimAccountId: 'acct-a',
      claimQuery: 'Alpha',
      claimChoices: choices,
      claimActiveIndex: indexB,
    })
    assert.equal(submitted, 'acct-b')
    assert.equal(choices[indexB].label, 'Alpha Two')
  })
})

describe('site admin last raid', () => {
  const dkpSummary = [
    { character_key: '1', character_name: 'Altman', last_activity_date: '2024-01-02T00:00:00+00:00' },
    { character_key: '1', last_activity_date: '2023-05-01' },
    { character_key: 'Altman', last_activity_date: '2020-01-01' },
    { character_key: '3', last_activity_date: '2025-06-15' },
    { character_key: 'Ghost', last_activity_date: '2019-08-08' },
    { character_key: '', last_activity_date: '2025-01-01' },
  ]
  const accountSummary = [
    { account_id: 'a1', last_activity_date: '2024-11-01' },
    { account_id: 'a3', last_activity_date: null },
  ]

  it('omits active and inactive accounts and keeps an unlinked character', () => {
    const classified = classifiedAccountIdSet(
      [{ account_id: 'a1' }, { account_id: 'a1' }, { account_id: '  ' }],
      accounts,
    )
    assert.deepEqual([...classified].sort(), ['a1', 'a2', 'a3'])
    const rows = buildCharacterRows(characters, characterAccount, accounts)
    const picker = omitClassifiedPickerRows(rows, classified)
    assert.deepEqual(picker.map((row) => row.char_id), ['3'])
    const accountRows = buildAccountAdminRows(characters, characterAccount, accounts)
    const accountPicker = omitClassifiedPickerRows(accountRows, classified)
    assert.deepEqual(accountPicker.map((row) => row.char_id), ['3'])
    assert.equal(accountPicker[0].unlinked, true)

    const stillOpen = classifiedAccountIdSet(
      [{ account_id: 'a1' }],
      [{ account_id: 'a2', inactive: false }],
    )
    assert.deepEqual([...stillOpen], ['a1'])
  })

  it('uses the account date for every linked character, and the character date when unlinked', () => {
    const characterDated = withPickerLastRaidDates(
      buildCharacterRows(characters, characterAccount, accounts),
      dkpSummary,
      accountSummary,
      { characters, characterAccount },
    )
    assert.equal(characterDated.find((row) => row.char_id === '1').lastRaidDate, '2024-11-01')
    assert.equal(characterDated.find((row) => row.char_id === '2').lastRaidDate, '2024-11-01')
    assert.equal(characterDated.find((row) => row.char_id === '3').lastRaidDate, '2025-06-15')
    assert.equal(
      withPickerLastRaidDates(
        [{ char_id: '99', name: 'Ghost' }],
        dkpSummary,
        accountSummary,
      )[0].lastRaidDate,
      '2019-08-08',
    )

    const accountDated = withPickerLastRaidDates(
      buildAccountAdminRows(characters, characterAccount, accounts),
      dkpSummary,
      accountSummary,
    )
    assert.equal(accountDated.find((row) => row.account_id === 'a1').lastRaidDate, '2024-11-01')
    assert.equal(accountDated.find((row) => row.char_id === '3').lastRaidDate, '2025-06-15')

    const columns = withAccountLastRaidDates(
      buildAccountColumnRows(['a1', 'a3'], new Map(accounts.map((account) => [account.account_id, account]))),
      accountSummary,
    )
    assert.equal(columns.find((row) => row.account_id === 'a1').lastRaidDate, '2024-11-01')
    assert.equal(columns.find((row) => row.account_id === 'a3').lastRaidDate, '')
  })

  it('gives an alt the main character date when that is newer than the account summary', () => {
    const dates = accountRaidDates({
      accountSummary: [{ account_id: 'a1', last_activity_date: '2024-11-01' }],
      dkpSummary: [
        { character_key: '1', character_name: 'Altman', last_activity_date: '2024-01-02' },
        { character_key: 'Ezram', character_name: 'Ezram', last_activity_date: '2026-10-01' },
      ],
      characters,
      characterAccount,
    })
    assert.equal(dates.get('a1'), '2026-10-01')
    const rows = withPickerLastRaidDates(
      buildCharacterRows(characters, characterAccount, accounts),
      [
        { character_key: '1', character_name: 'Altman', last_activity_date: '2024-01-02' },
        { character_key: 'Ezram', character_name: 'Ezram', last_activity_date: '2026-10-01' },
      ],
      [{ account_id: 'a1', last_activity_date: '2024-11-01' }],
      { characters, characterAccount },
    )
    assert.equal(rows.find((row) => row.char_id === '1').lastRaidDate, '2026-10-01')
    assert.equal(rows.find((row) => row.char_id === '2').lastRaidDate, '2026-10-01')
  })

  it('sorts by name and treats a missing last raid as the oldest date', () => {
    const rows = [
      { label: 'Zed', lastRaidDate: '2024-01-01' },
      { label: 'Amy', lastRaidDate: '' },
      { label: 'Bea', lastRaidDate: '2025-02-02' },
      { label: 'Cara', lastRaidDate: '' },
    ]
    assert.deepEqual(sortSiteAdminRows(rows, { key: 'name', dir: 'asc' }).map((row) => row.label), ['Amy', 'Bea', 'Cara', 'Zed'])
    assert.deepEqual(sortSiteAdminRows(rows, { key: 'name', dir: 'desc' }).map((row) => row.label), ['Zed', 'Cara', 'Bea', 'Amy'])
    assert.deepEqual(sortSiteAdminRows(rows, { key: 'lastRaid', dir: 'asc' }).map((row) => row.label), ['Amy', 'Cara', 'Zed', 'Bea'])
    assert.deepEqual(sortSiteAdminRows(rows, { key: 'lastRaid', dir: 'desc' }).map((row) => row.label), ['Bea', 'Zed', 'Amy', 'Cara'])
    assert.deepEqual(
      sortSiteAdminRows(rows, null).map((row) => row.label),
      ['Amy', 'Bea', 'Cara', 'Zed'],
    )
    assert.deepEqual(normalizeSiteAdminSort({ key: 'nope', dir: 'desc' }), { key: 'name', dir: 'desc' })
    assert.deepEqual(normalizeSiteAdminSort(null), { key: 'name', dir: 'asc' })
    assert.deepEqual(normalizeSiteAdminSort({ key: 'lastRaid', dir: 'asc' }), { key: 'lastRaid', dir: 'asc' })
  })
})
