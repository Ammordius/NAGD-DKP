import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderDiscovery } from './render.js'

describe('discovery render', () => {
  it('raid loot includes table rows with raid/item/character links', () => {
    const answer = renderDiscovery({
      ok: true,
      family: 'raid_loot',
      query: { family: 'raid_loot', zone: 'Plane of Fire', raw: 'x' },
      raid: { raidId: 'r-fire-new', raidName: 'Fire Minis', dateIso: '2026-03-01' },
      awards: [
        {
          raidId: 'r-fire-new',
          raidName: 'Fire Minis',
          dateIso: '2026-03-01',
          itemName: 'Blazing Whip of Trillia',
          characterName: 'Tandiyen',
        },
      ],
      totalCount: 1,
      gaps: [],
      notes: [],
    })
    assert.match(answer.factText, /Plane of Fire/)
    assert.match(answer.factText, /1 recorded loot award/)
    assert.ok(answer.table?.rows?.length === 1)
    assert.deepEqual(answer.table.columns, ['Item', 'Character', 'Date', 'Raid', 'DKP'])
    const row = answer.table.rows[0]
    assert.equal(row.item?.to, `/items/${encodeURIComponent('Blazing Whip of Trillia')}`)
    assert.equal(row.character?.to, `/characters/${encodeURIComponent('Tandiyen')}`)
    assert.equal(row.raid?.to, '/raids/r-fire-new')
    assert.equal(row.date, '2026-03-01')
    assert.equal(row.dkp, '—')
    assert.equal(answer.links?.length || 0, 0)
  })

  it('who-got wording distinguishes recorded awards with recipient table', () => {
    const answer = renderDiscovery({
      ok: true,
      family: 'item_recipients',
      query: { family: 'item_recipients', itemQuery: 'Cloak of Wishes', raw: 'x' },
      awards: [
        {
          raidId: 'r1',
          raidName: 'Time',
          dateIso: '2026-02-10T21:00:00-04:00',
          itemName: 'Cloak of Wishes',
          characterName: 'Frank',
          cost: 41,
        },
      ],
    })
    assert.match(answer.factText, /recorded/i)
    assert.match(answer.factText, /Frank/)
    assert.match(answer.factText, /Cloak of Wishes/)
    assert.match(answer.factText, /2026-02-10/)
    assert.doesNotMatch(answer.factText, /21:00:00/)
    assert.ok(answer.table?.rows?.length === 1)
    assert.deepEqual(answer.table.columns, ['Character', 'Date', 'DKP'])
    assert.equal(answer.table.rows[0].character?.to, `/characters/${encodeURIComponent('Frank')}`)
    assert.equal(answer.table.rows[0].date?.to, '/raids/r1')
    assert.equal(answer.table.rows[0].date?.label, '2026-02-10')
    assert.equal(answer.table.rows[0].dkp, '41')
    assert.equal(answer.links?.[0]?.to, `/items/${encodeURIComponent('Cloak of Wishes')}`)
  })

  it('boss+slot catalog window awards use item/character/date/raid table', () => {
    const answer = renderDiscovery({
      ok: true,
      family: 'item_last',
      query: {
        family: 'item_last',
        boss: 'Quarm',
        slot: 'FINGER',
        itemQuery: 'ring',
        raw: 'x',
      },
      awards: [
        {
          raidId: 'r-quarm',
          raidName: 'Time Day 2',
          dateIso: '2026-02-25',
          itemName: 'Band of the Eternal',
          characterName: 'Helen',
        },
      ],
    })
    assert.match(answer.factText, /Last recorded finger awards for Quarm/i)
    assert.match(answer.factText, /item_sources/i)
    assert.doesNotMatch(answer.factText, /Band of the Eternal →/)
    const row = answer.table?.rows?.[0]
    assert.ok(row)
    assert.equal(row.item?.label, 'Band of the Eternal')
    assert.equal(row.item?.to, `/items/${encodeURIComponent('Band of the Eternal')}`)
    assert.equal(row.character?.label, 'Helen')
    assert.equal(row.character?.to, `/characters/${encodeURIComponent('Helen')}`)
    assert.equal(row.raid?.to, '/raids/r-quarm')
    assert.equal(row.date, '2026-02-25')
    assert.equal(answer.links?.length || 0, 0)
  })

  it('catalog drops render one-column item table', () => {
    const answer = renderDiscovery({
      ok: true,
      family: 'boss_catalog',
      query: { family: 'boss_catalog', boss: 'Quarm', raw: 'x' },
      catalogItems: [
        { name: 'Band of the Eternal', itemId: 90003 },
        { name: 'Quarm Tooth', itemId: 90001 },
      ],
    })
    assert.match(answer.factText, /Catalog drops/i)
    assert.match(answer.factText, /not a historical kill/i)
    assert.deepEqual(answer.table?.columns, ['Item'])
    assert.equal(answer.table?.rows?.length, 2)
    assert.equal(answer.table.rows[0].item?.to, `/items/${encodeURIComponent('Band of the Eternal')}`)
    assert.equal(answer.links?.length || 0, 0)
  })

  it('P3 note appears when phase filter applied', () => {
    const answer = renderDiscovery({
      ok: true,
      family: 'raid_loot',
      query: { family: 'raid_loot', phase: 'P3', zone: 'Plane of Time', raw: 'x' },
      raid: { raidId: 'r-time-mixed', raidName: 'Time', dateIso: '2026-02-20' },
      awards: [
        {
          raidId: 'r-time-mixed',
          itemName: 'Cloak of Wishes',
          characterName: 'Alice',
          dateIso: '2026-02-20',
        },
      ],
      totalCount: 1,
      gaps: [],
      notes: ['P3/phase answers include only awards whose items are labeled'],
    })
    assert.match(answer.factText, /P3/)
    assert.match(answer.factText, /identifiable/i)
    assert.ok(answer.table?.rows?.[0]?.item?.label === 'Cloak of Wishes')
  })

  it('ambiguous item asks for clarification', () => {
    const answer = renderDiscovery({
      ok: false,
      family: 'item_recipients',
      query: { family: 'item_recipients', raw: 'x' },
      ambiguous: {
        kind: 'item',
        candidates: ['A', 'B'],
        message: 'Which item? Candidates: A, B.',
      },
    })
    assert.equal(answer.reasonCode, 'need_item')
    assert.match(answer.factText, /Candidates/)
    assert.equal(answer.table, null)
  })

  it('spelling ambiguity enables roast flavor', () => {
    const answer = renderDiscovery({
      ok: false,
      family: 'item_recipients',
      query: { family: 'item_recipients', raw: 'x' },
      ambiguous: {
        kind: 'item',
        candidates: ['Cloak of Wishes', 'Cloak of Wishes II'],
        message: 'Did you mean Cloak of Wishes, or Cloak of Wishes II?',
        spelling: true,
      },
    })
    assert.equal(answer.allowFlavor, true)
    assert.match(answer.factText, /Did you mean/)
  })

  it('itemCorrection preface and allowFlavor', () => {
    const answer = renderDiscovery({
      ok: true,
      family: 'item_last',
      query: { family: 'item_last', raw: 'timless breastplate mold' },
      awards: [],
      itemCorrection: { from: 'timless breastplate mold', to: 'Timeless Breastplate Mold' },
      gaps: [],
      notes: [],
    })
    assert.match(answer.factText, /Assuming you meant Timeless Breastplate Mold/)
    assert.equal(answer.allowFlavor, true)
  })
})
