import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAccountFacts,
  normalizePurchase,
  dedupeLootRows,
} from './facts.js'
import { handleMessage, createConversationState, startConversation } from './conversation.js'
import { INTENTS, classifyIntent } from './intents.js'
import { FULL_GEAR_COST_REFUSAL } from './templates.js'
import { resetIfIdentityChanged } from './conversation.js'

describe('roastBot facts and purchases', () => {
  it('dedupes duplicate sale rows by id', () => {
    const rows = dedupeLootRows([
      { id: 1, item_name: 'Sword', cost: 10 },
      { id: 1, item_name: 'Sword', cost: 10 },
      { id: 2, item_name: 'Shield', cost: 5 },
    ])
    assert.equal(rows.length, 2)
  })

  it('differentiates buyer vs assignee attribution', () => {
    const chars = [
      { char_id: 'w1', name: 'War' },
      { char_id: 'c1', name: 'Clr' },
    ]
    const p = normalizePurchase(
      {
        id: 9,
        item_name: 'Breastplate',
        cost: 100,
        char_id: 'w1',
        character_name: 'War',
        assigned_char_id: 'c1',
        assigned_character_name: 'Clr',
      },
      chars,
    )
    assert.equal(p.buyerCharId, 'w1')
    assert.equal(p.assignedCharId, 'c1')
    assert.equal(p.attributionReliable, true)
    assert.equal(p.attributedCharacterName, 'Clr')
  })

  it('handles unknown assignee and missing cost', () => {
    const p = normalizePurchase({
      id: 3,
      item_name: 'Mystery',
      cost: null,
      char_id: 'w1',
      character_name: 'War',
    })
    assert.equal(p.cost, null)
    assert.equal(p.attributionReliable, false)
  })

  it('includes zero-DKP items in purchase count but not as biggest paid purchase', () => {
    const facts = buildAccountFacts({
      accountId: 'a1',
      characters: [{ char_id: 'w1', name: 'War' }],
      lootRows: [
        { id: 1, item_name: 'Freebie', cost: 0, char_id: 'w1', character_name: 'War' },
        { id: 2, item_name: 'Expensive', cost: 200, char_id: 'w1', character_name: 'War', sale_date: '2026-01-02' },
        { id: 3, item_name: 'Mid', cost: 50, char_id: 'w1', character_name: 'War', sale_date: '2026-01-01' },
      ],
    })
    assert.equal(facts.totalRecordedPurchases, 3)
    assert.equal(facts.biggestPurchase.itemName, 'Expensive')
    assert.equal(facts.biggestPurchase.cost, 200)
  })

  it('does not invent prices when sale history is missing', () => {
    const facts = buildAccountFacts({
      accountId: 'a1',
      currentDkp: 80,
      characters: [{ char_id: 'w1', name: 'War', class_name: 'Warrior' }],
      lootRows: [],
      recentItemPrices: {},
      itemCatalog: [{ name: 'Rare Drop' }],
    })
    const { response, intent } = handleMessage({
      text: 'How much is Rare Drop?',
      facts,
      state: createConversationState(),
      rng: () => 0,
    })
    assert.ok([INTENTS.ITEM_PRICE, INTENTS.ITEM_SEARCH, INTENTS.AFFORDABILITY].includes(intent) || intent)
    assert.equal(response.text.includes('999'), false)
    assert.match(response.text, /no |can'?t|reliable|trustworthy|usable|invent/i)
  })

  it('shows verified historical price without inventing future cost', () => {
    const facts = buildAccountFacts({
      accountId: 'a1',
      currentDkp: 200,
      characters: [{ char_id: 'w1', name: 'War' }],
      recentItemPrices: { 'time sword': { values: [75, 60, 90], avg: '75.0' } },
      itemCatalog: [{ name: 'Time Sword' }],
      knownItemSources: { 'time sword': { zone: 'Plane of Time', mob: 'Quarm' } },
    })
    const { response } = handleMessage({
      text: 'How much is Time Sword?',
      facts,
      state: createConversationState(),
      rng: () => 0,
    })
    assert.match(response.text, /75/)
    assert.equal(/will cost|guaranteed|exactly \d+ next/i.test(response.text), false)
  })

  it('refuses exact combined gearing total', () => {
    const facts = buildAccountFacts({
      accountId: 'a1',
      currentDkp: 500,
      characters: [{ char_id: 'w1', name: 'War', class_name: 'Warrior' }],
      recentItemPrices: {
        a: { values: [10], avg: '10' },
        b: { values: [20], avg: '20' },
      },
    })
    const { response, intent } = handleMessage({
      text: 'How much DKP do I need to fully upgrade everything?',
      facts,
      state: createConversationState(),
      rng: () => 0,
    })
    assert.equal(intent, INTENTS.FULL_GEAR_COST)
    assert.equal(response.text, FULL_GEAR_COST_REFUSAL)
    assert.equal(/\b30\b/.test(response.text), false)
  })
})

describe('roastBot conversation', () => {
  it('greets and supports generic roast without account', () => {
    const facts = buildAccountFacts({})
    const started = startConversation(facts)
    assert.match(started.response.text, /DKP Inquisitor/i)
    assert.match(started.response.text, /claimed game account/i)

    const { response } = handleMessage({
      text: 'Roast me',
      facts,
      state: started.state,
      rng: () => 0,
    })
    assert.ok(response.text.length > 10)
  })

  it('resolves follow-up item price from context', () => {
    const facts = buildAccountFacts({
      accountId: 'a1',
      currentDkp: 100,
      characters: [{ char_id: 'w1', name: 'War' }],
      lootRows: [
        { id: 1, item_name: 'Fancy Belt', cost: 120, char_id: 'w1', character_name: 'War', sale_date: '2026-10-01' },
      ],
      recentItemPrices: { 'fancy belt': { values: [110], avg: '110' } },
      itemCatalog: [{ name: 'Fancy Belt' }],
    })
    const state = createConversationState()
    const first = handleMessage({ text: 'Roast my DKP spending', facts, state, rng: () => 0 })
    assert.ok(first.state.lastItemName)
    const second = handleMessage({
      text: 'How much was it?',
      facts,
      state: first.state,
      rng: () => 0,
    })
    assert.match(second.response.text, /110|Fancy Belt/i)
  })

  it('avoids repeating the same template within five responses when alternatives exist', () => {
    const facts = buildAccountFacts({
      accountId: 'a1',
      currentDkp: 40,
      guildBalances: Array.from({ length: 20 }, (_, i) => i * 10),
      characters: [{ char_id: 'w1', name: 'War' }],
    })
    let state = createConversationState()
    const ids = []
    for (let i = 0; i < 5; i++) {
      // Balance still uses category templates; why-broke is fact-first and fixed.
      const r = handleMessage({ text: "What's my DKP balance?", facts, state, rng: () => 0.1 * i })
      state = r.state
      ids.push(r.response.templateId)
    }
    // With several low-balance templates, recent exclusion should prevent collapse to one id
    assert.ok(new Set(ids).size >= 2, `expected variation, got ${ids.join(',')}`)
  })

  it('clears conversation state on auth identity change', () => {
    const state = createConversationState()
    state.authUserId = 'u1'
    state.accountId = 'a1'
    state.lastItemName = 'Secret'
    state.turnCount = 4
    const next = resetIfIdentityChanged(state, { userId: 'u2', accountId: 'a1' })
    assert.equal(next.lastItemName, null)
    assert.equal(next.turnCount, 0)
    assert.equal(next.authUserId, 'u2')
  })

  it('classifies common intents', () => {
    assert.equal(classifyIntent('hello').intent, INTENTS.GREETING)
    assert.equal(classifyIntent('What should I buy?').intent, INTENTS.UPGRADES)
    assert.equal(classifyIntent('What was my worst purchase?').intent, INTENTS.WORST_PURCHASE)
    assert.equal(classifyIntent("How's my raiding?").intent, INTENTS.ATTENDANCE)
  })

  it('does not invent upgrade deltas without Magelo context', () => {
    const facts = buildAccountFacts({
      accountId: 'a1',
      characters: [{ char_id: 'w1', name: 'War', class_name: 'Warrior' }],
      currentDkp: 100,
    })
    const { response } = handleMessage({
      text: 'What should I buy for my warrior?',
      facts,
      state: createConversationState(),
      upgradeContext: { rankings: { characters: [], classWeights: {} }, itemStats: {}, raidItemIds: new Set() },
      rng: () => 0,
    })
    assert.equal(response.cards?.length || 0, 0)
    assert.equal(/\+\d+(\.\d+)? score/.test(response.text), false)
  })
})
