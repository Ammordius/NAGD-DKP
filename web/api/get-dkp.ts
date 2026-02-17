/**
 * Vercel serverless proxy for DKP leaderboard data.
 * Fetches from Supabase with selective columns only (no select('*')) and returns
 * Cache-Control: public, s-maxage=300, stale-while-revalidate=600 so Vercel Edge
 * caches for 5 minutes and serves stale while revalidating for 10 minutes.
 *
 * Env (Vercel): SUPABASE_URL, SUPABASE_ANON_KEY (or reuse VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const PAGE_SIZE = 1000

async function fetchAll<T>(
  supabase: SupabaseClient,
  table: string,
  select: string
): Promise<{ data: T[]; error: Error | null }> {
  const all: T[] = []
  let from = 0
  while (true) {
    const to = from + PAGE_SIZE - 1
    const { data, error } = await supabase.from(table).select(select).range(from, to)
    if (error) return { data: [], error }
    const rows = (data ?? []) as T[]
    all.push(...rows)
    if (rows.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return { data: all, error: null }
}

export default {
  async fetch(_request: Request): Promise<Response> {
    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY

    if (!supabaseUrl || !supabaseAnonKey) {
      return new Response(
        JSON.stringify({ error: 'Missing SUPABASE_URL or SUPABASE_ANON_KEY' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey)

    // Only select columns needed for the main table / leaderboard (no select('*')).
    const [summary, adjustments, activeRaiders, periodTotals, charAccount, accounts, characters] =
      await Promise.all([
        fetchAll(supabase, 'dkp_summary', 'character_key, character_name, earned, spent, earned_30d, earned_60d, last_activity_date, updated_at'),
        supabase.from('dkp_adjustments').select('character_name, earned_delta, spent_delta').limit(1000),
        fetchAll(supabase, 'active_raiders', 'character_key'),
        supabase.from('dkp_period_totals').select('period, total_dkp'),
        fetchAll(supabase, 'character_account', 'char_id, account_id'),
        fetchAll(supabase, 'accounts', 'account_id, toon_names, display_name'),
        fetchAll(supabase, 'characters', 'char_id, name, class_name'),
      ])

    if (summary.error) {
      return new Response(
        JSON.stringify({ error: (summary.error as { message?: string })?.message ?? 'Failed to fetch dkp_summary' }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const payload = {
      dkp_summary: summary.data,
      dkp_adjustments: adjustments.data ?? [],
      active_raiders: activeRaiders.data ?? [],
      dkp_period_totals: periodTotals.data ?? [],
      character_account: charAccount.data ?? [],
      accounts: accounts.data ?? [],
      characters: characters.data ?? [],
    }

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      },
    })
  },
}
