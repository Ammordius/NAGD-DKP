import { supabase } from './supabase'

const PAGE_SIZE = 1000

/**
 * Load all rows from a table using repeated .range() calls.
 * PostgREST caps each response (~1000 rows by default); a single .limit(N) is not enough.
 */
export async function fetchAllByRange(table, selectColumns) {
  const merged = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase.from(table).select(selectColumns).range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const rows = data || []
    merged.push(...rows)
    if (rows.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return merged
}
