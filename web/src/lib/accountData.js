import { supabase } from './supabase'

const PAGE = 1000
/** @param {object} [opts] - optional: { order: { column: string, ascending: boolean } } for reverse chronological etc. */
export async function fetchAll(table, select = '*', filter, opts) {
  const all = []
  let from = 0
  while (true) {
    const to = from + PAGE - 1
    let q = supabase.from(table).select(select).range(from, to)
    if (filter) q = filter(q)
    if (opts?.order) q = q.order(opts.order.column, { ascending: opts.order.ascending })
    const { data, error } = await q
    if (error) return { data: null, error }
    all.push(...(data || []))
    if (!data || data.length < PAGE) break
    from += PAGE
  }
  return { data: all, error: null }
}

/** Load characters and activity for an account (same logic as AccountDetail). Uses raid_attendance_dkp + raid_dkp_totals so we do not query per-tic data. */
export async function loadAccountActivity(accountId) {
  const accRes = await supabase.from('accounts').select('account_id, toon_names, display_name, toon_count').eq('account_id', accountId).single()
  if (accRes.error || !accRes.data) return { error: accRes.error?.message || 'Account not found', characters: [], activityByRaid: [] }

  const caRes = await supabase.from('character_account').select('char_id').eq('account_id', accountId)
  const charIds = (caRes.data || []).map((r) => r.char_id).filter(Boolean)
  if (charIds.length === 0) return { account: accRes.data, characters: [], activityByRaid: [] }

  const [chRes, attRes, lootRes, attDkpRes] = await Promise.all([
    supabase.from('characters').select('char_id, name, class_name, level').in('char_id', charIds),
    fetchAll('raid_attendance', 'raid_id, char_id, character_name', (q) => q.in('char_id', charIds)),
    fetchAll('raid_loot_with_assignment', 'raid_id, char_id, character_name, item_name, cost', (q) => q.in('char_id', charIds)),
    (async () => {
      const chars = (await supabase.from('characters').select('char_id, name').in('char_id', charIds)).data || []
      const characterKeys = [...new Set([...charIds, ...chars.map((c) => c.name).filter(Boolean)])]
      if (characterKeys.length === 0) return { data: [] }
      return fetchAll('raid_attendance_dkp', 'raid_id, character_key, dkp_earned', (q) => q.in('character_key', characterKeys), { order: { column: 'raid_id', ascending: true } })
    })(),
  ])
  const chars = (chRes.data || []).map((c) => ({ ...c, displayName: c.name || c.char_id }))
  const attDkp = (attDkpRes.error ? [] : (attDkpRes.data || []))

  const raidIds = new Set([
    ...(attRes.data || []).map((r) => r.raid_id),
    ...(lootRes.data || []).map((r) => r.raid_id),
    ...attDkp.map((r) => r.raid_id),
  ])
  if (raidIds.size === 0) return { account: accRes.data, characters: chars, activityByRaid: [] }

  const raidList = [...raidIds]
  const [rRes, totalsRes] = await Promise.all([
    supabase.from('raids').select('raid_id, raid_name, date_iso').in('raid_id', raidList),
    fetchAll('raid_dkp_totals', 'raid_id, total_dkp', (q) => q.in('raid_id', raidList), { order: { column: 'raid_id', ascending: true } }),
  ])
  if (totalsRes.error) return { error: totalsRes.error?.message || 'Failed to load raid totals', characters: [], activityByRaid: [] }

  const rMap = {}
  ;(rRes.data || []).forEach((row) => { rMap[row.raid_id] = row })
  const totalRaidDkp = {}
  ;(totalsRes.data || []).forEach((row) => { totalRaidDkp[row.raid_id] = parseFloat(row.total_dkp || 0) })
  const dkpByRaid = {}
  attDkp.forEach((row) => {
    if (!dkpByRaid[row.raid_id]) dkpByRaid[row.raid_id] = 0
    dkpByRaid[row.raid_id] += parseFloat(row.dkp_earned || 0)
  })
  const lootByRaid = {}
  ;(lootRes.data || []).forEach((row) => {
    if (!lootByRaid[row.raid_id]) lootByRaid[row.raid_id] = []
    lootByRaid[row.raid_id].push(row)
  })
  const activityByRaid = raidList.map((raidId) => ({
    raid_id: raidId,
    date: (rMap[raidId]?.date_iso || '').slice(0, 10),
    raid_name: rMap[raidId]?.raid_name || raidId,
    dkpEarned: dkpByRaid[raidId] ?? 0,
    dkpRaidTotal: totalRaidDkp[raidId] ?? 0,
    items: lootByRaid[raidId] || [],
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''))

  return { account: accRes.data, characters: chars, activityByRaid }
}
