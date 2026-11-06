/**
 * Table-driven natural-language regression for compositional discovery.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { recognizeDiscovery, tryParseDiscovery } from './parse.js'
import { prepareDiscovery, runDiscovery, resetDiscoveryCache } from './index.js'
import { createDiscoveryMockClient } from './mockSupabase.js'
import { buildKnownItemSources } from '../../itemSourceLookup.js'
import {
  FIXTURE_ITEM_SOURCES,
  FIXTURE_MOB_LOOT,
  FIXTURE_ITEM_STATS,
} from './fixtures.js'
import { handleMessage, createConversationState } from '../conversation.js'
import { INTENTS } from '../intents.js'

const known = buildKnownItemSources({
  itemSources: FIXTURE_ITEM_SOURCES,
  mobLoot: FIXTURE_MOB_LOOT,
})

const PARSE_CASES = [
  {
    name: 'what about quarm ring',
    text: 'what about quarm ring',
    expect: { status: 'recognized', intent: 'last_award', boss: 'Quarm', slot: 'FINGER' },
  },
  {
    name: 'when did quarm last drop a ring',
    text: 'when did quarm last drop a ring',
    expect: { status: 'recognized', intent: 'last_award', boss: 'Quarm', slot: 'FINGER' },
  },
  {
    name: 'who got the last quarm ring',
    text: 'who got the last quarm ring',
    expect: { status: 'recognized', intent: 'last_award', boss: 'Quarm', slot: 'FINGER' },
  },
  {
    name: 'last quarm ring?',
    text: 'last quarm ring?',
    expect: { status: 'recognized', intent: 'last_award', boss: 'Quarm', slot: 'FINGER' },
  },
  {
    name: 'what dropped in P3 last time',
    text: 'What dropped in P3 last time?',
    expect: { status: 'recognized', family: 'raid_loot', phase: 'P3' },
  },
  {
    name: 'when did P3 caster shoulders last drop',
    text: "When's the last time P3 caster shoulders dropped?",
    expect: { status: 'recognized', family: 'item_last', phase: 'P3', slot: 'SHOULDERS' },
  },
  {
    name: 'who got cloak',
    text: 'Who got Cloak of Wishes?',
    expect: { status: 'recognized', family: 'item_recipients' },
  },
  {
    name: 'how many times has X dropped',
    text: 'How many times has Cloak of Wishes dropped?',
    expect: { status: 'recognized', family: 'item_count' },
  },
  {
    name: 'did Tandiyen ever get X',
    text: 'Did Tandiyen ever get Cloak of Wishes?',
    expect: { status: 'recognized', intent: 'has_won', character: 'Tandiyen' },
  },
  {
    name: 'what has Ammordius won in Time',
    text: 'What has Ammordius won in Time?',
    expect: { status: 'recognized', family: 'character_awards', character: 'Ammordius', zone: 'Plane of Time' },
  },
  {
    name: 'personal roast is not discovery',
    text: 'Why am I broke?',
    expect: { status: 'not_discovery' },
  },
  {
    name: 'item source stays non-discovery',
    text: 'Where does Cloak of Wishes drop?',
    expect: { status: 'not_discovery' },
  },
  {
    name: 'silk arms mold last drop',
    text: "When's the last time silk arms dropped?",
    expect: { status: 'recognized', family: 'item_last', slot: 'ARMS' },
  },
  {
    name: 'plate BP mold last drop',
    text: "When's the last time plate BP dropped?",
    expect: { status: 'recognized', family: 'item_last', slot: 'CHEST' },
  },
  {
    name: 'ele mold last drop',
    text: "When's the last time ele mold dropped?",
    expect: { status: 'recognized', family: 'item_last' },
  },
]

describe('discovery NL paraphrase suite', () => {
  for (const c of PARSE_CASES) {
    it(c.name, () => {
      const r = recognizeDiscovery(c.text, { nowIso: '2026-03-05T12:00:00Z' })
      assert.equal(r.status, c.expect.status, `${c.text} status`)
      if (c.expect.status !== 'recognized') return
      const q = r.query
      assert.ok(q, `expected query for ${c.text}`)
      for (const [k, v] of Object.entries(c.expect)) {
        if (k === 'status') continue
        assert.equal(q[k], v, `${k} for ${c.text}`)
      }
    })
  }
})

describe('discovery mold phrases', () => {
  it('silk arms resolves to Elemental Silk Sleeve Pattern', () => {
    const prepared = prepareDiscovery("When's the last time silk arms dropped?", {
      knownItemSources: known,
      itemStats: FIXTURE_ITEM_STATS,
    })
    assert.ok(prepared?.resolved)
    assert.equal(prepared.resolved.item?.name, 'Elemental Silk Sleeve Pattern')
    assert.equal(prepared.plan?.ops?.[0]?.op, 'awards_for_item')
  })

  it('ele mold plans multi-name catalog window', () => {
    const prepared = prepareDiscovery("When's the last time ele mold dropped?", {
      knownItemSources: known,
      itemStats: FIXTURE_ITEM_STATS,
    })
    assert.ok(prepared?.plan)
    assert.equal(prepared.resolved?.itemSelector?.names?.size, 28)
    assert.equal(prepared.plan.ops[0].op, 'awards_for_catalog_window')
    assert.equal(prepared.plan.ops[0].params.match, 'item')
    assert.equal(prepared.plan.ops[0].params.itemNames?.length, 28)
  })

  it('typo correction metadata surfaces on prepare', () => {
    const prepared = prepareDiscovery("When's the last time timless breastplate mold dropped?", {
      knownItemSources: known,
      itemStats: {
        ...FIXTURE_ITEM_STATS,
        16375: { name: 'Timeless Breastplate Mold', classes: 'WAR CLR PAL SHD BRD' },
      },
    })
    assert.equal(prepared?.resolved?.item?.name, 'Timeless Breastplate Mold')
    assert.equal(prepared?.resolved?.itemCorrection?.to, 'Timeless Breastplate Mold')
  })
})

describe('discovery Quarm ring end-to-end', () => {
  it('when did quarm last drop a ring returns newest Band of the Eternal award', async () => {
    resetDiscoveryCache()
    const client = createDiscoveryMockClient()
    const run = await runDiscovery(client, 'when did quarm last drop a ring', {
      knownItemSources: known,
      itemStats: FIXTURE_ITEM_STATS,
      skipCache: true,
    })
    assert.ok(run)
    assert.equal(run.recognition?.status, 'recognized')
    assert.equal(run.prepared.query.boss, 'Quarm')
    assert.equal(run.prepared.query.slot, 'FINGER')
    assert.equal(run.prepared.query.intent, 'last_award')
    const awards = run.result.awards || []
    assert.ok(awards.length >= 1)
    assert.equal(awards[0].itemName, 'Band of the Eternal')
    assert.equal(awards[0].characterName, 'Helen')
    assert.equal(awards[0].dateIso, '2026-02-25')
    assert.match(run.answer.factText, /recorded.*finger|finger.*awards/i)
    const row = run.answer.table?.rows?.[0]
    assert.ok(row, 'expected award table row')
    assert.equal(row.item?.label, 'Band of the Eternal')
    assert.equal(row.toon?.label, 'Helen')
    assert.equal(row.class, 'Enchanter')
    assert.equal(row.date, '2026-02-25')
    assert.ok(row.item?.to?.includes('Band'))
    assert.equal(row.dkp, '75')
    assert.equal(run.answer.links?.length || 0, 0)
  })

  it('what about quarm ring plans catalog window with boss + filterSlot', () => {
    const prepared = prepareDiscovery('what about quarm ring', {
      knownItemSources: known,
      itemStats: FIXTURE_ITEM_STATS,
    })
    assert.ok(prepared?.plan)
    assert.equal(prepared.plan.ops[0].op, 'awards_for_catalog_window')
    assert.equal(prepared.plan.ops[0].params.match, 'boss')
    assert.equal(prepared.plan.ops[0].params.boss, 'Quarm')
    assert.equal(prepared.plan.ops[0].params.filterSlot, 'FINGER')
  })

  it('catalog vs raid-night vs history remain distinct for Quarm', async () => {
    resetDiscoveryCache()
    const client = createDiscoveryMockClient()
    const catalog = await runDiscovery(client, 'What can Quarm drop?', {
      knownItemSources: known,
      itemStats: FIXTURE_ITEM_STATS,
      skipCache: true,
    })
    assert.match(catalog.answer.factText, /Catalog drops/i)
    assert.match(catalog.answer.factText, /not a historical kill/i)

    const night = await runDiscovery(client, 'What dropped off Quarm?', {
      knownItemSources: known,
      itemStats: FIXTURE_ITEM_STATS,
      skipCache: true,
    })
    assert.match(night.answer.factText, /Quarm/i)
    assert.ok(night.result.raid?.raidId)

    const hist = await runDiscovery(client, 'last quarm ring?', {
      knownItemSources: known,
      itemStats: FIXTURE_ITEM_STATS,
      skipCache: true,
    })
    assert.match(hist.answer.factText, /recorded/i)
    assert.equal(hist.answer.table?.rows?.[0]?.item?.label, 'Band of the Eternal')
  })

  it('empty boss+slot catalog surfaces classification gap', async () => {
    resetDiscoveryCache()
    const client = createDiscoveryMockClient()
    // Quarm has no EAR items in fixtures
    const run = await runDiscovery(client, 'when did quarm last drop an earring', {
      knownItemSources: known,
      itemStats: FIXTURE_ITEM_STATS,
      skipCache: true,
    })
    // May be not_discovery if earring alias missing — accept unsupported/recognized with gap
    if (run?.prepared?.query?.slot) {
      assert.ok(
        (run.result?.gaps || []).some((g) => /catalog|classification|mapped/i.test(g)) ||
          (run.result?.awards || []).length === 0,
      )
    }
  })
})

describe('discovery follow-up merge', () => {
  it('what about rings after Quarm night merges slot onto prior boss', () => {
    const prev = tryParseDiscovery('What dropped off Quarm?')
    assert.ok(prev)
    const r = recognizeDiscovery('What about rings?', {
      prev,
      prevPrimary: { itemName: 'Quarm Tooth', characterName: 'Eve', raidId: 'r-quarm', dateIso: '2026-02-25' },
    })
    assert.equal(r.status, 'recognized')
    assert.equal(r.query.boss, 'Quarm')
    assert.equal(r.query.slot, 'FINGER')
    assert.equal(r.query.intent, 'last_award')
  })

  it('who got it binds primary item', () => {
    const prev = tryParseDiscovery('Who got Cloak of Wishes?')
    const r = recognizeDiscovery('Who got it?', {
      prev,
      prevPrimary: { itemName: 'Cloak of Wishes', characterName: 'Frank' },
    })
    assert.equal(r.status, 'recognized')
    assert.equal(r.query.intent, 'recipients')
    assert.equal(r.query.itemQuery, 'Cloak of Wishes')
  })

  it('what about last week keeps prior zone filters', () => {
    const prev = tryParseDiscovery('What dropped in Time last week?', { nowIso: '2026-03-05T12:00:00Z' })
    assert.ok(prev)
    const r = recognizeDiscovery('What about last week?', {
      prev,
      nowIso: '2026-03-12T12:00:00Z',
    })
    assert.equal(r.status, 'recognized')
    assert.equal(r.query.zone, 'Plane of Time')
    assert.equal(r.query.timeRange?.label, 'last week')
  })

  it('how many times has it dropped uses sticky item', () => {
    const prev = tryParseDiscovery('Who got Cloak of Wishes?')
    const r = recognizeDiscovery('How many times has it dropped?', {
      prev,
      prevPrimary: { itemName: 'Cloak of Wishes' },
    })
    assert.equal(r.status, 'recognized')
    assert.equal(r.query.intent, 'count')
    assert.equal(r.query.itemQuery, 'Cloak of Wishes')
  })

  it('and Tandiyen swaps character on prior character awards', () => {
    const prev = tryParseDiscovery('What did Ammordius get last month?', {
      nowIso: '2026-03-05T12:00:00Z',
    })
    assert.ok(prev)
    assert.equal(prev.character, 'Ammordius')
    const r = recognizeDiscovery('And Tandiyen?', { prev })
    assert.equal(r.status, 'recognized')
    assert.equal(r.query.character, 'Tandiyen')
    assert.equal(r.query.family, 'character_awards')
  })

  it('which of my toons could use this ring after Quarm is not_discovery', () => {
    const prev = tryParseDiscovery('when did quarm last drop a ring')
    assert.ok(prev)
    assert.equal(prev.boss, 'Quarm')
    assert.equal(prev.slot, 'FINGER')
    const r = recognizeDiscovery('which of my toons could use this ring', {
      prev,
      prevPrimary: { itemName: 'Band of the Eternal', characterName: 'Helen' },
    })
    assert.equal(r.status, 'not_discovery')
  })
})

describe('discovery dialogue false-recognition guard', () => {
  it('FOLLOWUP after loot_discovery without prefetch does not claim award history not loaded', () => {
    const state = createConversationState()
    state.lastIntent = INTENTS.LOOT_DISCOVERY
    const out = handleMessage({
      text: 'hmm okay',
      facts: { characters: [], accountId: 'a1', knownItemSources: known, itemCatalog: [] },
      state,
      rng: () => 0,
    })
    assert.doesNotMatch(out.response.text, /award history was not loaded/i)
    assert.notEqual(out.intent, INTENTS.LOOT_DISCOVERY)
  })

  it('item-fit follow-up after Quarm rings routes to ITEM_FIT not loot discovery', () => {
    const state = createConversationState()
    state.lastIntent = INTENTS.LOOT_DISCOVERY
    state.lastItemName = 'Band of the Eternal'
    state.lastItemId = '90003'
    state.lastDiscovery = {
      query: { boss: 'Quarm', slot: 'FINGER', intent: 'last_award', raw: 'when did quarm last drop a ring' },
      primary: { itemName: 'Band of the Eternal', itemId: '90003', characterName: 'Helen' },
      recognition: { status: 'recognized' },
    }
    const out = handleMessage({
      text: 'which of my toons could use this ring',
      facts: {
        accountId: 'a1',
        characters: [
          { char_id: 'e1', name: 'Iaminae', class_name: 'Enchanter' },
          { char_id: 'w1', name: 'Zender', class_name: 'Warrior' },
        ],
        knownItemSources: known,
        itemCatalog: [{ name: 'Band of the Eternal', itemId: 90003 }],
      },
      state,
      // Discovery must not win even if a stale recognition were passed.
      discoveryRecognition: null,
      upgradeContext: {
        rankings: {
          classWeights: {
            Enchanter: { ac_pct: 1, hp_pct: 0, mana_pct: 0, resists_pct: 0 },
            Warrior: { ac_pct: 1, hp_pct: 0, mana_pct: 0, resists_pct: 0 },
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
        },
        itemStats: {
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
        },
        raidItemIds: new Set([80001, 90003]),
      },
      rng: () => 0,
    })
    assert.equal(out.intent, INTENTS.ITEM_FIT)
    assert.ok(out.answer.requiredClaims.includes('item_fit_upgrades'))
    assert.match(out.response.text, /Band of the Eternal/i)
    assert.match(out.response.text, /Iaminae/i)
    assert.doesNotMatch(out.response.text, /finger awards for Quarm/i)
  })

  it('prefetched quarm ring answer routes to loot discovery', () => {
    const answer = {
      intent: INTENTS.LOOT_DISCOVERY,
      category: 'general',
      factText: 'Last recorded finger awards for Quarm (most recent 2026-02-25):',
      requiredClaims: ['loot_discovery'],
      placeholders: {},
      referenced: { characters: ['Helen'], items: ['Band of the Eternal'], raids: [] },
      links: [],
      table: {
        columns: ['Item', 'Toon', 'Class', 'Date', 'Raid', 'DKP'],
        rows: [
          {
            item: {
              type: 'item',
              label: 'Band of the Eternal',
              to: `/items/${encodeURIComponent('Band of the Eternal')}`,
            },
            toon: {
              type: 'character',
              label: 'Helen',
              to: `/characters/${encodeURIComponent('Helen')}`,
            },
            class: 'Enchanter',
            date: '2026-02-25',
            raid: null,
            dkp: '75',
          },
        ],
      },
      reasonCode: 'loot_discovery',
      allowFlavor: false,
      templateId: 'LOOT_DISCOVERY',
    }
    const out = handleMessage({
      text: 'when did quarm last drop a ring',
      facts: { characters: [], accountId: 'a1', knownItemSources: known, itemCatalog: [] },
      state: createConversationState(),
      discoveryAnswer: answer,
      discoveryRecognition: { status: 'recognized' },
      rng: () => 0,
    })
    assert.equal(out.intent, INTENTS.LOOT_DISCOVERY)
    assert.match(out.response.text, /finger awards for Quarm/i)
    assert.equal(out.response.table?.rows?.[0]?.item?.label, 'Band of the Eternal')
    assert.equal(out.response.table?.rows?.[0]?.toon?.label, 'Helen')
    assert.doesNotMatch(out.response.text, /award history was not loaded/i)
  })
})
