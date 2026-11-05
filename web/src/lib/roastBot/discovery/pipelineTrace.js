/**
 * Structured pipeline instrumentation for discovery eval / regression tests.
 * Not used by the UI — test and eval harness only.
 */

import { recognizeDiscovery } from './parse.js'
import { prepareDiscovery, runDiscovery } from './index.js'
import { fingerprintQuery } from './cacheKey.js'
import { handleMessage } from '../conversation.js'

/**
 * @typedef {object} PipelineTrace
 * @property {string} input
 * @property {import('./types.js').Recognition} recognition
 * @property {import('./types.js').StructuredQuery|null} query
 * @property {object|null} resolved
 * @property {string|null} resolvedItemId
 * @property {string|null} resolvedItemName
 * @property {string[]|null} selectorNames
 * @property {import('./types.js').QueryPlan|null} plan
 * @property {string|null} planFingerprint
 * @property {string|null} cacheKey
 * @property {number[]} awardIds
 * @property {string[]} awardItemNames
 * @property {string[]} awardRecipients
 * @property {'answered'|'clarification'|'no_match'|'unsupported'|'not_discovery'|'error'} outcome
 * @property {object|null} answer
 * @property {object|null} referenced
 * @property {import('./types.js').DiscoveryResult|null} result
 */

/**
 * Classify a discovery outcome for eval scoring.
 * @param {import('./types.js').Recognition} recognition
 * @param {import('./types.js').DiscoveryResult|null} result
 * @param {object|null} answer
 */
export function classifyOutcome(recognition, result, answer) {
  if (!recognition || recognition.status === 'not_discovery') return 'not_discovery'
  if (recognition.status === 'unsupported') return 'unsupported'
  if (recognition.status === 'ambiguous' || answer?.clarification || result?.ambiguous) {
    return 'clarification'
  }
  if (result?.ok === false && result?.error) return 'error'
  if (result?.ok && (result.awards?.length || result.raid || result.catalogEntries?.length || result.totalCount != null)) {
    return 'answered'
  }
  if (result?.ok) return 'no_match'
  if (answer?.factText) return 'answered'
  return 'unsupported'
}

/**
 * Run the full production-shaped discovery path and return a structured trace.
 * Mirrors RoastBot.jsx: recognize → runDiscovery → handleMessage.
 *
 * @param {object} args
 * @param {import('@supabase/supabase-js').SupabaseClient} args.client
 * @param {string} args.text
 * @param {object} args.facts
 * @param {object} args.state - conversation state (mutated like production)
 * @param {string} [args.nowIso]
 * @param {boolean} [args.skipCache]
 * @returns {Promise<{ trace: PipelineTrace, out: object|null, run: object|null }>}
 */
export async function traceDiscoveryTurn({
  client,
  text,
  facts,
  state,
  nowIso,
  skipCache = true,
}) {
  const prev = state.lastDiscovery?.query || null
  const prevPrimary = state.lastDiscovery?.primary || null

  const recognition = recognizeDiscovery(text, { prev, prevPrimary, nowIso })
  /** @type {object|null} */
  let run = null
  /** @type {import('./types.js').DiscoveryResult|null} */
  let result = null
  /** @type {object|null} */
  let answer = null

  if (
    recognition.status === 'recognized' ||
    recognition.status === 'ambiguous' ||
    recognition.status === 'unsupported'
  ) {
    run = await runDiscovery(client, text, {
      knownItemSources: facts.knownItemSources,
      itemCatalog: facts.itemCatalog || [],
      itemStats: facts.itemStats,
      prev,
      prevPrimary,
      recognition,
      nowIso,
      skipCache,
    })
    if (run) {
      result = run.result
      answer = run.answer
    }
  }

  const prepared =
    run?.prepared ||
    (recognition.status !== 'not_discovery'
      ? prepareDiscovery(text, {
          knownItemSources: facts.knownItemSources,
          itemCatalog: facts.itemCatalog || [],
          itemStats: facts.itemStats,
          prev,
          prevPrimary,
          recognition,
          nowIso,
        })
      : null)

  const query = prepared?.query || recognition.query || null
  const resolved = prepared?.resolved || null
  const plan = prepared?.plan || null
  const planFingerprint = query ? fingerprintQuery(query, resolved) : null

  const awards = result?.awards || []
  const awardIds = awards.map((a) => a.id).filter((id) => id != null)
  const awardItemNames = awards.map((a) => a.itemName).filter(Boolean)
  const awardRecipients = awards
    .map((a) => a.characterName || a.assignedCharacterName)
    .filter(Boolean)

  let out = null
  if (run || recognition.status !== 'not_discovery') {
    out = handleMessage({
      text,
      facts,
      state,
      discoveryResult: result,
      discoveryAnswer: answer,
      discoveryRecognition: recognition,
    })
    answer = out.answer || answer
  } else {
    out = handleMessage({ text, facts, state })
  }

  /** @type {PipelineTrace} */
  const trace = {
    input: text,
    recognition: {
      status: recognition.status,
      reason: recognition.reason,
      missing: recognition.missing,
      query: recognition.query || query || null,
    },
    query,
    resolved,
    resolvedItemId: resolved?.item?.itemId || resolved?.item?.id || null,
    resolvedItemName: resolved?.item?.name || query?.itemQuery || null,
    selectorNames: resolved?.itemSelector?.names
      ? [...resolved.itemSelector.names]
      : null,
    plan,
    planFingerprint,
    cacheKey: planFingerprint,
    awardIds,
    awardItemNames,
    awardRecipients,
    outcome: classifyOutcome(recognition, result, answer),
    answer,
    referenced: answer?.referenced || out?.response?.referenced || null,
    result,
  }

  return { trace, out, run }
}

/**
 * Compact summary for eval reports.
 * @param {PipelineTrace} trace
 */
export function summarizeTrace(trace) {
  return {
    input: trace.input,
    status: trace.recognition?.status,
    outcome: trace.outcome,
    intent: trace.query?.intent || null,
    family: trace.query?.family || null,
    itemQuery: trace.query?.itemQuery || null,
    resolvedItemName: trace.resolvedItemName,
    resolvedItemId: trace.resolvedItemId,
    boss: trace.query?.boss || null,
    zone: trace.query?.zone || null,
    phase: trace.query?.phase || null,
    slot: trace.query?.slot || null,
    character: trace.query?.character || null,
    awardIds: trace.awardIds,
    awardItemNames: [...new Set(trace.awardItemNames)],
    awardRecipients: trace.awardRecipients.slice(0, 3),
    planFingerprint: trace.planFingerprint,
  }
}
