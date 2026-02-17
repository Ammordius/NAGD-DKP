import { useEffect, useState, useMemo } from 'react'
import { supabase } from './supabase'

/**
 * Fetches character_account, characters, and accounts to build char_id/name -> account_id and account display name.
 * Returns getAccountId(charIdOrName), getAccountDisplayName(charIdOrName), and loading flag.
 * Use for linking character names to account pages and showing "account (character)".
 */
export function useCharToAccountMap() {
  const [charToAccount, setCharToAccount] = useState({})
  const [accountIdToDisplayName, setAccountIdToDisplayName] = useState({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      supabase.from('character_account').select('char_id, account_id').limit(20000),
      supabase.from('characters').select('char_id, name').limit(20000),
      supabase.from('accounts').select('account_id, display_name').limit(5000),
    ]).then(([caRes, chRes, accRes]) => {
      if (cancelled) return
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
      setCharToAccount(map)
      const accNames = {}
      ;(accRes.data || []).forEach((a) => {
        if (a?.account_id) accNames[a.account_id] = (a.display_name || '').trim() || a.account_id
      })
      setAccountIdToDisplayName(accNames)
      setLoading(false)
    }).catch(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

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

  return { getAccountId, getAccountDisplayName, loading }
}
