/**
 * Hand-authored high-value discovery eval seeds (incl. reported failures).
 */
import { defineCase } from './caseSchema.js'

/** @type {import('./caseSchema.js').EvalCase[]} */
export const SEED_CASES = [
  defineCase({
    id: 'seed-five-turn-sequence',
    category: 'seed',
    turns: [
      'what did quarm drop last time',
      'who got the last plate bp',
      'what about silk robe',
      'who go the most recent silk robe?',
      'who got the most recent silk robe',
    ],
    expectTurns: [
      {
        recognitionStatus: 'recognized',
        boss: 'Quarm',
        scope: 'last_raid_night',
        outcome: 'answered',
      },
      {
        recognitionStatus: 'recognized',
        intent: 'last_award',
        resolvedItemMatch: /breastplate/i,
        awardRecipients: ['PlateWinner'],
        outcome: 'answered',
      },
      {
        recognitionStatus: 'recognized',
        resolvedItemMatch: /silk robe/i,
        awardRecipients: ['SilkWinner'],
        prevItemMustNotAppear: 'Breastplate',
        mustChangeEntity: true,
        outcome: 'answered',
      },
      {
        recognitionStatus: 'recognized',
        resolvedItemMatch: /silk robe/i,
        awardRecipients: ['SilkWinner'],
        outcome: 'answered',
      },
      {
        recognitionStatus: 'recognized',
        intent: 'last_award',
        resolvedItemMatch: /silk robe/i,
        awardRecipients: ['SilkWinner'],
        prevItemMustNotAppear: 'Breastplate',
        outcome: 'answered',
      },
    ],
    expect: {},
  }),
  defineCase({
    id: 'seed-quarm-drop-last-time',
    category: 'A_raid_boss_zone',
    text: 'what did quarm drop last time',
    expect: {
      recognitionStatus: 'recognized',
      boss: 'Quarm',
      scope: 'last_raid_night',
      outcome: 'answered',
    },
  }),
  defineCase({
    id: 'seed-plate-bp-last',
    category: 'B_items_slots',
    text: 'who got the last plate bp',
    expect: {
      recognitionStatus: 'recognized',
      intent: 'last_award',
      resolvedItemMatch: /breastplate/i,
      awardRecipients: ['PlateWinner'],
      outcome: 'answered',
    },
  }),
  defineCase({
    id: 'seed-silk-robe-fresh',
    category: 'B_items_slots',
    text: 'who got the most recent silk robe',
    expect: {
      recognitionStatus: 'recognized',
      intent: 'last_award',
      resolvedItemMatch: /silk robe/i,
      awardRecipients: ['SilkWinner'],
      outcome: 'answered',
    },
  }),
  defineCase({
    id: 'seed-who-go-typo',
    category: 'E_malformed',
    text: 'who go the most recent silk robe?',
    expect: {
      recognitionStatus: 'recognized',
      resolvedItemMatch: /silk robe/i,
      outcome: 'answered',
    },
  }),
  defineCase({
    id: 'seed-context-silk-after-plate',
    category: 'D_context',
    turns: ['who got the last plate bp', 'what about silk robe'],
    expectTurns: [
      { resolvedItemMatch: /breastplate/i, awardRecipients: ['PlateWinner'] },
      {
        resolvedItemMatch: /silk robe/i,
        awardRecipients: ['SilkWinner'],
        prevItemMustNotAppear: 'Breastplate',
        mustChangeEntity: true,
      },
    ],
    expect: {},
  }),
  defineCase({
    id: 'seed-context-plate-after-silk',
    category: 'D_context',
    turns: ['who got the most recent silk robe', 'And plate BP?'],
    expectTurns: [
      { resolvedItemMatch: /silk robe/i, awardRecipients: ['SilkWinner'] },
      {
        resolvedItemMatch: /breastplate/i,
        awardRecipients: ['PlateWinner'],
        prevItemMustNotAppear: 'Silk Robe',
        mustChangeEntity: true,
      },
    ],
    expect: {},
  }),
  defineCase({
    id: 'seed-quarm-rings-followup',
    category: 'D_context',
    turns: ['What dropped off Quarm?', 'What about rings?'],
    expectTurns: [
      { boss: 'Quarm', scope: 'last_raid_night' },
      { boss: 'Quarm', slot: 'FINGER', intent: 'last_award' },
    ],
    expect: {},
  }),
  defineCase({
    id: 'seed-isolation-a-b-a',
    category: 'F_isolation',
    turns: [
      'who got the last plate bp',
      'who got the most recent silk robe',
      'who got the last plate bp',
    ],
    expectTurns: [
      { resolvedItemMatch: /breastplate/i, awardRecipients: ['PlateWinner'] },
      { resolvedItemMatch: /silk robe/i, awardRecipients: ['SilkWinner'], mustChangeEntity: true },
      { resolvedItemMatch: /breastplate/i, awardRecipients: ['PlateWinner'], mustChangeEntity: true },
    ],
    expect: {},
  }),
  defineCase({
    id: 'seed-personal-roast-not-discovery',
    category: 'E_malformed',
    text: 'Why am I broke?',
    expect: { recognitionStatus: 'not_discovery', skipRetrieval: true },
    inScope: false,
  }),
  defineCase({
    id: 'seed-item-source-not-discovery',
    category: 'E_malformed',
    text: 'Where does Cloak of Wishes drop?',
    expect: { recognitionStatus: 'not_discovery', skipRetrieval: true },
    inScope: false,
  }),
  defineCase({
    id: 'seed-cloak-recipients',
    category: 'B_items_slots',
    text: 'Who got Cloak of Wishes?',
    expect: {
      recognitionStatus: 'recognized',
      family: 'item_recipients',
      resolvedItemMatch: /cloak of wishes/i,
      outcome: 'answered',
    },
  }),
  defineCase({
    id: 'seed-quarm-catalog',
    category: 'A_raid_boss_zone',
    text: 'What can Quarm drop?',
    expect: {
      recognitionStatus: 'recognized',
      intent: 'catalog',
      boss: 'Quarm',
    },
  }),
  defineCase({
    id: 'seed-p3-last-time',
    category: 'A_raid_boss_zone',
    text: 'What dropped in P3 last time?',
    expect: {
      recognitionStatus: 'recognized',
      phase: 'P3',
      family: 'raid_loot',
      outcome: 'answered',
    },
  }),
  defineCase({
    id: 'seed-ammordius-awards',
    category: 'B_items_slots',
    text: 'What did Ammordius get last month?',
    expect: {
      recognitionStatus: 'recognized',
      character: 'Ammordius',
      family: 'character_awards',
    },
  }),
]
