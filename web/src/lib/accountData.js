import { supabase } from './supabase'

const PAGE = 1000
export async function fetchAll(table, select = '*', filter) {
  const all = []
  let from = 0
  while (true) {
    const to = from + PAGE - 1
    let q = supabase.from(table).select(select).range(from, to)
    if (filter) q = filter(q)
    const { data, error } = await q
    if (error) return { data: null, error }
    all.push(...(data || []))
    if (!data || data.length < PAGE) break
    from += PAGE
  }
  return { data: all, error: null }
}

/** Load characters and activity for an account (same logic as AccountDetail). */
export async function loadAccountActivity(accountId) {
  const accRes = await supabase.from('accounts').select('account_id, toon_names, display_name, toon_count').eq('account_id', accountId).single()
  if (accRes.error || !accRes.data) return { error: accRes.error?.message || 'Account not found', characters: [], activityByRaid: [] }

  const caRes = await supabase.from('character_account').select('char_id').eq('account_id', accountId)
  const charIds = (caRes.data || []).map((r) => r.char_id).filter(Boolean)
  if (charIds.length === 0) return { account: accRes.data, characters: [], activityByRaid: [] }

  const [chRes, attRes, evAttByCharId, lootRes] = await Promise.all([
    supabase.from('characters').select('char_id, name, class_name, level').in('char_id', charIds),
    fetchAll('raid_attendance', 'raid_id, char_id, character_name', (q) => q.in('char_id', charIds)),
    fetchAll('raid_event_attendance', 'raid_id, event_id, char_id, character_name', (q) => q.in('char_id', charIds)),
    fetchAll('raid_loot', 'raid_id, char_id, character_name, item_name, cost', (q) => q.in('char_id', charIds)),
  ])
  const chars = (chRes.data || []).map((c) => ({ ...c, displayName: c.name || c.char_id }))
  const names = chars.map((c) => c.name).filter(Boolean)

  const byNameResults = names.length > 0
    ? await Promise.all(names.map((name) => fetchAll('raid_event_attendance', 'raid_id, event_id, char_id, character_name', (q) => q.eq('character_name', name))))
    : []
  const byNameRows = byNameResults.flatMap((r) => r.data || [])
  const seen = new Set()
  const evAttRes = { data: [] }
  for (const row of [...(evAttByCharId.data || []), ...byNameRows]) {
    const key = `${row.raid_id}|${row.event_id}|${row.char_id || row.character_name || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    evAttRes.data.push(row)
  }

  const raidIds = new Set([
    ...(attRes.data || []).map((r) => r.raid_id),
    ...(lootRes.data || []).map((r) => r.raid_id),
    ...(evAttRes.data || []).map((r) => r.raid_id),
  ])
  if (raidIds.size === 0) return { account: accRes.data, characters: chars, activityByRaid: [] }

  const raidList = [...raidIds]
  const [rRes, eRes] = await Promise.all([
    supabase.from('raids').select('raid_id, raid_name, date_iso').in('raid_id', raidList),
    supabase.from('raid_events').select('raid_id, event_id, dkp_value').in('raid_id', raidList),
  ])
  const rMap = {}
  ;(rRes.data || []).forEach((row) => { rMap[row.raid_id] = row })
  const eventDkp = {}
  const totalRaidDkp = {}
  ;(eRes.data || []).forEach((ev) => {
    const v = parseFloat(ev.dkp_value || 0)
    eventDkp[`${ev.raid_id}|${ev.event_id}`] = v
    if (!totalRaidDkp[ev.raid_id]) totalRaidDkp[ev.raid_id] = 0
    totalRaidDkp[ev.raid_id] += v
  })
  const totalByRaid = {}
  ;(eRes.data || []).forEach((ev) => {
    if (!totalByRaid[ev.raid_id]) totalByRaid[ev.raid_id] = 0
    totalByRaid[ev.raid_id] += parseFloat(ev.dkp_value || 0)
  })
  const dkpByRaid = {}
  if (evAttRes.data?.length > 0) {
    evAttRes.data.forEach((a) => {
      const k = `${a.raid_id}|${a.event_id}`
      if (!dkpByRaid[a.raid_id]) dkpByRaid[a.raid_id] = 0
      dkpByRaid[a.raid_id] += eventDkp[k] || 0
    })
    const attRaidIds = new Set((attRes.data || []).map((r) => r.raid_id))
    raidList.forEach((raidId) => {
      if ((dkpByRaid[raidId] ?? 0) === 0 && attRaidIds.has(raidId)) {
        dkpByRaid[raidId] = totalByRaid[raidId] ?? 0
      }
    })
  } else {
    ;(attRes.data || []).forEach((a) => {
      if (!dkpByRaid[a.raid_id]) dkpByRaid[a.raid_id] = 0
      dkpByRaid[a.raid_id] += totalByRaid[a.raid_id] || 0
    })
  }
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
