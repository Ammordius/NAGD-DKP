/**
 * Full-run Expedition simulator for balance Monte Carlo.
 * Advances battle + route/event/boon/consumable until victory or wipe.
 */

import {
  startRun,
  commitRound,
  selectRoute,
  selectEventChoice,
  selectBoon,
  selectConsumable,
  ENCOUNTER_COUNT,
} from './gameEngine.js'
import { calculateScore } from './scoring.js'
import { basicSpam, getPolicy } from './simPolicies.js'

const DEFAULT_MAX_ROUNDS_PER_FIGHT = 80
const DEFAULT_MAX_TOTAL_ROUNDS = 500

/**
 * Prefer safe routes so combat skill dominates meta risk choices.
 * @param {object} state
 */
export function resolveBetweenFights(state) {
  let guard = 0
  while (state.phase !== 'battle' && state.phase !== 'rewards' && guard++ < 20) {
    if (state.phase === 'route') {
      const id = state.routeChoices?.[0]?.id || 'safe'
      const r = selectRoute(state, id)
      if (!r.ok) break
      continue
    }
    if (state.phase === 'event') {
      const id = state.eventChoices?.choices?.[0]?.id
      if (!id) break
      const r = selectEventChoice(state, id)
      if (!r.ok) break
      continue
    }
    if (state.phase === 'boon') {
      const id = state.boonChoices?.[0]?.id
      if (!id) break
      // Prefer non-risk boons when available
      const safe = (state.boonChoices || []).find((b) => !b.risk)
      const r = selectBoon(state, (safe || state.boonChoices[0]).id)
      if (!r.ok) break
      continue
    }
    if (state.phase === 'consumable') {
      const r = selectConsumable(state, true)
      if (!r.ok) break
      continue
    }
    break
  }
  return state
}

/**
 * @param {object[]} partyChars
 * @param {{
 *   seed?: number,
 *   difficulty?: string,
 *   profiles?: Map<string, object>|null,
 *   policy?: string|((state: object) => Record<string, { actionId: string, targetId?: string }>),
 *   maxRoundsPerFight?: number,
 *   maxTotalRounds?: number,
 * }} [opts]
 */
export function simulateRun(partyChars, opts = {}) {
  const seed = opts.seed != null ? opts.seed >>> 0 : 1
  const difficulty = opts.difficulty || 'normal'
  const policyFn =
    typeof opts.policy === 'function'
      ? opts.policy
      : getPolicy(opts.policy || 'skilledSupport')
  const maxPerFight = opts.maxRoundsPerFight || DEFAULT_MAX_ROUNDS_PER_FIGHT
  const maxTotal = opts.maxTotalRounds || DEFAULT_MAX_TOTAL_ROUNDS

  let state = startRun(partyChars, {
    seed,
    difficulty,
    profiles: opts.profiles === undefined ? null : opts.profiles,
  })

  let fightRounds = 0
  let totalRounds = 0
  let timedOut = false

  while (!state.victory && !state.defeated && totalRounds < maxTotal) {
    if (state.phase !== 'battle') {
      resolveBetweenFights(state)
      fightRounds = 0
      if (state.victory || state.defeated) break
      if (state.phase !== 'battle') {
        timedOut = true
        break
      }
      continue
    }

    const actions = policyFn(state)
    const result = commitRound(state, actions)
    if (!result.ok) {
      // Recover with basic spam if policy produced invalid actions
      const retry = commitRound(state, basicSpam(state))
      if (!retry.ok) {
        timedOut = true
        break
      }
    }

    fightRounds += 1
    totalRounds += 1

    if (fightRounds >= maxPerFight) {
      timedOut = true
      break
    }
  }

  if (timedOut && !state.victory && !state.defeated) {
    state.defeated = true
    state.victory = false
    state.phase = 'rewards'
  }

  const live = (state.party || []).filter((p) => p.alive)
  const hpPct = state.party?.length
    ? live.reduce((s, p) => s + p.hp / p.maxHp, 0) / state.party.length
    : 0
  const score =
    state.report?.score ??
    calculateScore({
      encountersCleared: state.encountersCleared || 0,
      remainingHpPct: hpPct,
      knockouts: state.knockouts || 0,
      turns: state.turns || 0,
      victory: Boolean(state.victory),
      scoreMult: state.difficultyMods?.scoreMult || 1,
      riskBonus: state.riskBonus || 0,
      abilityCasts: state.abilityCasts || 0,
      supportActions: state.supportActions || 0,
    })

  return {
    won: Boolean(state.victory),
    defeated: Boolean(state.defeated),
    timedOut,
    encountersCleared: state.encountersCleared || 0,
    totalEncounters: ENCOUNTER_COUNT,
    rounds: state.turns || totalRounds,
    knockouts: state.knockouts || 0,
    abilityCasts: state.abilityCasts || 0,
    supportActions: state.supportActions || 0,
    remainingHpPct: hpPct,
    score,
    seed,
    difficulty: state.difficulty || difficulty,
    report: state.report || null,
  }
}

/**
 * Run N seeded trials and aggregate win rate / averages.
 * @param {object[]} partyChars
 * @param {{
 *   trials?: number,
 *   baseSeed?: number,
 *   difficulty?: string,
 *   profiles?: Map<string, object>|null,
 *   policy?: string|Function,
 * }} opts
 */
export function simulateMany(partyChars, opts = {}) {
  const trials = opts.trials ?? 40
  const baseSeed = opts.baseSeed ?? 1000
  const results = []
  for (let i = 0; i < trials; i++) {
    results.push(
      simulateRun(partyChars, {
        ...opts,
        seed: (baseSeed + i * 9973) >>> 0,
      }),
    )
  }
  const wins = results.filter((r) => r.won).length
  const avg = (key) => results.reduce((s, r) => s + (r[key] || 0), 0) / results.length
  return {
    trials,
    wins,
    winRate: wins / trials,
    avgClears: avg('encountersCleared'),
    avgRounds: avg('rounds'),
    avgKnockouts: avg('knockouts'),
    avgSupport: avg('supportActions'),
    avgScore: avg('score'),
    avgHpPct: avg('remainingHpPct'),
    results,
  }
}
