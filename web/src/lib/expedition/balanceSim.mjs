#!/usr/bin/env node
/**
 * Expedition balance Monte Carlo — Ammordius parties × policy × gear × difficulty.
 *
 * Usage (from repo root or web/):
 *   node web/src/lib/expedition/balanceSim.mjs
 *   node web/src/lib/expedition/balanceSim.mjs --trials 60
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AMMORDIUS_PARTIES, profilesMapFromJson } from './ammordiusFixtures.js'
import { simulateMany } from './simulateRun.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROFILES_PATH = join(__dirname, '../../../public/expedition/combat-profiles.json')

function parseArgs(argv) {
  const out = { trials: 40, baseSeed: 1000 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--trials' && argv[i + 1]) out.trials = Number(argv[++i]) || 40
    if (argv[i] === '--seed' && argv[i + 1]) out.baseSeed = Number(argv[++i]) || 1000
    if (argv[i] === '--quick') out.trials = 12
  }
  return out
}

function pct(n) {
  return `${(n * 100).toFixed(1)}%`
}

function row(cells) {
  return cells.map((c) => String(c).padEnd(14)).join(' ')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const json = JSON.parse(readFileSync(PROFILES_PATH, 'utf8'))
  const geared = profilesMapFromJson(json)
  const bare = new Map() // empty → class+level only via lookup miss

  const parties = Object.values(AMMORDIUS_PARTIES)
  const policies = ['basicSpam', 'offenseOnly', 'skilledSupport']
  const difficulties = ['normal', 'heroic', 'reckless']
  const gearModes = [
    { id: 'geared', profiles: geared },
    { id: 'bare', profiles: bare },
  ]

  console.log(
    `Expedition balance sim — trials=${args.trials} baseSeed=${args.baseSeed} profiles=${geared.size}`,
  )
  console.log(
    row(['party', 'policy', 'gear', 'diff', 'win%', 'clears', 'rounds', 'KOs', 'support']),
  )
  console.log('-'.repeat(120))

  const summary = []

  for (const partyDef of parties) {
    for (const policy of policies) {
      for (const gear of gearModes) {
        for (const difficulty of difficulties) {
          // Skip offenseOnly on bare to keep matrix smaller unless quick already tiny
          if (policy === 'offenseOnly' && gear.id === 'bare') continue

          const agg = simulateMany(partyDef.party(), {
            trials: args.trials,
            baseSeed: args.baseSeed,
            difficulty,
            profiles: gear.profiles,
            policy,
          })
          const line = {
            party: partyDef.id,
            policy,
            gear: gear.id,
            difficulty,
            winRate: agg.winRate,
            avgClears: agg.avgClears,
            avgRounds: agg.avgRounds,
            avgKnockouts: agg.avgKnockouts,
            avgSupport: agg.avgSupport,
          }
          summary.push(line)
          console.log(
            row([
              partyDef.id,
              policy,
              gear.id,
              difficulty,
              pct(agg.winRate),
              agg.avgClears.toFixed(2),
              agg.avgRounds.toFixed(1),
              agg.avgKnockouts.toFixed(2),
              agg.avgSupport.toFixed(1),
            ]),
          )
        }
      }
    }
  }

  // Design-target checks (geared)
  console.log('\n--- Design target checks (geared) ---')
  const find = (party, policy, difficulty) =>
    summary.find(
      (r) =>
        r.party === party &&
        r.policy === policy &&
        r.gear === 'geared' &&
        r.difficulty === difficulty,
    )

  const balancedSkilledReckless = find('balanced', 'skilledSupport', 'reckless')
  const balancedSpamReckless = find('balanced', 'basicSpam', 'reckless')
  const allDpsSkilledReckless = find('allDps', 'skilledSupport', 'reckless')
  const balancedSkilledNormal = find('balanced', 'skilledSupport', 'normal')
  const balancedGearedHeroic = find('balanced', 'skilledSupport', 'heroic')
  const balancedBareHeroic = summary.find(
    (r) =>
      r.party === 'balanced' &&
      r.policy === 'skilledSupport' &&
      r.gear === 'bare' &&
      r.difficulty === 'heroic',
  )

  const checks = [
    {
      name: 'balanced+skilled Normal win >= 70%',
      ok: (balancedSkilledNormal?.winRate ?? 0) >= 0.7,
      detail: pct(balancedSkilledNormal?.winRate ?? 0),
    },
    {
      name: 'balanced+skilled Heroic win >= 50%',
      ok: (balancedGearedHeroic?.winRate ?? 0) >= 0.5,
      detail: pct(balancedGearedHeroic?.winRate ?? 0),
    },
    {
      name: 'balanced+skilled Reckless in 25–50%',
      ok:
        (balancedSkilledReckless?.winRate ?? 0) >= 0.25 &&
        (balancedSkilledReckless?.winRate ?? 1) <= 0.5,
      detail: pct(balancedSkilledReckless?.winRate ?? 0),
    },
    {
      name: 'skilled > basicSpam on Reckless (balanced)',
      ok:
        (balancedSkilledReckless?.winRate ?? 0) >
        (balancedSpamReckless?.winRate ?? 1) + 0.05,
      detail: `${pct(balancedSkilledReckless?.winRate ?? 0)} vs ${pct(balancedSpamReckless?.winRate ?? 0)}`,
    },
    {
      name: 'allDps+skilled Reckless near-wipe (<15%)',
      ok: (allDpsSkilledReckless?.winRate ?? 1) < 0.15,
      detail: pct(allDpsSkilledReckless?.winRate ?? 0),
    },
    {
      name: 'geared >= bare on Heroic balanced+skilled',
      ok:
        (balancedGearedHeroic?.winRate ?? 0) >= (balancedBareHeroic?.winRate ?? 1) - 0.02,
      detail: `${pct(balancedGearedHeroic?.winRate ?? 0)} vs bare ${pct(balancedBareHeroic?.winRate ?? 0)}`,
    },
  ]

  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  (${c.detail})`)
  }

  const failed = checks.filter((c) => !c.ok).length
  console.log(`\n${failed === 0 ? 'All checks passed.' : `${failed} check(s) failed.`}`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
