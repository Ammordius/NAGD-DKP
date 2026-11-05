/**
 * Discovery golden eval campaign — generative corpus + structured scoring.
 * Run: npm run test:discovery-eval
 */
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { resetDiscoveryCache } from '../index.js'
import { createDiscoveryMockClient } from '../mockSupabase.js'
import { buildKnownItemSources } from '../../../itemSourceLookup.js'
import {
  FIXTURE_ITEM_SOURCES,
  FIXTURE_MOB_LOOT,
  FIXTURE_ITEM_STATS,
} from '../fixtures.js'
import { createConversationState } from '../../conversation.js'
import { traceDiscoveryTurn, summarizeTrace } from '../pipelineTrace.js'
import { buildEvalCorpus, NOW_ISO } from './corpusGenerator.js'
import { scoreCase } from './scoreCase.js'
import { writeEvalReports } from './writeReport.js'

const known = buildKnownItemSources({
  itemSources: FIXTURE_ITEM_SOURCES,
  mobLoot: FIXTURE_MOB_LOOT,
})

function makeFacts() {
  return {
    characters: [
      { name: 'Ammordius', char_id: 'c2' },
      { name: 'Tandiyen', char_id: 'c1' },
    ],
    accountId: 'a1',
    knownItemSources: known,
    itemCatalog: [],
    itemStats: FIXTURE_ITEM_STATS,
  }
}

/**
 * @param {import('./caseSchema.js').EvalCase} evalCase
 * @param {ReturnType<typeof createDiscoveryMockClient>} client
 * @param {object} facts
 */
async function runEvalCase(evalCase, client, facts) {
  resetDiscoveryCache()
  const state = createConversationState()
  const turns = evalCase.turns?.length ? evalCase.turns : [evalCase.text]
  /** @type {import('../pipelineTrace.js').PipelineTrace[]} */
  const traces = []

  for (const text of turns) {
    const { trace } = await traceDiscoveryTurn({
      client,
      text,
      facts,
      state,
      nowIso: NOW_ISO,
      skipCache: false,
    })
    traces.push(trace)
  }

  return { traces, scored: scoreCase(evalCase, traces) }
}

describe('discovery eval campaign', () => {
  /** @type {import('./caseSchema.js').EvalCase[]} */
  let cases = []
  /** @type {object} */
  let summary = {}

  before(async () => {
    const built = buildEvalCorpus()
    cases = built.cases
    const client = createDiscoveryMockClient()
    const facts = makeFacts()

    let passed = 0
    let failed = 0
    let wrongEntityCount = 0
    let staleReuseCount = 0
    let unsupportedRecognizedCount = 0
    let inScopeTotal = 0
    let inScopeInterpOk = 0
    let retrievalChecked = 0
    let retrievalOk = 0
    let clarificationTotal = 0
    let clarificationOk = 0
    /** @type {Record<string, number>} */
    const failuresByCategory = {}
    /** @type {object[]} */
    const sampleFailures = []
    /** @type {Map<string, object[]>} */
    const metaGroups = new Map()

    for (const evalCase of cases) {
      const { traces, scored } = await runEvalCase(evalCase, client, facts)
      const inScope = evalCase.inScope !== false
      const unambiguous =
        evalCase.expect?.recognitionStatus === 'recognized' ||
        evalCase.expectTurns?.some((e) => e.recognitionStatus === 'recognized') ||
        !evalCase.expect?.recognitionStatus

      if (scored.ok) passed += 1
      else {
        failed += 1
        failuresByCategory[evalCase.category] = (failuresByCategory[evalCase.category] || 0) + 1
        if (sampleFailures.length < 40) {
          sampleFailures.push({
            id: evalCase.id,
            category: evalCase.category,
            input: evalCase.turns?.join(' → ') || evalCase.text,
            failures: scored.failures,
            actual: summarizeTrace(traces[traces.length - 1]),
          })
        }
      }

      if (scored.wrongEntity) wrongEntityCount += 1
      if (scored.staleReuse) staleReuseCount += 1

      for (const tr of traces) {
        if (tr.recognition?.status === 'unsupported') unsupportedRecognizedCount += 1
        if (tr.outcome === 'clarification') {
          clarificationTotal += 1
          if (scored.ok) clarificationOk += 1
        }
      }

      if (inScope && unambiguous) {
        inScopeTotal += 1
        if (scored.interpretationOk || scored.ok) inScopeInterpOk += 1
      }

      const expectsAwards =
        Boolean(evalCase.expect?.awardRecipients?.length) ||
        Boolean(evalCase.expectTurns?.some((e) => e.awardRecipients?.length))
      if (expectsAwards) {
        retrievalChecked += 1
        if (scored.retrievalOk || scored.ok) retrievalOk += 1
      }

      if (evalCase.group) {
        const list = metaGroups.get(evalCase.group) || []
        list.push({ evalCase, traces, scored })
        metaGroups.set(evalCase.group, list)
      }
    }

    // Metamorphic equivalence: same group → same resolved item id / intent
    let metaFailures = 0
    for (const [group, rows] of metaGroups) {
      if (rows.length < 2) continue
      const base = rows[0].traces[0]
      for (const row of rows.slice(1)) {
        const tr = row.traces[0]
        if (
          base.resolvedItemId &&
          tr.resolvedItemId &&
          String(base.resolvedItemId) !== String(tr.resolvedItemId)
        ) {
          metaFailures += 1
          sampleFailures.push({
            id: `meta-${group}`,
            category: 'C_paraphrase',
            input: row.evalCase.text,
            failures: [
              `metamorphic mismatch vs ${rows[0].evalCase.text}: itemId ${tr.resolvedItemId} != ${base.resolvedItemId}`,
            ],
            actual: summarizeTrace(tr),
          })
        }
        if (base.query?.intent && tr.query?.intent && base.query.intent !== tr.query.intent) {
          metaFailures += 1
        }
      }
    }

    const interpretationRate = inScopeTotal ? inScopeInterpOk / inScopeTotal : 0
    const retrievalRate = retrievalChecked ? retrievalOk / retrievalChecked : 1
    const clarificationRate = clarificationTotal ? clarificationOk / clarificationTotal : 1

    summary = {
      generatedAt: new Date().toISOString(),
      total: cases.length,
      passed,
      failed,
      interpretationRate,
      retrievalRate,
      clarificationRate,
      wrongEntityCount,
      staleReuseCount,
      unsupportedRecognizedCount,
      metaFailures,
      failuresByCategory,
      sampleFailures,
      gates: {
        'corpus >= 300': cases.length >= 300,
        'interpretation >= 95% in-scope': interpretationRate >= 0.95,
        'retrieval 100% on fixture award cases': retrievalRate >= 1,
        'zero wrong-entity': wrongEntityCount === 0,
        'zero stale-reuse': staleReuseCount === 0,
        'seed five-turn covered': cases.some((c) => c.id === 'seed-five-turn-sequence'),
      },
    }

    writeEvalReports(summary)
  })

  it('builds at least 300 golden cases', () => {
    assert.ok(cases.length >= 300, `expected >= 300 cases, got ${cases.length}`)
  })

  it('writes eval reports', () => {
    assert.ok(summary.total > 0)
    assert.equal(typeof summary.interpretationRate, 'number')
  })

  it('meets acceptance gates for wrong-entity and stale-reuse', () => {
    assert.equal(summary.wrongEntityCount, 0, 'wrong-entity answers must be zero')
    assert.equal(summary.staleReuseCount, 0, 'stale-result reuse must be zero')
  })

  it('meets interpretation and retrieval targets', () => {
    assert.ok(
      summary.interpretationRate >= 0.95,
      `interpretation rate ${summary.interpretationRate} < 0.95; see eval/reports/latest.md`,
    )
    assert.ok(
      summary.retrievalRate >= 1,
      `retrieval rate ${summary.retrievalRate} < 1; see eval/reports/latest.md`,
    )
  })

  it('covers the mandatory five-turn seed', async () => {
    const seed = cases.find((c) => c.id === 'seed-five-turn-sequence')
    assert.ok(seed)
    const client = createDiscoveryMockClient()
    const { scored } = await runEvalCase(seed, client, makeFacts())
    assert.equal(scored.ok, true, scored.failures.join('; '))
  })
})
