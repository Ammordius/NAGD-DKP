import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  accountColumnLabel,
  buildAccountAdminRows,
  buildAccountColumnRows,
  buildCharacterRows,
  characterMatchesQuery,
  filterAccountAdminRows,
  resolveAdminCharacter,
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
