import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  viabilityThresholdForClass,
  extractGearPct,
  isViableGearPct,
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

describe('extractGearPct', () => {
  it('prefers overall_score (NAGD export)', () => {
    assert.equal(extractGearPct({ overall_score: 88.2, overall_pct: 50 }), 88.2)
  })
  it('prefers overall_pct when overall_score missing', () => {
    assert.equal(extractGearPct({ overall_pct: 82, overall: 50 }), 82)
  })
  it('falls back to overall', () => {
    assert.equal(extractGearPct({ overall: 76 }), 76)
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
})

describe('buildAccountCoverage', () => {
  const rankingsChars = [
    { name: 'MainWiz', class: 'Wizard', overall_score: 90 },
    { name: 'AltClr', class: 'Cleric', overall_score: 80 },
    { name: 'TankWar', class: 'Warrior', overall_score: 86 },
    { name: 'LowRog', class: 'Rogue', overall_score: 70 },
  ]

  it('dedupes by class and applies tank threshold', () => {
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
  })

  it('excludes warrior at exactly 85%', () => {
    const built = buildAccountCoverage({
      links: [{ char_id: 'w1', account_id: 'acc2' }],
      characters: [{ char_id: 'w1', name: 'EdgeWar', class_name: 'Warrior' }],
      rankingsChars: [{ name: 'EdgeWar', class: 'Warrior', overall_score: 85 }],
      spendByCharId: {},
    })
    assert.equal(built.byAccount.get('acc2'), undefined)
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
