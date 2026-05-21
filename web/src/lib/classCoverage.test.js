import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  viabilityThresholdForClass,
  extractRawGearScore,
  buildMaxRawScoreByClass,
  normalizedGearPct,
  extractGearPct,
  isViableGearPct,
  isHighlightedGearPct,
  highlightThresholdForClass,
  HIGHLIGHT_GEAR_PCT,
  TANK_HIGHLIGHT_GEAR_PCT,
  classesMatchForRanking,
  findRankingChar,
  buildAccountCoverage,
  coverageToUpsertRows,
  classNameToAbbrev,
} from './classCoverage.js'

describe('viabilityThresholdForClass', () => {
  it('uses 85 for tanks', () => {
    assert.equal(viabilityThresholdForClass('PAL'), 85)
    assert.equal(viabilityThresholdForClass('WAR'), 85)
    assert.equal(viabilityThresholdForClass('SHD'), 85)
  })
  it('uses 75 for non-tanks', () => {
    assert.equal(viabilityThresholdForClass('CLR'), 75)
    assert.equal(viabilityThresholdForClass('ROG'), 75)
  })
})

describe('extractRawGearScore', () => {
  it('prefers overall_score and ignores overall_pct', () => {
    assert.equal(extractRawGearScore({ overall_score: 7944, overall_pct: 88.3 }), 7944)
  })
  it('falls back to overall', () => {
    assert.equal(extractRawGearScore({ overall: 76 }), 76)
  })
})

describe('normalizedGearPct', () => {
  const rankingsChars = [
    { name: 'TopWar', class: 'Warrior', overall_score: 9000 },
    { name: 'Badammo', class: 'Warrior', overall_score: 7944 },
  ]
  const maxByClass = buildMaxRawScoreByClass(rankingsChars)

  it('normalizes vs best raw in class', () => {
    const badammo = rankingsChars.find((c) => c.name === 'Badammo')
    assert.equal(normalizedGearPct(badammo, maxByClass), 88.3)
  })

  it('single toon in class is 100%', () => {
    const solo = [{ name: 'Only', class: 'Wizard', overall_score: 42 }]
    const max = buildMaxRawScoreByClass(solo)
    assert.equal(normalizedGearPct(solo[0], max), 100)
  })

  it('uses overall_pct when max index empty', () => {
    assert.equal(normalizedGearPct({ class: 'Warrior', overall_pct: 82 }, new Map()), 82)
  })
})

describe('extractGearPct', () => {
  it('delegates to normalizedGearPct when maxByClass provided', () => {
    const max = buildMaxRawScoreByClass([
      { class: 'Warrior', overall_score: 100 },
      { class: 'Warrior', overall_score: 85 },
    ])
    assert.equal(
      extractGearPct({ class: 'Warrior', overall_score: 85 }, max),
      85,
    )
  })
})

describe('isViableGearPct', () => {
  it('requires strictly above threshold', () => {
    assert.equal(isViableGearPct(75, 'CLR'), false)
    assert.equal(isViableGearPct(75.1, 'CLR'), true)
    assert.equal(isViableGearPct(85, 'WAR'), false)
    assert.equal(isViableGearPct(85.1, 'WAR'), true)
  })
})

describe('highlightThresholdForClass / isHighlightedGearPct', () => {
  it('uses 85 highlight for non-tanks', () => {
    assert.equal(highlightThresholdForClass('WIZ'), HIGHLIGHT_GEAR_PCT)
    assert.equal(isHighlightedGearPct(85, 'WIZ'), false)
    assert.equal(isHighlightedGearPct(85.1, 'WIZ'), true)
  })

  it('uses 92 highlight for tanks (above 85 viability)', () => {
    assert.equal(TANK_HIGHLIGHT_GEAR_PCT, 92)
    assert.equal(highlightThresholdForClass('WAR'), 92)
    assert.equal(isHighlightedGearPct(88, 'WAR'), false)
    assert.equal(isHighlightedGearPct(92, 'WAR'), false)
    assert.equal(isHighlightedGearPct(92.1, 'WAR'), true)
    assert.equal(isHighlightedGearPct(85.1, 'WAR'), false)
  })
})

describe('classesMatchForRanking', () => {
  it('matches WAR abbrev to Warrior', () => {
    assert.equal(classesMatchForRanking('WAR', 'Warrior'), true)
    assert.equal(classesMatchForRanking('Warrior', 'WAR'), true)
  })
})

describe('findRankingChar', () => {
  const chars = [
    { name: 'Alice', class: 'Cleric' },
    { name: 'Bob', class: 'Warrior' },
  ]
  it('matches name and class', () => {
    assert.equal(findRankingChar(chars, 'Alice', 'Cleric')?.name, 'Alice')
  })
  it('matches name when class omitted', () => {
    assert.equal(findRankingChar(chars, 'Bob', '')?.class, 'Warrior')
  })
  it('matches WAR db class to Warrior magelo row', () => {
    assert.equal(findRankingChar(chars, 'Bob', 'WAR')?.class, 'Warrior')
  })
  it('falls back to name-only when db class mismatches', () => {
    const multi = [
      { name: 'Badammo', class: 'Warrior', overall_score: 88 },
      { name: 'Badammo', class: 'Cleric', overall_score: 50 },
    ]
    assert.equal(findRankingChar(multi, 'Badammo', 'Bard')?.class, 'Warrior')
  })
})

describe('buildAccountCoverage', () => {
  const rankingsChars = [
    { name: 'TopWiz', class: 'Wizard', overall_score: 100 },
    { name: 'MainWiz', class: 'Wizard', overall_score: 90 },
    { name: 'AltClr', class: 'Cleric', overall_score: 80 },
    { name: 'TankWar', class: 'Warrior', overall_score: 86 },
    { name: 'TopRog', class: 'Rogue', overall_score: 100 },
    { name: 'LowRog', class: 'Rogue', overall_score: 70 },
  ]

  it('dedupes by class and applies tank threshold on normalized %', () => {
    const built = buildAccountCoverage({
      links: [
        { char_id: 'c1', account_id: 'acc1' },
        { char_id: 'c2', account_id: 'acc1' },
        { char_id: 'c3', account_id: 'acc1' },
        { char_id: 'c4', account_id: 'acc1' },
      ],
      characters: [
        { char_id: 'c1', name: 'MainWiz', class_name: 'Wizard' },
        { char_id: 'c2', name: 'AltClr', class_name: 'Cleric' },
        { char_id: 'c3', name: 'TankWar', class_name: 'Warrior' },
        { char_id: 'c4', name: 'LowRog', class_name: 'Rogue' },
      ],
      rankingsChars,
      spendByCharId: { c1: 500, c2: 100, c3: 50 },
    })

    const cov = built.byAccount.get('acc1')
    assert.ok(cov)
    const abbrevs = cov.classes.map((c) => c.abbrev).sort()
    assert.deepEqual(abbrevs, ['CLR', 'WAR', 'WIZ'])
    const wiz = cov.classes.find((c) => c.abbrev === 'WIZ')
    assert.equal(wiz.is_main, true)
    assert.equal(wiz.gear_pct, 90)
    const clr = cov.classes.find((c) => c.abbrev === 'CLR')
    assert.equal(clr.is_main, false)
    assert.equal(clr.gear_pct, 100)
  })

  it('excludes warrior at exactly 85% normalized', () => {
    const built = buildAccountCoverage({
      links: [{ char_id: 'w1', account_id: 'acc2' }],
      characters: [{ char_id: 'w1', name: 'EdgeWar', class_name: 'Warrior' }],
      rankingsChars: [
        { name: 'BestWar', class: 'Warrior', overall_score: 100 },
        { name: 'EdgeWar', class: 'Warrior', overall_score: 85 },
      ],
      spendByCharId: {},
    })
    assert.equal(built.byAccount.get('acc2'), undefined)
  })

  it('includes Badammo WAR when raw is below tank cutoff but normalized is above', () => {
    const built = buildAccountCoverage({
      links: [{ char_id: 'bad1', account_id: 'ammordius' }],
      characters: [{ char_id: 'bad1', name: 'Badammo', class_name: 'Warrior' }],
      rankingsChars: [
        { name: 'TopWar', class: 'Warrior', overall_score: 9000 },
        { name: 'Badammo', class: 'Warrior', overall_score: 7944 },
      ],
      spendByCharId: {},
    })
    const cov = built.byAccount.get('ammordius')
    assert.ok(cov)
    const war = cov.classes.find((c) => c.abbrev === 'WAR')
    assert.ok(war)
    assert.equal(war.gear_pct, 88.3)
    assert.equal(war.char_name, 'Badammo')
  })

  it('attributes WAR from magelo when db class is wrong', () => {
    const built = buildAccountCoverage({
      links: [{ char_id: 'bad1', account_id: 'ammordius' }],
      characters: [{ char_id: 'bad1', name: 'Badammo', class_name: 'Bard' }],
      rankingsChars: [{ name: 'Badammo', class: 'Warrior', overall_score: 88 }],
      spendByCharId: {},
    })
    const cov = built.byAccount.get('ammordius')
    assert.ok(cov)
    const war = cov.classes.find((c) => c.abbrev === 'WAR')
    assert.ok(war)
    assert.equal(war.gear_pct, 100)
    assert.equal(war.char_name, 'Badammo')
  })

  it('matches db WAR abbrev to magelo Warrior', () => {
    const built = buildAccountCoverage({
      links: [{ char_id: 'w1', account_id: 'acc3' }],
      characters: [{ char_id: 'w1', name: 'Tank', class_name: 'WAR' }],
      rankingsChars: [{ name: 'Tank', class: 'Warrior', overall_score: 88 }],
      spendByCharId: {},
    })
    const war = built.byAccount.get('acc3')?.classes.find((c) => c.abbrev === 'WAR')
    assert.ok(war)
    assert.equal(war.gear_pct, 100)
  })
})

describe('coverageToUpsertRows', () => {
  it('omits accounts with no viable classes', () => {
    const built = buildAccountCoverage({
      links: [{ char_id: 'x', account_id: 'empty' }],
      characters: [{ char_id: 'x', name: 'Nobody', class_name: 'Bard' }],
      rankingsChars: [],
    })
    assert.equal(coverageToUpsertRows(built).length, 0)
  })
})

describe('classNameToAbbrev', () => {
  it('maps full class names', () => {
    assert.equal(classNameToAbbrev('Shadow Knight'), 'SHD')
    assert.equal(classNameToAbbrev('PAL'), 'PAL')
  })
})
