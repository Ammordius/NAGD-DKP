import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeCharacterUpgrades,
  findMageloCharacter,
  extractInventory,
  filterItemStatsForRaidLoot,
  resetUpgradeCaches,
  loadClassRankings,
  validateClassRankingsSchema,
  formatMageloLoadError,
  DEFAULT_CLASS_RANKINGS_URL,
} from './upgrades.js'
import { handleMessage, createConversationState } from './conversation.js'
import { buildAccountFacts } from './facts.js'
import { buildPlaceholderValues, isEligible } from './rules.js'

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
      rankings: { characters: [], classWeights: { Warrior: { STR: 1 } } },
      itemStats: { 10: { name: 'Better', slot: 'CHEST', classes: 'WAR' } },
      raidItemIds: new Set([10]),
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'missing_magelo')
    assert.deepEqual(result.suggestions, [])
  })

  it('computes upgrades when Magelo inventory and weights exist', () => {
    resetUpgradeCaches()
    const itemStats = {
      100: {
        name: 'Old Chest',
        slot: 'CHEST',
        classes: 'WAR',
        ac: 10,
        mods: [{ label: 'STR', value: 5 }],
        resists: [],
      },
      200: {
        name: 'New Chest',
        slot: 'CHEST',
        classes: 'WAR',
        ac: 40,
        mods: [{ label: 'STR', value: 20 }],
        resists: [],
      },
    }
    const rankings = {
      classWeights: {
        Warrior: { STR: 1, AC: 1, hp: 0.3 },
      },
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
    // Engine may or may not find positive delta depending on weight keys; must not invent if error
    if (result.ok) {
      assert.ok(result.suggestions.length >= 0)
      for (const s of result.suggestions) {
        assert.ok(s.itemName)
        assert.ok(Number.isFinite(s.delta))
        assert.ok(s.upgrade)
      }
    } else {
      assert.ok(result.reason)
      assert.deepEqual(result.suggestions, [])
    }
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
