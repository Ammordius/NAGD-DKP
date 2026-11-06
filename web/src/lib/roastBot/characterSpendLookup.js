/**
 * Guild-wide character DKP spent lookup via get_character_dkp_spent.
 * Matches Loot Recipients / Character page totals — no invented numbers.
 */

import { extractSubjectCharacterName, INTENTS } from './intents.js'
import { sumCharacterSpent } from '../characterSpent.js'

/**
 * @param {string} raw
 */
export function looksLikeCharacterDkpSpent(raw) {
  const name = extractSubjectCharacterName(raw, { intent: INTENTS.CHARACTER_DKP_SPENT })
  // Phrase alone is enough to prefetch when classifier already matched spent intent
  return Boolean(name) || /\bspent\b/i.test(String(raw || '')) && /\bdkp\b/i.test(String(raw || ''))
}

/**
 * @param {string} raw
 * @param {{ characters?: object[] }} [opts]
 */
export function extractSpendCharacterName(raw, opts = {}) {
  return extractSubjectCharacterName(raw, {
    characters: opts.characters || [],
    intent: INTENTS.CHARACTER_DKP_SPENT,
  })
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} characterName
 * @returns {Promise<{
 *   status: 'ok'|'not_found'|'no_name'|'error',
 *   characterName: string|null,
 *   charId: string|null,
 *   totalSpent: number|null,
 *   error?: string|null,
 * }>}
 */
export async function lookupCharacterDkpSpent(supabase, characterName) {
  const wanted = String(characterName || '').trim()
  if (!wanted) {
    return {
      status: 'no_name',
      characterName: null,
      charId: null,
      totalSpent: null,
    }
  }

  const keys = [wanted]
  try {
    // Resolve char_id from the same map who-is uses when available.
    const { fetchCharToAccountMap } = await import('../useCharToAccountMap.js')
    const mapData = await fetchCharToAccountMap()
    const lower = wanted.toLowerCase()
    let charId = null
    let resolvedName = wanted
    for (const [id, name] of Object.entries(mapData.charIdToName || {})) {
      if (name && name.toLowerCase() === lower) {
        charId = id
        resolvedName = name
        keys.push(id)
        if (name !== wanted) keys.push(name)
        break
      }
    }

    const { data, error } = await supabase.rpc('get_character_dkp_spent', { p_keys: keys })
    if (error) {
      return {
        status: 'error',
        characterName: resolvedName,
        charId,
        totalSpent: null,
        error: error.message || 'rpc_error',
      }
    }

    const rows = Array.isArray(data) ? data : []
    if (!rows.length) {
      return {
        status: 'ok',
        characterName: resolvedName,
        charId,
        totalSpent: 0,
      }
    }

    // Prefer exact name / id match; take max if multiple keys hit the same row twice.
    let best = null
    for (const row of rows) {
      const total = Number(row.total_spent)
      if (!Number.isFinite(total)) continue
      const rowName = String(row.character_name || '').trim()
      const rowId = String(row.char_id || '').trim()
      const exact =
        (charId && rowId === charId) ||
        (rowName && rowName.toLowerCase() === lower) ||
        String(row.character_key || '').toLowerCase() === lower
      if (!best || (exact && !best.exact) || (exact === best.exact && total > best.total)) {
        best = {
          exact: Boolean(exact),
          total,
          charId: rowId || charId,
          name: rowName || resolvedName,
        }
      }
    }

    if (!best) {
      return {
        status: 'ok',
        characterName: resolvedName,
        charId,
        totalSpent: 0,
      }
    }

    return {
      status: 'ok',
      characterName: best.name || resolvedName,
      charId: best.charId || charId,
      totalSpent: best.total,
    }
  } catch (e) {
    return {
      status: 'error',
      characterName: wanted,
      charId: null,
      totalSpent: null,
      error: e?.message || 'lookup_failed',
    }
  }
}

/**
 * Fallback from in-memory account loot facts (tests / RPC unavailable).
 * @param {object} facts
 * @param {{ name?: string, char_id?: string, character_name?: string }} character
 */
export function spentFromAccountFacts(facts, character) {
  if (!character) return null
  const total = sumCharacterSpent(facts?.purchasesByCharacterSpent || {}, character)
  return Number.isFinite(total) ? total : 0
}
