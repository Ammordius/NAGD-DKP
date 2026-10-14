import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyTicAttendance } from './officerRaidParse.js'
import {
  emptyTicDraft,
  normalizeUiPreferences,
  readTicDraft,
  sanitizeTicDraft,
  writeTicDraft,
} from './uiPreferences.js'

describe('normalizeUiPreferences', () => {
  it('turns missing and legacy values on', () => {
    assert.deepEqual(normalizeUiPreferences(null), {
      showTicCharacterPicker: true,
      useCharacterAdminSelectors: true,
      raidNameOnly: true,
    })
    assert.deepEqual(normalizeUiPreferences({}), normalizeUiPreferences(undefined))
    assert.deepEqual(normalizeUiPreferences([]), normalizeUiPreferences('nope'))
    assert.equal(normalizeUiPreferences({ showTicCharacterPicker: 'yes', extra: 1 }).showTicCharacterPicker, true)
    assert.equal(normalizeUiPreferences({ raidNameOnly: 0 }).raidNameOnly, true)
  })

  it('keeps a saved false value and fills the other defaults', () => {
    const prefs = normalizeUiPreferences({ showTicCharacterPicker: false })
    assert.equal(prefs.showTicCharacterPicker, false)
    assert.equal(prefs.useCharacterAdminSelectors, true)
    assert.equal(prefs.raidNameOnly, true)
  })
})

describe('tic draft', () => {
  it('keeps paste and attending selections for a raid', () => {
    const storage = new Map()
    const memory = {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, value),
    }
    writeTicDraft(memory, 'raid-1', {
      ...emptyTicDraft(),
      ticPaste: 'Ezram, Hunted',
      ticAttendingIds: ['c-hunted'],
      ticExcludedCharIds: ['c-skip'],
      ticDestination: 'existing',
    })
    const draft = readTicDraft(memory, 'raid-1')
    assert.equal(draft.ticPaste, 'Ezram, Hunted')
    assert.deepEqual(draft.ticAttendingIds, ['c-hunted'])
    assert.deepEqual(draft.ticExcludedCharIds, ['c-skip'])
    assert.equal(draft.ticDestination, 'existing')
    assert.equal(readTicDraft(memory, 'raid-2'), null)
  })

  it('drops junk draft fields without clearing a real paste', () => {
    const draft = sanitizeTicDraft({ ticPaste: 'Name1', ticAttendingIds: 'nope', ticResolutions: ['bad'] })
    assert.equal(draft.ticPaste, 'Name1')
    assert.deepEqual(draft.ticAttendingIds, [])
    assert.deepEqual(draft.ticResolutions, {})
  })
})

describe('tic submit sources', () => {
  const lookup = {
    nameToChars: {
      ezram: [{ char_id: 'c-ezram', name: 'Ezram' }],
      hunted: [{ char_id: 'c-hunted', name: 'Hunted' }],
    },
    charIdToAccountId: {
      'c-ezram': 'acc-ezram',
      'c-hunted': 'acc-hunted',
    },
  }

  it('credits paste names and picker selections together when the picker is hidden', () => {
    const result = classifyTicAttendance(['Ezram'], {
      ...lookup,
      explicitChars: [{ char_id: 'c-hunted', name: 'Hunted' }],
    })
    assert.deepEqual(
      result.toAdd.map((row) => row.char_id).sort(),
      ['c-ezram', 'c-hunted'],
    )
  })
})
