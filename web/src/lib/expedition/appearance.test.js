import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  APPEARANCE_LABELS,
  APPEARANCE_MODES,
  APPEARANCE_PAGE_STATE_KEY,
  DEFAULT_APPEARANCE_MODE,
  isGnomeAppearance,
  normalizeAppearanceMode,
} from './appearance.js'

describe('expedition appearance', () => {
  it('defaults to classic and rejects unknown values', () => {
    assert.equal(DEFAULT_APPEARANCE_MODE, 'classic')
    assert.equal(normalizeAppearanceMode('classic'), 'classic')
    assert.equal(normalizeAppearanceMode('gnomes'), 'gnomes')
    assert.equal(normalizeAppearanceMode('oops'), 'classic')
    assert.equal(normalizeAppearanceMode(null), 'classic')
    assert.equal(normalizeAppearanceMode(undefined), 'classic')
    assert.equal(normalizeAppearanceMode(1), 'classic')
  })

  it('exposes both mode labels and a separate persistence key', () => {
    assert.deepEqual([...APPEARANCE_MODES], ['classic', 'gnomes'])
    assert.equal(APPEARANCE_LABELS.classic, 'Classic Adventurers')
    assert.equal(APPEARANCE_LABELS.gnomes, 'Oops, All Gnomes!')
    assert.equal(APPEARANCE_PAGE_STATE_KEY, '/games/expedition:appearance')
    assert.ok(!APPEARANCE_PAGE_STATE_KEY.includes(':save:'))
  })

  it('detects gnome mode after normalization', () => {
    assert.equal(isGnomeAppearance('gnomes'), true)
    assert.equal(isGnomeAppearance('classic'), false)
    assert.equal(isGnomeAppearance('nope'), false)
  })
})
