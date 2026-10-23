/**
 * Read one raid for the raid detail page. Viewing must not update raids or
 * delete attendance. Officer tic edits maintain the stored attendee count.
 */
export async function fetchRaidDetail(client, raidId) {
  const [r, e, l, a, ea] = await Promise.all([
    client.from('raids').select('raid_id, raid_name, date_iso, date, attendees').eq('raid_id', raidId).maybeSingle(),
    client.from('raid_events').select('id, raid_id, event_id, event_order, event_name, dkp_value, attendee_count, event_time').eq('raid_id', raidId).order('event_order'),
    client.from('raid_loot_with_assignment').select('id, raid_id, event_id, item_name, char_id, character_name, cost, assigned_char_id, assigned_character_name').eq('raid_id', raidId),
    client.from('raid_attendance').select('id, raid_id, char_id, character_name').eq('raid_id', raidId).order('character_name'),
    client.from('raid_event_attendance').select('event_id, char_id, character_name').eq('raid_id', raidId),
  ])
  if (r.error) throw new Error(r.error.message)
  return {
    raid: r.data,
    events: e.data || [],
    loot: l.data || [],
    attendance: a.data || [],
    eventAttendance: ea.data || [],
  }
}
