import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyIntent, INTENTS, extractWhoIsCharacterName } from './intents.js'
import { looksLikeWhoIs, extractWhoIsName, resolveWhoIsFromMaps } from './whoIs.js'
import { createConversationState, handleMessage } from './conversation.js'
import { dispatchHandler } from './handlers/index.js'

describe('who-is intent classification', () => {
  it('classifies who is / who\'s / whose account as WHO_IS', () => {
    for (const text of ['who is Tandiyen', "who's Tandiyen?", 'Whose account is Tandiyen']) {
      const c = classifyIntent(text)
      assert.equal(c.intent, INTENTS.WHO_IS, text)
      const name = c.whoIsName || extractWhoIsCharacterName(text)
      assert.equal(String(name).toLowerCase(), 'tandiyen', text)
    }
  })

  it('does not steal who got / who won for WHO_IS', () => {
    for (const text of ['who got the Cloak of Wishes', 'who won Timeless Breastplate Mold', 'who received Whip']) {
      const c = classifyIntent(text)
      assert.notEqual(c.intent, INTENTS.WHO_IS, text)
      assert.equal(looksLikeWhoIs(text), false, text)
      assert.equal(extractWhoIsName(text), null, text)
    }
  })
})

describe('resolveWhoIsFromMaps', () => {
  const maps = {
    charToAccount: { '42': 'a1', Tandiyen: 'a1', tandiyen: 'a1', Ghost: 'a9' },
    accountIdToDisplayName: { a1: 'BobAccount', a9: 'GhostAccount' },
    charIdToName: { '42': 'Tandiyen', '99': 'UnlinkedAlt' },
    lastRaidByAccount: new Map([
      ['a1', '2026-03-01'],
      ['a9', null],
    ]),
  }

  it('resolves linked character to account + last raid date', () => {
    const r = resolveWhoIsFromMaps({ ...maps, characterName: 'tandiyen' })
    assert.equal(r.status, 'ok')
    assert.equal(r.characterName, 'Tandiyen')
    assert.equal(r.accountName, 'BobAccount')
    assert.equal(r.lastRaidDate, '2026-03-01')
  })

  it('returns not_found for unknown names', () => {
    const r = resolveWhoIsFromMaps({ ...maps, characterName: 'NopeNobody' })
    assert.equal(r.status, 'not_found')
    assert.equal(r.accountName, null)
    assert.equal(r.lastRaidDate, null)
  })

  it('returns unlinked when character exists without account', () => {
    const r = resolveWhoIsFromMaps({ ...maps, characterName: 'UnlinkedAlt' })
    assert.equal(r.status, 'unlinked')
    assert.equal(r.accountName, null)
  })

  it('allows null last raid date without inventing one', () => {
    const r = resolveWhoIsFromMaps({
      ...maps,
      characterName: 'Ghost',
      lastRaidByAccount: new Map([['a9', null]]),
    })
    assert.equal(r.status, 'ok')
    assert.equal(r.accountName, 'GhostAccount')
    assert.equal(r.lastRaidDate, null)
  })
})

describe('handleWhoIs answers', () => {
  it('embeds account and last raid date claims on success', () => {
    const answer = dispatchHandler({
      intent: INTENTS.WHO_IS,
      facts: { accountId: 'viewer' },
      whoIsName: 'Tandiyen',
      whoIsResult: {
        status: 'ok',
        characterName: 'Tandiyen',
        accountId: 'a1',
        accountName: 'BobAccount',
        lastRaidDate: '2026-03-01',
        charId: '42',
      },
    })
    assert.equal(answer.intent, INTENTS.WHO_IS)
    assert.equal(answer.category, 'who_is')
    assert.equal(answer.allowFlavor, true)
    assert.match(answer.factText, /Tandiyen/)
    assert.match(answer.factText, /BobAccount/)
    assert.match(answer.factText, /2026-03-01/)
    assert.ok(answer.requiredClaims.includes('who_is_account'))
    assert.ok(answer.requiredClaims.includes('who_is_last_raid'))
  })

  it('does not invent account when not found', () => {
    const answer = dispatchHandler({
      intent: INTENTS.WHO_IS,
      facts: {},
      whoIsName: 'NopeNobody',
      whoIsResult: {
        status: 'not_found',
        characterName: 'NopeNobody',
        accountId: null,
        accountName: null,
        lastRaidDate: null,
        charId: null,
      },
    })
    assert.match(answer.factText, /NopeNobody/)
    assert.doesNotMatch(answer.factText, /account [A-Za-z0-9_-]+ is/)
    assert.equal(answer.placeholders.account, undefined)
  })

  it('dialogue path with prefetched whoIsResult stays WHO_IS', () => {
    const { intent, response } = handleMessage({
      text: 'who is Tandiyen',
      facts: { accountId: 'viewer', characters: [], purchases: [] },
      state: createConversationState(),
      whoIsResult: {
        status: 'ok',
        characterName: 'Tandiyen',
        accountId: 'a1',
        accountName: 'BobAccount',
        lastRaidDate: '2026-03-01',
        charId: '42',
      },
      whoIsName: 'Tandiyen',
      rng: () => 0,
    })
    assert.equal(intent, INTENTS.WHO_IS)
    assert.match(response.text, /Tandiyen/)
    assert.match(response.text, /BobAccount/)
    assert.match(response.text, /2026-03-01/)
  })
})
