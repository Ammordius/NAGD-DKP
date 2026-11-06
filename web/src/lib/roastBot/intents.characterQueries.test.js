/**
 * Intent classification for character spend / Quarm eligibility / Magelo stats.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  INTENTS,
  classifyIntent,
  isCharacterDkpSpentQuestion,
  isQuarmEligibilityQuestion,
  isCharacterStatsQuestion,
  extractSubjectCharacterName,
} from './intents.js'

const chars = [
  { char_id: 'e1', name: 'Iaminae', class_name: 'Enchanter' },
  { char_id: 'w1', name: 'Zender', class_name: 'Warrior' },
]

describe('character spend / eligibility / stats intents', () => {
  it('classifies how much dkp spent on character', () => {
    const out = classifyIntent('how much dkp has been spent on tandiyen', { characters: chars })
    assert.equal(out.intent, INTENTS.CHARACTER_DKP_SPENT)
  })

  it('classifies spent ask even when lastIntent was upgrades', () => {
    const out = classifyIntent('how much dkp has been spent on Iaminae', {
      characters: chars,
      lastIntent: INTENTS.UPGRADES,
    })
    assert.equal(out.intent, INTENTS.CHARACTER_DKP_SPENT)
    assert.equal(out.matchedCharacter?.name, 'Iaminae')
  })

  it('classifies Quarm eligibility', () => {
    const out = classifyIntent('Is Iaminae Quarm eligible?', { characters: chars })
    assert.equal(out.intent, INTENTS.QUARM_ELIGIBILITY)
  })

  it('classifies raid ready phrasing', () => {
    const out = classifyIntent('is Iaminae raid ready?', { characters: chars })
    assert.equal(out.intent, INTENTS.QUARM_ELIGIBILITY)
  })

  it('classifies character stats', () => {
    const out = classifyIntent("what are Iaminae's stats", { characters: chars })
    assert.equal(out.intent, INTENTS.CHARACTER_STATS)
  })

  it('extracts guild-wide spend subject name', () => {
    assert.equal(
      extractSubjectCharacterName('how much dkp has been spent on tandiyen', {
        intent: INTENTS.CHARACTER_DKP_SPENT,
      }),
      'tandiyen',
    )
  })

  it('helper predicates agree with classifier', () => {
    assert.equal(isCharacterDkpSpentQuestion('total dkp spent on Zender'), true)
    assert.equal(isQuarmEligibilityQuestion('is Zender raid viable'), true)
    assert.equal(isCharacterStatsQuestion('show Zender stats'), true)
  })
})
