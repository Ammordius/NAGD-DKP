import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { duplicateAccountNameResult, toonNamesInclude } from './accountNameTaken.js'

const accounts = [
  { display_name: 'Ezram', toon_names: 'Ezram, Altman' },
  { display_name: 'Other', toon_names: 'Bobby, Cherish' },
]

const characters = [
  { name: 'Hunted' },
  { name: '  Wizzie  ' },
]

describe('toonNamesInclude', () => {
  it('matches a whole token, ignoring case and spaces', () => {
    assert.equal(toonNamesInclude('Ezram, Altman', 'altman'), true)
    assert.equal(toonNamesInclude(' Bobby , Cherish ', 'bobby'), true)
  })

  it('does not match a name that is only part of another token', () => {
    assert.equal(toonNamesInclude('Bobby, Cherish', 'Bob'), false)
    assert.equal(toonNamesInclude('Ezram, Altman', 'Ez'), false)
  })
})

describe('duplicateAccountNameResult', () => {
  it('rejects a blank name', () => {
    assert.deepEqual(duplicateAccountNameResult('   '), {
      taken: true,
      message: 'Enter a display name.',
    })
  })

  it('matches an account display name case-insensitively', () => {
    const result = duplicateAccountNameResult(' ezram ', { accounts, characters })
    assert.equal(result.taken, true)
    assert.match(result.message, /An account named ezram already exists/)
    assert.match(result.message, /A character named ezram already exists/)
  })

  it('matches a character name that is not an account display name', () => {
    const result = duplicateAccountNameResult('HUNTED', { accounts, characters })
    assert.deepEqual(result, {
      taken: true,
      message: 'A character named HUNTED already exists.',
    })
  })

  it('matches a character name stored with surrounding spaces', () => {
    const result = duplicateAccountNameResult('wizzie', { accounts, characters })
    assert.equal(result.taken, true)
    assert.match(result.message, /A character named wizzie already exists/)
    assert.doesNotMatch(result.message, /An account named/)
  })

  it('matches a toon list token that is not the account display name', () => {
    const result = duplicateAccountNameResult('Cherish', { accounts, characters })
    assert.deepEqual(result, {
      taken: true,
      message: 'A character named Cherish already exists.',
    })
  })

  it('allows a name that is not already an account or character', () => {
    assert.deepEqual(duplicateAccountNameResult('Newmain', { accounts, characters }), {
      taken: false,
      message: '',
    })
  })

  it('does not treat a shorter name as a hit inside a longer one', () => {
    assert.deepEqual(duplicateAccountNameResult('Bob', { accounts, characters }), {
      taken: false,
      message: '',
    })
  })
})
