import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderDiscovery } from './render.js'

describe('discovery render', () => {
  it('raid loot includes raid/item/character links pointing at source records', () => {
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
    assert.match(answer.factText, /Blazing Whip of Trillia/)
    assert.match(answer.factText, /Tandiyen/)
    const raid = answer.links.find((l) => l.type === 'raid')
    const item = answer.links.find((l) => l.type === 'item')
    const character = answer.links.find((l) => l.type === 'character')
    assert.equal(raid?.to, '/raids/r-fire-new')
    assert.equal(item?.to, `/items/${encodeURIComponent('Blazing Whip of Trillia')}`)
    assert.equal(character?.to, `/characters/${encodeURIComponent('Tandiyen')}`)
  })

  it('who-got wording distinguishes recorded awards', () => {
    const answer = renderDiscovery({
      ok: true,
      family: 'item_recipients',
      query: { family: 'item_recipients', itemQuery: 'Cloak of Wishes', raw: 'x' },
      awards: [
        {
          raidId: 'r1',
          raidName: 'Time',
          dateIso: '2026-02-10',
          itemName: 'Cloak of Wishes',
          characterName: 'Frank',
        },
      ],
    })
    assert.match(answer.factText, /recorded/i)
    assert.match(answer.factText, /Frank/)
    assert.ok(answer.links.some((l) => l.type === 'item' && l.to.includes('Cloak')))
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
  })
})
