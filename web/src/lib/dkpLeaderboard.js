/**
 * DKP leaderboard data: fetched from Supabase (authenticated) so RLS allows read.
 * Used by DKP page, LootRecipients, and AccountDetail so DKP totals are a single source of truth (same cache everywhere).
 */
import { useMemo } from 'react'
import useSWR from 'swr'
import { supabase } from './supabase'

export const ACTIVE_DAYS = 120
/** SWR key for DKP payload (authenticated Supabase fetch). */
export const DKP_DATA_KEY = 'dkp-payload'
const PAGE_SIZE = 1000
const DEDUPING_INTERVAL_MS = 60 * 1000

async function fetchAll(supabaseClient, table, select) {
  const all = []
  let from = 0
  while (true) {
    const to = from + PAGE_SIZE - 1
    const { data, error } = await supabaseClient.from(table).select(select).range(from, to)
    if (error) throw new Error(error.message || `Failed to fetch ${table}`)
    const rows = data ?? []
    all.push(...rows)
    if (rows.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return all
}

/** Fetch same payload as former /api/get-dkp using authenticated Supabase client (required after requiring sign-in). */
export async function fetchDkpPayloadFromSupabase() {
  const [summary, adjRes, activeRaiders, periodRes, charAccount, accounts, characters] = await Promise.all([
    fetchAll(supabase, 'dkp_summary', 'character_key, character_name, earned, spent, earned_30d, earned_60d, last_activity_date, updated_at'),
    supabase.from('dkp_adjustments').select('character_name, earned_delta, spent_delta').limit(1000),
    fetchAll(supabase, 'active_raiders', 'character_key'),
    supabase.from('dkp_period_totals').select('period, total_dkp'),
    fetchAll(supabase, 'character_account', 'char_id, account_id'),
    fetchAll(supabase, 'accounts', 'account_id, toon_names, display_name'),
    fetchAll(supabase, 'characters', 'char_id, name, class_name'),
  ])
  if (adjRes.error) throw new Error(adjRes.error.message || 'Failed to fetch dkp_adjustments')
  if (periodRes.error) throw new Error(periodRes.error.message || 'Failed to fetch dkp_period_totals')
  const adjustments = adjRes.data ?? []
  const periodTotals = periodRes.data ?? []
  return {
    dkp_summary: summary,
    dkp_adjustments: adjustments,
    active_raiders: activeRaiders,
    dkp_period_totals: periodTotals,
    character_account: charAccount,
    accounts,
    characters,
  }
}

async function defaultDkpFetcher() {
  return fetchDkpPayloadFromSupabase()
}

function applyAdjustmentsAndBalance(list, adjustmentsMap) {
  list.forEach((r) => {
    const adjRow = adjustmentsMap[(r.name || '').trim()] || adjustmentsMap[(r.name || '').trim().replace(/^\(\*\)\s*/, '')]
    if (adjRow) {
      r.earned += Math.round(Number(adjRow.earned_delta) || 0)
      r.spent += Math.round(Number(adjRow.spent_delta) || 0)
    }
    r.balance = r.earned - r.spent
  })
  list.sort((a, b) => b.balance - a.balance)
}

export function buildAccountLeaderboard(list, caData, accData, charData) {
  const charToAccount = {}
  ;(caData || []).forEach((r) => { charToAccount[String(r.char_id)] = r.account_id })
  const nameToAccount = {}
  if (charData?.length) {
    const charIdToName = {}
    charData.forEach((c) => { if (c.name) charIdToName[String(c.char_id)] = c.name })
    ;(caData || []).forEach((r) => {
      const name = charIdToName[String(r.char_id)]
      if (name) nameToAccount[name] = r.account_id
    })
  }
  const accountNames = {}
  ;(accData || []).forEach((r) => {
    const display = (r.display_name || '').trim()
    const first = (r.toon_names || '').split(',')[0]?.trim() || r.account_id
    accountNames[r.account_id] = display || first
  })
  const byAccount = {}
  list.forEach((r) => {
    const aid = charToAccount[String(r.char_id)] ?? nameToAccount[String(r.name || '')] ?? '_no_account_'
    if (!byAccount[aid]) byAccount[aid] = { account_id: aid, earned: 0, spent: 0, earned_30d: 0, earned_60d: 0, name: accountNames[aid] || (aid === '_no_account_' ? '(no account)' : aid) }
    byAccount[aid].earned += r.earned
    byAccount[aid].spent += r.spent
    byAccount[aid].earned_30d += (r.earned_30d != null ? r.earned_30d : 0)
    byAccount[aid].earned_60d += (r.earned_60d != null ? r.earned_60d : 0)
  })
  const accountList = Object.values(byAccount).map((r) => ({ ...r, balance: r.earned - r.spent }))
  accountList.sort((a, b) => b.balance - a.balance)
  return accountList
}

function isActiveRow(r, activeKeysSet, cutoffDate) {
  if (activeKeysSet?.has(String(r.char_id))) return true
  if (!cutoffDate) return false
  if (r.last_activity_date == null || r.last_activity_date === '') return false
  const d = typeof r.last_activity_date === 'string' ? new Date(r.last_activity_date) : r.last_activity_date
  if (isNaN(d.getTime())) return false
  return d >= cutoffDate
}

function dedupeByCharacterName(list) {
  const byName = {}
  /** Same person can appear twice in dkp_summary: character_key=char_id and character_key=name. Don't sum those. */
  const isNameKey = (row) =>
    row.char_id && row.name && String(row.char_id).trim().toLowerCase() === String(row.name).trim().toLowerCase()
  list.forEach((r) => {
    const key = (r.name || r.char_id || '').toString().trim().toLowerCase()
    if (!key) return
    if (!byName[key]) {
      byName[key] = { ...r }
      return
    }
    const m = byName[key]
    const mNameKey = isNameKey(m)
    const rNameKey = isNameKey(r)
    if (mNameKey && !rNameKey) {
      byName[key] = { ...r }
      return
    }
    if (!mNameKey && rNameKey) return
    m.earned += r.earned
    m.spent += r.spent
    m.earned_30d = (m.earned_30d ?? 0) + (r.earned_30d ?? 0)
    m.earned_60d = (m.earned_60d ?? 0) + (r.earned_60d ?? 0)
    if (r.last_activity_date && (!m.last_activity_date || (r.last_activity_date > m.last_activity_date))) {
      m.last_activity_date = r.last_activity_date
    }
    if (r.char_id && r.char_id !== m.char_id) m.char_id = m.char_id || r.char_id
  })
  return Object.values(byName)
}

/**
 * Process /api/get-dkp response into leaderboard list and account list (with adjustments applied).
 * Returns { list, accountList, activeKeys, periodTotals, caData, accData, charData, summaryUpdatedAt } or null.
 */
export function processApiPayload(payload) {
  if (!payload?.dkp_summary?.length) return null
  const rows = payload.dkp_summary
  const activeKeys = (payload.active_raiders ?? []).map((x) => String(x.character_key))
  const activeSet = new Set(activeKeys)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - ACTIVE_DAYS)
  cutoff.setHours(0, 0, 0, 0)
  const adjustmentsMap = {}
  ;(payload.dkp_adjustments ?? []).forEach((row) => {
    const n = (row.character_name || '').trim()
    if (n) adjustmentsMap[n] = { earned_delta: Number(row.earned_delta) || 0, spent_delta: Number(row.spent_delta) || 0 }
  })
  const pt = { '30d': 0, '60d': 0 }
  ;(payload.dkp_period_totals ?? []).forEach((row) => { pt[row.period] = Math.round(Number(row.total_dkp) || 0) })
  let list = rows.map((r) => ({
    char_id: r.character_key,
    name: r.character_name || r.character_key,
    earned: Math.round(Number(r.earned) || 0),
    spent: Math.round(Number(r.spent) || 0),
    earned_30d: Math.round(Number(r.earned_30d) || 0),
    earned_60d: Math.round(Number(r.earned_60d) || 0),
    last_activity_date: r.last_activity_date || null,
  }))
  list = dedupeByCharacterName(list)
  applyAdjustmentsAndBalance(list, adjustmentsMap)
  const caData = payload.character_account ?? []
  const accData = payload.accounts ?? []
  const charData = payload.characters ?? []
  // Full account totals (incl. inactive) for account detail / balance lookups.
  const accountListFull = buildAccountLeaderboard(list, caData, accData, charData)
  const fullAccountBalances = {}
  accountListFull.forEach((a) => {
    if (a.account_id != null && a.account_id !== '') fullAccountBalances[String(a.account_id)] = Number(a.balance) || 0
  })
  // Main page: only active raiders and only accounts that have at least one active raider.
  list = list.filter((r) => isActiveRow(r, activeSet, cutoff))
  const accountList = buildAccountLeaderboard(list, caData, accData, charData)
  const summaryUpdatedAt = rows[0]?.updated_at ?? null
  return { list, accountList, fullAccountBalances, activeKeys, periodTotals: pt, caData, accData, charData, summaryUpdatedAt }
}

/**
 * Fetch DKP payload (from Supabase, authenticated) and return account_id -> balance (same as DKP page Account table).
 */
export async function fetchAccountDkpBalances() {
  try {
    const payload = await fetchDkpPayloadFromSupabase()
    const processed = processApiPayload(payload)
    return processed?.fullAccountBalances ?? {}
  } catch {
    return {}
  }
}

/**
 * Shared hook: one SWR cache for DKP payload (authenticated Supabase). Use everywhere that shows DKP totals so result and cache are identical.
 * Returns processed payload (list, accountList, etc.) and accountBalanceByAccountId for account-level balance.
 */
export function useDkpData(fetcher = defaultDkpFetcher) {
  const { data: apiData, error, isLoading, mutate } = useSWR(DKP_DATA_KEY, fetcher, {
    dedupingInterval: DEDUPING_INTERVAL_MS,
    revalidateOnFocus: false,
  })
  const processed = useMemo(() => (apiData ? processApiPayload(apiData) : null), [apiData])
  const accountBalanceByAccountId = useMemo(() => processed?.fullAccountBalances ?? {}, [processed])
  return {
    ...processed,
    list: processed?.list ?? [],
    accountList: processed?.accountList ?? [],
    activeKeys: processed?.activeKeys ?? [],
    periodTotals: processed?.periodTotals ?? { '30d': 0, '60d': 0 },
    summaryUpdatedAt: processed?.summaryUpdatedAt ?? null,
    accountBalanceByAccountId,
    apiData,
    error: error?.message ?? null,
    isLoading,
    mutate,
  }
}
