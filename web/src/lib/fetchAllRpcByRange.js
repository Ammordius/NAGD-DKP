const PAGE_SIZE = 1000

/**
 * Load every row from a PostgREST RPC that returns a set.
 * Each response is capped (~1000 rows). Callers must ensure the SQL function
 * uses a deterministic ORDER BY with a unique tie-breaker so pages do not
 * skip or duplicate rows.
 *
 * @param {{ rpc: Function }} client Supabase-like client
 * @param {string} fn RPC name
 * @param {Record<string, unknown>} [params]
 * @param {{ pageSize?: number, orderColumns?: Array<string | { column: string, ascending?: boolean }> }} [options]
 * @returns {Promise<unknown[]>}
 */
export async function fetchAllRpcByRange(client, fn, params = {}, options = {}) {
  const pageSize = Math.min(Math.max(1, options.pageSize || PAGE_SIZE), PAGE_SIZE)
  const orderColumns = options.orderColumns || []
  const merged = []
  let from = 0
  for (;;) {
    let query = client.rpc(fn, params)
    for (const spec of orderColumns) {
      if (typeof spec === 'string') {
        query = query.order(spec, { ascending: true })
      } else if (spec && spec.column) {
        query = query.order(spec.column, { ascending: spec.ascending !== false })
      }
    }
    const { data, error } = await query.range(from, from + pageSize - 1)
    if (error) throw error
    const rows = data || []
    merged.push(...rows)
    if (rows.length < pageSize) break
    from += pageSize
  }
  return merged
}

export { PAGE_SIZE as RPC_PAGE_SIZE }
