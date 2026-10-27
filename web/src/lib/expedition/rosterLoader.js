import { accountDetailSessionKey } from '../accountDetailMissingScope.js'
import { FICTIONAL_STARTERS, normalizeRoster } from './characterAdapter.js'

/** @type {Map<string, { characters: ReturnType<typeof normalizeRoster>, source: string }>} */
const memoryRosterByAccount = new Map()

/**
 * @param {string} accountId
 */
export function clearRosterMemoryCache(accountId) {
  if (accountId) memoryRosterByAccount.delete(accountId)
  else memoryRosterByAccount.clear()
}

/**
 * @param {unknown} data
 * @returns {ReturnType<typeof normalizeRoster>|null}
 */
export function extractCharactersFromAccountDetail(data) {
  if (!data || typeof data !== 'object') return null
  const chars = /** @type {{ characters?: unknown }} */ (data).characters
  if (!Array.isArray(chars) || chars.length === 0) return null
  const normalized = normalizeRoster(chars)
  return normalized.length ? normalized : null
}

/**
 * Peek sessionStorage account-detail blob without triggering fetches.
 * @param {string} accountId
 * @param {Storage} [storage]
 */
export function peekSessionAccountCharacters(accountId, storage = typeof sessionStorage !== 'undefined' ? sessionStorage : undefined) {
  if (!accountId || !storage) return null
  const key = accountDetailSessionKey(accountId, false)
  if (!key) return null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    return extractCharactersFromAccountDetail(JSON.parse(raw))
  } catch {
    return null
  }
}

/**
 * @param {unknown} swrEntryOrData
 */
export function peekSwrAccountCharacters(swrEntryOrData) {
  if (!swrEntryOrData) return null
  if (typeof swrEntryOrData === 'object' && 'data' in /** @type {object} */ (swrEntryOrData)) {
    return extractCharactersFromAccountDetail(/** @type {{ data?: unknown }} */ (swrEntryOrData).data)
  }
  return extractCharactersFromAccountDetail(swrEntryOrData)
}

/**
 * Minimal Supabase-shaped client: from(table).select().eq|in().limit()
 * @typedef {{
 *   from: (table: string) => {
 *     select: (cols: string) => {
 *       eq: (col: string, val: string) => { limit: (n: number) => Promise<{ data: any, error: any }> },
 *       in: (col: string, vals: string[]) => { limit: (n: number) => Promise<{ data: any, error: any }> },
 *     }
 *   }
 * }} ExpeditionSupabase
 */

/**
 * At most two account-scoped reads.
 * @param {ExpeditionSupabase} client
 * @param {string} accountId
 */
export async function fetchAccountRosterMinimal(client, accountId) {
  const caRes = await client
    .from('character_account')
    .select('char_id')
    .eq('account_id', accountId)
    .limit(40)
  if (caRes.error) throw caRes.error
  const charIds = (caRes.data || []).map((r) => r.char_id).filter(Boolean)
  if (!charIds.length) return []
  const chRes = await client
    .from('characters')
    .select('char_id,name,class_name,level')
    .in('char_id', charIds)
    .limit(40)
  if (chRes.error) throw chRes.error
  return normalizeRoster(chRes.data || [])
}

/**
 * Resolve roster: fictional if unclaimed; cache-first; else ≤2 queries.
 *
 * @param {{
 *   accountId?: string|null,
 *   swrData?: unknown,
 *   sessionStorage?: Storage,
 *   client?: ExpeditionSupabase|null,
 *   allowNetwork?: boolean,
 * }} opts
 */
export async function resolveExpeditionRoster(opts = {}) {
  const accountId = opts.accountId || null

  if (!accountId) {
    return {
      characters: normalizeRoster(FICTIONAL_STARTERS),
      source: 'fictional',
      fictional: true,
      notice: 'No linked game account — playing with fictional stand-ins.',
      networkQueries: 0,
    }
  }

  const mem = memoryRosterByAccount.get(accountId)
  if (mem?.characters?.length) {
    return {
      characters: mem.characters,
      source: 'memory',
      fictional: false,
      notice: null,
      networkQueries: 0,
    }
  }

  const fromSwr = peekSwrAccountCharacters(opts.swrData)
  if (fromSwr?.length) {
    memoryRosterByAccount.set(accountId, { characters: fromSwr, source: 'swr' })
    return {
      characters: fromSwr,
      source: 'swr',
      fictional: false,
      notice: null,
      networkQueries: 0,
    }
  }

  const fromSession = peekSessionAccountCharacters(accountId, opts.sessionStorage)
  if (fromSession?.length) {
    memoryRosterByAccount.set(accountId, { characters: fromSession, source: 'session' })
    return {
      characters: fromSession,
      source: 'session',
      fictional: false,
      notice: null,
      networkQueries: 0,
    }
  }

  if (opts.allowNetwork === false || !opts.client) {
    return {
      characters: normalizeRoster(FICTIONAL_STARTERS),
      source: 'fictional',
      fictional: true,
      notice: 'Roster unavailable offline — fictional stand-ins loaded.',
      networkQueries: 0,
    }
  }

  try {
    const characters = await fetchAccountRosterMinimal(opts.client, accountId)
    if (!characters.length) {
      return {
        characters: normalizeRoster(FICTIONAL_STARTERS),
        source: 'fictional',
        fictional: true,
        notice: 'No characters linked — fictional stand-ins loaded.',
        networkQueries: 2,
      }
    }
    memoryRosterByAccount.set(accountId, { characters, source: 'network' })
    return {
      characters,
      source: 'network',
      fictional: false,
      notice: null,
      networkQueries: 2,
    }
  } catch {
    return {
      characters: normalizeRoster(FICTIONAL_STARTERS),
      source: 'fictional',
      fictional: true,
      notice: 'Could not load roster — fictional stand-ins loaded.',
      networkQueries: 2,
    }
  }
}
