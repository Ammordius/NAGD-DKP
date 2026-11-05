import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tryParseDiscovery, looksLikeDiscovery, extractTimeRange } from './parse.js'

const CASES = [
  {
    name: 'last PoF loot',
    text: 'What dropped last time in PoF?',
    expect: { family: 'raid_loot', zone: 'Plane of Fire', mostRecentRaidFirst: true },
  },
  {
    name: 'last Fire alias',
    text: 'What dropped last time in Fire?',
    expect: { family: 'raid_loot', zone: 'Plane of Fire' },
  },
  {
    name: 'P3 last time',
    text: 'What dropped in P3 last time?',
    expect: { family: 'raid_loot', phase: 'P3', zone: 'Plane of Time', mostRecentRaidFirst: true },
  },
  {
    name: 'phase three',
    text: 'What dropped in phase three last time?',
    expect: { family: 'raid_loot', phase: 'P3', zone: 'Plane of Time' },
  },
  {
    name: 'last item award timing',
    text: "When's the last time P3 caster shoulders dropped?",
    expect: { family: 'item_last', phase: 'P3' },
  },
  {
    name: 'who got item',
    text: 'Who got Cloak of Wishes?',
    expect: { family: 'item_recipients', itemQuery: 'cloak of wishes' },
  },
  {
    name: 'who got the last item',
    text: 'Who got the last Cloak of Wishes?',
    expect: { family: 'item_last' },
  },
  {
    name: 'has character won',
    text: 'Has Ammordius ever won Cloak of Wishes?',
    expect: { family: 'has_won', character: 'Ammordius' },
  },
  {
    name: 'how many times',
    text: 'How many times did Cloak of Wishes drop?',
    expect: { family: 'item_count', itemQuery: 'cloak of wishes' },
  },
  {
    name: 'character last month',
    text: 'What did Tandiyen get last month?',
    expect: { family: 'character_awards', character: 'Tandiyen' },
    timeLabel: 'last month',
  },
  {
    name: 'Time last week',
    text: 'What dropped in Time last week?',
    expect: { family: 'raid_loot', zone: 'Plane of Time' },
    timeLabel: 'last week',
  },
  {
    name: 'dropped off boss',
    text: 'What dropped off Quarm?',
    expect: { family: 'boss_raid_loot', boss: 'Quarm' },
  },
  {
    name: 'catalog boss drops',
    text: 'What can Quarm drop?',
    expect: { family: 'boss_catalog', boss: 'Quarm' },
  },
]

describe('discovery parse', () => {
  for (const c of CASES) {
    it(c.name, () => {
      assert.equal(looksLikeDiscovery(c.text), true)
      const q = tryParseDiscovery(c.text, { nowIso: '2026-03-05T12:00:00Z' })
      assert.ok(q, `expected parse for: ${c.text}`)
      for (const [k, v] of Object.entries(c.expect)) {
        if (k === 'itemQuery') {
          assert.equal(String(q.itemQuery || '').toLowerCase(), String(v).toLowerCase())
        } else {
          assert.equal(q[k], v, `${k} for ${c.text}`)
        }
      }
      if (c.timeLabel) {
        assert.equal(q.timeRange?.label, c.timeLabel)
      }
    })
  }

  it('does not treat personal roast as discovery', () => {
    assert.equal(looksLikeDiscovery('Roast my spending'), false)
    assert.equal(tryParseDiscovery('Why am I broke?'), null)
    assert.equal(tryParseDiscovery('What should I buy?'), null)
  })

  it('extractTimeRange windows', () => {
    const week = extractTimeRange('loot last week', '2026-03-05T00:00:00Z')
    assert.equal(week?.label, 'last week')
    assert.equal(week?.toIso, '2026-03-05')
    assert.equal(week?.fromIso, '2026-02-26')
  })
})
