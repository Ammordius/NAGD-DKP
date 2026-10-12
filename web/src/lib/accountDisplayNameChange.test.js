import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  linkedCharacterOptions,
  selectLinkedCharacter,
  displayNamePreview,
  isDisplayNameUnchanged,
} from './accountDisplayNameChange.js'

const linked = [
  { char_id: 'c1', name: 'Alpha' },
  { char_id: 'c2', name: 'Beta' },
  { char_id: '  c3  ', name: '  Gamma  ' },
  { char_id: 'blank', name: '   ' },
  { char_id: '', name: 'NoId' },
]

const otherAccount = [
  { char_id: 'other', name: 'Other' },
]

describe('linkedCharacterOptions', () => {
  it('returns only linked characters that have a name', () => {
    const options = linkedCharacterOptions(linked)
    assert.deepEqual(options.map((option) => option.charId), ['c1', 'c2', 'c3'])
    assert.deepEqual(options.map((option) => option.name), ['Alpha', 'Beta', 'Gamma'])
  })

  it('does not include characters from another list', () => {
    const options = linkedCharacterOptions(linked, 'other')
    assert.equal(options.some((option) => option.charId === 'other' || option.name === 'Other'), false)
    assert.deepEqual(linkedCharacterOptions(otherAccount).map((option) => option.name), ['Other'])
  })

  it('uses the query only to narrow the linked list', () => {
    assert.deepEqual(
      linkedCharacterOptions(linked, 'bet').map((option) => option.charId),
      ['c2']
    )
    assert.deepEqual(linkedCharacterOptions(linked, 'not-a-character'), [])
    assert.equal(
      linkedCharacterOptions(linked, 'Arbitrary Name').some((option) => option.name === 'Arbitrary Name'),
      false
    )
  })
})

describe('selectLinkedCharacter', () => {
  it('rejects an id that is not in the linked list', () => {
    assert.throws(
      () => selectLinkedCharacter(linked, 'missing'),
      /not linked to this account/
    )
  })

  it('rejects a character linked only to another account', () => {
    assert.throws(
      () => selectLinkedCharacter(linked, 'other'),
      /not linked to this account/
    )
    assert.deepEqual(selectLinkedCharacter(otherAccount, 'other'), { charId: 'other', name: 'Other' })
  })

  it('rejects a blank name before a write', () => {
    assert.throws(
      () => selectLinkedCharacter(linked, 'blank'),
      /not linked to this account/
    )
  })
})

describe('displayNamePreview', () => {
  it('exposes the current account name and the proposed character name', () => {
    assert.deepEqual(displayNamePreview(' Old Name ', ' New Name '), {
      current: 'Old Name',
      proposed: 'New Name',
    })
  })

  it('treats the same name as a no-op', () => {
    assert.equal(isDisplayNameUnchanged(' Alpha ', 'Alpha'), true)
    assert.equal(isDisplayNameUnchanged('Alpha', 'Beta'), false)
    assert.equal(isDisplayNameUnchanged(null, 'Alpha'), false)
  })
})
