import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  estimateBidReconstructionHeuristic,
  normalizeEquipSlotKey,
  slotKeysOverlap,
  simulateBalancesBeforeLootRow,
} from './bidForecastModel.js'

describe('simulateBalancesBeforeLootRow', () => {
  it('raid_level: credits full raid earned then subtracts prior loot', () => {
    const balances = simulateBalancesBeforeLootRow({
      accountRollup: [{ account_id: 'A', earned_this_raid: 100, spent_this_raid: 50 }],
      balanceByAccount: { A: 500 },
      simMode: 'raid_level',
      eventsOrdered: [],
      perEventEarned: [],
      lootTimeline: [
        {
          loot_id: 1,
          event_id: '',
          event_order: 0,
          cost: 20,
          buyer_account_id: 'A',
        },
        {
          loot_id: 2,
          event_id: '',
          event_order: 0,
          cost: 30,
          buyer_account_id: 'A',
        },
      ],
      targetLootId: 2,
    })
    // B0 = 500 + 50 - 100 = 450; +100 raid = 550; -20 first loot = 530; stop before loot 2
    assert.equal(balances.A, 530)
  })

  it('per_event: credits event DKP before loot in that event', () => {
    const balances = simulateBalancesBeforeLootRow({
      accountRollup: [{ account_id: 'A', earned_this_raid: 50, spent_this_raid: 10 }],
      balanceByAccount: { A: 200 },
      eventsOrdered: [
        { event_id: 'e1', event_order: 1 },
        { event_id: 'e2', event_order: 2 },
      ],
      perEventEarned: [
        { account_id: 'A', event_id: 'e1', dkp_earned: 40 },
        { account_id: 'A', event_id: 'e2', dkp_earned: 10 },
      ],
      lootTimeline: [
        { loot_id: 10, event_id: 'e1', event_order: 1, cost: 5, buyer_account_id: 'A' },
        { loot_id: 20, event_id: 'e2', event_order: 2, cost: 100, buyer_account_id: 'A' },
      ],
      targetLootId: 20,
    })
    // B0 = 200 + 10 - 50 = 160; e1: +40, -5 => 195; e2: +10 before its loot => 205; stop before loot 20
    assert.equal(balances.A, 205)
  })
})

describe('normalizeEquipSlotKey / slotKeysOverlap', () => {
  it('sorts multi-slot keys for stable matching', () => {
    assert.equal(normalizeEquipSlotKey('PRIMARY SECONDARY'), 'PRIMARY|SECONDARY')
    assert.equal(normalizeEquipSlotKey('SECONDARY PRIMARY'), 'PRIMARY|SECONDARY')
  })
  it('detects token overlap', () => {
    assert.equal(slotKeysOverlap('EAR', 'EAR'), true)
    assert.equal(slotKeysOverlap('EAR', 'NECK'), false)
  })
})

describe('estimateBidReconstructionHeuristic', () => {
  it('picks highest scoreDelta with enough pool as winner at clearing price', () => {
    const candidates = [
      {
        toonRowKey: 'a:1',
        accountId: 'A',
        scoreDelta: 0.1,
        upgrade: { isUpgrade: true },
        charName: 'Low',
      },
      {
        toonRowKey: 'b:2',
        accountId: 'B',
        scoreDelta: 0.5,
        upgrade: { isUpgrade: true },
        charName: 'High',
      },
    ]
    const { winner, byToonRowKey } = estimateBidReconstructionHeuristic(
      candidates,
      { A: 200, B: 80 },
      75,
    )
    assert.equal(winner?.charName, 'High')
    assert.equal(byToonRowKey.get('b:2')?.role, 'winner_guess')
    assert.equal(byToonRowKey.get('a:1')?.role, 'outbid_rank')
  })

  it('marks priced_out when pool below clearing', () => {
    const { winner, byToonRowKey } = estimateBidReconstructionHeuristic(
      [
        {
          toonRowKey: 'x:1',
          accountId: 'X',
          scoreDelta: 1,
          upgrade: { isUpgrade: true },
          charName: 'Poor',
        },
      ],
      { X: 10 },
      50,
    )
    assert.equal(winner, null)
    assert.equal(byToonRowKey.get('x:1')?.role, 'priced_out')
  })
})
