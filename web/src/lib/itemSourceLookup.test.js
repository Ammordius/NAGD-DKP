import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildKnownItemSources,
  lookupItemSource,
  catalogEntriesFromKnownSources,
  dedupePreferZone,
} from './itemSourceLookup.js'

const EARTHEN = 'Earthen Bracer of Fortitude'

const itemSourcesFixture = {
  'earthen bracer of fortitude': [
    { mob: 'Quarm', zone: '' },
    { mob: 'Quarm', zone: 'Plane of Time' },
  ],
}

const mobLootFixture = {
  'Quarm|Plane of Time': {
    mob: 'Quarm',
    mobs: ['Quarm'],
    zone: 'Plane of Time',
    loot: [
      {
        item_id: 32100,
        name: EARTHEN,
        sources: ['dkp', 'raid_item_sources'],
      },
    ],
    // Mistaken shape must be ignored
    items: [{ name: 'Should Not Appear', zone: 'Wrong Zone' }],
  },
}

const raidItemSourcesFixture = {
  '32100': {
    mob: 'Quarm',
    zone: 'Plane of Time',
    name: EARTHEN,
  },
}

describe('itemSourceLookup', () => {
  it('dedupePreferZone drops empty-zone twin when populated zone exists', () => {
    const out = dedupePreferZone([
      { mob: 'Quarm', zone: '' },
      { mob: 'Quarm', zone: 'Plane of Time' },
      { mob: 'Quarm', zone: 'Plane of Time' },
    ])
    assert.deepEqual(out, [{ mob: 'Quarm', zone: 'Plane of Time' }])
  })

  it('merges three JSON sources for Earthen Bracer → Quarm / Plane of Time', () => {
    const known = buildKnownItemSources({
      itemSources: itemSourcesFixture,
      mobLoot: mobLootFixture,
      raidItemSources: raidItemSourcesFixture,
    })
    const entry = lookupItemSource(known, EARTHEN)
    assert.ok(entry)
    assert.equal(entry.mob, 'Quarm')
    assert.equal(entry.zone, 'Plane of Time')
    assert.equal(entry.displayName, EARTHEN)
    assert.equal(Number(entry.itemId), 32100)
    assert.equal(entry.sources.length, 1)
    assert.deepEqual(entry.sources[0], { mob: 'Quarm', zone: 'Plane of Time' })
  })

  it('reads entry.loot (not .items) and entry-level mob/zone from dkp_mob_loot', () => {
    const known = buildKnownItemSources({
      mobLoot: {
        'SomeKey|Wrong': {
          mob: 'Vallon Zek',
          zone: 'Plane of Tactics',
          loot: [{ name: 'Spear of Discord', item_id: 1 }],
          items: [{ name: 'Fake From Items Prop' }],
        },
      },
    })
    assert.ok(lookupItemSource(known, 'Spear of Discord'))
    assert.equal(lookupItemSource(known, 'Spear of Discord').zone, 'Plane of Tactics')
    assert.equal(lookupItemSource(known, 'Spear of Discord').mob, 'Vallon Zek')
    assert.equal(lookupItemSource(known, 'Fake From Items Prop'), null)
  })

  it('catalogEntriesFromKnownSources exposes display names for resolve', () => {
    const known = buildKnownItemSources({
      itemSources: itemSourcesFixture,
      raidItemSources: raidItemSourcesFixture,
    })
    const catalog = catalogEntriesFromKnownSources(known)
    assert.ok(catalog.some((c) => c.name === EARTHEN))
  })
})
