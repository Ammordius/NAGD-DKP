import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planDiscovery } from './queryPlan.js'
import { resolveDiscoveryEntities } from './resolve.js'
import { buildKnownItemSources } from '../../itemSourceLookup.js'
import { FIXTURE_ITEM_SOURCES, FIXTURE_MOB_LOOT } from './fixtures.js'

const known = buildKnownItemSources({
  itemSources: FIXTURE_ITEM_SOURCES,
  mobLoot: FIXTURE_MOB_LOOT,
})

describe('discovery queryPlan', () => {
  it('plans last zone raid via catalog item join then loot', () => {
    const q = {
      family: 'raid_loot',
      zone: 'Plane of Fire',
      mostRecentRaidFirst: true,
      raw: 'what dropped last time in pof',
      limit: 40,
    }
    const plan = planDiscovery(q)
    assert.equal(plan.ops[0].op, 'latest_raid_by_catalog')
    assert.equal(plan.ops[0].params.match, 'zone')
    assert.equal(plan.ops[0].params.zone, 'Plane of Fire')
    assert.equal(plan.ops[1].op, 'loot_for_raid')
  })

  it('plans P3 via catalog phase items then phase-filtered loot', () => {
    const q = {
      family: 'raid_loot',
      phase: 'P3',
      zone: 'Plane of Time',
      mostRecentRaidFirst: true,
      raw: 'what dropped in p3 last time',
      limit: 40,
    }
    const resolved = resolveDiscoveryEntities(q, { knownItemSources: known })
    const plan = planDiscovery(resolved.query, resolved)
    assert.equal(plan.ops[0].op, 'latest_raid_by_catalog')
    assert.equal(plan.ops[0].params.match, 'phase')
    assert.ok(plan.ops[0].params.mobs.includes('P3'))
    assert.equal(plan.ops[1].op, 'loot_for_raid')
    assert.ok(plan.ops[1].params.filterPhaseMobs.includes('P3'))
    assert.ok(plan.notes.some((n) => /phase|item_sources/i.test(n)))
  })

  it('plans item count as count + sample awards', () => {
    const plan = planDiscovery({
      family: 'item_count',
      itemQuery: 'Cloak of Wishes',
      raw: 'how many times',
      limit: 1,
    })
    assert.equal(plan.ops[0].op, 'count_awards_for_item')
    assert.equal(plan.ops[1].op, 'awards_for_item')
  })

  it('plans boss catalog without supabase loot ops', () => {
    const plan = planDiscovery({
      family: 'boss_catalog',
      boss: 'Quarm',
      raw: 'what can quarm drop',
      limit: 40,
    })
    assert.equal(plan.ops.length, 1)
    assert.equal(plan.ops[0].op, 'catalog_boss_drops')
  })

  it('plans boss raid via catalog boss items', () => {
    const plan = planDiscovery({
      family: 'boss_raid_loot',
      boss: 'Quarm',
      raw: 'what dropped off quarm',
      limit: 40,
    })
    assert.equal(plan.ops[0].op, 'latest_raid_by_catalog')
    assert.equal(plan.ops[0].params.match, 'boss')
    assert.equal(plan.ops[0].params.boss, 'Quarm')
  })
})
