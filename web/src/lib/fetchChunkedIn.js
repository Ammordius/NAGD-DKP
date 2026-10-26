/** PostgREST returns at most this many rows per response unless the caller pages. */
export const CHUNKED_PAGE_SIZE = 1000
/** Keep each `.in()` list short enough for the request URL. */
export const CHUNKED_IN_SIZE = 150

/**
 * Load every row matching `column IN values`.
 * One unordered `.in()` stops at CHUNKED_PAGE_SIZE, which drops later attendance
 * tics and makes a full attendee look absent from every newer raid.
 * @param {{ from: (table: string) => any }} client
 */
export async function fetchChunkedIn(client, table, select, column, values, orderColumn) {
  if (!values?.length) return { data: [], error: null }
  if (!orderColumn) return { data: null, error: new Error(`fetchChunkedIn(${table}) needs an order column`) }
  const all = []
  for (let i = 0; i < values.length; i += CHUNKED_IN_SIZE) {
    const chunk = values.slice(i, i + CHUNKED_IN_SIZE)
    let from = 0
    for (;;) {
      const { data, error } = await client
        .from(table)
        .select(select)
        .in(column, chunk)
        .order(orderColumn, { ascending: true })
        .range(from, from + CHUNKED_PAGE_SIZE - 1)
      if (error) return { data: null, error }
      const rows = data || []
      all.push(...rows)
      if (rows.length < CHUNKED_PAGE_SIZE) break
      from += CHUNKED_PAGE_SIZE
    }
  }
  return { data: all, error: null }
}
