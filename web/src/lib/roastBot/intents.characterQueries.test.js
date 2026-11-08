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
  extractCharacterSwapFollowUp,
  extractWhoIsCharacterName,
  isRepeatableCharacterSwapIntent,
  isCharacterPronoun,
  messageUsesCharacterPronoun,
} from './intents.js'
import { isCharacterSwapFollowUp } from './conversation.js'
import { looksLikeWhoIs } from './whoIs.js'

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

  it('classifies raid geared as Quarm eligibility', () => {
    const out = classifyIntent('is pigpen raid geared?', { characters: chars })
    assert.equal(out.intent, INTENTS.QUARM_ELIGIBILITY)
  })

  it('classifies best geared phrasing as gear assessment', () => {
    const out = classifyIntent('is pigpen the best geared gnome', { characters: chars })
    assert.equal(out.intent, INTENTS.GEAR_ASSESSMENT)
  })

  it('classifies strongest / best / how-strong phrasing as gear assessment', () => {
    assert.equal(
      classifyIntent('is pigpen the strongest gnome', { characters: chars }).intent,
      INTENTS.GEAR_ASSESSMENT,
    )
    assert.equal(
      classifyIntent('is pigpen the best gnome', { characters: chars }).intent,
      INTENTS.GEAR_ASSESSMENT,
    )
    assert.equal(
      classifyIntent('how strong is pigpen', { characters: chars }).intent,
      INTENTS.GEAR_ASSESSMENT,
    )
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

  it('extracts guild-wide raid geared subject name', () => {
    assert.equal(
      extractSubjectCharacterName('is pigpen raid geared?', {
        intent: INTENTS.QUARM_ELIGIBILITY,
      }),
      'pigpen',
    )
  })

  it('extracts guild-wide gear assessment subject name', () => {
    assert.equal(
      extractSubjectCharacterName('is pigpen the best geared gnome', {
        intent: INTENTS.GEAR_ASSESSMENT,
      }),
      'pigpen',
    )
    assert.equal(
      extractSubjectCharacterName('is pigpen the strongest gnome', {
        intent: INTENTS.GEAR_ASSESSMENT,
      }),
      'pigpen',
    )
    assert.equal(
      extractSubjectCharacterName('is pigpen the best gnome', {
        intent: INTENTS.GEAR_ASSESSMENT,
      }),
      'pigpen',
    )
    assert.equal(
      extractSubjectCharacterName('how strong is pigpen', {
        intent: INTENTS.GEAR_ASSESSMENT,
      }),
      'pigpen',
    )
    assert.equal(
      extractSubjectCharacterName('how is Pigpen gear?', {
        intent: INTENTS.GEAR_ASSESSMENT,
      }),
      'Pigpen',
    )
    assert.equal(
      extractSubjectCharacterName('how is my gear?', {
        intent: INTENTS.GEAR_ASSESSMENT,
      }),
      null,
    )
  })

  it('helper predicates agree with classifier', () => {
    assert.equal(isCharacterDkpSpentQuestion('total dkp spent on Zender'), true)
    assert.equal(isQuarmEligibilityQuestion('is Zender raid viable'), true)
    assert.equal(isCharacterStatsQuestion('show Zender stats'), true)
  })

  it('extracts character-swap follow-up name', () => {
    assert.equal(extractCharacterSwapFollowUp('what about badammo?'), 'Badammo')
    assert.equal(extractCharacterSwapFollowUp('how about Charmalt'), 'Charmalt')
    assert.equal(extractCharacterSwapFollowUp('what about shoulder?'), null)
    assert.equal(extractCharacterSwapFollowUp('what about plate arms?'), null)
    assert.equal(extractCharacterSwapFollowUp('what about he?'), null)
  })

  it('rejects pronouns as subject / who-is names', () => {
    assert.equal(isCharacterPronoun('he'), true)
    assert.equal(isCharacterPronoun('she?'), true)
    assert.equal(messageUsesCharacterPronoun('is he raid ready?'), true)
    assert.equal(
      extractSubjectCharacterName('is he raid ready?', { intent: INTENTS.QUARM_ELIGIBILITY }),
      null,
    )
    assert.equal(extractWhoIsCharacterName('who is he'), null)
    assert.equal(extractWhoIsCharacterName('who is she?'), null)
    assert.equal(looksLikeWhoIs('who is he'), true)
    assert.equal(looksLikeWhoIs('who is Badammo'), true)
  })

  it('bare pronoun with sticky subject classifies as FOLLOWUP', () => {
    const out = classifyIntent('he', {
      characters: chars,
      lastSubject: 'Badammo',
      lastIntent: INTENTS.QUARM_ELIGIBILITY,
    })
    assert.equal(out.intent, INTENTS.FOLLOWUP)
    assert.equal(out.bareCharacterPronoun, true)
  })

  it('bare pronoun without sticky subject is UNKNOWN', () => {
    const out = classifyIntent('he', { characters: chars })
    assert.equal(out.intent, INTENTS.UNKNOWN)
  })

  it('soft-matches bare typo andiyen → Tandiyen', () => {
    const withTand = [...chars, { char_id: 't1', name: 'Tandiyen', class_name: 'Shadow Knight' }]
    const out = classifyIntent('andiyen', { characters: withTand })
    assert.equal(out.matchedCharacter?.name, 'Tandiyen')
    assert.equal(out.intent, INTENTS.FOLLOWUP)
    assert.equal(out.bareCharacterName, true)
  })

  it('does not treat for him as an item hint on upgrades', () => {
    const out = classifyIntent('what would be a good upgrade for him', {
      characters: chars,
      lastSubject: 'Iaminae',
    })
    assert.equal(out.intent, INTENTS.UPGRADES)
    assert.equal(out.matchedItemHint, null)
  })

  it('isCharacterSwapFollowUp only after repeatable character intents', () => {
    assert.equal(isRepeatableCharacterSwapIntent(INTENTS.GEAR_ASSESSMENT), true)
    assert.equal(isRepeatableCharacterSwapIntent(INTENTS.WHO_IS), true)
    assert.equal(isRepeatableCharacterSwapIntent(INTENTS.LOOT_DISCOVERY), false)
    assert.equal(
      isCharacterSwapFollowUp('what about Badammo?', { lastIntent: INTENTS.GEAR_ASSESSMENT }),
      true,
    )
    assert.equal(
      isCharacterSwapFollowUp('what about Badammo?', { lastIntent: INTENTS.LOOT_DISCOVERY }),
      false,
    )
    assert.equal(
      isCharacterSwapFollowUp('what about shoulder?', { lastIntent: INTENTS.UPGRADES }),
      false,
    )
  })
})
