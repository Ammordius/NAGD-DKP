/** Base path for per-item CI shards (see scripts/build_bid_forecast_by_item.mjs). */
export const BID_FORECAST_SHARD_BASE = '/bid_forecast_items/'

/**
 * Fetch upgrade precompute for one item id (small JSON vs monolithic index).
 * @param {string} itemId
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<
 *   | { ok: true; payload: { version?: number; generated_at?: string; activity_days?: number; byItem: Record<string, object[]> } }
 *   | { ok: false; absent?: boolean; status?: number; badShape?: boolean; badId?: boolean }
 * >}
 */
export async function fetchBidForecastPrecomputeShard(itemId, opts = {}) {
  const id = String(itemId ?? '').trim()
  if (!id) return { ok: false, badId: true }
  const url = `${BID_FORECAST_SHARD_BASE}${encodeURIComponent(id)}.json`
  const r = await fetch(url, { signal: opts.signal })
  if (r.status === 404) return { ok: false, absent: true }
  if (!r.ok) return { ok: false, status: r.status }
  const j = await r.json()
  const entries = j.entries
  if (!Array.isArray(entries)) return { ok: false, badShape: true }
  return {
    ok: true,
    payload: {
      version: j.version,
      generated_at: j.generated_at,
      activity_days: j.activity_days,
      byItem: { [id]: entries },
    },
  }
}
