import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeCharacterUpgrades,
  countSlotClassMatches,
  evaluateItemFitForAccount,
  expandRaidLootWithClassArmor,
  findMageloCharacter,
  extractInventory,
  filterItemStatsForRaidLoot,
  resetUpgradeCaches,
  loadClassRankings,
  validateClassRankingsSchema,
  formatMageloLoadError,
  DEFAULT_CLASS_RANKINGS_URL,
  extractUpgradeSlotHint,
  slotIdsFromCanonical,
} from './upgrades.js'
import { seedElementalArmorForTests } from '../elementalArmor.js'
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

  it('extracts equipped inventory slots 1–21', () => {
    const inv = extractInventory({
      inventory: [
        { slot_id: 17, item_id: 1, item_name: 'Chest' },
        { slot_id: 21, item_id: 3, item_name: 'Ammo' },
        { slot_id: 22, item_id: 4, item_name: 'General1 Bag' },
        { slot_id: 99, item_id: 2, item_name: 'Bag' },
      ],
    })
    assert.equal(inv.length, 2)
    assert.equal(inv[0].slot_id, 17)
    assert.equal(inv[1].slot_id, 21)
  })

  it('filters item stats to raid loot ids', () => {
    const filtered = filterItemStatsForRaidLoot(
      { 1: { name: 'A' }, 2: { name: 'B' } },
      new Set([2]),
    )
    assert.deepEqual(Object.keys(filtered), ['2'])
  })

  it('expandRaidLootWithClassArmor injects class armor for raid molds', () => {
    seedElementalArmorForTests({
      50001: {
        mold_name: 'Elemental Chest Mold',
        slot: 'chest',
        armor_type: 'plate',
        by_class: { WAR: 60001 },
      },
    })
    const allStats = {
      50001: { name: 'Elemental Chest Mold', classes: 'ALL', gearScore: 0 },
      60001: {
        name: 'Warrior Elemental Breastplate',
        slot: 'CHEST',
        classes: 'WAR',
        ac: 80,
        mods: [],
        resists: [],
      },
      70001: { name: 'Unrelated', slot: 'FEET', classes: 'WAR', ac: 1, mods: [], resists: [] },
    }
    const { itemStats, armorToMold } = expandRaidLootWithClassArmor(
      allStats,
      new Set([50001]),
      'WAR',
    )
    assert.ok(itemStats['50001'])
    assert.ok(itemStats['60001'])
    assert.equal(itemStats['70001'], undefined)
    assert.equal(armorToMold.get(60001)?.moldName, 'Elemental Chest Mold')
    assert.equal(armorToMold.get(60001)?.moldId, 50001)
  })

  it('computeCharacterUpgrades surfaces mold upgrades with mold display name', () => {
    resetUpgradeCaches()
    seedElementalArmorForTests({
      50001: {
        mold_name: 'Elemental Chest Mold',
        slot: 'chest',
        armor_type: 'plate',
        by_class: { WAR: 60001 },
      },
    })
    const itemStats = {
      100: {
        name: 'Old Chest',
        slot: 'CHEST',
        classes: 'WAR',
        ac: 10,
        mods: [],
        resists: [],
      },
      50001: {
        name: 'Elemental Chest Mold',
        classes: 'ALL',
        gearScore: 0,
      },
      60001: {
        name: 'Warrior Elemental Breastplate',
        slot: 'CHEST',
        classes: 'WAR',
        ac: 40,
        mods: [],
        resists: [],
      },
      7869: {
        name: 'Heavy Yttrium Chestplate',
        slot: 'CHEST',
        classes: 'WAR',
        ac: 11,
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
    const result = computeCharacterUpgrades({
      character: { char_id: 'w1', name: 'War', class_name: 'Warrior' },
      rankings,
      itemStats,
      // Include equipped id so baseline is real gear, not 0
      raidItemIds: new Set([100, 50001, 7869]),
      limit: 3,
    })
    assert.equal(result.ok, true, result.reason)
    assert.ok(result.suggestions.length >= 1)
    const moldHit = result.suggestions.find((s) => s.itemId === 60001)
    assert.ok(moldHit, 'expected class armor from mold in suggestions')
    assert.equal(moldHit.itemName, 'Elemental Chest Mold')
    assert.equal(moldHit.moldName, 'Elemental Chest Mold')
    assert.equal(moldHit.moldId, 50001)
    assert.equal(moldHit.delta, EXPECTED_AC_DELTA_10_TO_40)
    // Tiny raid piece still scores; mold armor should outrank it
    const yttrium = result.suggestions.find((s) => s.itemId === 7869)
    if (yttrium) assert.ok(moldHit.delta > yttrium.delta)
  })

  it('evaluateItemFitForAccount expands sticky mold to class armor', () => {
    resetUpgradeCaches()
    seedElementalArmorForTests({
      50001: {
        mold_name: 'Elemental Chest Mold',
        slot: 'chest',
        armor_type: 'plate',
        by_class: { WAR: 60001, ENC: 60002 },
      },
    })
    const itemStats = {
      100: {
        name: 'Old Chest',
        slot: 'CHEST',
        classes: 'WAR ENC',
        ac: 10,
        mods: [],
        resists: [],
      },
      50001: { name: 'Elemental Chest Mold', classes: 'ALL', gearScore: 0 },
      60001: {
        name: 'Warrior Elemental Breastplate',
        slot: 'CHEST',
        classes: 'WAR',
        ac: 40,
        mods: [],
        resists: [],
      },
      60002: {
        name: 'Enchanter Elemental Robe',
        slot: 'CHEST',
        classes: 'ENC',
        ac: 5,
        mods: [],
        resists: [],
      },
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
          name: 'Enc',
          class: 'Enchanter',
          inventory: [{ slot_id: 17, item_id: 100, item_name: 'Old Chest' }],
        },
      ],
    }
    const result = evaluateItemFitForAccount({
      characters: [
        { char_id: 'w1', name: 'War', class_name: 'Warrior' },
        { char_id: 'e1', name: 'Enc', class_name: 'Enchanter' },
      ],
      itemId: 50001,
      itemName: 'Elemental Chest Mold',
      rankings,
      itemStats,
      raidItemIds: new Set([100, 50001]),
    })
    assert.equal(result.ok, true, result.reason)
    assert.equal(result.itemName, 'Elemental Chest Mold')
    assert.equal(result.itemId, 50001)
    const war = result.fits.find((f) => f.characterName === 'War')
    const enc = result.fits.find((f) => f.characterName === 'Enc')
    assert.ok(war?.isUpgrade)
    assert.ok(war.scoreDelta > 0)
    // ENC armor has lower AC than equipped (ac 5 vs 10) → eligible but not upgrade
    assert.equal(enc?.eligible, true)
    assert.equal(enc?.isUpgrade, false)
    assert.equal(war.candidateName, 'Elemental Chest Mold')
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

  it('evaluateItemFitForAccount scores a ring across toons and flags class mismatch', () => {
    resetUpgradeCaches()
    const itemStats = {
      80001: {
        name: 'Old Ring',
        slot: 'FINGER',
        classes: 'ENC WAR',
        ac: 5,
        mods: [],
        resists: [],
      },
      90003: {
        name: 'Band of the Eternal',
        slot: 'FINGER',
        classes: 'ENC',
        ac: 40,
        mods: [],
        resists: [],
      },
    }
    const rankings = {
      classWeights: {
        Enchanter: { ...AC_WEIGHTS },
        Warrior: { ...AC_WEIGHTS },
      },
      focusCandidates: {},
      characters: [
        {
          name: 'Iaminae',
          class: 'Enchanter',
          inventory: [{ slot_id: 15, item_id: 80001, item_name: 'Old Ring' }],
        },
        {
          name: 'Zender',
          class: 'Warrior',
          inventory: [{ slot_id: 15, item_id: 80001, item_name: 'Old Ring' }],
        },
      ],
    }
    const result = evaluateItemFitForAccount({
      characters: [
        { char_id: 'e1', name: 'Iaminae', class_name: 'Enchanter' },
        { char_id: 'w1', name: 'Zender', class_name: 'Warrior' },
      ],
      itemName: 'Band of the Eternal',
      rankings,
      itemStats,
      raidItemIds: new Set([80001, 90003]),
    })
    assert.equal(result.ok, true, result.reason)
    assert.equal(result.itemName, 'Band of the Eternal')
    assert.equal(result.itemId, 90003)
    const enc = result.fits.find((f) => f.characterName === 'Iaminae')
    const war = result.fits.find((f) => f.characterName === 'Zender')
    assert.ok(enc?.isUpgrade)
    assert.ok(enc.scoreDelta > 0)
    assert.equal(war?.eligible, false)
    assert.equal(war?.reason, 'class_mismatch')
    assert.equal(result.fits[0].characterName, 'Iaminae')
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

  it('extractUpgradeSlotHint resolves shoulder and for-slot phrasing', () => {
    const shoulder = extractUpgradeSlotHint('what about shoulder?')
    assert.equal(shoulder?.canonical, 'SHOULDERS')
    assert.deepEqual(shoulder?.slotIds, [6])
    assert.equal(shoulder?.chipLabel, 'Shoulder')

    const bare = extractUpgradeSlotHint('Shoulders')
    assert.deepEqual(bare?.slotIds, [6])

    const forSlot = extractUpgradeSlotHint('What should I buy for shoulders?')
    assert.deepEqual(forSlot?.slotIds, [6])

    assert.equal(extractUpgradeSlotHint('What should I buy for Iaminae?'), null)
    assert.deepEqual(slotIdsFromCanonical('FINGER'), [15, 16])
  })

  it('extractUpgradeSlotHint handles possessive, punctuation, and noun-first wrist phrasing', () => {
    const possessive = extractUpgradeSlotHint('what about his wrist/.')
    assert.equal(possessive?.canonical, 'WRIST')
    assert.deepEqual(possessive?.slotIds, [9, 10])
    assert.equal(possessive?.chipLabel, 'Wrist')

    const nounFirst = extractUpgradeSlotHint('what wrist upgrades does badammo have')
    assert.equal(nounFirst?.canonical, 'WRIST')
    assert.deepEqual(nounFirst?.slotIds, [9, 10])

    const bareWrist = extractUpgradeSlotHint('wrist')
    assert.deepEqual(bareWrist?.slotIds, [9, 10])

    assert.equal(extractUpgradeSlotHint('what upgrades does he have'), null)
    assert.equal(extractUpgradeSlotHint('what about Badammo?'), null)
  })

  it('slot filter returns up to 5 upgrades and lists upgradeSlots', () => {
    resetUpgradeCaches()
    const itemStats = {
      100: { name: 'Old Shoulders', slot: 'SHOULDERS', classes: 'WAR', ac: 5, mods: [], resists: [] },
      101: { name: 'Old Chest', slot: 'CHEST', classes: 'WAR', ac: 10, mods: [], resists: [] },
      201: { name: 'Shoulder A', slot: 'SHOULDERS', classes: 'WAR', ac: 20, mods: [], resists: [] },
      202: { name: 'Shoulder B', slot: 'SHOULDERS', classes: 'WAR', ac: 30, mods: [], resists: [] },
      203: { name: 'Shoulder C', slot: 'SHOULDERS', classes: 'WAR', ac: 40, mods: [], resists: [] },
      204: { name: 'Shoulder D', slot: 'SHOULDERS', classes: 'WAR', ac: 50, mods: [], resists: [] },
      205: { name: 'Shoulder E', slot: 'SHOULDERS', classes: 'WAR', ac: 60, mods: [], resists: [] },
      206: { name: 'Shoulder F', slot: 'SHOULDERS', classes: 'WAR', ac: 70, mods: [], resists: [] },
      301: { name: 'New Chest', slot: 'CHEST', classes: 'WAR', ac: 80, mods: [], resists: [] },
    }
    const rankings = {
      classWeights: { Warrior: { ...AC_WEIGHTS } },
      focusCandidates: {},
      characters: [
        {
          name: 'War',
          class: 'Warrior',
          inventory: [
            { slot_id: 6, item_id: 100, item_name: 'Old Shoulders' },
            { slot_id: 17, item_id: 101, item_name: 'Old Chest' },
          ],
        },
      ],
    }
    const filtered = computeCharacterUpgrades({
      character: { char_id: 'w1', name: 'War', class_name: 'Warrior' },
      rankings,
      itemStats,
      raidItemIds: new Set(Object.keys(itemStats).map(Number)),
      limit: 5,
      slotIds: [6],
    })
    assert.equal(filtered.ok, true, `expected ok, got ${filtered.reason}`)
    assert.ok(filtered.suggestions.length <= 5)
    assert.equal(filtered.suggestions.length, 5)
    assert.ok(filtered.suggestions.every((s) => s.slotId === 6))
    assert.equal(filtered.suggestions[0].itemId, 206)
    assert.ok(filtered.upgradeSlots.some((s) => s.slotId === 6))
    assert.ok(filtered.upgradeSlots.some((s) => s.slotId === 17))

    const emptySlot = computeCharacterUpgrades({
      character: { char_id: 'w1', name: 'War', class_name: 'Warrior' },
      rankings,
      itemStats,
      raidItemIds: new Set(Object.keys(itemStats).map(Number)),
      limit: 5,
      slotIds: [2],
    })
    assert.equal(emptySlot.ok, false)
    assert.equal(emptySlot.reason, 'no_upgrades_for_slot')
    assert.ok(emptySlot.upgradeSlots.some((s) => s.slotId === 6))
  })

  it('slot filter dedupes the same ring across Finger 1 and Finger 2', () => {
    resetUpgradeCaches()
    const itemStats = {
      80001: { name: 'Old Ring', slot: 'FINGER', classes: 'WAR', ac: 5, mods: [], resists: [] },
      90001: { name: 'Better Ring', slot: 'FINGER', classes: 'WAR', ac: 40, mods: [], resists: [] },
    }
    const rankings = {
      classWeights: { Warrior: { ...AC_WEIGHTS } },
      focusCandidates: {},
      characters: [
        {
          name: 'War',
          class: 'Warrior',
          inventory: [
            { slot_id: 15, item_id: 80001, item_name: 'Old Ring' },
            { slot_id: 16, item_id: 80001, item_name: 'Old Ring' },
          ],
        },
      ],
    }
    const result = computeCharacterUpgrades({
      character: { char_id: 'w1', name: 'War', class_name: 'Warrior' },
      rankings,
      itemStats,
      raidItemIds: new Set([80001, 90001]),
      limit: 5,
      slotIds: [15, 16],
    })
    assert.equal(result.ok, true, `expected ok, got ${result.reason}`)
    const better = result.suggestions.filter((s) => s.itemId === 90001)
    assert.equal(better.length, 1)
  })

  it('unfiltered upgrades also dedupe the same wrist item across Wrist 1 and Wrist 2', () => {
    resetUpgradeCaches()
    const itemStats = {
      200: { name: 'Old Bracer', slot: 'WRIST', classes: 'WAR', ac: 5, mods: [], resists: [] },
      101: { name: 'Old Chest', slot: 'CHEST', classes: 'WAR', ac: 10, mods: [], resists: [] },
      90010: { name: 'Better Bracer', slot: 'WRIST', classes: 'WAR', ac: 40, mods: [], resists: [] },
      301: { name: 'New Chest', slot: 'CHEST', classes: 'WAR', ac: 80, mods: [], resists: [] },
    }
    const rankings = {
      classWeights: { Warrior: { ...AC_WEIGHTS } },
      focusCandidates: {},
      characters: [
        {
          name: 'War',
          class: 'Warrior',
          inventory: [
            { slot_id: 9, item_id: 200, item_name: 'Old Bracer' },
            { slot_id: 10, item_id: 200, item_name: 'Old Bracer' },
            { slot_id: 17, item_id: 101, item_name: 'Old Chest' },
          ],
        },
      ],
    }
    const result = computeCharacterUpgrades({
      character: { char_id: 'w1', name: 'War', class_name: 'Warrior' },
      rankings,
      itemStats,
      raidItemIds: new Set(Object.keys(itemStats).map(Number)),
      limit: 5,
    })
    assert.equal(result.ok, true, `expected ok, got ${result.reason}`)
    const bracers = result.suggestions.filter((s) => s.itemId === 90010)
    assert.equal(bracers.length, 1)
    assert.ok(result.upgradeSlots.some((s) => s.slotId === 9 || s.slotId === 10))
  })
})
