import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  accountColumnLabel,
  buildAccountColumnRows,
  buildCharacterRows,
  characterMatchesQuery,
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
