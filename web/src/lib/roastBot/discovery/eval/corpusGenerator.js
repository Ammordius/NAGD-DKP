/**
 * Deterministic compositional corpus generator for discovery eval.
 * Combines intent × verb synonym × entity × temporal × word-order × context.
 */
import { defineCase } from './caseSchema.js'
import { SEED_CASES } from './seedCases.js'

const NOW_ISO = '2026-03-05T12:00:00Z'

const ITEMS = [
  {
    key: 'plate_bp',
    phrases: ['plate bp', 'plate BP', 'plate breastplate'],
    resolvedMatch: /breastplate/i,
    recipient: 'PlateWinner',
    id: '16375',
  },
  {
    key: 'silk_robe',
    phrases: ['silk robe', 'silk Robe'],
    resolvedMatch: /silk robe/i,
    recipient: 'SilkWinner',
    id: '16384',
  },
  {
    key: 'cloak',
    phrases: ['Cloak of Wishes', 'cloak of wishes'],
    resolvedMatch: /cloak of wishes/i,
    recipient: null,
    id: '21997',
  },
  {
    key: 'silk_arms',
    phrases: ['silk arms'],
    resolvedMatch: /silk sleeve/i,
    recipient: null,
    id: '16385',
  },
]

const BOSSES = [
  { key: 'quarm', phrases: ['Quarm', 'quarm'], name: 'Quarm' },
]

const ZONES = [
  { key: 'pof', phrases: ['PoF', 'Fire', 'Plane of Fire'], zone: 'Plane of Fire' },
  { key: 'time', phrases: ['Time', 'PoTime', 'Plane of Time'], zone: 'Plane of Time' },
]

const PHASES = [
  { key: 'p3', phrases: ['P3', 'p3', 'phase 3'], phase: 'P3' },
]

const CHARACTERS = [
  { key: 'ammordius', phrases: ['Ammordius'], name: 'Ammordius' },
  { key: 'tandiyen', phrases: ['Tandiyen'], name: 'Tandiyen' },
]

const WHO_VERBS = ['got', 'won', 'received']
const LAST_TEMPORALS = ['the last', 'the most recent', 'the latest', 'last']
const DROP_TEMPLATES = [
  (b) => `what did ${b} drop last time`,
  (b) => `what dropped off ${b}`,
  (b) => `last ${b} loot`,
  (b) => `What can ${b} drop?`,
]

/**
 * @returns {import('./caseSchema.js').EvalCase[]}
 */
export function generateCorpus() {
  /** @type {import('./caseSchema.js').EvalCase[]} */
  const cases = [...SEED_CASES]
  let n = 0
  const id = (prefix) => `${prefix}-${++n}`

  // --- Category A: raid / boss / zone / phase ---
  for (const boss of BOSSES) {
    for (const phrase of boss.phrases) {
      for (const tmpl of DROP_TEMPLATES) {
        const text = tmpl(phrase)
        const isCatalog = /what can/i.test(text)
        cases.push(
          defineCase({
            id: id('A-boss'),
            category: 'A_raid_boss_zone',
            text,
            expect: {
              recognitionStatus: 'recognized',
              boss: boss.name,
              ...(isCatalog
                ? { intent: 'catalog' }
                : /last time|dropped off|last .+ loot/i.test(text)
                  ? { scope: 'last_raid_night' }
                  : {}),
            },
          }),
        )
      }
    }
  }

  for (const zone of ZONES) {
    for (const phrase of zone.phrases) {
      for (const text of [
        `What dropped in ${phrase} last time?`,
        `Last ${phrase} loot`,
        `What was looted in ${phrase}?`,
      ]) {
        cases.push(
          defineCase({
            id: id('A-zone'),
            category: 'A_raid_boss_zone',
            text,
            expect: {
              recognitionStatus: 'recognized',
              zone: zone.zone,
            },
          }),
        )
      }
    }
  }

  for (const phase of PHASES) {
    for (const phrase of phase.phrases) {
      for (const text of [
        `What dropped in ${phrase} last time?`,
        `What was looted in ${phrase}?`,
        `What dropped in ${phrase}?`,
      ]) {
        cases.push(
          defineCase({
            id: id('A-phase'),
            category: 'A_raid_boss_zone',
            text,
            expect: {
              recognitionStatus: 'recognized',
              phase: phase.phase,
            },
          }),
        )
      }
    }
  }

  // --- Category B + C: items / paraphrases / metamorphic equivalence ---
  for (const item of ITEMS) {
    for (const phrase of item.phrases) {
      for (const verb of WHO_VERBS) {
        for (const temporal of LAST_TEMPORALS) {
          const text = `who ${verb} ${temporal} ${phrase}`
          const group = `meta-last-${item.key}`
          cases.push(
            defineCase({
              id: id('C-who-last'),
              category: 'C_paraphrase',
              text,
              group,
              expect: {
                recognitionStatus: 'recognized',
                intent: 'last_award',
                resolvedItemMatch: item.resolvedMatch,
                ...(item.recipient
                  ? { awardRecipients: [item.recipient], outcome: 'answered' }
                  : {}),
                ...(item.id ? { resolvedItemId: item.id } : {}),
              },
            }),
          )
        }
        // Non-last recipient history
        cases.push(
          defineCase({
            id: id('B-who'),
            category: 'B_items_slots',
            text: `who ${verb} ${phrase}`,
            expect: {
              recognitionStatus: 'recognized',
              resolvedItemMatch: item.resolvedMatch,
            },
          }),
        )
      }

      for (const text of [
        `when was ${phrase} last awarded`,
        `when's the last time ${phrase} dropped`,
        `last ${phrase}`,
        `most recent ${phrase}`,
        `did ${phrase} drop recently`,
      ]) {
        cases.push(
          defineCase({
            id: id('C-when'),
            category: 'C_paraphrase',
            text,
            group: `meta-when-${item.key}`,
            expect: {
              recognitionStatus: 'recognized',
              resolvedItemMatch: item.resolvedMatch,
            },
          }),
        )
      }
    }
  }

  // Non-equivalence: plate bp vs silk robe must not share resolved id
  cases.push(
    defineCase({
      id: id('C-nonequiv'),
      category: 'C_paraphrase',
      turns: ['who got the last plate bp', 'who got the last silk robe'],
      expectTurns: [
        { resolvedItemId: '16375', resolvedItemMatch: /breastplate/i },
        {
          resolvedItemId: '16384',
          resolvedItemMatch: /silk robe/i,
          mustChangeEntity: true,
          prevItemMustNotAppear: 'Breastplate',
        },
      ],
      expect: {},
    }),
  )

  // --- Category D: conversational context ---
  const contextPairs = [
    {
      first: 'Who got the last plate bp?',
      second: 'What about silk robe?',
      e1: { resolvedItemMatch: /breastplate/i },
      e2: {
        resolvedItemMatch: /silk robe/i,
        mustChangeEntity: true,
        prevItemMustNotAppear: 'Breastplate',
      },
    },
    {
      first: 'Who got the most recent silk robe?',
      second: 'And plate BP?',
      e1: { resolvedItemMatch: /silk robe/i },
      e2: {
        resolvedItemMatch: /breastplate/i,
        mustChangeEntity: true,
        prevItemMustNotAppear: 'Silk',
      },
    },
    {
      first: 'What dropped off Quarm?',
      second: 'What about rings?',
      e1: { boss: 'Quarm' },
      e2: { boss: 'Quarm', slot: 'FINGER' },
    },
    {
      first: 'When did Quarm last drop a ring?',
      second: 'Who got it?',
      e1: { boss: 'Quarm', slot: 'FINGER' },
      e2: { intent: 'recipients' },
    },
    {
      first: 'What dropped in P3?',
      second: 'How about P4?',
      e1: { phase: 'P3' },
      e2: { phase: 'P4' },
    },
    {
      first: 'What did Ammordius get?',
      second: 'And Tandiyen?',
      e1: { character: 'Ammordius' },
      e2: { character: 'Tandiyen' },
    },
    {
      first: 'Who got Cloak of Wishes?',
      second: 'What about last month?',
      e1: { resolvedItemMatch: /cloak/i },
      e2: { resolvedItemMatch: /cloak/i },
    },
    {
      first: 'Show Quarm loot',
      second: 'Actually, PoF.',
      e1: { boss: 'Quarm' },
      e2: { zone: 'Plane of Fire' },
    },
  ]

  for (const pair of contextPairs) {
    cases.push(
      defineCase({
        id: id('D-ctx'),
        category: 'D_context',
        turns: [pair.first, pair.second],
        expectTurns: [pair.e1, pair.e2],
        expect: {},
      }),
    )
  }

  // Character swaps
  for (const a of CHARACTERS) {
    for (const b of CHARACTERS) {
      if (a.key === b.key) continue
      cases.push(
        defineCase({
          id: id('D-char'),
          category: 'D_context',
          turns: [`What did ${a.name} get last month?`, `And ${b.name}?`],
          expectTurns: [{ character: a.name }, { character: b.name, mustChangeEntity: true }],
          expect: {},
        }),
      )
    }
  }

  // --- Category E: malformed / ambiguous ---
  const malformed = [
    { text: 'who go the most recent silk robe', expect: { recognitionStatus: 'recognized', resolvedItemMatch: /silk robe/i } },
    { text: 'who gott the last plate bp', expect: { recognitionStatus: 'recognized', resolvedItemMatch: /breastplate/i } },
    { text: 'last plate bp?', expect: { recognitionStatus: 'recognized', resolvedItemMatch: /breastplate/i } },
    { text: 'quarm ring', expect: { recognitionStatus: 'recognized', boss: 'Quarm', slot: 'FINGER' } },
    { text: 'p3 shoulders', expect: { recognitionStatus: 'recognized', phase: 'P3', slot: 'SHOULDERS' } },
    { text: 'who got the last zxqy foobar item', expect: { recognitionStatus: 'recognized' } },
    { text: 'roast my spending', expect: { recognitionStatus: 'not_discovery', skipRetrieval: true }, inScope: false },
    { text: 'what should i buy', expect: { recognitionStatus: 'not_discovery', skipRetrieval: true }, inScope: false },
  ]
  for (const m of malformed) {
    cases.push(
      defineCase({
        id: id('E-mal'),
        category: 'E_malformed',
        text: m.text,
        inScope: m.inScope !== false,
        expect: m.expect,
      }),
    )
  }

  // --- Category F: cross-query isolation ---
  cases.push(
    defineCase({
      id: id('F-abab'),
      category: 'F_isolation',
      turns: [
        'who got the last plate bp',
        'who got the most recent silk robe',
        'who got the last plate bp',
        'who got the most recent silk robe',
      ],
      expectTurns: [
        { resolvedItemMatch: /breastplate/i, awardRecipients: ['PlateWinner'] },
        { resolvedItemMatch: /silk robe/i, awardRecipients: ['SilkWinner'], mustChangeEntity: true },
        { resolvedItemMatch: /breastplate/i, awardRecipients: ['PlateWinner'], mustChangeEntity: true },
        { resolvedItemMatch: /silk robe/i, awardRecipients: ['SilkWinner'], mustChangeEntity: true },
      ],
      expect: {},
    }),
  )

  cases.push(
    defineCase({
      id: id('F-boss-swap'),
      category: 'F_isolation',
      turns: ['What dropped off Quarm?', 'What can Quarm drop?'],
      expectTurns: [
        { boss: 'Quarm', scope: 'last_raid_night' },
        { boss: 'Quarm', intent: 'catalog', mustChangeEntity: true },
      ],
      expect: {},
    }),
  )

  // Fresh vs follow-up: same short phrase
  cases.push(
    defineCase({
      id: id('F-fresh-silk'),
      category: 'F_isolation',
      text: 'what about silk robe',
      expect: {
        recognitionStatus: 'recognized',
        resolvedItemMatch: /silk robe/i,
      },
    }),
  )
  cases.push(
    defineCase({
      id: id('F-follow-silk'),
      category: 'F_isolation',
      turns: ['who got the last plate bp', 'what about silk robe'],
      expectTurns: [
        { resolvedItemMatch: /breastplate/i },
        { resolvedItemMatch: /silk robe/i, mustChangeEntity: true, prevItemMustNotAppear: 'Breastplate' },
      ],
      expect: {},
    }),
  )

  // Pad with additional slot/role/zone paraphrases to clear 300
  const slots = [
    { phrase: 'rings', slot: 'FINGER' },
    { phrase: 'shoulders', slot: 'SHOULDERS' },
    { phrase: 'arms', slot: 'ARMS' },
  ]
  for (const boss of BOSSES) {
    for (const s of slots) {
      for (const text of [
        `who got the last ${boss.phrases[0]} ${s.phrase}`,
        `last ${boss.phrases[0]} ${s.phrase}`,
        `when did ${boss.phrases[0]} last drop a ${s.phrase.replace(/s$/, '')}`,
        `what about ${boss.phrases[0]} ${s.phrase}`,
      ]) {
        cases.push(
          defineCase({
            id: id('B-boss-slot'),
            category: 'B_items_slots',
            text,
            expect: {
              recognitionStatus: 'recognized',
              boss: boss.name,
              slot: s.slot,
            },
          }),
        )
      }
    }
  }

  const armorSlots = [
    { phrase: 'plate arms', match: /vambrace|plate/i },
    { phrase: 'silk arms', match: /silk sleeve/i },
    { phrase: 'chain bp', match: /chain tunic/i },
    { phrase: 'leather tunic', match: /leather tunic/i },
    { phrase: 'ele mold', match: null },
    { phrase: 'plate legs', match: /greaves/i },
    { phrase: 'silk wrists', match: /silk bracelet/i },
  ]
  for (const a of armorSlots) {
    for (const verb of WHO_VERBS) {
      for (const temporal of ['the last', 'the most recent']) {
        cases.push(
          defineCase({
            id: id('B-armor'),
            category: 'B_items_slots',
            text: `who ${verb} ${temporal} ${a.phrase}`,
            expect: {
              recognitionStatus: 'recognized',
              intent: 'last_award',
              ...(a.match ? { resolvedItemMatch: a.match } : {}),
            },
          }),
        )
      }
    }
  }

  // Word-order variations for Quarm loot
  for (const text of [
    'last time what did quarm drop',
    'quarm drop last time',
    'dropped off quarm last time',
    'what dropped last time off quarm',
  ]) {
    cases.push(
      defineCase({
        id: id('C-wordorder'),
        category: 'C_paraphrase',
        text,
        expect: {
          recognitionStatus: 'recognized',
          boss: 'Quarm',
        },
      }),
    )
  }

  // Extra paraphrases to ensure ≥300 and broaden coverage
  const extraItems = ['plate bp', 'silk robe', 'Cloak of Wishes', 'Band of the Eternal', 'Quarm Tooth']
  const extraVerbs = ['got', 'won', 'looted', 'received']
  for (const item of extraItems) {
    for (const verb of extraVerbs) {
      cases.push(
        defineCase({
          id: id('C-extra'),
          category: 'C_paraphrase',
          text: `who ${verb} the last ${item}`,
          expect: {
            recognitionStatus: 'recognized',
            intent: 'last_award',
          },
        }),
      )
      cases.push(
        defineCase({
          id: id('B-extra'),
          category: 'B_items_slots',
          text: `how many times has ${item} dropped`,
          expect: {
            recognitionStatus: 'recognized',
            intent: 'count',
          },
        }),
      )
    }
  }

  for (const text of [
    'Show the last Plane of Time raid',
    'What dropped in Time before the EP gods?',
    'Last Quarm loot?',
    'What did Quarm drop yesterday?',
    'Has Tandiyen ever received Cloak of Wishes?',
    'How many times was Cloak of Wishes awarded?',
    'Who looted the last silk robe',
    'latest plate bp recipient',
    'who won silk robe most recently',
  ]) {
    cases.push(
      defineCase({
        id: id('A-extra'),
        category: text.toLowerCase().includes('who') || text.toLowerCase().includes('recipient')
          ? 'B_items_slots'
          : 'A_raid_boss_zone',
        text,
        expect: { recognitionStatus: 'recognized' },
      }),
    )
  }

  return cases
}

export { NOW_ISO }

/**
 * @returns {{ cases: import('./caseSchema.js').EvalCase[], total: number }}
 */
export function buildEvalCorpus() {
  const cases = generateCorpus()
  return { cases, total: cases.length }
}
