/**
 * Comprehensive RoastBot prompt smoke tests, exit/topic-switch suite,
 * and cross-flow matrix. Complements dialogue.acceptance.test.js.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  INTENTS,
  FULL_GEAR_COST_REFUSAL,
  resetUpgradeCaches,
} from './index.js'
import {
  fixtureFacts,
  rankingsFixture,
  itemStatsFixture,
  defaultUpgradeContext,
  createConversationState,
  turn,
  runScript,
  sampleDiscoveryAnswer,
} from './test/dialogueHarness.js'

const UPGRADE_CTX = defaultUpgradeContext()

describe('roastBot prompt smoke — every intent', () => {
  it('GREETING', () => {
    const out = turn(createConversationState(), 'Hello')
    assert.equal(out.intent, INTENTS.GREETING)
    assert.ok(out.answer.requiredClaims.includes('greeting') || out.response.text.length > 0)
    assert.match(out.response.text, /inquisitor|DKP|roast|account|ask/i)
  })

  it('DKP_EXPLAIN', () => {
    const out = turn(createConversationState(), 'How does DKP work?')
    assert.equal(out.intent, INTENTS.DKP_EXPLAIN)
    assert.ok(out.answer.requiredClaims.includes('dkp_earn'))
  })

  it('CAPABILITIES', () => {
    const out = turn(createConversationState(), 'What can you do?')
    assert.equal(out.intent, INTENTS.CAPABILITIES)
    assert.ok(out.answer.requiredClaims.includes('capabilities'))
    assert.match(out.response.text, /balance|upgrade|roast|discovery|who is/i)
  })

  it('WHO_IS (prefetched)', () => {
    const out = turn(createConversationState(), 'who is Tandiyen', {
      whoIsName: 'Tandiyen',
      whoIsResult: {
        status: 'ok',
        characterName: 'Tandiyen',
        accountId: 'a1',
        accountName: 'RaidDad',
        lastRaidDate: '2026-02-14',
        charId: '7',
      },
    })
    assert.equal(out.intent, INTENTS.WHO_IS)
    assert.match(out.response.text, /Tandiyen/)
    assert.match(out.response.text, /RaidDad/)
  })

  it('FULL_GEAR_COST refuses totals', () => {
    const out = turn(createConversationState(), 'How much to fully gear everything?')
    assert.equal(out.intent, INTENTS.FULL_GEAR_COST)
    assert.equal(out.response.text, FULL_GEAR_COST_REFUSAL)
    assert.ok(out.answer.requiredClaims.includes('no_gearing_total'))
  })

  it('WORST_PURCHASE', () => {
    const out = turn(createConversationState(), 'What was my worst purchase?')
    assert.equal(out.intent, INTENTS.WORST_PURCHASE)
    assert.match(out.response.text, /Beguiler Circlet|220/i)
    assert.ok(out.answer.requiredClaims.includes('largest_purchase'))
  })

  it('WHY_BROKE', () => {
    const out = turn(createConversationState(), 'Why am I broke?')
    assert.equal(out.intent, INTENTS.WHY_BROKE)
    assert.ok(out.answer.requiredClaims.includes('balance'))
    assert.match(out.response.text, /42/)
  })

  it('BALANCE', () => {
    const out = turn(createConversationState(), 'What is my DKP balance?')
    assert.equal(out.intent, INTENTS.BALANCE)
    assert.ok(out.answer.requiredClaims.includes('balance'))
    assert.match(out.response.text, /42/)
  })

  it('GEAR_ASSESSMENT clarifies when class is ambiguous', () => {
    const out = turn(createConversationState(), 'Is this a well geared enchanter?')
    assert.equal(out.intent, INTENTS.GEAR_ASSESSMENT)
    assert.equal(out.state.pendingIntent, INTENTS.GEAR_ASSESSMENT)
    assert.deepEqual(out.state.pendingSlots, ['character'])
    assert.ok(out.answer.requiredClaims.includes('need_character'))
  })

  it('ATTENDANCE', () => {
    const out = turn(createConversationState(), "How's my raiding?")
    assert.equal(out.intent, INTENTS.ATTENDANCE)
    assert.ok(out.response.text.length > 20)
    assert.ok(
      out.answer.requiredClaims.some((c) => c.startsWith('attendance') || c === 'no_account'),
    )
  })

  it('ITEM_FIT with sticky item + Magelo', () => {
    const state = createConversationState()
    state.lastItemName = 'Beguiler Circlet'
    state.lastItemId = '501'
    const out = turn(state, 'which of my toons could use this', {
      upgradeContext: UPGRADE_CTX,
    })
    assert.equal(out.intent, INTENTS.ITEM_FIT)
    assert.ok(
      out.answer.requiredClaims.includes('item_fit_upgrades') ||
        out.answer.requiredClaims.includes('item_fit_none') ||
        out.answer.requiredClaims.includes('magelo_unavailable'),
      out.response.text,
    )
  })

  it('UPGRADES for named character', () => {
    const out = turn(createConversationState(), 'What should I buy for Iaminae?', {
      upgradeContext: UPGRADE_CTX,
    })
    assert.equal(out.intent, INTENTS.UPGRADES)
    assert.ok(out.answer.requiredClaims.includes('upgrade_candidates'))
    assert.ok(out.response.cards?.length > 0)
  })

  it('AFFORDABILITY named item', () => {
    const out = turn(createConversationState(), 'Can I afford Beguiler Circlet?')
    assert.equal(out.intent, INTENTS.AFFORDABILITY)
    assert.ok(out.answer.requiredClaims.includes('affordability'))
    assert.match(out.response.text, /Beguiler Circlet/i)
    assert.match(out.response.text, /42|200|220/)
  })

  it('AFFORDABILITY without item sets pending', () => {
    const out = turn(createConversationState(), 'Can I afford it?')
    assert.equal(out.intent, INTENTS.AFFORDABILITY)
    // Sticky empty → need_item clarification
    assert.ok(
      out.answer.requiredClaims.includes('need_item') ||
        out.answer.requiredClaims.includes('price_unknown') ||
        out.answer.requiredClaims.includes('affordability'),
    )
    if (out.answer.requiredClaims.includes('need_item')) {
      assert.equal(out.state.pendingIntent, INTENTS.AFFORDABILITY)
      assert.deepEqual(out.state.pendingSlots, ['item'])
    }
  })

  it('ITEM_PRICE', () => {
    const out = turn(createConversationState(), 'How much is Smooth Onyx Torque?')
    assert.equal(out.intent, INTENTS.ITEM_PRICE)
    assert.ok(out.answer.requiredClaims.includes('last_sale'))
    assert.match(out.response.text, /150/)
  })

  it('ITEM_SOURCE', () => {
    const out = turn(createConversationState(), 'Where does Beguiler Circlet drop?')
    assert.equal(out.intent, INTENTS.ITEM_SOURCE)
    assert.ok(out.answer.requiredClaims.includes('item_source'))
    assert.match(out.response.text, /Quarm|Plane of Time/i)
  })

  it('ITEM_SEARCH routes to source or price', () => {
    const out = turn(createConversationState(), 'Tell me about Beguiler Circlet')
    assert.ok(
      [INTENTS.ITEM_SEARCH, INTENTS.ITEM_SOURCE, INTENTS.ITEM_PRICE].includes(out.intent),
    )
    assert.match(out.response.text, /Beguiler Circlet|Quarm|Plane of Time|200|220/i)
  })

  it('SPENDING_ROAST', () => {
    const out = turn(createConversationState(), 'Roast my DKP spending')
    assert.equal(out.intent, INTENTS.SPENDING_ROAST)
    assert.ok(out.answer.requiredClaims.includes('purchase_history'))
    assert.match(out.response.text, /Beguiler Circlet|Smooth Onyx|220|90/i)
  })

  it('PURCHASE_HISTORY', () => {
    const out = turn(createConversationState(), 'What did I buy?')
    assert.equal(out.intent, INTENTS.PURCHASE_HISTORY)
    assert.ok(out.answer.requiredClaims.includes('purchase_history'))
  })

  it('CHARACTER_ROAST', () => {
    const out = turn(createConversationState(), 'Roast my character')
    assert.equal(out.intent, INTENTS.CHARACTER_ROAST)
    assert.ok(out.answer.requiredClaims.includes('characters') || out.answer.requiredClaims.includes('need_character'))
  })

  it('CHARACTERS', () => {
    const out = turn(createConversationState(), 'My characters')
    assert.equal(out.intent, INTENTS.CHARACTERS)
    assert.ok(out.answer.requiredClaims.includes('characters'))
    assert.match(out.response.text, /Iaminae|Zender|4 linked/i)
  })

  it('DEFENSE', () => {
    const out = turn(createConversationState(), 'But I needed it')
    assert.equal(out.intent, INTENTS.DEFENSE)
    assert.ok(out.answer.requiredClaims.includes('defense'))
  })

  it('GENERAL_ROAST cascades to spending when purchases exist', () => {
    const out = turn(createConversationState(), 'Roast me')
    assert.equal(out.intent, INTENTS.GENERAL_ROAST)
    // Cascades to purchases when biggestPurchase exists
    assert.ok(
      out.answer.requiredClaims.includes('purchase_history') ||
        out.answer.requiredClaims.includes('general_roast') ||
        out.answer.requiredClaims.includes('characters') ||
        out.answer.requiredClaims.includes('balance'),
      out.response.text,
    )
    assert.equal(/Welcome to the DKP Inquisitor/i.test(out.response.text), false)
  })

  it('ACCOUNT_COMPARISON aliases to balance facts', () => {
    const out = turn(createConversationState(), 'How do I compare vs the guild leaderboard?')
    assert.equal(out.intent, INTENTS.ACCOUNT_COMPARISON)
    assert.ok(out.answer.requiredClaims.includes('balance'))
    assert.match(out.response.text, /42/)
  })

  it('LOOT_DISCOVERY with prefetched answer', () => {
    const out = turn(createConversationState(), 'What dropped last time in PoF?', {
      discoveryAnswer: sampleDiscoveryAnswer({ intent: INTENTS.LOOT_DISCOVERY }),
    })
    assert.equal(out.intent, INTENTS.LOOT_DISCOVERY)
    assert.match(out.response.text, /Plane of Fire|recorded loot/i)
  })

  it('UNKNOWN', () => {
    const out = turn(createConversationState(), 'What is the meaning of life?')
    assert.equal(out.intent, INTENTS.UNKNOWN)
    assert.ok(out.answer.requiredClaims.includes('unknown_no_analysis'))
  })

  it('FOLLOWUP remaps how much after sticky item', () => {
    const state = createConversationState()
    state.lastIntent = INTENTS.ITEM_PRICE
    state.lastItemName = 'Beguiler Circlet'
    state.lastItemId = '501'
    const out = turn(state, 'How much?')
    assert.equal(out.intent, INTENTS.ITEM_PRICE)
    assert.match(out.response.text, /Beguiler Circlet/i)
  })
})

describe('roastBot exit / topic-switch', () => {
  it('abandons gear clarification for Why am I broke and clears pending', () => {
    const facts = fixtureFacts()
    const first = turn(createConversationState(), 'Is this a well geared enchanter?', { facts })
    assert.equal(first.state.pendingIntent, INTENTS.GEAR_ASSESSMENT)

    const second = turn(first.state, 'Why am I broke?', { facts })
    assert.equal(second.intent, INTENTS.WHY_BROKE)
    assert.equal(second.state.pendingIntent, null)
    assert.deepEqual(second.state.pendingSlots, [])
    assert.match(second.response.text, /42/)
  })

  it('after abandoning gear clarify, bare Iaminae does not resurrect gear assessment', () => {
    const facts = fixtureFacts()
    let state = createConversationState()
    state = turn(state, 'Is this a well geared enchanter?', { facts }).state
    state = turn(state, 'Why am I broke?', { facts }).state
    assert.equal(state.pendingIntent, null)

    const third = turn(state, 'Iaminae', { facts })
    assert.notEqual(third.intent, INTENTS.GEAR_ASSESSMENT)
    assert.equal(third.state.pendingIntent, null)
    // Must not resume the abandoned gear clarification
    assert.equal(third.answer.requiredClaims?.includes('gear_pct'), false)
    assert.equal(third.answer.requiredClaims?.includes('need_character'), false)
  })

  it('abandons item pending for capabilities / DKP explain', () => {
    const facts = fixtureFacts()
    const need = turn(createConversationState(), 'Can I afford it?', { facts })
    if (need.state.pendingIntent !== INTENTS.AFFORDABILITY) {
      // Sticky-empty path may not always pending; force pending for this exit case
      need.state.pendingIntent = INTENTS.AFFORDABILITY
      need.state.pendingSlots = ['item']
    }

    const caps = turn(need.state, 'What can you do?', { facts })
    assert.equal(caps.intent, INTENTS.CAPABILITIES)
    assert.equal(caps.state.pendingIntent, null)

    const need2 = turn(createConversationState(), 'Where does it drop?', { facts })
    if (need2.state.pendingIntent) {
      const dkp = turn(need2.state, 'How does DKP work?', { facts })
      assert.equal(dkp.intent, INTENTS.DKP_EXPLAIN)
      assert.equal(dkp.state.pendingIntent, null)
    } else {
      // Explicit pending trap
      const state = createConversationState()
      state.pendingIntent = INTENTS.ITEM_SOURCE
      state.pendingSlots = ['item']
      const dkp = turn(state, 'How does DKP work?', { facts })
      assert.equal(dkp.intent, INTENTS.DKP_EXPLAIN)
      assert.equal(dkp.state.pendingIntent, null)
    }
  })

  it('item hint still resumes pending affordability (does not abandon)', () => {
    const state = createConversationState()
    state.pendingIntent = INTENTS.AFFORDABILITY
    state.pendingSlots = ['item']
    const out = turn(state, 'Beguiler Circlet')
    assert.equal(out.intent, INTENTS.AFFORDABILITY)
    assert.equal(out.state.pendingIntent, null)
    assert.ok(out.answer.requiredClaims.includes('affordability'))
  })

  it('character name still resumes pending gear assessment', () => {
    const facts = fixtureFacts()
    let state = createConversationState()
    state = turn(state, 'Is this a well geared enchanter?', { facts }).state
    const resumed = turn(state, 'Iaminae', {
      facts,
      upgradeContext: UPGRADE_CTX,
    })
    assert.equal(resumed.intent, INTENTS.GEAR_ASSESSMENT)
    assert.equal(resumed.state.pendingIntent, null)
    assert.equal(resumed.state.selectedCharacterId, 'e1')
  })

  it('mid-discovery sticky leaves for personal roast / balance / capabilities', () => {
    const facts = fixtureFacts()
    const state = createConversationState()
    state.lastIntent = INTENTS.LOOT_DISCOVERY
    state.lastItemName = 'Whip'
    state.lastItemId = '1'
    state.lastDiscovery = {
      query: { zone: 'Plane of Fire', intent: 'list_awards', raw: 'what dropped in PoF' },
      primary: { itemName: 'Whip', itemId: '1', characterName: 'Tandiyen' },
      recognition: { status: 'recognized' },
    }

    const roast = turn(state, 'Roast my DKP spending', { facts })
    assert.equal(roast.intent, INTENTS.SPENDING_ROAST)
    assert.notEqual(roast.intent, INTENTS.LOOT_DISCOVERY)

    const bal = turn(roast.state, 'What is my DKP balance?', { facts })
    assert.equal(bal.intent, INTENTS.BALANCE)
    assert.match(bal.response.text, /42/)

    const caps = turn(bal.state, 'What can you do?', { facts })
    assert.equal(caps.intent, INTENTS.CAPABILITIES)
  })

  it('mid-upgrades leaves for why-broke; shoulder follow-up only with upgrades context', () => {
    resetUpgradeCaches()
    const facts = fixtureFacts()
    const itemStats = {
      ...itemStatsFixture,
      110: {
        name: 'Old Shoulders',
        slot: 'SHOULDERS',
        classes: 'ENC',
        ac: 5,
        mods: [],
        resists: [],
      },
      610: {
        name: 'Silk Lined Shoulderpads',
        slot: 'SHOULDERS',
        classes: 'ENC',
        ac: 30,
        mods: [],
        resists: [],
      },
    }
    const rankings = {
      ...rankingsFixture,
      characters: [
        {
          name: 'Iaminae',
          class: 'Enchanter',
          overall_score: 800,
          inventory: [
            { slot_id: 2, item_id: 100, item_name: 'Old Circlet' },
            { slot_id: 6, item_id: 110, item_name: 'Old Shoulders' },
          ],
        },
        rankingsFixture.characters[1],
        rankingsFixture.characters[2],
      ],
    }
    const upgradeContext = {
      rankings,
      itemStats,
      raidItemIds: new Set([100, 501, 110, 610]),
    }

    let state = createConversationState()
    const buy = turn(state, 'What should I buy for Iaminae?', { facts, upgradeContext })
    assert.equal(buy.intent, INTENTS.UPGRADES)
    state = buy.state

    const broke = turn(state, 'Why am I broke?', { facts, upgradeContext })
    assert.equal(broke.intent, INTENTS.WHY_BROKE)
    assert.match(broke.response.text, /42/)
    state = broke.state
    assert.notEqual(state.lastIntent, INTENTS.UPGRADES)

    // After leaving upgrades, a non-slot roast question still works
    const roast = turn(state, 'Roast my DKP spending', { facts, upgradeContext })
    assert.equal(roast.intent, INTENTS.SPENDING_ROAST)
    state = roast.state

    // Slot follow-up only when upgrades context is intentional again
    const buyAgain = turn(createConversationState(), 'What should I buy for Iaminae?', {
      facts,
      upgradeContext,
    })
    assert.equal(buyAgain.intent, INTENTS.UPGRADES)
    const again = turn(buyAgain.state, 'what about shoulder?', { facts, upgradeContext })
    assert.equal(again.intent, INTENTS.UPGRADES)
  })

  it('UNKNOWN while pending does not clear pending (user can still clarify)', () => {
    const facts = fixtureFacts()
    let state = createConversationState()
    state = turn(state, 'Is this a well geared enchanter?', { facts }).state
    assert.equal(state.pendingIntent, INTENTS.GEAR_ASSESSMENT)

    const unk = turn(state, 'What is the meaning of life?', { facts })
    assert.equal(unk.intent, INTENTS.UNKNOWN)
    assert.equal(unk.state.pendingIntent, INTENTS.GEAR_ASSESSMENT)

    const resumed = turn(unk.state, 'Iaminae', { facts, upgradeContext: UPGRADE_CTX })
    assert.equal(resumed.intent, INTENTS.GEAR_ASSESSMENT)
    assert.equal(resumed.state.pendingIntent, null)
  })
})

describe('roastBot cross-flow matrix', () => {
  it('discovery sticky item → how much was it (ITEM_PRICE)', () => {
    const facts = fixtureFacts()
    const state = createConversationState()
    state.lastIntent = INTENTS.LOOT_DISCOVERY
    state.lastItemName = 'Beguiler Circlet'
    state.lastItemId = '501'
    state.lastDiscovery = {
      query: { itemName: 'Beguiler Circlet', intent: 'last_award', raw: 'when did Beguiler Circlet last drop' },
      primary: { itemName: 'Beguiler Circlet', itemId: '501' },
      recognition: { status: 'recognized' },
    }
    const out = turn(state, 'How much was it?', { facts })
    assert.equal(out.intent, INTENTS.ITEM_PRICE)
    assert.match(out.response.text, /Beguiler Circlet/i)
    assert.match(out.response.text, /200|220/)
  })

  it('discovery → ITEM_FIT regression pointer', () => {
    const BAND = 'Band of the Eternal'
    const facts = fixtureFacts({
      itemCatalog: [
        { name: 'Beguiler Circlet', itemId: 501 },
        { name: BAND, itemId: 90003 },
      ],
      knownItemSources: {
        'band of the eternal': {
          zone: 'Plane of Time',
          mob: 'Quarm',
          displayName: BAND,
          itemId: 90003,
        },
      },
    })
    const state = createConversationState()
    state.lastIntent = INTENTS.LOOT_DISCOVERY
    state.lastItemName = BAND
    state.lastItemId = '90003'
    state.lastDiscovery = {
      query: { boss: 'Quarm', slot: 'FINGER', intent: 'last_award', raw: 'quarm ring' },
      primary: { itemName: BAND, itemId: '90003' },
      recognition: { status: 'recognized' },
    }
    const itemStats = {
      ...itemStatsFixture,
      80001: { name: 'Old Ring', slot: 'FINGER', classes: 'ENC', ac: 5, mods: [], resists: [] },
      90003: { name: BAND, slot: 'FINGER', classes: 'ENC', ac: 40, mods: [], resists: [] },
    }
    const rankings = {
      classWeights: { Enchanter: { ac_pct: 1, hp_pct: 0, mana_pct: 0, resists_pct: 0 } },
      focusCandidates: {},
      characters: [
        {
          name: 'Iaminae',
          class: 'Enchanter',
          inventory: [{ slot_id: 15, item_id: 80001, item_name: 'Old Ring' }],
        },
      ],
    }
    const out = turn(state, 'which of my toons could use this ring', {
      facts,
      upgradeContext: { rankings, itemStats, raidItemIds: new Set([80001, 90003]) },
    })
    assert.equal(out.intent, INTENTS.ITEM_FIT)
    assert.match(out.response.text, /Band of the Eternal/i)
  })

  it('discovery context → WHO_IS wins with prefetch', () => {
    const state = createConversationState()
    state.lastIntent = INTENTS.LOOT_DISCOVERY
    state.lastDiscovery = {
      query: { intent: 'list_awards', raw: 'loot' },
      primary: { itemName: 'Whip' },
      recognition: { status: 'recognized' },
    }
    const out = turn(state, 'who is Tandiyen', {
      discoveryAnswer: sampleDiscoveryAnswer(),
      whoIsName: 'Tandiyen',
      whoIsResult: {
        status: 'ok',
        characterName: 'Tandiyen',
        accountId: 'a1',
        accountName: 'RaidDad',
        lastRaidDate: '2026-02-14',
        charId: '7',
      },
    })
    assert.equal(out.intent, INTENTS.WHO_IS)
    assert.match(out.response.text, /RaidDad/)
  })

  it('who-is → why-broke / balance (no loot hijack)', () => {
    const facts = fixtureFacts()
    runScript(
      [
        {
          text: 'who is Tandiyen',
          opts: {
            whoIsName: 'Tandiyen',
            whoIsResult: {
              status: 'ok',
              characterName: 'Tandiyen',
              accountId: 'a1',
              accountName: 'RaidDad',
              lastRaidDate: '2026-02-14',
              charId: '7',
            },
          },
          assert: (out) => assert.equal(out.intent, INTENTS.WHO_IS),
        },
        {
          text: 'Why am I broke?',
          assert: (out) => {
            assert.equal(out.intent, INTENTS.WHY_BROKE)
            assert.match(out.response.text, /42/)
            assert.equal(out.intent, INTENTS.WHY_BROKE)
          },
        },
        {
          text: 'What is my DKP balance?',
          assert: (out) => {
            assert.equal(out.intent, INTENTS.BALANCE)
            assert.match(out.response.text, /42/)
          },
        },
      ],
      { facts },
    )
  })

  it('upgrades cards → affordability / price on sticky candidate', () => {
    const facts = fixtureFacts()
    const first = turn(createConversationState(), 'What should I buy for Iaminae?', {
      facts,
      upgradeContext: UPGRADE_CTX,
    })
    assert.equal(first.intent, INTENTS.UPGRADES)
    assert.ok(first.state.lastItemName)

    const afford = turn(first.state, `Can I afford ${first.state.lastItemName}?`, {
      facts,
      upgradeContext: UPGRADE_CTX,
    })
    assert.equal(afford.intent, INTENTS.AFFORDABILITY)
    assert.ok(
      afford.answer.requiredClaims.includes('affordability') ||
        afford.answer.requiredClaims.includes('price_unknown'),
      afford.response.text,
    )

    const price = turn(afford.state, 'How much was it?', { facts, upgradeContext: UPGRADE_CTX })
    assert.equal(price.intent, INTENTS.ITEM_PRICE)
    assert.match(price.response.text, new RegExp(first.state.lastItemName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
  })

  it('spending roast → DEFENSE', () => {
    const facts = fixtureFacts()
    runScript(
      [
        {
          text: 'Roast my DKP spending',
          assert: (out) => assert.equal(out.intent, INTENTS.SPENDING_ROAST),
        },
        {
          text: 'But I needed it',
          assert: (out) => {
            assert.equal(out.intent, INTENTS.DEFENSE)
            assert.ok(out.answer.requiredClaims.includes('defense'))
          },
        },
      ],
      { facts },
    )
  })

  it('capabilities → discovery-prefetched ask still works', () => {
    const facts = fixtureFacts()
    runScript(
      [
        {
          text: 'What can you do?',
          assert: (out) => assert.equal(out.intent, INTENTS.CAPABILITIES),
        },
        {
          text: 'What dropped last time in PoF?',
          opts: { discoveryAnswer: sampleDiscoveryAnswer({ intent: INTENTS.LOOT_DISCOVERY }) },
          assert: (out) => {
            assert.equal(out.intent, INTENTS.LOOT_DISCOVERY)
            assert.match(out.response.text, /Plane of Fire|recorded loot/i)
          },
        },
      ],
      { facts },
    )
  })

  it('pending character → unrelated intent abandons (cross-flow)', () => {
    const facts = fixtureFacts()
    const clarify = turn(createConversationState(), 'Is this a well geared enchanter?', { facts })
    assert.equal(clarify.state.pendingIntent, INTENTS.GEAR_ASSESSMENT)

    const roast = turn(clarify.state, 'Roast my DKP spending', { facts })
    assert.equal(roast.intent, INTENTS.SPENDING_ROAST)
    assert.equal(roast.state.pendingIntent, null)
  })

  it('ACCOUNT_COMPARISON behaves as balance facts', () => {
    const out = turn(createConversationState(), 'compared to other players')
    assert.equal(out.intent, INTENTS.ACCOUNT_COMPARISON)
    assert.ok(out.answer.requiredClaims.includes('balance'))
  })

  it('FULL_GEAR_COST after upgrades still refuses', () => {
    const facts = fixtureFacts()
    const buy = turn(createConversationState(), 'What should I buy for Iaminae?', {
      facts,
      upgradeContext: UPGRADE_CTX,
    })
    assert.equal(buy.intent, INTENTS.UPGRADES)

    const total = turn(buy.state, 'How much DKP to fully gear my enchanter?', {
      facts,
      upgradeContext: UPGRADE_CTX,
    })
    assert.equal(total.intent, INTENTS.FULL_GEAR_COST)
    assert.equal(total.response.text, FULL_GEAR_COST_REFUSAL)
  })

  it('new upgrades ask mentioning character abandons pending gear clarify', () => {
    const facts = fixtureFacts()
    const clarify = turn(createConversationState(), 'Is this a well geared enchanter?', { facts })
    assert.equal(clarify.state.pendingIntent, INTENTS.GEAR_ASSESSMENT)

    const buy = turn(clarify.state, 'What should I buy for Iaminae?', {
      facts,
      upgradeContext: UPGRADE_CTX,
    })
    assert.equal(buy.intent, INTENTS.UPGRADES)
    assert.equal(buy.state.pendingIntent, null)
    assert.ok(buy.response.cards?.length > 0)
  })
})
