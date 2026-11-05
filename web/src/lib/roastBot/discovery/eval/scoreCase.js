/**
 * Compare pipeline traces against structured eval expectations.
 */

/**
 * @param {string|RegExp|null|undefined} pattern
 * @param {string|null|undefined} value
 */
function matches(pattern, value) {
  if (pattern == null) return true
  const v = value == null ? '' : String(value)
  if (pattern instanceof RegExp) return pattern.test(v)
  return v.toLowerCase() === String(pattern).toLowerCase()
}

/**
 * @param {import('./caseSchema.js').EvalExpect} expect
 * @param {import('../pipelineTrace.js').PipelineTrace} trace
 * @param {import('../pipelineTrace.js').PipelineTrace|null} [prevTrace]
 */
export function scoreExpect(expect, trace, prevTrace = null) {
  /** @type {string[]} */
  const failures = []

  if (expect.recognitionStatus && trace.recognition?.status !== expect.recognitionStatus) {
    failures.push(
      `recognitionStatus: expected ${expect.recognitionStatus}, got ${trace.recognition?.status}`,
    )
  }
  if (expect.intent && trace.query?.intent !== expect.intent) {
    failures.push(`intent: expected ${expect.intent}, got ${trace.query?.intent}`)
  }
  if (expect.family && trace.query?.family !== expect.family) {
    failures.push(`family: expected ${expect.family}, got ${trace.query?.family}`)
  }
  if (expect.scope && trace.query?.scope !== expect.scope) {
    failures.push(`scope: expected ${expect.scope}, got ${trace.query?.scope}`)
  }
  if (expect.boss !== undefined && (trace.query?.boss || null) !== expect.boss) {
    failures.push(`boss: expected ${expect.boss}, got ${trace.query?.boss}`)
  }
  if (expect.zone !== undefined && (trace.query?.zone || null) !== expect.zone) {
    failures.push(`zone: expected ${expect.zone}, got ${trace.query?.zone}`)
  }
  if (expect.phase !== undefined && (trace.query?.phase || null) !== expect.phase) {
    failures.push(`phase: expected ${expect.phase}, got ${trace.query?.phase}`)
  }
  if (expect.slot !== undefined && (trace.query?.slot || null) !== expect.slot) {
    failures.push(`slot: expected ${expect.slot}, got ${trace.query?.slot}`)
  }
  if (expect.character !== undefined && (trace.query?.character || null) !== expect.character) {
    failures.push(`character: expected ${expect.character}, got ${trace.query?.character}`)
  }
  if (expect.itemQueryMatch && !matches(expect.itemQueryMatch, trace.query?.itemQuery)) {
    failures.push(`itemQueryMatch: ${expect.itemQueryMatch} !~ ${trace.query?.itemQuery}`)
  }
  if (expect.resolvedItemMatch && !matches(expect.resolvedItemMatch, trace.resolvedItemName)) {
    failures.push(
      `resolvedItemMatch: ${expect.resolvedItemMatch} !~ ${trace.resolvedItemName}`,
    )
  }
  if (expect.resolvedItemId && String(trace.resolvedItemId) !== String(expect.resolvedItemId)) {
    failures.push(
      `resolvedItemId: expected ${expect.resolvedItemId}, got ${trace.resolvedItemId}`,
    )
  }
  if (expect.outcome && trace.outcome !== expect.outcome) {
    // Allow answered when awards exist even if outcome classification differs slightly
    if (!(expect.outcome === 'answered' && trace.awardIds?.length)) {
      failures.push(`outcome: expected ${expect.outcome}, got ${trace.outcome}`)
    }
  }
  if (expect.awardRecipients?.length) {
    const got = trace.awardRecipients || []
    for (const r of expect.awardRecipients) {
      if (!got.includes(r)) {
        failures.push(`awardRecipients missing ${r}; got [${got.join(', ')}]`)
      }
    }
  }
  if (expect.awardIds?.length) {
    const got = (trace.awardIds || []).map(String)
    for (const id of expect.awardIds) {
      if (!got.includes(String(id))) {
        failures.push(`awardIds missing ${id}`)
      }
    }
  }
  if (expect.prevItemMustNotAppear) {
    const needle = String(expect.prevItemMustNotAppear).toLowerCase()
    const hay = [
      trace.resolvedItemName,
      ...(trace.awardItemNames || []),
      trace.answer?.factText,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    if (hay.includes(needle)) {
      failures.push(`stale/wrong entity: found "${expect.prevItemMustNotAppear}" in result`)
    }
  }
  if (expect.mustChangeEntity && prevTrace) {
    const sameItem =
      trace.resolvedItemName &&
      prevTrace.resolvedItemName &&
      String(trace.resolvedItemName).toLowerCase() ===
        String(prevTrace.resolvedItemName).toLowerCase()
    const sameFp =
      trace.planFingerprint &&
      prevTrace.planFingerprint &&
      trace.planFingerprint === prevTrace.planFingerprint
    const sameAwards =
      expect.awardRecipients &&
      prevTrace.awardRecipients?.[0] &&
      trace.awardRecipients?.[0] === prevTrace.awardRecipients[0] &&
      expect.awardRecipients[0] !== prevTrace.awardRecipients[0]
    if (sameItem && sameFp) {
      failures.push('mustChangeEntity: plan fingerprint and item unchanged vs prior turn')
    }
    if (sameAwards) {
      failures.push('mustChangeEntity: reused prior recipient for different expected entity')
    }
  }

  return {
    ok: failures.length === 0,
    failures,
  }
}

/**
 * @param {import('./caseSchema.js').EvalCase} evalCase
 * @param {import('../pipelineTrace.js').PipelineTrace[]} traces
 */
export function scoreCase(evalCase, traces) {
  if (evalCase.expectTurns?.length) {
    /** @type {string[]} */
    const allFailures = []
    let wrongEntity = false
    let staleReuse = false
    for (let i = 0; i < evalCase.expectTurns.length; i++) {
      const exp = evalCase.expectTurns[i]
      const tr = traces[i]
      if (!tr) {
        allFailures.push(`missing trace for turn ${i}`)
        continue
      }
      const scored = scoreExpect(exp, tr, i > 0 ? traces[i - 1] : null)
      for (const f of scored.failures) {
        allFailures.push(`turn${i}: ${f}`)
        if (/stale|wrong entity|mustChangeEntity/i.test(f)) {
          if (/stale/i.test(f)) staleReuse = true
          wrongEntity = true
        }
      }
    }
    return {
      ok: allFailures.length === 0,
      failures: allFailures,
      wrongEntity,
      staleReuse,
      interpretationOk: allFailures.every((f) => !/recognitionStatus|intent|family|boss|zone|phase|slot|character|itemQuery|resolvedItem/i.test(f)),
      retrievalOk: allFailures.every((f) => !/awardRecipients|awardIds|outcome|stale|wrong entity/i.test(f)),
    }
  }

  const scored = scoreExpect(evalCase.expect, traces[0])
  const wrongEntity = scored.failures.some((f) => /stale|wrong entity/i.test(f))
  const staleReuse = scored.failures.some((f) => /stale/i.test(f))
  return {
    ok: scored.ok,
    failures: scored.failures,
    wrongEntity,
    staleReuse,
    interpretationOk: scored.failures.every(
      (f) => !/recognitionStatus|intent|family|boss|zone|phase|slot|character|itemQuery|resolvedItem/i.test(f),
    ),
    retrievalOk: scored.failures.every(
      (f) => !/awardRecipients|awardIds|outcome|stale|wrong entity/i.test(f),
    ),
  }
}
