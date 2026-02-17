import useSWR from 'swr'
import { useMemo } from 'react'
import { supabase } from './supabase'

/** SWR deduplication: 60s so multiple components don't trigger the same fetch (e.g. RaidDetail + AccountDetail). */
const DEDUPING_INTERVAL_MS = 60_000

const CHAR_TO_ACCOUNT_KEY = 'char-to-account-map'

async function fetchCharToAccountMap() {
  const [caRes, chRes, accRes] = await Promise.all([
    supabase.from('character_account').select('char_id, account_id').limit(20000),
    supabase.from('characters').select('char_id, name').limit(20000),
    supabase.from('accounts').select('account_id, display_name').limit(5000),
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
  const accountIdToDisplayName = {}
  ;(accRes.data || []).forEach((a) => {
    if (a?.account_id) accountIdToDisplayName[a.account_id] = (a.display_name || '').trim() || a.account_id
  })
  return { charToAccount: map, accountIdToDisplayName }
}

/**
 * Fetches character_account, characters, and accounts to build char_id/name -> account_id and account display name.
 * Uses SWR so multiple components share one request (dedupingInterval 60s).
 * Returns getAccountId(charIdOrName), getAccountDisplayName(charIdOrName), and loading flag.
 */
export function useCharToAccountMap() {
  const { data, isLoading } = useSWR(CHAR_TO_ACCOUNT_KEY, fetchCharToAccountMap, {
    dedupingInterval: DEDUPING_INTERVAL_MS,
    revalidateOnFocus: false,
  })

  const charToAccount = data?.charToAccount ?? {}
  const accountIdToDisplayName = data?.accountIdToDisplayName ?? {}

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

  return { getAccountId, getAccountDisplayName, loading: isLoading }
}
