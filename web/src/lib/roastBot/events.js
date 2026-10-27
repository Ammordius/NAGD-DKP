/**
 * Fact-driven roast events and transparent thresholds.
 */

export const THRESHOLDS = {
  /** Minimum guild balances before percentile low/high is used. */
  GUILD_BALANCE_SAMPLE_MIN: 10,
  /** Absolute fallbacks when guild sample is too small. */
  BALANCE_LOW_ABSOLUTE: 25,
  BALANCE_HIGH_ABSOLUTE: 500,
  /** Expensive purchase: top decile, min sample. */
  EXPENSIVE_PURCHASE_MIN_N: 5,
  /** Price outlier vs same-item median. */
  PRICE_OUTLIER_RATIO: 1.5,
  PRICE_OUTLIER_MIN_COMPARABLE: 3,
  /** One character's share of attributable spend. */
  SPEND_CONCENTRATION_PCT: 60,
  SPEND_CONCENTRATION_MIN_CHARS: 2,
  /** Strong vs modest upgrade delta (engine score points). */
  UPGRADE_STRONG_DELTA: 15,
  UPGRADE_MODEST_DELTA: 0.01,
  SLOT_REPEAT_MIN: 2,
}

/**
 * @param {number[]} values sorted ascending
 * @param {number} p 0–100
 */
export function percentile(values, p) {
  if (!values?.length) return null
  const sorted = [...values].filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))))
  return sorted[idx]
}

/**
 * @param {number|null|undefined} balance
 * @param {number[]} guildBalances
 * @returns {'low'|'high'|'mid'|null}
 */
export function classifyBalance(balance, guildBalances = []) {
  if (balance == null || !Number.isFinite(Number(balance))) return null
  const b = Number(balance)
  const sample = (guildBalances || []).filter((n) => Number.isFinite(n))
  if (sample.length >= THRESHOLDS.GUILD_BALANCE_SAMPLE_MIN) {
    const p25 = percentile(sample, 25)
    const p75 = percentile(sample, 75)
    if (p25 != null && b <= p25) return 'low'
    if (p75 != null && b >= p75) return 'high'
    return 'mid'
  }
  if (b <= THRESHOLDS.BALANCE_LOW_ABSOLUTE) return 'low'
  if (b >= THRESHOLDS.BALANCE_HIGH_ABSOLUTE) return 'high'
  return 'mid'
}

/**
 * @param {Array<{ cost?: number }>} purchases
 */
export function isTopDecilePurchase(purchase, purchases) {
  const costs = (purchases || [])
    .map((p) => Number(p.cost))
    .filter((n) => Number.isFinite(n) && n > 0)
  if (costs.length < THRESHOLDS.EXPENSIVE_PURCHASE_MIN_N) return false
  const sorted = [...costs].sort((a, b) => a - b)
  const cutoff = percentile(sorted, 90)
  const cost = Number(purchase?.cost)
  return cutoff != null && Number.isFinite(cost) && cost >= cutoff
}

/**
 * @param {number} paid
 * @param {number[]} comparableCosts same item historical sales excluding current if desired
 */
export function isPriceOutlier(paid, comparableCosts) {
  const comps = (comparableCosts || []).map(Number).filter((n) => Number.isFinite(n) && n > 0)
  if (comps.length < THRESHOLDS.PRICE_OUTLIER_MIN_COMPARABLE) return { outlier: false, median: null }
  const sorted = [...comps].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  const cost = Number(paid)
  if (!Number.isFinite(cost) || median <= 0) return { outlier: false, median }
  return {
    outlier: cost >= median * THRESHOLDS.PRICE_OUTLIER_RATIO,
    median: Math.round(median * 10) / 10,
  }
}

/**
 * @param {Record<string, number>} spentByCharKey
 * @param {Array<{ char_id?: string, name?: string }>} characters
 */
export function spendingConcentration(spentByCharKey, characters) {
  const chars = characters || []
  if (chars.length < THRESHOLDS.SPEND_CONCENTRATION_MIN_CHARS) return null
  let total = 0
  const rows = []
  for (const ch of chars) {
    const id = String(ch.char_id || '').trim()
    const name = String(ch.name || '').trim()
    let spent = 0
    if (id && spentByCharKey[id] != null) spent += Number(spentByCharKey[id]) || 0
    if (name && name !== id && spentByCharKey[name] != null) spent += Number(spentByCharKey[name]) || 0
    rows.push({ character: ch, spent })
    total += spent
  }
  if (total <= 0) return null
  rows.sort((a, b) => b.spent - a.spent)
  const top = rows[0]
  const sharePct = Math.round((top.spent / total) * 100)
  if (sharePct < THRESHOLDS.SPEND_CONCENTRATION_PCT) return null
  return { character: top.character, sharePct, spent: top.spent }
}

/**
 * @param {number} delta
 * @returns {'strong'|'modest'|'none'}
 */
export function classifyUpgradeDelta(delta) {
  const d = Number(delta)
  if (!Number.isFinite(d) || d <= 0) return 'none'
  if (d >= THRESHOLDS.UPGRADE_STRONG_DELTA) return 'strong'
  if (d >= THRESHOLDS.UPGRADE_MODEST_DELTA) return 'modest'
  return 'none'
}

/**
 * Build prioritized roast events from facts.
 * @param {object} facts from buildAccountFacts
 */
export function deriveEvents(facts) {
  /** @type {Array<{ type: string, severity: number, confidence: string, payload?: object }>} */
  const events = []
  if (!facts?.accountId) return events

  const balanceClass = classifyBalance(facts.currentDkp, facts.guildBalances || [])
  if (balanceClass === 'low') {
    events.push({ type: 'LOW_BALANCE', severity: 50, confidence: 'verified', payload: { balance: facts.currentDkp } })
  } else if (balanceClass === 'high') {
    events.push({ type: 'HIGH_BALANCE', severity: 45, confidence: 'verified', payload: { balance: facts.currentDkp } })
  }

  if (facts.biggestPurchase) {
    const sev = isTopDecilePurchase(facts.biggestPurchase, facts.purchases) ? 70 : 55
    events.push({
      type: 'LARGEST_PURCHASE',
      severity: sev,
      confidence: 'verified',
      payload: facts.biggestPurchase,
    })
  }

  if (facts.recentPurchase) {
    events.push({
      type: 'RECENT_PURCHASE',
      severity: 50,
      confidence: 'verified',
      payload: facts.recentPurchase,
    })
  }

  if ((facts.totalRecordedPurchases || 0) >= 3) {
    events.push({
      type: 'PURCHASE_VOLUME',
      severity: 40,
      confidence: 'verified',
      payload: { purchaseCount: facts.totalRecordedPurchases },
    })
  }

  if ((facts.characters || []).length >= 2) {
    events.push({
      type: 'MULTI_CHAR',
      severity: 35,
      confidence: 'verified',
      payload: { charCount: facts.characters.length },
    })
  }

  const conc = spendingConcentration(facts.purchasesByCharacterSpent || {}, facts.characters)
  if (conc) {
    events.push({
      type: 'SPEND_CONCENTRATION',
      severity: 60,
      confidence: 'verified',
      payload: conc,
    })
  }

  for (const pattern of facts.slotRepeatPatterns || []) {
    events.push({
      type: 'SLOT_REPEAT',
      severity: 65,
      confidence: 'verified',
      payload: pattern,
    })
  }

  for (const outlier of facts.priceOutliers || []) {
    events.push({
      type: 'PRICE_OUTLIER',
      severity: 75,
      confidence: 'verified',
      payload: outlier,
    })
  }

  const att = facts.attendanceEligibility || {}
  if (att.canRoastFrequent) {
    events.push({
      type: 'ATTENDANCE_FREQUENT',
      severity: 40,
      confidence: 'verified',
      payload: { raidCount: facts.accountRaidCount },
    })
  }
  if (att.canRoastSparse) {
    events.push({
      type: 'ATTENDANCE_SPARSE',
      severity: 55,
      confidence: 'verified',
      payload: {
        daysSince: facts.daysSince,
        lastRaid: facts.lastAccountRaid?.raidName,
        raidCount: facts.accountRaidCount,
      },
    })
  }
  if (att.canRoastReturn) {
    events.push({
      type: 'ATTENDANCE_RETURN',
      severity: 50,
      confidence: 'verified',
      payload: { daysSince: facts.returnGapDays },
    })
  }

  events.sort((a, b) => b.severity - a.severity)
  return events
}
