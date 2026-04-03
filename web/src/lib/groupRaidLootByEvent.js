/**
 * Group raid_loot rows by raid_events for display: event_order, then Misc for unmatched event_id.
 * @param {Array<{ id?: number|string, event_id?: string|null }>} loot
 * @param {Array<{ event_id?: string|null, event_order?: number|string|null, event_name?: string|null }>} events
 * @returns {Array<{ key: string, title: string, rows: typeof loot }>}
 */
export function groupRaidLootByEvent(loot, events) {
  if (!loot?.length) return []

  const eventById = new Map()
  for (const e of events || []) {
    const id = String(e?.event_id ?? '').trim()
    if (id) eventById.set(id, e)
  }

  const buckets = new Map()
  const misc = []

  for (const row of loot) {
    const eid = String(row?.event_id ?? '').trim()
    if (eid && eventById.has(eid)) {
      if (!buckets.has(eid)) buckets.set(eid, [])
      buckets.get(eid).push(row)
    } else {
      misc.push(row)
    }
  }

  const sortRows = (rows) =>
    [...rows].sort((a, b) => {
      const na = Number(a?.id)
      const nb = Number(b?.id)
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
      return String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
    })

  const ordered = []
  const sortedEvents = [...(events || [])].sort((a, b) => {
    const oa = Number(a?.event_order)
    const ob = Number(b?.event_order)
    const fa = Number.isFinite(oa) ? oa : 0
    const fb = Number.isFinite(ob) ? ob : 0
    return fa - fb
  })

  for (const ev of sortedEvents) {
    const id = String(ev?.event_id ?? '').trim()
    const rows = buckets.get(id)
    if (rows?.length) {
      const name = (ev?.event_name ?? '').trim()
      ordered.push({
        key: id,
        title: name || `Event ${ev?.event_order ?? ''}`,
        rows: sortRows(rows),
      })
    }
  }

  if (misc.length) {
    ordered.push({
      key: '__misc__',
      title: 'Misc',
      rows: sortRows(misc),
    })
  }

  return ordered
}
