import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildKnownItemSources } from '../../itemSourceLookup.js'
import { resolveDiscoveryEntities, authoritativeItemSource } from './resolve.js'
import { preferAuthoritativeSource, classesMatchRole } from './aliases.js'
import {
  FIXTURE_ITEM_SOURCES,
  FIXTURE_MOB_LOOT,
  FIXTURE_ITEM_STATS,
} from './fixtures.js'

const known = buildKnownItemSources({
  itemSources: FIXTURE_ITEM_SOURCES,
  mobLoot: FIXTURE_MOB_LOOT,
})

describe('discovery resolve', () => {
  it('resolves exact item alias', () => {
    const resolved = resolveDiscoveryEntities(
      { family: 'item_recipients', itemQuery: 'ossein', raw: 'who got ossein' },
      { knownItemSources: known },
    )
    assert.equal(resolved.item?.name, 'Ossein of Limitless Time')
  })

  it('resolves P3 caster shoulders via stats + phase', () => {
    const resolved = resolveDiscoveryEntities(
      {
        family: 'item_last',
        itemQuery: 'p3 caster shoulders',
        phase: 'P3',
        zone: 'Plane of Time',
        raw: "when's the last time p3 caster shoulders dropped",
      },
      { knownItemSources: known, itemStats: FIXTURE_ITEM_STATS },
    )
    assert.equal(resolved.item?.name, 'Pauldrons of Purity')
    assert.equal(resolved.itemAmbiguous, null)
  })

  it('resolves bare p3 shoulders to Pauldrons of Purity', () => {
    const resolved = resolveDiscoveryEntities(
      {
        family: 'item_last',
        itemQuery: 'p3 shoulders',
        phase: 'P3',
        slot: 'SHOULDERS',
        zone: 'Plane of Time',
        raw: 'whens the last time p3 shoulders dropped',
      },
      { knownItemSources: known, itemStats: FIXTURE_ITEM_STATS },
    )
    assert.equal(resolved.item?.name, 'Pauldrons of Purity')
    assert.equal(resolved.itemAmbiguous, null)
  })

  it('resolves p3 arms via slot constraint', () => {
    const resolved = resolveDiscoveryEntities(
      {
        family: 'item_last',
        itemQuery: 'p3 arms',
        phase: 'P3',
        slot: 'ARMS',
        raw: "when's the last time p3 arms dropped",
      },
      { knownItemSources: known, itemStats: FIXTURE_ITEM_STATS },
    )
    assert.equal(resolved.item?.name, 'Sleeves of Temporal Force')
    assert.equal(resolved.itemAmbiguous, null)
  })

  it('does not silently pick warrior shoulders for caster query', () => {
    const resolved = resolveDiscoveryEntities(
      {
        family: 'item_last',
        itemQuery: 'caster shoulders',
        phase: 'P3',
        classesHint: 'caster',
        raw: 'caster shoulders',
      },
      { knownItemSources: known, itemStats: FIXTURE_ITEM_STATS },
    )
    assert.notEqual(resolved.item?.name, 'Plate of the Warrior')
  })

  it('priest shoulders resolves to soft pauldrons, not tank plate', () => {
    const resolved = resolveDiscoveryEntities(
      {
        family: 'item_last',
        itemQuery: 'priest shoulders',
        slot: 'SHOULDERS',
        classesHint: 'priest',
        raw: 'priest shoulders',
      },
      { knownItemSources: known, itemStats: FIXTURE_ITEM_STATS },
    )
    assert.equal(resolved.item?.name, 'Pauldrons of Purity')
  })

  it('tank shoulders resolves to plate, not soft pauldrons', () => {
    const resolved = resolveDiscoveryEntities(
      {
        family: 'item_last',
        itemQuery: 'tank shoulders',
        slot: 'SHOULDERS',
        classesHint: 'tank',
        raw: 'tank shoulders',
      },
      { knownItemSources: known, itemStats: FIXTURE_ITEM_STATS },
    )
    assert.equal(resolved.item?.name, 'Plate of the Warrior')
  })

  it('melee shoulders resolves to melee spaulders', () => {
    const resolved = resolveDiscoveryEntities(
      {
        family: 'item_last',
        itemQuery: 'melee shoulders',
        slot: 'SHOULDERS',
        classesHint: 'melee',
        raw: 'melee shoulders',
      },
      { knownItemSources: known, itemStats: FIXTURE_ITEM_STATS },
    )
    assert.equal(resolved.item?.name, 'Spaulders of the Wind')
  })

  it('caster role excludes priest-only and tank plate', () => {
    assert.equal(classesMatchRole('NEC WIZ MAG ENC', 'caster'), true)
    assert.equal(classesMatchRole('CLR DRU SHM', 'caster'), false)
    assert.equal(classesMatchRole('CLR DRU SHM NEC WIZ MAG ENC', 'caster'), true)
    assert.equal(classesMatchRole('WAR PAL SHD', 'tank'), true)
    assert.equal(classesMatchRole('WAR PAL SHD', 'melee'), false)
    assert.equal(classesMatchRole('ALL', 'priest'), true)
  })

  it('prefers P3 over warboar for cloak', () => {
    const auth = authoritativeItemSource(known, 'Cloak of Wishes')
    assert.equal(auth?.mob, 'P3')
    const preferred = preferAuthoritativeSource(known['cloak of wishes'].sources)
    assert.equal(preferred?.mob, 'P3')
  })

  it('reports unmatched rather than substituting', () => {
    const resolved = resolveDiscoveryEntities(
      { family: 'item_recipients', itemQuery: 'zzznonsenseitemzz', raw: 'who got zzznonsenseitemzz' },
      { knownItemSources: known, itemStats: FIXTURE_ITEM_STATS },
    )
    assert.equal(resolved.itemUnmatched, true)
    assert.ok(resolved.gaps?.length)
  })

  it('plate BP resolves to Timeless Breastplate Mold', () => {
    const resolved = resolveDiscoveryEntities(
      {
        family: 'item_last',
        intent: 'last_award',
        itemQuery: 'plate bp',
        slot: 'CHEST',
        raw: "when's the last time plate BP dropped",
      },
      { knownItemSources: known, itemStats: FIXTURE_ITEM_STATS },
    )
    assert.equal(resolved.item?.name, 'Timeless Breastplate Mold')
    assert.equal(resolved.itemAmbiguous, null)
  })

  it('silk arms resolves to Elemental Silk Sleeve Pattern', () => {
    const resolved = resolveDiscoveryEntities(
      {
        family: 'item_last',
        intent: 'last_award',
        itemQuery: 'silk arms',
        slot: 'ARMS',
        raw: "when's the last time silk arms dropped",
      },
      { knownItemSources: known, itemStats: FIXTURE_ITEM_STATS },
    )
    assert.equal(resolved.item?.name, 'Elemental Silk Sleeve Pattern')
  })

  it('plate arms resolves to Elemental Vambrace Mold', () => {
    const resolved = resolveDiscoveryEntities(
      {
        family: 'item_recipients',
        intent: 'recipients',
        itemQuery: 'plate arms',
        raw: 'who got plate arms',
      },
      { knownItemSources: known },
    )
    assert.equal(resolved.item?.name, 'Elemental Vambrace Mold')
  })

  it('ele mold builds multi-item selector of all molds', () => {
    const resolved = resolveDiscoveryEntities(
      {
        family: 'item_last',
        intent: 'last_award',
        itemQuery: 'ele mold',
        raw: "when's the last time ele mold dropped",
      },
      { knownItemSources: known },
    )
    assert.equal(resolved.item, null)
    assert.equal(resolved.itemSelector?.match, 'item')
    assert.equal(resolved.itemSelector?.names?.size, 28)
  })

  it('unique typo soft-match sets itemCorrection', () => {
    const resolved = resolveDiscoveryEntities(
      {
        family: 'item_last',
        intent: 'last_award',
        itemQuery: 'timless breastplate mold',
        raw: "when's the last time timless breastplate mold dropped",
      },
      {
        knownItemSources: known,
        itemStats: {
          16375: { name: 'Timeless Breastplate Mold', classes: 'WAR CLR PAL SHD BRD' },
        },
      },
    )
    assert.equal(resolved.item?.name, 'Timeless Breastplate Mold')
    assert.equal(resolved.itemCorrection?.from, 'timless breastplate mold')
    assert.equal(resolved.itemCorrection?.to, 'Timeless Breastplate Mold')
  })
})
