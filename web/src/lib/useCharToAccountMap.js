import useSWR from 'swr'
import { useMemo } from 'react'
import { supabase } from './supabase'

/** SWR deduplication: 60s so multiple components don't trigger the same fetch (e.g. RaidDetail + AccountDetail). */
const DEDUPING_INTERVAL_MS = 60_000

const CHAR_TO_ACCOUNT_KEY = 'char-to-account-map'

const ACCOUNTS_PAGE = 1000

/** Load all account rows (paginated); avoids missing display names when the guild has > default cap. */
async function fetchAllAccounts() {
  const merged = []
  let offset = 0
  for (;;) {
    const { data, error } = await supabase
      .from('accounts')
      .select('account_id, display_name')
      .order('account_id')
      .range(offset, offset + ACCOUNTS_PAGE - 1)
    if (error) throw error
    const rows = data || []
    merged.push(...rows)
    if (rows.length < ACCOUNTS_PAGE) break
    offset += ACCOUNTS_PAGE
  }
  return merged
}

async function fetchCharToAccountMap() {
  const [caRes, chRes, accRows] = await Promise.all([
    supabase.from('character_account').select('char_id, account_id').limit(20000),
    supabase.from('characters').select('char_id, name').limit(20000),
    fetchAllAccounts(),
  ])
  const map = {}
  ;(caRes.data || []).forEach((r) => {
    if (r.char_id != null && r.char_id !== '' && r.account_id != null) {
      const k = String(r.char_id).trim()
      if (map[k] == null) map[k] = r.account_id
    }
  })
  const charIds = new Set(Object.keys(map))
  ;(chRes.data || []).forEach((c) => {
    if (!c?.char_id || !charIds.has(String(c.char_id).trim())) return
    const name = (c.name || '').trim()
    const accId = map[String(c.char_id).trim()]
    if (name && accId) {
      if (map[name] == null) map[name] = accId
      const lower = name.toLowerCase()
      if (map[lower] == null) map[lower] = accId
    }
  })
  const charIdToName = {}
  ;(chRes.data || []).forEach((c) => {
    if (!c?.char_id) return
    const id = String(c.char_id).trim()
    const name = (c.name || '').trim()
    if (name) charIdToName[id] = name
  })
  /** First linked character name per account (for labels when only account_id is known). */
  const accountIdToSampleCharName = {}
  ;(caRes.data || []).forEach((r) => {
    if (r.char_id == null || r.char_id === '' || r.account_id == null) return
    const aid = String(r.account_id).trim()
    if (!aid || Object.prototype.hasOwnProperty.call(accountIdToSampleCharName, aid)) return
    const name = charIdToName[String(r.char_id).trim()]
    if (name) accountIdToSampleCharName[aid] = name
  })
  const accountIdToDisplayName = {}
  ;(accRows || []).forEach((a) => {
    if (a?.account_id) accountIdToDisplayName[a.account_id] = (a.display_name || '').trim() || a.account_id
  })
  return { charToAccount: map, accountIdToDisplayName, accountIdToSampleCharName }
}

/**
 * Fetches character_account, characters, and accounts to build char_id/name -> account_id and account display name.
 * Uses SWR so multiple components share one request (dedupingInterval 60s).
 * Returns getAccountId(charIdOrName), getAccountDisplayName(charIdOrName),
 * getDisplayNameForAccountId(accountId), getRepresentativeCharNameForAccount(accountId), and loading flag.
 */
export function useCharToAccountMap() {
  const { data, isLoading } = useSWR(CHAR_TO_ACCOUNT_KEY, fetchCharToAccountMap, {
    dedupingInterval: DEDUPING_INTERVAL_MS,
    revalidateOnFocus: false,
  })

  const charToAccount = data?.charToAccount ?? {}
  const accountIdToDisplayName = data?.accountIdToDisplayName ?? {}
  const accountIdToSampleCharName = data?.accountIdToSampleCharName ?? {}

  const getAccountId = useMemo(() => {
    return (charIdOrName) => {
      if (charIdOrName == null || charIdOrName === '') return null
      const k = String(charIdOrName).trim()
      return charToAccount[k] ?? charToAccount[k.toLowerCase()] ?? null
    }
  }, [charToAccount])

  const getAccountDisplayName = useMemo(() => {
    return (charIdOrName) => {
      if (charIdOrName == null || charIdOrName === '') return null
      const k = String(charIdOrName).trim()
      const accId = charToAccount[k] ?? charToAccount[k.toLowerCase()] ?? null
      if (!accId) return null
      return accountIdToDisplayName[accId] ?? accId
    }
  }, [charToAccount, accountIdToDisplayName])

  const getDisplayNameForAccountId = useMemo(() => {
    return (accountId) => {
      if (accountId == null || accountId === '') return null
      const trimmed = String(accountId).trim()
      if (trimmed === '') return null
      const n = Number(trimmed)
      const fromMap =
        accountIdToDisplayName[accountId] ??
        (Number.isFinite(n) ? accountIdToDisplayName[n] : undefined) ??
        accountIdToDisplayName[trimmed]
      return fromMap ?? trimmed
    }
  }, [accountIdToDisplayName])

  const getRepresentativeCharNameForAccount = useMemo(() => {
    return (accountId) => {
      if (accountId == null || accountId === '') return null
      const trimmed = String(accountId).trim()
      if (trimmed === '') return null
      const n = Number(trimmed)
      return (
        accountIdToSampleCharName[accountId] ??
        (Number.isFinite(n) ? accountIdToSampleCharName[n] : undefined) ??
        accountIdToSampleCharName[trimmed] ??
        null
      )
    }
  }, [accountIdToSampleCharName])

  return {
    getAccountId,
    getAccountDisplayName,
    getDisplayNameForAccountId,
    getRepresentativeCharNameForAccount,
    loading: isLoading,
  }
}
