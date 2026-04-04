import { normalizeItemNameForLookup } from './itemNameNormalize'

/** Build normalized name -> first matching item id from item_stats */
export function buildNameToItemId(itemStats) {
  const map = new Map()
  if (!itemStats || typeof itemStats !== 'object') return map
  for (const [idStr, st] of Object.entries(itemStats)) {
    const n = normalizeItemNameForLookup(st?.name || '')
    if (n && !map.has(n)) map.set(n, idStr)
  }
  return map
}

export function resolveItemIdFromName(itemName, nameToId) {
  const k = normalizeItemNameForLookup(itemName || '')
  if (!k) return null
  return nameToId.get(k) || null
}

/** Average of last N costs from dkp_prices.json entry */
export function avgDkpFromPrices(dkpPrices, itemId, n = 3) {
  if (!itemId || !dkpPrices || typeof dkpPrices !== 'object') return null
  const row = dkpPrices[String(itemId)] || dkpPrices[Number(itemId)]
  const arr = row?.dkp_prices
  if (!Array.isArray(arr) || arr.length === 0) return null
  const costs = arr
    .slice(0, n)
    .map((p) => Number(p.cost))
    .filter((c) => !Number.isNaN(c) && c > 0)
  if (costs.length === 0) return null
  return costs.reduce((a, b) => a + b, 0) / costs.length
}

/**
 * Per-purchase ratio: paid / global anchor from dkp_prices (same for all dates — heuristic).
 * Returns { medianRatio, ratios, labeled }
 */
export function bidVsMarketFromPurchases(purchasesChronological, nameToId, dkpPrices) {
  const ratios = []
  if (!Array.isArray(purchasesChronological)) return { medianRatio: null, ratios: [], label: 'no data' }
  for (const p of purchasesChronological) {
    const id = resolveItemIdFromName(p.item_name, nameToId)
    if (!id) continue
    const ref = avgDkpFromPrices(dkpPrices, id, 3)
    const cost = Number(p.cost) || 0
    if (ref == null || ref <= 0 || cost <= 0) continue
    ratios.push(cost / ref)
  }
  if (ratios.length === 0) return { medianRatio: null, ratios: [], label: 'insufficient comparable prices' }
  const sorted = [...ratios].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const medianRatio = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  let label = 'near typical vs recent sales'
  if (medianRatio >= 1.2) label = 'often pays above recent sale prices'
  else   if (medianRatio <= 0.88) label = 'often pays below recent sale prices'
  return { medianRatio, ratios, label }
}

/**
 * Like bidVsMarketFromPurchases, but uses `paid_to_ref_ratio` from the DB (guild prior sales
 * at time of purchase) when present on a purchase row; otherwise falls back to dkp_prices.json.
 * @param {Array<{ item_name?: string, cost?: number, paid_to_ref_ratio?: number|null }>} purchasesChronological
 */
export function bidVsMarketFromPurchasesTimeAware(purchasesChronological, nameToId, dkpPrices) {
  const ratios = []
  if (!Array.isArray(purchasesChronological)) return { medianRatio: null, ratios: [], label: 'no data' }
  for (const p of purchasesChronological) {
    const dbRatio = p?.paid_to_ref_ratio
    if (dbRatio != null && !Number.isNaN(Number(dbRatio)) && Number(dbRatio) > 0) {
      ratios.push(Number(dbRatio))
      continue
    }
    const id = resolveItemIdFromName(p.item_name, nameToId)
    if (!id) continue
    const ref = avgDkpFromPrices(dkpPrices, id, 3)
    const cost = Number(p.cost) || 0
    if (ref == null || ref <= 0 || cost <= 0) continue
    ratios.push(cost / ref)
  }
  if (ratios.length === 0) return { medianRatio: null, ratios: [], label: 'insufficient comparable prices' }
  const sorted = [...ratios].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const medianRatio = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  let label = 'near typical vs reference prices'
  if (medianRatio >= 1.2) label = 'often pays above reference prices'
  else if (medianRatio <= 0.88) label = 'often pays below reference prices'
  return { medianRatio, ratios, label }
}

/** @param {object} [archetypeOpts]
 * @param {string} [archetypeOpts.attendeeCharId] — when set, funnel_main only if this toon is top spender
 * @param {boolean} [archetypeOpts.accountLevelArchetype] — when true, funnel_main uses account-wide share (consolidated row)
 * @param {number} [archetypeOpts.longSaveBalance] — balance for long_save_candidate (defaults to profile.balance) */
export function spendArchetypeTags(profile, bidLabel, medianRatio, archetypeOpts = {}) {
  const tags = []
  const share = Number(profile?.top_toon_share) || 0
  const pc = Number(profile?.purchase_count) || 0
  const days = profile?.days_since_last_spend
  const { attendeeCharId, accountLevelArchetype, longSaveBalance } = archetypeOpts
  const bal =
    longSaveBalance != null && !Number.isNaN(Number(longSaveBalance))
      ? Number(longSaveBalance)
      : Number(profile?.balance) || 0

  const funnelCandidate = share >= 0.72 && pc >= 2
  if (funnelCandidate) {
    if (accountLevelArchetype) {
      tags.push('funnel_main')
    } else if (attendeeCharId) {
      const topId = topSpenderCharIdFromProfile(profile)
      if (topId != null && String(topId) === String(attendeeCharId)) tags.push('funnel_main')
    }
  }
  if (share > 0 && share <= 0.38 && pc >= 4) tags.push('spread_across_toons')
  if (days != null && days >= 56 && bal >= 40) tags.push('long_save_candidate')

  if (medianRatio != null) {
    if (medianRatio >= 1.18) tags.push('aggressive_vs_market')
    if (medianRatio <= 0.85) tags.push('patient_vs_market')
  }

  return [...new Set(tags)]
}

/** Lifetime DKP earned on this character (sum of raid_attendance_dkp rows keyed by char id or name). */
export function toonEarnedFromProfile(profile, charId) {
  const m = profile?.per_toon_earned
  if (!m || typeof m !== 'object' || charId == null || String(charId).trim() === '') return 0
  const id = String(charId).trim()
  const v = m[id] ?? m[charId]
  return Number(v) || 0
}

/** Lifetime DKP spent on assigned loot for this character (per loot_char_id). */
export function toonSpentFromProfile(profile, charId) {
  const m = profile?.per_toon_spent
  if (!m || typeof m !== 'object' || charId == null || String(charId).trim() === '') return 0
  const id = String(charId).trim()
  const v = m[id] ?? m[charId]
  return Number(v) || 0
}

/** Attendance earned minus loot spent on this character (matches /accounts assignment + attendance keys). */
export function toonBalanceFromProfile(profile, charId) {
  return toonEarnedFromProfile(profile, charId) - toonSpentFromProfile(profile, charId)
}

/** Char id with highest lifetime spend in profile.per_toon_spent, or null */
export function topSpenderCharIdFromProfile(profile) {
  const map = profile?.per_toon_spent
  if (!map || typeof map !== 'object') return null
  let bestK = null
  let bestV = -1
  for (const [k, v] of Object.entries(map)) {
    const n = Number(v) || 0
    if (n > bestV) {
      bestV = n
      bestK = k
    }
  }
  return bestV > 0 ? bestK : null
}

function normToken(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
}

function purchaseMatchesToon(p, charId, charName) {
  if (charId && p?.char_id != null && String(p.char_id).trim() !== '' && String(p.char_id) === String(charId)) {
    return true
  }
  if (charName && p?.character_name && normToken(p.character_name) === normToken(charName)) return true
  return false
}

/** @returns {number | null} whole days from raid_date to now */
export function daysSinceRaidDate(raidDate) {
  if (raidDate == null) return null
  const d = raidDate instanceof Date ? raidDate : new Date(raidDate)
  if (Number.isNaN(d.getTime())) return null
  const today = new Date()
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  const utcT = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  return Math.floor((utcT - utc) / 86400000)
}

/**
 * Newest matching purchase for this toon (purchases chronological ascending from RPC).
 * @returns {{ raid_date: string, item_name?: string, cost?: number } | null}
 */
export function lastPurchaseOnCharacter(purchasesChronological, charId, charName) {
  if (!Array.isArray(purchasesChronological) || purchasesChronological.length === 0) return null
  for (let i = purchasesChronological.length - 1; i >= 0; i--) {
    const p = purchasesChronological[i]
    if (purchaseMatchesToon(p, charId, charName)) return p
  }
  return null
}

/** Optional interest-score penalty when this toon is cold vs active spending elsewhere */
export const DORMANT_TOON_THRESHOLD_DAYS = 90

export function interestScoreDormantPenalty(profile, charId, charName) {
  if (!profile) return 0
  const purchases = Array.isArray(profile.recent_purchases_desc) ? profile.recent_purchases_desc : []
  const lastOnToon = lastPurchaseOnCharacter(purchases, charId, charName)
  const daysAccount = profile.days_since_last_spend
  if (lastOnToon == null) {
    if (purchases.length > 0 || (Number(profile.purchase_count) || 0) > 0) return 12
    return 0
  }
  const daysOnToon = daysSinceRaidDate(lastOnToon.raid_date)
  if (daysOnToon == null) return 0
  if (daysOnToon < DORMANT_TOON_THRESHOLD_DAYS) return 0
  if (daysAccount != null && daysAccount < Math.max(0, daysOnToon - 14)) return 10
  return 0
}

/**
 * Context when spend history is not on this character (or is much older than account-level activity).
 */
/**
 * Account-wide context: optional shared pool line, archetype, bid vs ref. Per-character balance is separate
 * (see buildCharacterBalanceBullet).
 * @param {object} [opts]
 * @param {number} [opts.accountPoolBalance] — account_dkp_summary net (shared pool)
 * @param {boolean} [opts.includeAccountPoolLine] — when true, emit pool line (e.g. multi-toon rows)
 */
export function buildSharedAccountSpendBullets(prof, bidInfo, tagsForArchetype, bidRatioLabel, opts = {}) {
  const { accountPoolBalance, includeAccountPoolLine } = opts
  const shared = []
  const label =
    bidRatioLabel ||
    'Vs reference prices (guild history when available, else dkp_prices.json)'
  if (prof) {
    if (includeAccountPoolLine && accountPoolBalance != null && !Number.isNaN(Number(accountPoolBalance))) {
      shared.push(`Account pool (earned − spent, shared): ~${Math.round(Number(accountPoolBalance))} DKP.`)
    }
    shared.push(archetypeDescription(tagsForArchetype))
    if (bidInfo?.medianRatio != null) {
      shared.push(`${label}: median paid/ref ≈ ${bidInfo.medianRatio.toFixed(2)} (${bidInfo.label}).`)
    }
  } else {
    shared.push('No linked account — DKP spend profile unavailable.')
  }
  return shared
}

export function buildCharacterBalanceBullet(toonBalance) {
  return `Character balance (attendance earned − loot spent on this character): ~${Math.round(Number(toonBalance) || 0)} DKP.`
}

export function dormantToonVersusAccountNarrative(profile, charId, charName) {
  if (!profile) return ''
  const purchases = Array.isArray(profile.recent_purchases_desc) ? profile.recent_purchases_desc : []
  const hasAnySpend = purchases.length > 0 || (Number(profile.purchase_count) || 0) > 0
  if (!hasAnySpend) return ''

  const lastOnToon = lastPurchaseOnCharacter(purchases, charId, charName)
  if (!lastOnToon) {
    return 'No tracked loot spend on this character in sampled history; the account has spending on other toons — funneling context may apply to those characters, not this one.'
  }

  const daysOnToon = daysSinceRaidDate(lastOnToon.raid_date)
  const daysAccount = profile.days_since_last_spend
  if (daysOnToon == null) return ''
  if (daysOnToon >= 56 && daysAccount != null && daysAccount < daysOnToon - 7) {
    return `Last spend on this toon was ~${daysOnToon}d ago; the account’s most recent spend overall was more recent (~${daysAccount}d ago), likely on another character.`
  }
  if (daysOnToon >= DORMANT_TOON_THRESHOLD_DAYS) {
    return `This toon has not received a tracked loot purchase in ~${daysOnToon}d — consider that when judging interest vs alts on the same account.`
  }
  return ''
}

export function archetypeDescription(tags) {
  if (!tags.length) return 'Spend pattern unclear from available data.'
  const parts = []
  if (tags.includes('funnel_main')) parts.push('Concentrates DKP heavily on one character.')
  if (tags.includes('spread_across_toons')) parts.push('Splits purchases across several toons.')
  if (tags.includes('long_save_candidate')) parts.push('Long gap since last spend with banked DKP — may be saving for a big ticket.')
  if (tags.includes('aggressive_vs_market')) parts.push('Historically pays more than recent reference prices (when comparable).')
  if (tags.includes('patient_vs_market')) parts.push('Historically pays less than recent reference prices (when comparable).')
  return parts.join(' ')
}

/**
 * Heuristic bid band: min(balance, anchor * aggressiveness factor), with low/mid/high.
 */
/** Combined band for a consolidated account row (min low, max high, mean mid). */
export function mergeBidBandsForAccountRow(bands) {
  if (!Array.isArray(bands) || bands.length === 0) {
    return { low: 0, high: 0, mid: 0, note: '' }
  }
  if (bands.length === 1) return bands[0]
  const lows = bands.map((b) => Number(b?.low) || 0)
  const highs = bands.map((b) => Number(b?.high) || 0)
  const mids = bands.map((b) => Number(b?.mid) || 0)
  return {
    low: Math.min(...lows),
    high: Math.max(...highs),
    mid: Math.round(mids.reduce((a, b) => a + b, 0) / mids.length),
    note: 'Span across toons on this account.',
  }
}

export function estimateBidBand(balance, anchorPrice, medianBidRatio, scoreDelta) {
  const b = Math.max(0, Number(balance) || 0)
  const a = anchorPrice != null && !Number.isNaN(Number(anchorPrice)) ? Number(anchorPrice) : null
  let mult = 1
  if (medianBidRatio != null && !Number.isNaN(medianBidRatio)) {
    mult = Math.min(1.35, Math.max(0.75, medianBidRatio))
  }
  if (scoreDelta != null && scoreDelta > 0.02) mult = Math.min(1.25, mult * 1.08)
  if (a == null || a <= 0) {
    const mid = Math.round(b * 0.45)
    return {
      low: Math.min(b, Math.max(0, Math.round(mid * 0.7))),
      mid: Math.min(b, mid),
      high: Math.min(b, Math.round(mid * 1.25)),
      note: 'No anchor from recent sales; using fraction of balance only.',
    }
  }
  const mid = Math.min(b, Math.round(a * mult))
  return {
    low: Math.min(b, Math.max(0, Math.round(mid * 0.75))),
    mid,
    high: Math.min(b, Math.round(mid * 1.2)),
    note: 'Heuristic only — not a prediction of actual bids.',
  }
}

export function lastSpendNarrative(profile, attendeeCharId) {
  const lp = profile?.last_purchase
  if (!lp || !lp.raid_date) return 'No recorded purchases for this account in loot history.'
  const onThis = lp.char_id && attendeeCharId && String(lp.char_id) === String(attendeeCharId)
  const toon = (lp.character_name || lp.char_id || '').trim() || 'a character'
  const item = (lp.item_name || '').trim() || 'an item'
  const days = profile?.days_since_last_spend
  const daysPart = days != null ? `${days}d ago` : 'recently'
  const where = onThis ? `on this toon (${toon})` : `on ${toon}`
  return `Last spend ${daysPart}: ${item} ${where} for ${lp.cost} DKP.`
}

export function perToonShareNarrative(profile, attendeeCharId) {
  const map = profile?.per_toon_spent
  if (!map || typeof map !== 'object') return ''
  const entries = Object.entries(map).map(([k, v]) => ({ k, v: Number(v) || 0 }))
  const total = entries.reduce((s, e) => s + e.v, 0)
  if (total <= 0) return ''
  const mine = entries.find((e) => String(e.k) === String(attendeeCharId))
  const share = mine ? mine.v / total : 0
  const top = [...entries].sort((a, b) => b.v - a.v)[0]
  const topShare = top ? top.v / total : 0
  let s = `Lifetime spend tracked on linked toons: ${Math.round(total)} DKP total.`
  if (top && topShare >= 0.5) {
    s += ` Most on one toon (${Math.round(topShare * 100)}% of tracked spend).`
  }
  if (mine && share > 0) {
    s += ` This toon accounts for ~${Math.round(share * 100)}% of that spend.`
  }
  return s
}
