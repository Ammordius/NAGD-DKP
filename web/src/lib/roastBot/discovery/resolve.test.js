import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildKnownItemSources } from '../../itemSourceLookup.js'
import { resolveDiscoveryEntities, authoritativeItemSource } from './resolve.js'
import { preferAuthoritativeSource } from './aliases.js'
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

  it('does not silently pick warrior shoulders for caster query', () => {
    const resolved = resolveDiscoveryEntities(
      {
        family: 'item_last',
        itemQuery: 'caster shoulders',
        phase: 'P3',
        raw: 'caster shoulders',
      },
      { knownItemSources: known, itemStats: FIXTURE_ITEM_STATS },
    )
    assert.notEqual(resolved.item?.name, 'Plate of the Warrior')
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
})
