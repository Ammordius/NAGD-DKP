/** Case-insensitive exact name checks for officer "Create new DKP account". */

export function normalizeAccountName(value) {
  return String(value ?? '').trim()
}

function sameName(a, b) {
  const left = normalizeAccountName(a).toLowerCase()
  const right = normalizeAccountName(b).toLowerCase()
  return left !== '' && left === right
}

/** True when a comma-separated toon list contains the name as a whole token. */
export function toonNamesInclude(toonNames, name) {
  const target = normalizeAccountName(name).toLowerCase()
  if (!target) return false
  return String(toonNames ?? '')
    .split(',')
    .some((part) => part.trim().toLowerCase() === target)
}

/**
 * Decide whether a proposed display name collides with existing accounts or characters.
 * @param {string} name
 * @param {{ accounts?: { display_name?: string, toon_names?: string }[], characters?: { name?: string }[] }} existing
 * @returns {{ taken: boolean, message: string }}
 */
export function duplicateAccountNameResult(name, existing = {}) {
  const trimmed = normalizeAccountName(name)
  if (!trimmed) {
    return { taken: true, message: 'Enter a display name.' }
  }
  const accounts = existing.accounts || []
  const characters = existing.characters || []
  const accountHit = accounts.some((row) => sameName(row.display_name, trimmed))
  const characterHit = characters.some((row) => sameName(row.name, trimmed))
    || accounts.some((row) => toonNamesInclude(row.toon_names, trimmed))
  const parts = []
  if (accountHit) parts.push(`An account named ${trimmed} already exists.`)
  if (characterHit) parts.push(`A character named ${trimmed} already exists.`)
  if (parts.length === 0) return { taken: false, message: '' }
  return { taken: true, message: parts.join(' ') }
}

function escapeIlike(value) {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/**
 * Look up accounts.display_name, accounts.toon_names, and characters.name.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} name
 */
export async function findDuplicateAccountName(supabase, name) {
  const trimmed = normalizeAccountName(name)
  if (!trimmed) return { taken: true, message: 'Enter a display name.' }
  const exact = escapeIlike(trimmed)
  const [byDisplay, byToon, byCharacter] = await Promise.all([
    supabase.from('accounts').select('account_id, display_name, toon_names').ilike('display_name', exact).limit(5),
    supabase.from('accounts').select('account_id, display_name, toon_names').ilike('toon_names', `%${exact}%`).limit(50),
    supabase.from('characters').select('char_id, name').ilike('name', exact).limit(5),
  ])
  const err = byDisplay.error || byToon.error || byCharacter.error
  if (err) throw new Error(err.message)
  const toonHits = (byToon.data || []).filter((row) => toonNamesInclude(row.toon_names, trimmed))
  return duplicateAccountNameResult(trimmed, {
    accounts: [...(byDisplay.data || []), ...toonHits],
    characters: byCharacter.data || [],
  })
}
