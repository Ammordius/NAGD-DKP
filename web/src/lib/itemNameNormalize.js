/**
 * Align with magelo/scripts/build_dkp_prices_json.py normalize_item_name_for_lookup.
 */
export function normalizeItemNameForLookup(name) {
  if (!name || typeof name !== 'string') return ''
  let s = name.trim()
  for (const c of ["'", "'", '`', '\u2019', '\u2018']) {
    s = s.split(c).join('')
  }
  s = s.replace(/-/g, ' ')
  s = s.toLowerCase().replace(/\s+/g, ' ').trim()
  s = s.replace(/^[,.;:!?]+|[,.;:!?]+$/g, '')
  return s
}
