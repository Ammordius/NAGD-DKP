import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  handleMessage,
  createConversationState,
  INTENTS,
  FULL_GEAR_COST_REFUSAL,
  responseImpliesCharacterAbsence,
  resetUpgradeCaches,
  loadClassRankings,
} from './index.js'
import {
  fixtureFacts,
  rankingsFixture,
  itemStatsFixture,
} from './test/dialogueHarness.js'

describe('roastBot dialogue acceptance', () => {
  it('asks which enchanter for gear assessment when two exist', () => {
    const facts = fixtureFacts()
    const { response, state, intent, answer } = handleMessage({
      text: 'Is this a well geared enchanter?',
      facts,
      state: createConversationState(),
      rng: () => 0,
    })
    assert.equal(intent, INTENTS.GEAR_ASSESSMENT)
    assert.equal(state.pendingIntent, INTENTS.GEAR_ASSESSMENT)
    assert.deepEqual(state.pendingSlots, ['character'])
    assert.match(response.text, /which enchanter/i)
    assert.match(response.text, /Iaminae/i)
    assert.match(response.text, /Charmalt/i)
    assert.ok(answer.requiredClaims.includes('need_character'))
  })

  it('Iaminae after clarification computes Iaminae gear assessment, not a generic joke', () => {
    const facts = fixtureFacts()
    let state = createConversationState()
    const first = handleMessage({
      text: 'Is this a well geared enchanter?',
      facts,
      state,
      rng: () => 0,
    })
    state = first.state
    const second = handleMessage({
      text: 'Iaminae',
      facts,
      state,
      upgradeContext: {
        rankings: rankingsFixture,
        itemStats: itemStatsFixture,
        raidItemIds: new Set([100, 501]),
      },
      rng: () => 0,
    })
    assert.equal(second.intent, INTENTS.GEAR_ASSESSMENT)
    assert.equal(second.state.pendingIntent, null)
    assert.equal(second.state.selectedCharacterId, 'e1')
    assert.match(second.response.text, /Iaminae/i)
    assert.match(second.response.text, /%/)
    assert.ok(second.response.requiredClaims.includes('gear_pct') || second.response.text.includes('%'))
    assert.ok(second.response.referenced.characters.includes('Iaminae'))
    assert.equal(second.response.templateId === 'A01' || /authorized them/.test(second.response.text), false)
    // Roast-first assessment (not a Magelo methodology dump)
    assert.match(second.response.text, /geared|buttons|rotation|shopping list|excuses|%|unavailable|invent/i)
    assert.doesNotMatch(second.response.text, /This is not a claim of true BiS/i)
  })

  it('strong gear assessment still insults play skill', () => {
    const facts = fixtureFacts()
    const { response, intent } = handleMessage({
      text: 'Is Iaminae geared?',
      facts,
      state: createConversationState(),
      upgradeContext: {
        rankings: {
          ...rankingsFixture,
          characters: rankingsFixture.characters.map((c) =>
            c.name === 'Iaminae' ? { ...c, overall_score: 980 } : c,
          ),
        },
        itemStats: itemStatsFixture,
        raidItemIds: new Set([100, 501]),
      },
      rng: () => 0,
    })
    assert.equal(intent, INTENTS.GEAR_ASSESSMENT)
    assert.match(response.text, /Iaminae/)
    assert.match(response.text, /9[0-9]%/)
    assert.match(response.text, /buttons|fight|rotation|damned/i)
    assert.ok(response.text.length <= 320, `too long: ${response.text.length}`)
  })

  it('Why am I broke returns balance and verified spending facts, not a greeting', () => {
    const facts = fixtureFacts()
    const { response, intent, answer } = handleMessage({
      text: 'Why am I broke?',
      facts,
      state: createConversationState(),
      rng: () => 0,
    })
    assert.equal(intent, INTENTS.WHY_BROKE)
    assert.match(response.text, /42/)
    assert.match(response.text, /Beguiler Circlet|220/i)
    assert.ok(answer.requiredClaims.includes('balance'))
    assert.equal(/disappointed already|Welcome to the DKP Inquisitor/i.test(response.text), false)
    assert.ok(response.text.length <= 320, `too long: ${response.text.length}`)
  })

  it('How does DKP work actually explains DKP', () => {
    const { response, intent, answer } = handleMessage({
      text: 'How does DKP work?',
      facts: fixtureFacts(),
      state: createConversationState(),
      rng: () => 0,
    })
    assert.equal(intent, INTENTS.DKP_EXPLAIN)
    assert.ok(answer.requiredClaims.includes('dkp_earn'))
    assert.match(response.text, /earn/i)
    assert.match(response.text, /spend/i)
    assert.match(response.text, /balance/i)
  })

  it('What should I buy for Iaminae returns verified upgrade cards', () => {
    const facts = fixtureFacts()
    const withData = handleMessage({
      text: 'What should I buy for Iaminae?',
      facts,
      state: createConversationState(),
      upgradeContext: {
        rankings: rankingsFixture,
        itemStats: itemStatsFixture,
        raidItemIds: new Set([100, 501]),
      },
      rng: () => 0,
    })
    assert.equal(withData.intent, INTENTS.UPGRADES)
    assert.ok(withData.response.cards?.length > 0, `expected upgrade cards: ${withData.response.text}`)
    assert.equal(withData.response.cards[0].itemName, 'Beguiler Circlet')
    assert.ok(withData.response.referenced.items.includes('Beguiler Circlet'))
    assert.ok(withData.answer.requiredClaims.includes('upgrade_candidates'))

    const missing = handleMessage({
      text: 'What should I buy for Iaminae?',
      facts,
      state: createConversationState(),
      upgradeContext: null,
      rng: () => 0,
    })
    assert.match(missing.response.text, /Magelo|unavailable|not loaded|invent/i)
    assert.ok(missing.answer.requiredClaims.includes('magelo_unavailable'))
  })

  it('which of my toons could use this ring after sticky Quarm ring uses Magelo fit', () => {
    const BAND = 'Band of the Eternal'
    const facts = fixtureFacts({
      itemCatalog: [
        { name: 'Beguiler Circlet', itemId: 501 },
        { name: 'Smooth Onyx Torque', itemId: 99 },
        { name: BAND, itemId: 90003 },
      ],
      knownItemSources: {
        'beguiler circlet': { zone: 'Plane of Time', mob: 'Quarm' },
        'smooth onyx torque': { zone: 'Plane of Time', mob: 'Quarm' },
        'band of the eternal': {
          zone: 'Plane of Time',
          mob: 'Quarm',
          displayName: BAND,
          itemId: 90003,
        },
      },
    })
    const itemStats = {
      ...itemStatsFixture,
      80001: {
        name: 'Old Ring',
        slot: 'FINGER',
        classes: 'ENC WAR',
        ac: 5,
        mods: [],
        resists: [],
      },
      90003: {
        name: BAND,
        slot: 'FINGER',
        classes: 'ENC',
        ac: 40,
        mods: [],
        resists: [],
      },
    }
    const rankings = {
      classWeights: {
        Enchanter: { ac_pct: 1, hp_pct: 0, mana_pct: 0, resists_pct: 0 },
        Warrior: { ac_pct: 1, hp_pct: 0, mana_pct: 0, resists_pct: 0 },
        Cleric: { ac_pct: 1, hp_pct: 0, mana_pct: 0, resists_pct: 0 },
      },
      focusCandidates: {},
      characters: [
        {
          name: 'Iaminae',
          class: 'Enchanter',
          inventory: [{ slot_id: 15, item_id: 80001, item_name: 'Old Ring' }],
        },
        {
          name: 'Charmalt',
          class: 'Enchanter',
          inventory: [{ slot_id: 15, item_id: 80001, item_name: 'Old Ring' }],
        },
        {
          name: 'Zender',
          class: 'Warrior',
          inventory: [{ slot_id: 15, item_id: 80001, item_name: 'Old Ring' }],
        },
        {
          name: 'Zenderheals',
          class: 'Cleric',
          inventory: [{ slot_id: 15, item_id: 80001, item_name: 'Old Ring' }],
        },
      ],
    }
    const state = createConversationState()
    state.lastIntent = INTENTS.LOOT_DISCOVERY
    state.lastItemName = BAND
    state.lastItemId = '90003'
    state.lastDiscovery = {
      query: { boss: 'Quarm', slot: 'FINGER', intent: 'last_award', raw: 'when did quarm last drop a ring' },
      primary: { itemName: BAND, itemId: '90003', characterName: 'Helen' },
      recognition: { status: 'recognized' },
    }

    const out = handleMessage({
      text: 'which of my toons could use this ring',
      facts,
      state,
      upgradeContext: {
        rankings,
        itemStats,
        raidItemIds: new Set([100, 501, 80001, 90003]),
      },
      rng: () => 0,
    })
    assert.equal(out.intent, INTENTS.ITEM_FIT)
    assert.ok(out.answer.requiredClaims.includes('item_fit_upgrades'), out.response.text)
    assert.match(out.response.text, /Band of the Eternal/i)
    assert.match(out.response.text, /Iaminae|Charmalt/i)
    assert.match(out.response.text, /Zender/i)
    assert.match(out.response.text, /wrong class|Not for/i)
    assert.ok(out.response.cards?.length > 0)
    assert.equal(out.response.cards[0].itemName, BAND)
  })

  it('after recommending Earthen Bracer of Fortitude, where it drops returns Quarm / Plane of Time', () => {
    const EARTHEN = 'Earthen Bracer of Fortitude'
    const facts = fixtureFacts({
      // Not owned — must resolve via known sources / Magelo recommend catalog
      itemCatalog: [
        { name: 'Beguiler Circlet', itemId: 501 },
        { name: 'Smooth Onyx Torque', itemId: 99 },
      ],
      knownItemSources: {
        'beguiler circlet': { zone: 'Plane of Time', mob: 'Quarm', displayName: 'Beguiler Circlet' },
        'smooth onyx torque': { zone: 'Plane of Time', mob: 'Quarm', displayName: 'Smooth Onyx Torque' },
        'earthen bracer of fortitude': {
          zone: 'Plane of Time',
          mob: 'Quarm',
          displayName: EARTHEN,
          itemId: 32100,
          sources: [{ mob: 'Quarm', zone: 'Plane of Time' }],
        },
      },
    })
    const earthenStats = {
      ...itemStatsFixture,
      200: {
        name: 'Old Bracer',
        slot: 'WRIST',
        classes: 'ENC',
        ac: 5,
        mods: [],
        resists: [],
      },
      32100: {
        name: EARTHEN,
        slot: 'WRIST',
        classes: 'ENC',
        ac: 40,
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
            { slot_id: 9, item_id: 200, item_name: 'Old Bracer' },
          ],
        },
        {
          name: 'Charmalt',
          class: 'Enchanter',
          overall_score: 500,
          inventory: [{ slot_id: 2, item_id: 100, item_name: 'Old Circlet' }],
        },
        {
          name: 'TopEnc',
          class: 'Enchanter',
          overall_score: 1000,
          inventory: [],
        },
      ],
    }
    const upgradeContext = {
      rankings,
      itemStats: earthenStats,
      raidItemIds: new Set([100, 501, 200, 32100]),
    }

    let state = createConversationState()
    const first = handleMessage({
      text: 'What should I buy for Iaminae?',
      facts,
      state,
      upgradeContext,
      rng: () => 0,
    })
    assert.equal(first.intent, INTENTS.UPGRADES)
    assert.ok(first.response.cards?.some((c) => c.itemName === EARTHEN), first.response.text)
    const earthenCard = first.response.cards.find((c) => c.itemName === EARTHEN)
    assert.equal(earthenCard.zone, 'Plane of Time')
    assert.ok(first.response.referenced.items.includes(EARTHEN))
    state = first.state

    const second = handleMessage({
      text: `Where does ${EARTHEN} drop?`,
      facts,
      state,
      upgradeContext,
      rng: () => 0,
    })
    assert.equal(second.intent, INTENTS.ITEM_SOURCE)
    assert.ok(!second.answer.requiredClaims.includes('item_unmatched'))
    assert.ok(!second.answer.requiredClaims.includes('source_unknown'))
    assert.ok(second.answer.requiredClaims.includes('item_source'))
    assert.match(second.response.text, /Quarm/i)
    assert.match(second.response.text, /Plane of Time/i)
  })

  it('How much was it after discussing an item resolves the correct item', () => {
    const facts = fixtureFacts()
    let state = createConversationState()
    const first = handleMessage({
      text: 'How much is Beguiler Circlet?',
      facts,
      state,
      rng: () => 0,
    })
    assert.match(first.response.text, /200|220/)
    assert.ok(first.response.referenced.items.includes('Beguiler Circlet'))
    state = first.state
    const second = handleMessage({
      text: 'How much was it?',
      facts,
      state,
      rng: () => 0,
    })
    assert.equal(second.intent, INTENTS.ITEM_PRICE)
    assert.match(second.response.text, /Beguiler Circlet/i)
    assert.match(second.response.text, /200|220/)
  })

  it('unrelated follow-up does not attach stale item links', () => {
    const facts = fixtureFacts()
    let state = createConversationState()
    const first = handleMessage({
      text: 'How much is Beguiler Circlet?',
      facts,
      state,
      rng: () => 0,
    })
    state = first.state
    const second = handleMessage({
      text: 'What is the meaning of life?',
      facts,
      state,
      rng: () => 0,
    })
    assert.equal(second.intent, INTENTS.UNKNOWN)
    assert.equal(second.response.links.length, 0)
    assert.ok(second.response.requiredClaims.includes('unknown_no_analysis'))
    assert.match(second.response.text, /did not perform an analysis|Try asking/i)
  })

  it('warrior attendance does not imply cleric absence', () => {
    const facts = fixtureFacts()
    const { response } = handleMessage({
      text: "How's my raiding?",
      facts,
      state: createConversationState(),
      rng: () => 0,
    })
    assert.equal(responseImpliesCharacterAbsence(response.text, ['Zenderheals', 'cleric']), false)
  })

  it('refuses total gearing DKP costs', () => {
    const { response, intent } = handleMessage({
      text: 'How much DKP to fully gear my enchanter?',
      facts: fixtureFacts(),
      state: createConversationState(),
      rng: () => 0,
    })
    assert.equal(intent, INTENTS.FULL_GEAR_COST)
    assert.equal(response.text, FULL_GEAR_COST_REFUSAL)
  })

  it('price answers include the historical price (not a general-only joke)', () => {
    const { response, answer } = handleMessage({
      text: 'How much is Smooth Onyx Torque?',
      facts: fixtureFacts(),
      state: createConversationState(),
      rng: () => 0,
    })
    assert.match(response.text, /150/)
    assert.ok(answer.requiredClaims.includes('last_sale'))
    assert.ok(response.referenced.items.includes('Smooth Onyx Torque'))
  })

  it('failed Magelo fetch does not permanently block retries', async () => {
    resetUpgradeCaches()
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return { ok: false, status: 404, json: async () => null }
    }
    try {
      const first = await loadClassRankings('/missing-rankings.json')
      assert.equal(first.ok, false)
      assert.equal(first.error, 'http_404')
      const second = await loadClassRankings('/missing-rankings.json')
      assert.equal(second.ok, false)
      assert.ok(calls >= 2, `expected retry fetch, got ${calls} calls`)
    } finally {
      globalThis.fetch = originalFetch
      resetUpgradeCaches()
    }
  })

  it('character dropdown scopes spending; Auto stays account-wide', () => {
    const facts = fixtureFacts()
    const state = createConversationState()
    state.selectedCharacterId = 'w1'
    const scoped = handleMessage({
      text: 'What was my worst purchase?',
      facts,
      state,
      rng: () => 0,
    })
    assert.match(scoped.response.text, /Smooth Onyx Torque/i)
    assert.equal(scoped.response.text.includes('Beguiler Circlet'), false)

    const accountWide = handleMessage({
      text: 'What was my worst purchase?',
      facts,
      state: createConversationState(),
      rng: () => 0,
    })
    assert.match(accountWide.response.text, /Beguiler Circlet/i)
  })

  it('price outlier median matches the cited purchase only', () => {
    const facts = fixtureFacts({
      lootRows: [
        {
          id: 10,
          item_name: 'Cheap Spike',
          cost: 100,
          char_id: 'e1',
          character_name: 'Iaminae',
          assigned_char_id: 'e1',
          assigned_character_name: 'Iaminae',
          sale_date: '2026-09-20',
        },
        {
          id: 11,
          item_name: 'Serpent of Vindication',
          cost: 51,
          char_id: 'e1',
          character_name: 'Iaminae',
          assigned_char_id: 'e1',
          assigned_character_name: 'Iaminae',
          sale_date: '2026-09-10',
        },
      ],
      comparableSalesByItem: {
        'cheap spike': [90, 95, 100],
        'serpent of vindication': [2, 2, 3, 2],
      },
    })
    assert.equal(facts.biggestPurchase.itemName, 'Cheap Spike')
    assert.ok(facts.priceOutliers.some((o) => o.itemName === 'Serpent of Vindication'))
    const { response, answer } = handleMessage({
      text: 'Roast my DKP spending',
      facts,
      state: createConversationState(),
      rng: () => 0,
    })
    // Must not pair Cheap Spike cost with Serpent median
    if (answer.placeholders?.medianPrice != null) {
      assert.equal(answer.placeholders.item, answer.purchase?.itemName)
      assert.equal(answer.placeholders.medianPrice, answer.purchase?.medianPrice)
      assert.notEqual(answer.placeholders.item, 'Cheap Spike')
    }
    assert.ok(response.text)
  })
})

describe('roastBot open-gate contract', () => {
  it('RoastBot gates SWR keys on open', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const path = await import('node:path')
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../components/RoastBot.jsx'),
      'utf8',
    )
    assert.match(src, /botActive = open && !factsOverride/)
    assert.match(src, /enabled: botActive && Boolean\(userId\)/)
    assert.match(src, /botActive && userId \? 'roast-bot-sale-costs'/)
    assert.match(src, /needsMageloContext/)
    assert.match(src, /isCharacterSwapFollowUp/)
    assert.match(src, /extractCharacterSwapFollowUp/)
    assert.match(src, /recognizeDiscovery/)
    assert.match(src, /runDiscovery/)
    assert.match(src, /looksLikeWhoIs/)
    assert.match(src, /lookupWhoIs/)
  })
})

describe('loot discovery dialogue regression', () => {
  it('capabilities mentions discovery without breaking roast why-broke', () => {
    const facts = fixtureFacts()
    const caps = handleMessage({
      text: 'What can you ask?',
      facts,
      state: createConversationState(),
      rng: () => 0,
    })
    assert.equal(caps.intent, INTENTS.CAPABILITIES)
    assert.match(caps.response.text, /loot intel|who got|what dropped/i)
    assert.match(caps.response.text, /who is|owns a toon/i)
    assert.ok(caps.suggestions.some((s) => /what dropped off quarm/i.test(s)))

    const broke = handleMessage({
      text: 'Why am I broke?',
      facts,
      state: createConversationState(),
      rng: () => 0,
    })
    assert.equal(broke.intent, INTENTS.WHY_BROKE)
    assert.match(broke.response.text, /42/)
  })

  it('discovery phrasing with prefetched answer does not fall through to item_source', () => {
    const facts = fixtureFacts()
    const discoveryAnswer = {
      intent: INTENTS.LOOT_DISCOVERY,
      category: 'general',
      factText: 'Last Plane of Fire raid — 2026-03-01\n1 recorded loot award.',
      requiredClaims: ['loot_discovery'],
      placeholders: {},
      referenced: { characters: ['Tandiyen'], items: ['Whip'], raids: [{ id: 'r1', name: 'Fire' }] },
      links: [],
      table: {
        columns: ['Item', 'Toon', 'Class', 'Date', 'Raid', 'DKP'],
        rows: [
          {
            item: { type: 'item', label: 'Whip', to: '/items/Whip' },
            toon: { type: 'character', label: 'Tandiyen', to: '/characters/Tandiyen' },
            class: 'Wizard',
            date: '2026-03-01',
            raid: { type: 'raid', label: 'Fire', to: '/raids/r1' },
            dkp: '40',
          },
        ],
      },
      reasonCode: 'loot_discovery',
      allowFlavor: true,
      templateId: 'LOOT_DISCOVERY',
    }
    const { response, intent } = handleMessage({
      text: 'What dropped last time in PoF?',
      facts,
      state: createConversationState(),
      discoveryAnswer,
      rng: () => 0,
    })
    assert.equal(intent, INTENTS.LOOT_DISCOVERY)
    assert.match(response.text, /Plane of Fire|recorded loot/i)
    assert.equal(response.table?.rows?.[0]?.raid?.to, '/raids/r1')
  })

  it('who is X uses prefetched identity and does not fall through to discovery', () => {
    const facts = fixtureFacts()
    const { response, intent } = handleMessage({
      text: 'who is Tandiyen',
      facts,
      state: createConversationState(),
      whoIsName: 'Tandiyen',
      whoIsResult: {
        status: 'ok',
        characterName: 'Tandiyen',
        accountId: 'a1',
        accountName: 'RaidDad',
        lastRaidDate: '2026-02-14',
        charId: '7',
      },
      rng: () => 0,
    })
    assert.equal(intent, INTENTS.WHO_IS)
    assert.match(response.text, /Tandiyen/)
    assert.match(response.text, /RaidDad/)
    assert.match(response.text, /2026-02-14/)
  })

  it('spent on character after who-is returns spend total not upgrades', () => {
    const facts = fixtureFacts()
    const state = createConversationState()
    state.lastIntent = INTENTS.WHO_IS
    const { response, intent, answer } = handleMessage({
      text: 'how much dkp has been spent on tandiyen',
      facts,
      state,
      characterSpendResult: {
        status: 'ok',
        characterName: 'Tandiyen',
        charId: '7',
        totalSpent: 1840,
      },
      rng: () => 0,
    })
    assert.equal(intent, INTENTS.CHARACTER_DKP_SPENT)
    assert.ok(answer.requiredClaims.includes('character_dkp_spent'))
    assert.match(response.text, /1840/)
    assert.match(response.text, /Tandiyen/)
    assert.match(response.text, /keys|judgment|armor|press/i)
    assert.doesNotMatch(response.text, /cannot suggest upgrades|Magelo rankings data is not loaded|character-attributed loot spend/i)
    assert.ok(response.text.length <= 280, `too long: ${response.text.length}`)
  })

  it('quarm eligibility not in rankings is honest', () => {
    const facts = fixtureFacts()
    const { response, intent, answer } = handleMessage({
      text: 'Is Tandiyen Quarm eligible?',
      facts,
      state: createConversationState(),
      upgradeContext: {
        rankings: rankingsFixture,
        itemStats: itemStatsFixture,
        raidItemIds: new Set(),
      },
      rng: () => 0,
    })
    assert.equal(intent, INTENTS.QUARM_ELIGIBILITY)
    assert.ok(answer.requiredClaims.includes('quarm_not_in_rankings'))
    assert.match(response.text, /not in the current Magelo rankings/i)
  })

  it('gear assessment → what about other linked character reuses GEAR_ASSESSMENT', () => {
    const facts = fixtureFacts()
    const upgradeContext = {
      rankings: rankingsFixture,
      itemStats: itemStatsFixture,
      raidItemIds: new Set([100, 501]),
    }
    let state = createConversationState()
    const first = handleMessage({
      text: 'how well geared is Iaminae',
      facts,
      state,
      upgradeContext,
      rng: () => 0,
    })
    assert.equal(first.intent, INTENTS.GEAR_ASSESSMENT)
    assert.match(first.response.text, /Iaminae/i)
    state = first.state
    assert.equal(state.lastIntent, INTENTS.GEAR_ASSESSMENT)

    const second = handleMessage({
      text: 'what about Charmalt?',
      facts,
      state,
      upgradeContext,
      discoveryRecognition: {
        status: 'unsupported',
        reason: 'I recognized a loot question but could not build a safe query from that phrasing.',
        missing: ['filters'],
      },
      rng: () => 0,
    })
    assert.equal(second.intent, INTENTS.GEAR_ASSESSMENT)
    assert.equal(second.state.selectedCharacterId, 'e2')
    assert.equal(second.state.lastIntent, INTENTS.GEAR_ASSESSMENT)
    assert.match(second.response.text, /Charmalt/i)
    assert.doesNotMatch(second.response.text, /could not build a safe query/i)
  })

  it('spend → what about character reuses CHARACTER_DKP_SPENT with prefetch', () => {
    const facts = fixtureFacts()
    let state = createConversationState()
    const first = handleMessage({
      text: 'how much dkp has been spent on Iaminae',
      facts,
      state,
      characterSpendResult: {
        status: 'ok',
        characterName: 'Iaminae',
        charId: 'e1',
        totalSpent: 220,
      },
      rng: () => 0,
    })
    assert.equal(first.intent, INTENTS.CHARACTER_DKP_SPENT)
    state = first.state

    const second = handleMessage({
      text: 'what about Zender?',
      facts,
      state,
      characterSpendResult: {
        status: 'ok',
        characterName: 'Zender',
        charId: 'w1',
        totalSpent: 90,
      },
      discoveryRecognition: {
        status: 'unsupported',
        reason: 'I recognized a loot question but could not build a safe query from that phrasing.',
        missing: ['filters'],
      },
      rng: () => 0,
    })
    assert.equal(second.intent, INTENTS.CHARACTER_DKP_SPENT)
    assert.match(second.response.text, /Zender/i)
    assert.match(second.response.text, /90/)
    assert.doesNotMatch(second.response.text, /could not build a safe query/i)
  })

  it('who-is → what about character reuses WHO_IS with prefetch', () => {
    const facts = fixtureFacts()
    let state = createConversationState()
    const first = handleMessage({
      text: 'who is Tandiyen',
      facts,
      state,
      whoIsName: 'Tandiyen',
      whoIsResult: {
        status: 'ok',
        characterName: 'Tandiyen',
        accountId: 'a1',
        accountName: 'RaidDad',
        lastRaidDate: '2026-02-14',
        charId: '7',
      },
      rng: () => 0,
    })
    assert.equal(first.intent, INTENTS.WHO_IS)
    state = first.state

    const second = handleMessage({
      text: 'what about Badammo?',
      facts,
      state,
      whoIsName: 'Badammo',
      whoIsResult: {
        status: 'ok',
        characterName: 'Badammo',
        accountId: 'a2',
        accountName: 'TankAlts',
        lastRaidDate: '2026-11-02',
        charId: '9',
      },
      discoveryRecognition: {
        status: 'unsupported',
        reason: 'I recognized a loot question but could not build a safe query from that phrasing.',
        missing: ['filters'],
      },
      rng: () => 0,
    })
    assert.equal(second.intent, INTENTS.WHO_IS)
    assert.match(second.response.text, /Badammo/)
    assert.match(second.response.text, /TankAlts/)
    assert.doesNotMatch(second.response.text, /could not build a safe query/i)
  })

  it('unsupported discovery on character swap does not stick lastIntent to loot', () => {
    const facts = fixtureFacts()
    const state = createConversationState()
    state.lastIntent = INTENTS.GEAR_ASSESSMENT
    state.selectedCharacterId = 'e1'
    state.lastSubject = 'Iaminae'
    // Force the failure path: no characterSwapHit if somehow recognition wins —
    // with characterSwapHit, intent is gear; assert lastIntent preserved either way.
    const out = handleMessage({
      text: 'what about Charmalt?',
      facts,
      state,
      upgradeContext: {
        rankings: rankingsFixture,
        itemStats: itemStatsFixture,
        raidItemIds: new Set([100, 501]),
      },
      discoveryRecognition: {
        status: 'unsupported',
        reason: 'I recognized a loot question but could not build a safe query from that phrasing.',
        missing: ['filters'],
      },
      rng: () => 0,
    })
    assert.notEqual(out.intent, INTENTS.LOOT_DISCOVERY)
    assert.equal(out.state.lastIntent, INTENTS.GEAR_ASSESSMENT)
  })

  it('what about shoulder after buy stays UPGRADES and returns slot cards/chips', () => {
    resetUpgradeCaches()
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
      611: {
        name: 'Second Shoulder Pad',
        slot: 'SHOULDERS',
        classes: 'ENC',
        ac: 22,
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
      raidItemIds: new Set([100, 501, 110, 610, 611]),
    }
    const facts = fixtureFacts()

    let state = createConversationState()
    const first = handleMessage({
      text: 'What should I buy for Iaminae?',
      facts,
      state,
      upgradeContext,
      rng: () => 0,
    })
    assert.equal(first.intent, INTENTS.UPGRADES)
    assert.ok(first.state.lastUpgradeSlots?.length > 0)
    assert.ok(
      first.suggestions.some((s) => /what about shoulder/i.test(s)),
      `expected shoulder chip, got ${JSON.stringify(first.suggestions)}`,
    )
    state = first.state

    const second = handleMessage({
      text: 'what about shoulder?',
      facts,
      state,
      upgradeContext,
      discoveryRecognition: {
        status: 'recognized',
        query: { slot: 'SHOULDERS', intent: 'last_award', raw: 'what about shoulder?' },
      },
      rng: () => 0,
    })
    assert.equal(second.intent, INTENTS.UPGRADES)
    assert.ok(second.response.cards?.length >= 1, second.response.text)
    assert.ok(
      second.response.cards.every((c) => /shoulder/i.test(c.slot || '')),
      JSON.stringify(second.response.cards),
    )
    assert.match(second.response.text, /shoulder/i)
    assert.ok(second.answer.requiredClaims.includes('upgrade_candidates'))
  })
})
