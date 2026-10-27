import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAccountFacts,
  handleMessage,
  createConversationState,
  INTENTS,
  FULL_GEAR_COST_REFUSAL,
  responseImpliesCharacterAbsence,
  resetUpgradeCaches,
  loadClassRankings,
} from './index.js'

const iaminae = { char_id: 'e1', name: 'Iaminae', class_name: 'Enchanter' }
const otherEnc = { char_id: 'e2', name: 'Charmalt', class_name: 'Enchanter' }
const warrior = { char_id: 'w1', name: 'Zender', class_name: 'Warrior' }
const cleric = { char_id: 'c1', name: 'Zenderheals', class_name: 'Cleric' }

function fixtureFacts(overrides = {}) {
  return buildAccountFacts({
    accountId: 'acct-1',
    accountName: 'TestAcct',
    currentDkp: 42,
    earnedDkp: 800,
    spentDkp: 758,
    characters: [iaminae, otherEnc, warrior, cleric],
    lootRows: [
      {
        id: 1,
        item_name: 'Beguiler Circlet',
        cost: 220,
        char_id: 'e1',
        character_name: 'Iaminae',
        assigned_char_id: 'e1',
        assigned_character_name: 'Iaminae',
        sale_date: '2026-09-15',
      },
      {
        id: 2,
        item_name: 'Smooth Onyx Torque',
        cost: 90,
        char_id: 'w1',
        character_name: 'Zender',
        sale_date: '2026-08-01',
      },
    ],
    recentItemPrices: {
      'beguiler circlet': { values: [200, 220], avg: '210' },
      'smooth onyx torque': { values: [150], avg: '150' },
    },
    itemCatalog: [
      { name: 'Beguiler Circlet', itemId: 501 },
      { name: 'Smooth Onyx Torque', itemId: 99 },
    ],
    knownItemSources: {
      'beguiler circlet': { zone: 'Plane of Time', mob: 'Quarm' },
      'smooth onyx torque': { zone: 'Plane of Time', mob: 'Quarm' },
    },
    attendanceRows: [
      { raid_id: 'pot', char_id: 'w1', character_name: 'Zender', account_id: 'acct-1' },
    ],
    raidsById: {
      pot: { raid_id: 'pot', raid_name: 'Plane of Time', date_iso: '2026-10-01' },
    },
    guildRaidCountInWindow: 20,
    now: new Date('2026-10-20T12:00:00Z'),
    ...overrides,
  })
}

const rankingsFixture = {
  characters: [
    {
      name: 'Iaminae',
      class: 'Enchanter',
      overall_score: 800,
      inventory: [{ slot_id: 2, item_id: 100, item_name: 'Old Circlet' }],
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
  classWeights: {
    Enchanter: { CHA: 1, INT: 1, AC: 0.2 },
  },
  focusCandidates: {},
}

const itemStatsFixture = {
  100: {
    name: 'Old Circlet',
    slot: 'HEAD',
    classes: 'ENC',
    ac: 5,
    mods: [{ label: 'CHA', value: 5 }],
    resists: [],
  },
  501: {
    name: 'Beguiler Circlet',
    slot: 'HEAD',
    classes: 'ENC',
    ac: 25,
    mods: [{ label: 'CHA', value: 20 }],
    resists: [],
  },
}

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
    assert.ok(second.response.requiredClaims.includes('gear_pct') || second.response.text.includes('Magelo'))
    assert.ok(second.response.referenced.characters.includes('Iaminae'))
    assert.equal(second.response.templateId === 'A01' || /authorized them/.test(second.response.text), false)
    // Must not be a pure general roast without assessment language
    assert.match(second.response.text, /geared|gear score|Magelo|relative|%|unavailable|invent/i)
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
    assert.match(response.text, /Beguiler Circlet|220|800|758/i)
    assert.ok(answer.requiredClaims.includes('balance'))
    assert.equal(/disappointed already|Welcome to the DKP Inquisitor/i.test(response.text), false)
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

  it('What should I buy for Iaminae returns upgrades or explicit missing-data reason', () => {
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
    assert.ok(
      withData.response.cards?.length > 0 ||
        /unavailable|cannot|no verified|invent|no positive|missing/i.test(withData.response.text),
      `unexpected upgrades reply: ${withData.response.text}`,
    )
    if (withData.response.cards?.length) {
      assert.ok(withData.response.referenced.items.length > 0)
    } else {
      assert.ok(withData.answer.requiredClaims.includes('upgrades_unavailable'))
    }

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
      return { ok: false, json: async () => null }
    }
    try {
      const first = await loadClassRankings('/missing-rankings.json')
      assert.equal(first, null)
      const second = await loadClassRankings('/missing-rankings.json')
      assert.equal(second, null)
      assert.ok(calls >= 2, `expected retry fetch, got ${calls} calls`)
    } finally {
      globalThis.fetch = originalFetch
      resetUpgradeCaches()
    }
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
  })
})
