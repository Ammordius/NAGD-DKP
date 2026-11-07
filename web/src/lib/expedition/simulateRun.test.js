import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AMMORDIUS_PARTIES, profilesMapFromJson } from './ammordiusFixtures.js'
import { simulateMany, simulateRun } from './simulateRun.js'
import { buildCombatIdentity } from './combatProfile.js'
import { getPassive } from './passives.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROFILES_PATH = join(__dirname, '../../../public/expedition/combat-profiles.json')

function loadProfiles() {
  const json = JSON.parse(readFileSync(PROFILES_PATH, 'utf8'))
  return profilesMapFromJson(json)
}

describe('expedition simulateRun balance', () => {
  it('wires cleric healPower into healEfficiency and healCostMult', () => {
    const passive = getPassive('Cleric')
    assert.equal(passive.modifiers.healPower, 0.25)
    assert.equal(passive.modifiers.healCostMult, 0.85)
    const idn = buildCombatIdentity({ name: 'Healammo', class_name: 'Cleric', level: 65 }, null)
    assert.equal(idn.derived.healEfficiency, 0.25)
    assert.equal(idn.derived.healCostMult, 0.85)
  })

  it('completes a short seeded run without throwing', () => {
    const profiles = loadProfiles()
    const result = simulateRun(AMMORDIUS_PARTIES.balanced.party(), {
      seed: 42,
      difficulty: 'normal',
      profiles,
      policy: 'skilledSupport',
    })
    assert.equal(typeof result.won, 'boolean')
    assert.ok(result.encountersCleared >= 0)
    assert.ok(result.rounds >= 1)
  })

  it('on Reckless, balanced+skilled beats basicSpam and all-DPS (seeded)', () => {
    const profiles = loadProfiles()
    const trials = 32
    const baseSeed = 1000

    const balancedSkilled = simulateMany(AMMORDIUS_PARTIES.balanced.party(), {
      trials,
      baseSeed,
      difficulty: 'reckless',
      profiles,
      policy: 'skilledSupport',
    })
    const balancedSpam = simulateMany(AMMORDIUS_PARTIES.balanced.party(), {
      trials,
      baseSeed,
      difficulty: 'reckless',
      profiles,
      policy: 'basicSpam',
    })
    const allDpsSkilled = simulateMany(AMMORDIUS_PARTIES.allDps.party(), {
      trials,
      baseSeed,
      difficulty: 'reckless',
      profiles,
      policy: 'skilledSupport',
    })

    assert.ok(
      balancedSkilled.winRate > balancedSpam.winRate + 0.1,
      `skilled ${balancedSkilled.winRate} should beat spam ${balancedSpam.winRate}`,
    )
    assert.ok(
      balancedSkilled.winRate > allDpsSkilled.winRate,
      `balanced ${balancedSkilled.winRate} should beat allDps ${allDpsSkilled.winRate}`,
    )
    assert.ok(
      balancedSkilled.winRate >= 0.2 && balancedSkilled.winRate <= 0.7,
      `balanced skilled reckless winRate out of band: ${balancedSkilled.winRate}`,
    )
    assert.ok(
      allDpsSkilled.winRate <= 0.25,
      `allDps skilled reckless too high: ${allDpsSkilled.winRate}`,
    )
  })

  it('geared balanced outpaces bare on Heroic skilled', () => {
    const profiles = loadProfiles()
    const trials = 16
    const baseSeed = 77
    const geared = simulateMany(AMMORDIUS_PARTIES.balanced.party(), {
      trials,
      baseSeed,
      difficulty: 'heroic',
      profiles,
      policy: 'skilledSupport',
    })
    const bare = simulateMany(AMMORDIUS_PARTIES.balanced.party(), {
      trials,
      baseSeed,
      difficulty: 'heroic',
      profiles: new Map(),
      policy: 'skilledSupport',
    })
    assert.ok(
      geared.winRate > bare.winRate,
      `geared ${geared.winRate} should beat bare ${bare.winRate}`,
    )
  })
})
