import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeCharacterUpgrades,
  countSlotClassMatches,
  findMageloCharacter,
  extractInventory,
  filterItemStatsForRaidLoot,
  resetUpgradeCaches,
  loadClassRankings,
  validateClassRankingsSchema,
  formatMageloLoadError,
  DEFAULT_CLASS_RANKINGS_URL,
} from './upgrades.js'
import { CLASS_TO_ABBREV, computeUpgradesForCharacter } from '../mageloUpgradeEngine.js'
import { handleMessage, createConversationState } from './conversation.js'
import { buildAccountFacts } from './facts.js'
import { buildPlaceholderValues, isEligible } from './rules.js'
import { INTENTS } from './intents.js'

/** AC-only weights — engine reads hp_pct/mana_pct/ac_pct/resists_pct, not STR/AC/CHA. */
const AC_WEIGHTS = { ac_pct: 1, hp_pct: 0, mana_pct: 0, resists_pct: 0 }

/** Score = (ac / 1200) * ac_pct after normalize → ac/1200 when only ac_pct is set. */
const EXPECTED_AC_DELTA_10_TO_40 = (40 - 10) / 1200 // 0.025

function warriorChestFixture() {
  const itemStats = {
    100: {
      name: 'Old Chest',
      slot: 'CHEST',
      classes: 'WAR',
      ac: 10,
      mods: [],
      resists: [],
    },
    200: {
      name: 'New Chest',
      slot: 'CHEST',
      classes: 'WAR',
      ac: 40,
      mods: [],
      resists: [],
    },
  }
  const rankings = {
    classWeights: { Warrior: { ...AC_WEIGHTS } },
    focusCandidates: {},
    characters: [
      {
        name: 'War',
        class: 'Warrior',
        inventory: [{ slot_id: 17, item_id: 100, item_name: 'Old Chest' }],
      },
    ],
  }
  return { itemStats, rankings }
}

describe('roastBot upgrades', () => {
  it('matches Magelo character by name only', () => {
    const rankings = {
      characters: [
        { name: 'Other', class: 'Wizard', inventory: [] },
        { name: 'War', class: 'Warrior', inventory: [{ slot_id: 17, item_id: 100, item_name: 'Old Chest' }] },
      ],
    }
    assert.equal(findMageloCharacter(rankings, 'War').name, 'War')
    assert.equal(findMageloCharacter(rankings, 'Missing'), null)
  })

  it('extracts equipped inventory slots 1–22', () => {
    const inv = extractInventory({
      inventory: [
        { slot_id: 17, item_id: 1, item_name: 'Chest' },
        { slot_id: 99, item_id: 2, item_name: 'Bag' },
      ],
    })
    assert.equal(inv.length, 1)
    assert.equal(inv[0].slot_id, 17)
  })

  it('filters item stats to raid loot ids', () => {
    const filtered = filterItemStatsForRaidLoot(
      { 1: { name: 'A' }, 2: { name: 'B' } },
      new Set([2]),
    )
    assert.deepEqual(Object.keys(filtered), ['2'])
  })

  it('returns missing_magelo without inventing deltas', () => {
    resetUpgradeCaches()
    const result = computeCharacterUpgrades({
      character: { char_id: 'w1', name: 'War', class_name: 'Warrior' },
      rankings: { characters: [], classWeights: { Warrior: { ...AC_WEIGHTS } } },
      itemStats: { 10: { name: 'Better', slot: 'CHEST', classes: 'WAR', ac: 40, mods: [], resists: [] } },
      raidItemIds: new Set([10]),
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'missing_magelo')
    assert.deepEqual(result.suggestions, [])
  })

  it('engine returns bySlot.upgrades (not candidates); reading candidates would discard recommendations', () => {
    const { itemStats, rankings } = warriorChestFixture()
    const ctx = {
      itemStats,
      classWeights: rankings.classWeights,
      focusCandidates: {},
    }
    const engine = computeUpgradesForCharacter(
      { class: 'Warrior', inventory: rankings.characters[0].inventory },
      3,
      false,
      ctx,
    )
    assert.equal(engine.error, undefined)
    assert.ok(engine.bySlot.length >= 1)
    const slot = engine.bySlot[0]
    assert.equal(slot.candidates, undefined)
    assert.ok(Array.isArray(slot.upgrades))
    assert.ok(slot.upgrades.length >= 1, 'engine produced upgrade rows')
    assert.equal(slot.upgrades[0].itemId, 200)
    // Regression: the pre-fix flatten used .candidates and discarded all rows
    const discarded = (slot.candidates || []).length
    assert.equal(discarded, 0)
    assert.ok(slot.upgrades.length > discarded)
  })

  it('computes a deterministic positive upgrade with valid ac_pct weights', () => {
    resetUpgradeCaches()
    const { itemStats, rankings } = warriorChestFixture()
    const result = computeCharacterUpgrades({
      character: { char_id: 'w1', name: 'War', class_name: 'Warrior' },
      rankings,
      itemStats,
      raidItemIds: new Set([100, 200]),
      limit: 3,
    })
    assert.equal(result.ok, true, `expected ok, got ${result.reason}`)
    assert.equal(result.suggestions.length, 1)
    const top = result.suggestions[0]
    assert.equal(top.itemId, 200)
    assert.equal(top.itemName, 'New Chest')
    assert.equal(top.slotId, 17)
    assert.equal(top.slot, 'Chest')
    assert.equal(top.delta, EXPECTED_AC_DELTA_10_TO_40)
    assert.ok(top.delta > 0)
    assert.ok(top.upgrade)
    assert.ok(result.debug)
    assert.equal(result.debug.raidFilteredCount, 2)
    assert.ok(result.debug.matchCount >= 1)
    assert.ok(result.debug.upgradeRowCount >= 1)
  })

  it('raid-loot filter retains legitimate candidates and reports counts', () => {
    resetUpgradeCaches()
    const itemStats = {
      100: { name: 'Old Chest', slot: 'CHEST', classes: 'WAR', ac: 10, mods: [], resists: [] },
      200: { name: 'New Chest', slot: 'CHEST', classes: 'WAR', ac: 40, mods: [], resists: [] },
      999: { name: 'Unrelated Feet', slot: 'FEET', classes: 'WAR', ac: 99, mods: [], resists: [] },
    }
    const filtered = filterItemStatsForRaidLoot(itemStats, new Set([100, 200]))
    assert.deepEqual(Object.keys(filtered).sort(), ['100', '200'])
    assert.equal(Object.keys(filtered).includes('999'), false)

    const rankings = {
      classWeights: { Warrior: { ...AC_WEIGHTS } },
      focusCandidates: {},
      characters: [
        {
          name: 'War',
          class: 'Warrior',
          inventory: [{ slot_id: 17, item_id: 100, item_name: 'Old Chest' }],
        },
      ],
    }
    const result = computeCharacterUpgrades({
      character: { char_id: 'w1', name: 'War', class_name: 'Warrior' },
      rankings,
      itemStats,
      raidItemIds: new Set([100, 200]),
      limit: 3,
    })
    assert.equal(result.ok, true)
    assert.equal(result.suggestions[0].itemId, 200)
    assert.equal(result.debug.raidFilteredCount, 2)
    assert.equal(
      countSlotClassMatches(filtered, [17], CLASS_TO_ABBREV.Warrior),
      result.debug.matchCount,
    )
  })

  it('empty equipped slot still yields a positive upgrade vs baseline 0', () => {
    resetUpgradeCaches()
    const itemStats = {
      200: { name: 'New Chest', slot: 'CHEST', classes: 'WAR', ac: 40, mods: [], resists: [] },
    }
    const rankings = {
      classWeights: { Warrior: { ...AC_WEIGHTS } },
      focusCandidates: {},
      characters: [
        {
          name: 'War',
          class: 'Warrior',
          inventory: [{ slot_id: 17, item_id: null, item_name: '' }],
        },
      ],
    }
    const result = computeCharacterUpgrades({
      character: { char_id: 'w1', name: 'War', class_name: 'Warrior' },
      rankings,
      itemStats,
      raidItemIds: new Set([200]),
      limit: 3,
    })
    assert.equal(result.ok, true, `expected ok, got ${result.reason}`)
    assert.equal(result.suggestions[0].itemId, 200)
    assert.equal(result.suggestions[0].delta, 40 / 1200)
    assert.equal(result.anyMissing, false)
  })

  it('reports missing_equipped_item_stats when equipped id lacks stats and no usable positives', () => {
    resetUpgradeCaches()
    // Equipped 100 missing from stats; only a zero-score candidate (ac 0) remains → no positive upgrades
    const itemStats = {
      200: { name: 'Zero Chest', slot: 'CHEST', classes: 'WAR', ac: 0, mods: [], resists: [] },
    }
    const rankings = {
      classWeights: { Warrior: { ...AC_WEIGHTS } },
      focusCandidates: {},
      characters: [
        {
          name: 'War',
          class: 'Warrior',
          inventory: [{ slot_id: 17, item_id: 100, item_name: 'Ghost Chest' }],
        },
      ],
    }
    const result = computeCharacterUpgrades({
      character: { char_id: 'w1', name: 'War', class_name: 'Warrior' },
      rankings,
      itemStats,
      raidItemIds: new Set([200]),
      limit: 3,
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'missing_equipped_item_stats')
    assert.equal(result.anyMissing, true)
    assert.deepEqual(result.suggestions, [])
  })

  it('reports empty_candidate_set when no slot-matching items remain', () => {
    resetUpgradeCaches()
    // Raid filter keeps a FEET item only; warrior has CHEST equipped → no slot matches
    const itemStats = {
      100: { name: 'Old Chest', slot: 'CHEST', classes: 'WAR', ac: 10, mods: [], resists: [] },
      300: { name: 'Raid Boots', slot: 'FEET', classes: 'WAR', ac: 50, mods: [], resists: [] },
    }
    const rankings = {
      classWeights: { Warrior: { ...AC_WEIGHTS } },
      focusCandidates: {},
      characters: [
        {
          name: 'War',
          class: 'Warrior',
          inventory: [{ slot_id: 17, item_id: 100, item_name: 'Old Chest' }],
        },
      ],
    }
    const result = computeCharacterUpgrades({
      character: { char_id: 'w1', name: 'War', class_name: 'Warrior' },
      rankings,
      itemStats,
      raidItemIds: new Set([300]),
      limit: 3,
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'empty_candidate_set')
    assert.equal(result.debug.matchCount, 0)
    assert.deepEqual(result.suggestions, [])
  })

  it('reports no_positive_upgrades when candidates exist but are not upgrades', () => {
    resetUpgradeCaches()
    const itemStats = {
      100: { name: 'Good Chest', slot: 'CHEST', classes: 'WAR', ac: 40, mods: [], resists: [] },
      200: { name: 'Worse Chest', slot: 'CHEST', classes: 'WAR', ac: 10, mods: [], resists: [] },
    }
    const rankings = {
      classWeights: { Warrior: { ...AC_WEIGHTS } },
      focusCandidates: {},
      characters: [
        {
          name: 'War',
          class: 'Warrior',
          inventory: [{ slot_id: 17, item_id: 100, item_name: 'Good Chest' }],
        },
      ],
    }
    const result = computeCharacterUpgrades({
      character: { char_id: 'w1', name: 'War', class_name: 'Warrior' },
      rankings,
      itemStats,
      raidItemIds: new Set([100, 200]),
      limit: 3,
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'no_positive_upgrades')
    assert.ok(result.debug.matchCount >= 1)
    assert.deepEqual(result.suggestions, [])
  })

  it('handleMessage upgrade path returns distinct recommendations for two differently geared characters', () => {
    resetUpgradeCaches()
    const itemStats = {
      100: { name: 'Old Chest', slot: 'CHEST', classes: 'WAR', ac: 10, mods: [], resists: [] },
      200: { name: 'New Chest', slot: 'CHEST', classes: 'WAR', ac: 40, mods: [], resists: [] },
      110: { name: 'Old Circlet', slot: 'HEAD', classes: 'ENC', ac: 5, mods: [], resists: [] },
      501: { name: 'Beguiler Circlet', slot: 'HEAD', classes: 'ENC', ac: 25, mods: [], resists: [] },
    }
    const rankings = {
      classWeights: {
        Warrior: { ...AC_WEIGHTS },
        Enchanter: { ...AC_WEIGHTS },
      },
      focusCandidates: {},
      characters: [
        {
          name: 'War',
          class: 'Warrior',
          inventory: [{ slot_id: 17, item_id: 100, item_name: 'Old Chest' }],
        },
        {
          name: 'Iaminae',
          class: 'Enchanter',
          inventory: [{ slot_id: 2, item_id: 110, item_name: 'Old Circlet' }],
        },
      ],
    }
    const facts = buildAccountFacts({
      accountId: 'a1',
      currentDkp: 100,
      characters: [
        { char_id: 'w1', name: 'War', class_name: 'Warrior' },
        { char_id: 'e1', name: 'Iaminae', class_name: 'Enchanter' },
      ],
      itemCatalog: [
        { name: 'New Chest', itemId: 200 },
        { name: 'Beguiler Circlet', itemId: 501 },
      ],
    })
    const upgradeContext = {
      rankings,
      itemStats,
      raidItemIds: new Set([100, 200, 110, 501]),
    }

    const war = handleMessage({
      text: 'What should I buy for War?',
      facts,
      state: createConversationState(),
      upgradeContext,
      rng: () => 0,
    })
    assert.equal(war.intent, INTENTS.UPGRADES)
    assert.ok(war.response.cards?.length > 0, war.response.text)
    assert.equal(war.response.cards[0].itemName, 'New Chest')
    assert.ok(war.response.referenced.items.includes('New Chest'))
    assert.match(war.response.text, /New Chest/)

    const enc = handleMessage({
      text: 'What should I buy for Iaminae?',
      facts,
      state: createConversationState(),
      upgradeContext,
      rng: () => 0,
    })
    assert.equal(enc.intent, INTENTS.UPGRADES)
    assert.ok(enc.response.cards?.length > 0, enc.response.text)
    assert.equal(enc.response.cards[0].itemName, 'Beguiler Circlet')
    assert.ok(enc.response.referenced.items.includes('Beguiler Circlet'))
    assert.match(enc.response.text, /Beguiler Circlet/)
    assert.notEqual(war.response.cards[0].itemId, enc.response.cards[0].itemId)
  })

  it('conversation never sums upgrade prices into a gearing total', () => {
    const facts = buildAccountFacts({
      accountId: 'a1',
      currentDkp: 9999,
      characters: [{ char_id: 'w1', name: 'War', class_name: 'Warrior' }],
      recentItemPrices: {
        'new chest': { values: [50], avg: '50' },
        'new legs': { values: [60], avg: '60' },
      },
    })
    const { response } = handleMessage({
      text: 'How much to fully gear my warrior?',
      facts,
      state: createConversationState(),
      rng: () => 0,
    })
    assert.match(response.text, /no reliable fixed|uncertain|refuse to invent/i)
    assert.equal(response.text.includes('110'), false)
  })

  it('defaults Magelo URL to the hosted guild export', () => {
    assert.match(DEFAULT_CLASS_RANKINGS_URL, /ammordius\.github\.io\/NAGD-spell-inventory\/class_rankings\.json/)
  })

  it('validateClassRankingsSchema requires characters and weights', () => {
    assert.equal(validateClassRankingsSchema(null).ok, false)
    assert.equal(validateClassRankingsSchema({ characters: [] }).ok, false)
    assert.equal(
      validateClassRankingsSchema({ characters: [], class_weights: { Warrior: { STR: 1 } } }).ok,
      true,
    )
  })

  it('loadClassRankings reports HTTP errors and retries after failure', async () => {
    resetUpgradeCaches()
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return { ok: false, status: 404, json: async () => ({}) }
    }
    try {
      const first = await loadClassRankings('https://example.test/missing.json')
      assert.equal(first.ok, false)
      assert.equal(first.error, 'http_404')
      assert.match(formatMageloLoadError(first), /HTTP 404/)
      const second = await loadClassRankings('https://example.test/missing.json')
      assert.equal(second.ok, false)
      assert.ok(calls >= 2)
    } finally {
      globalThis.fetch = originalFetch
      resetUpgradeCaches()
    }
  })

  it('loadClassRankings rejects invalid JSON and invalid schema', async () => {
    resetUpgradeCaches()
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => {
        throw new Error('bad json')
      },
    })
    try {
      const badJson = await loadClassRankings('https://example.test/bad.json')
      assert.equal(badJson.ok, false)
      assert.equal(badJson.error, 'invalid_json')
    } finally {
      globalThis.fetch = originalFetch
      resetUpgradeCaches()
    }

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ characters: [{ name: 'X' }] }),
    })
    try {
      const badSchema = await loadClassRankings('https://example.test/noschema.json')
      assert.equal(badSchema.ok, false)
      assert.equal(badSchema.error, 'invalid_schema')
    } finally {
      globalThis.fetch = originalFetch
      resetUpgradeCaches()
    }
  })

  it('loadClassRankings succeeds with valid schema', async () => {
    resetUpgradeCaches()
    const originalFetch = globalThis.fetch
    const payload = {
      characters: [{ name: 'War', class: 'Warrior', inventory: [] }],
      class_weights: { Warrior: { STR: 1 } },
    }
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => payload,
    })
    try {
      const ok = await loadClassRankings('https://example.test/ok.json')
      assert.equal(ok.ok, true)
      assert.equal(ok.rankings.characters[0].name, 'War')
      const cached = await loadClassRankings('https://example.test/ok.json')
      assert.equal(cached.ok, true)
      assert.equal(cached.rankings, ok.rankings)
    } finally {
      globalThis.fetch = originalFetch
      resetUpgradeCaches()
    }
  })

  it('buildPlaceholderValues never mixes purchase item with unrelated outlier median', () => {
    const purchase = { purchaseId: '1', itemName: 'Expensive', cost: 200 }
    const values = buildPlaceholderValues({
      facts: {
        biggestPurchase: purchase,
        priceOutliers: [{ purchaseId: '2', itemName: 'Outlier', cost: 51, medianPrice: 2 }],
      },
      purchase,
    })
    assert.equal(values.item, 'Expensive')
    assert.equal(values.cost, 200)
    assert.equal(values.medianPrice, null)
    assert.equal(
      isEligible('price_outlier', { purchase, facts: { priceOutliers: [{ medianPrice: 2 }] } }),
      false,
    )
    assert.equal(
      isEligible('price_outlier', {
        purchase: { ...purchase, medianPrice: 150 },
        facts: {},
      }),
      true,
    )
  })
})
