import { supabase } from './supabase'

const PAGE_SIZE = 1000

/**
 * Load all rows from a table using repeated .range() calls.
 * PostgREST caps each response (~1000 rows by default); a single .limit(N) is not enough.
 */
export async function fetchAllByRange(table, selectColumns, orderColumns = ['id']) {
  const columns = (Array.isArray(orderColumns) ? orderColumns : [orderColumns]).filter(Boolean)
  const merged = []
  let from = 0
  for (;;) {
    let query = supabase.from(table).select(selectColumns)
    for (const column of columns) query = query.order(column, { ascending: true })
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const rows = data || []
    merged.push(...rows)
    if (rows.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return merged
}
