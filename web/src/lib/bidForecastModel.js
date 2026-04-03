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

export function spendArchetypeTags(profile, bidLabel, medianRatio) {
  const tags = []
  const share = Number(profile?.top_toon_share) || 0
  const pc = Number(profile?.purchase_count) || 0
  const bal = Number(profile?.balance) || 0
  const days = profile?.days_since_last_spend

  if (share >= 0.72 && pc >= 2) tags.push('funnel_main')
  if (share > 0 && share <= 0.38 && pc >= 4) tags.push('spread_across_toons')
  if (days != null && days >= 56 && bal >= 40) tags.push('long_save_candidate')

  if (medianRatio != null) {
    if (medianRatio >= 1.18) tags.push('aggressive_vs_market')
    if (medianRatio <= 0.85) tags.push('patient_vs_market')
  }

  return [...new Set(tags)]
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
