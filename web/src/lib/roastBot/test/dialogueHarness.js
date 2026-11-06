/**
 * Shared fixtures and turn helpers for RoastBot dialogue acceptance tests.
 */

import {
  buildAccountFacts,
  handleMessage,
  createConversationState,
} from '../index.js'

export const iaminae = { char_id: 'e1', name: 'Iaminae', class_name: 'Enchanter' }
export const otherEnc = { char_id: 'e2', name: 'Charmalt', class_name: 'Enchanter' }
export const warrior = { char_id: 'w1', name: 'Zender', class_name: 'Warrior' }
export const cleric = { char_id: 'c1', name: 'Zenderheals', class_name: 'Cleric' }

export function fixtureFacts(overrides = {}) {
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

export const rankingsFixture = {
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
    // Engine reads hp_pct/mana_pct/ac_pct/resists_pct (not CHA/INT/AC)
    Enchanter: { ac_pct: 1, hp_pct: 0, mana_pct: 0, resists_pct: 0 },
  },
  focusCandidates: {},
}

export const itemStatsFixture = {
  100: {
    name: 'Old Circlet',
    slot: 'HEAD',
    classes: 'ENC',
    ac: 5,
    mods: [],
    resists: [],
  },
  501: {
    name: 'Beguiler Circlet',
    slot: 'HEAD',
    classes: 'ENC',
    ac: 25,
    mods: [],
    resists: [],
  },
}

/** Magelo upgradeContext using the shared rankings/itemStats fixtures. */
export function defaultUpgradeContext(overrides = {}) {
  return {
    rankings: rankingsFixture,
    itemStats: itemStatsFixture,
    raidItemIds: new Set([100, 501]),
    ...overrides,
  }
}

/**
 * One dialogue turn with deterministic rng.
 * @param {object} state
 * @param {string} text
 * @param {{ facts?: object, upgradeContext?: object|null, discoveryAnswer?: object|null, discoveryResult?: object|null, discoveryRecognition?: object|null, whoIsResult?: object|null, whoIsName?: string|null }} [opts]
 */
export function turn(state, text, opts = {}) {
  const facts = opts.facts ?? fixtureFacts()
  const out = handleMessage({
    text,
    facts,
    state,
    upgradeContext: opts.upgradeContext ?? null,
    discoveryResult: opts.discoveryResult ?? null,
    discoveryAnswer: opts.discoveryAnswer ?? null,
    discoveryRecognition: opts.discoveryRecognition ?? null,
    whoIsResult: opts.whoIsResult ?? null,
    whoIsName: opts.whoIsName ?? null,
    rng: () => 0,
  })
  return out
}

/**
 * Run a multi-turn script. Each step: { text, opts?, assert?(out) }.
 * Returns the final turn result; state is threaded automatically.
 * @param {Array<{ text: string, opts?: object, assert?: (out: object) => void }>} steps
 * @param {{ facts?: object, state?: object }} [start]
 */
export function runScript(steps, start = {}) {
  let state = start.state || createConversationState()
  const facts = start.facts ?? fixtureFacts()
  let last = null
  for (const step of steps) {
    last = turn(state, step.text, { facts, ...step.opts })
    state = last.state
    if (typeof step.assert === 'function') step.assert(last)
  }
  return last
}

/** Prefetched loot-discovery answer fixture used across acceptance tests. */
export function sampleDiscoveryAnswer(overrides = {}) {
  return {
    intent: 'loot_discovery',
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
    ...overrides,
  }
}

export { createConversationState, handleMessage }
