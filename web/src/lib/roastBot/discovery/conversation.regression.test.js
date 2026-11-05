/**
 * Mandatory five-turn stateful regression for discovery reliability.
 * Exercises the production orchestration path via pipelineTrace.
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { resetDiscoveryCache } from './index.js'
import { createDiscoveryMockClient } from './mockSupabase.js'
import { buildKnownItemSources } from '../../itemSourceLookup.js'
import {
  FIXTURE_ITEM_SOURCES,
  FIXTURE_MOB_LOOT,
  FIXTURE_ITEM_STATS,
} from './fixtures.js'
import { createConversationState } from '../conversation.js'
import { traceDiscoveryTurn } from './pipelineTrace.js'

const NOW = '2026-03-05T12:00:00Z'

const known = buildKnownItemSources({
  itemSources: FIXTURE_ITEM_SOURCES,
  mobLoot: FIXTURE_MOB_LOOT,
})

function makeFacts() {
  return {
    characters: [],
    accountId: 'a1',
    knownItemSources: known,
    itemCatalog: [],
    itemStats: FIXTURE_ITEM_STATS,
  }
}

describe('mandatory five-turn discovery regression', () => {
  /** @type {ReturnType<typeof createDiscoveryMockClient>} */
  let client
  /** @type {ReturnType<typeof createConversationState>} */
  let state
  /** @type {object} */
  let facts

  beforeEach(() => {
    resetDiscoveryCache()
    client = createDiscoveryMockClient()
    state = createConversationState()
    facts = makeFacts()
  })

  it('runs the reported conversation sequence without wrong-entity or stale reuse', async () => {
    const turns = [
      'what did quarm drop last time',
      'who got the last plate bp',
      'what about silk robe',
      'who go the most recent silk robe?',
      'who got the most recent silk robe',
    ]

    /** @type {import('./pipelineTrace.js').PipelineTrace[]} */
    const traces = []
    for (const text of turns) {
      const { trace } = await traceDiscoveryTurn({
        client,
        text,
        facts,
        state,
        nowIso: NOW,
        skipCache: false,
      })
      traces.push(trace)
    }

    // Turn 1: Quarm last-time loot — recognized and planned as boss raid loot
    assert.equal(traces[0].recognition.status, 'recognized', 'turn1 recognition')
    assert.equal(traces[0].query?.boss, 'Quarm', 'turn1 boss')
    assert.equal(traces[0].query?.scope, 'last_raid_night', 'turn1 scope')
    assert.ok(traces[0].plan, 'turn1 has plan')
    assert.equal(traces[0].outcome, 'answered', 'turn1 answered')
    assert.ok(
      traces[0].awardItemNames.some((n) => /quarm tooth|band of the eternal/i.test(n)),
      'turn1 quarm awards',
    )

    // Turn 2: last plate bp — most recent breastplate recipient, not silk
    assert.equal(traces[1].recognition.status, 'recognized', 'turn2 recognition')
    assert.match(String(traces[1].resolvedItemName || ''), /breastplate/i, 'turn2 item')
    assert.equal(traces[1].query?.intent, 'last_award', 'turn2 intent')
    assert.equal(traces[1].awardRecipients[0], 'PlateWinner', 'turn2 latest recipient')
    assert.equal(traces[1].awardIds[0], 20, 'turn2 latest award id')
    assert.match(String(traces[1].answer?.factText || ''), /PlateWinner/, 'turn2 singular lead')
    assert.doesNotMatch(
      String(traces[1].answer?.factText || ''),
      /^Who got /m,
      'turn2 should not open as generic who-got history',
    )

    // Turn 3: what about silk robe — MUST replace breastplate, never reuse plate results
    assert.equal(traces[2].recognition.status, 'recognized', 'turn3 recognition')
    assert.match(String(traces[2].resolvedItemName || ''), /silk robe/i, 'turn3 silk item')
    assert.doesNotMatch(
      String(traces[2].resolvedItemName || ''),
      /breastplate/i,
      'turn3 must not keep breastplate',
    )
    assert.equal(traces[2].awardRecipients[0], 'SilkWinner', 'turn3 silk recipient')
    assert.equal(traces[2].awardIds[0], 21, 'turn3 silk award id')
    assert.notEqual(traces[2].planFingerprint, traces[1].planFingerprint, 'turn3 cache identity differs')
    assert.ok(
      !traces[2].awardItemNames.some((n) => /breastplate/i.test(n)),
      'turn3 no breastplate awards',
    )

    // Turn 4: typo who go — still discovery for silk robe
    assert.equal(traces[3].recognition.status, 'recognized', 'turn4 recognition')
    assert.match(String(traces[3].resolvedItemName || ''), /silk robe/i, 'turn4 silk')
    assert.equal(traces[3].awardRecipients[0], 'SilkWinner', 'turn4 recipient')

    // Turn 5: most recent silk robe — last_award, silk only
    assert.equal(traces[4].recognition.status, 'recognized', 'turn5 recognition')
    assert.equal(traces[4].query?.intent, 'last_award', 'turn5 last_award for most recent')
    assert.match(String(traces[4].resolvedItemName || ''), /silk robe/i, 'turn5 silk')
    assert.equal(traces[4].awardRecipients[0], 'SilkWinner', 'turn5 recipient')
    assert.ok(
      !traces[4].awardItemNames.some((n) => /breastplate/i.test(n)),
      'turn5 no breastplate (stale) awards',
    )
  })
})
