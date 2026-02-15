import { useEffect, useState, useCallback, useMemo, useRef, Fragment } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// --- Parsing ---

/** Parse Discord-style raid string e.g. "Thursday 02/12 9pm est: Water Minis + Cursed/Emp - February 12, 2026 8:00 PM" */
function parseRaidString(str) {
  const s = (str || '').trim()
  let raidName = ''
  let dateIso = ''
  // Try to get "February 12, 2026 8:00 PM" or similar at the end (after " - ")
  const dashMatch = s.match(/\s+-\s+([^-]+)$/)
  if (dashMatch) {
    const datePart = dashMatch[1].trim()
    raidName = s.replace(/\s+-\s+[^-]+$/, '').replace(/^[^:]+:\s*/, '').trim()
    const d = new Date(datePart)
    if (!isNaN(d.getTime())) {
      dateIso = d.toISOString().slice(0, 19).replace('T', ' ')
    }
  }
  if (!raidName && s) {
    const colonIdx = s.indexOf(':')
    if (colonIdx > 0) raidName = s.slice(colonIdx + 1).trim()
    else raidName = s
  }
  return { raidName, dateIso }
}

/** Parse channel member list lines; returns { eventTime, names[] } (names deduped, trimmed). */
function parseChannelList(paste) {
  const lines = (paste || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  let eventTime = ''
  const nameSet = new Set()
  for (const line of lines) {
    const tsMatch = line.match(/^\[([^\]]+)\]/)
    if (tsMatch) {
      const ts = tsMatch[1].trim()
      if (!eventTime) eventTime = ts
      // Skip "Channel X(N) members:"
      if (/members:\s*$/i.test(line)) continue
      const rest = line.replace(/^\[[^\]]+\]\s*/, '').trim()
      rest.split(',').forEach((n) => {
        const name = n.trim()
        if (name && !/^\d+$/.test(name)) nameSet.add(name)
      })
    }
  }
  return { eventTime, names: [...nameSet] }
}

/** Parse loot log lines. Supports:
 * - "Item grats Name, 4 DKP" or "Item congrats Name 7 dkp"
 * - "Item no bids - Name w/ 764/777 grats" (0 DKP)
 * - "Item grats Name, 545/666" or "Item congrats Name top roll" (0 DKP)
 */
function parseLootLog(paste) {
  const lines = (paste || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const results = []
  for (const line of lines) {
    const quoted = line.match(/'([^']+)'/)?.[1] || line
    let itemName = ''
    let characterName = ''
    let cost = 0

    // Explicit DKP: "... grats/congrats Name ... N DKP" (name is text before the number that precedes "dkp")
    const explicitDkp = quoted.match(/\b(?:grats|congrats)\s+(.+?)\s+(\d+)\s*dkp/i)
    if (explicitDkp) {
      characterName = explicitDkp[1].trim().replace(/,\s*$/, '')
      cost = parseInt(explicitDkp[2], 10)
      itemName = quoted.replace(/\s*(?:grats|congrats)\s+[\s\S]+$/i, '').trim()
    } else {
      // "Item no bids - Name w/ 764/777 grats" (0 DKP)
      const noBids = quoted.match(/^(.+?)\s+no bids\s*-\s*(\S+)\s+w\/\s*\d+\/\d+\s*grats\s*$/i)
      if (noBids) {
        itemName = noBids[1].trim()
        characterName = noBids[2].trim()
      } else {
        // "Item grats/congrats Name, 545/666" or "Item grats Name 750/777" or "Item congrats Name top roll" (0 DKP)
        const zeroDkp = quoted.match(/\b(?:grats|congrats)\s+(\S+(?:\s+\S+)?)\s*(?:,\s*\d+\/\d+|\s+\d+\/\d+|\s+top\s+roll)/i)
        if (zeroDkp) {
          characterName = zeroDkp[1].trim()
          itemName = quoted.replace(/\s*(?:grats|congrats)\s+[\s\S]+$/i, '').trim()
          // e.g. "Blood Veil of the Shissar no bids" -> "Blood Veil of the Shissar"
          itemName = itemName.replace(/\s*,?\s*no bids\s*$/i, '').trim()
        }
      }
    }
    if (itemName && characterName) results.push({ itemName, characterName, cost: isNaN(cost) ? 0 : cost })
  }
  return results
}

/** Generate a unique raid_id for officer-created raids (string, no collision with numeric imports). */
function generateRaidId() {
  return `manual-${Date.now()}`
}

/** Generate event_id for a tic (use timestamp from log or now). */
function generateEventId(eventTimeStr) {
  if (eventTimeStr) {
    const d = new Date(eventTimeStr)
    if (!isNaN(d.getTime())) return `tic-${d.getTime()}`
  }
  return `tic-${Date.now()}`
}

export default function Officer({ isOfficer }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [raids, setRaids] = useState([])
  const [selectedRaidId, setSelectedRaidId] = useState('')
  const [raid, setRaid] = useState(null)
  const [events, setEvents] = useState([])
  const [loot, setLoot] = useState([])
  const [eventAttendance, setEventAttendance] = useState([])
  const [characters, setCharacters] = useState([])
  const [charIdToAccountId, setCharIdToAccountId] = useState({})
  const [itemNames, setItemNames] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mutating, setMutating] = useState(false)

  // Add raid
  const [raidPaste, setRaidPaste] = useState('')
  const [addRaidResult, setAddRaidResult] = useState(null)

  // Add tic
  const [ticPaste, setTicPaste] = useState('')
  const [ticDkpValue, setTicDkpValue] = useState('1')
  const [ticResult, setTicResult] = useState(null)

  // Add loot manual
  const [lootItemQuery, setLootItemQuery] = useState('')
  const [lootCharName, setLootCharName] = useState('')
  const [lootCost, setLootCost] = useState('0')
  const [lootLogPaste, setLootLogPaste] = useState('')
  const [lootResult, setLootResult] = useState(null)

  // Delete
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleteError, setDeleteError] = useState('')

  // Inline edit (raid view)
  const [attendance, setAttendance] = useState([])
  const [editingEventId, setEditingEventId] = useState(null)
  const [editingEventDkp, setEditingEventDkp] = useState('')
  const [editingLootId, setEditingLootId] = useState(null)
  const [editingLootCost, setEditingLootCost] = useState('')
  const [expandedEvents, setExpandedEvents] = useState({})
  const [showLootDropdown, setShowLootDropdown] = useState(false)

  // Add single attendee to a tic
  const [addToTicEventId, setAddToTicEventId] = useState('')
  const [addToTicCharQuery, setAddToTicCharQuery] = useState('')
  const [showCharDropdown, setShowCharDropdown] = useState(false)
  const [addToTicResult, setAddToTicResult] = useState(null)

  const nameToChar = useMemo(() => {
    const m = {}
    characters.forEach((c) => {
      const n = (c.name || '').trim()
      if (n) m[n.toLowerCase()] = { char_id: c.char_id, name: n }
    })
    return m
  }, [characters])

  const loadRaids = useCallback(async () => {
    const { data } = await supabase
      .from('raids')
      .select('raid_id, raid_name, date_iso, date')
      .order('date_iso', { ascending: false, nullsFirst: false })
      .limit(150)
    setRaids(data || [])
  }, [])

  const loadOfficerData = useCallback(async () => {
    setLoading(true)
    setError('')
    await loadRaids()
    const charsRes = await supabase.from('characters').select('char_id, name').limit(5000)
    if (charsRes.data) setCharacters(charsRes.data)
    const caRes = await supabase.from('character_account').select('char_id, account_id').limit(10000)
    const map = {}
    ;(caRes.data || []).forEach((r) => {
      if (r.char_id && r.account_id && map[r.char_id] == null) map[r.char_id] = r.account_id
    })
    setCharIdToAccountId(map)
    // Fetch all distinct item_name from raid_loot (paginate; Supabase returns max 1000 per request)
    const allItemRows = []
    let from = 0
    const pageSize = 1000
    while (true) {
      const { data } = await supabase.from('raid_loot').select('item_name').range(from, from + pageSize - 1)
      if (!data?.length) break
      allItemRows.push(...data)
      if (data.length < pageSize) break
      from += pageSize
    }
    const names = [...new Set(allItemRows.map((r) => r.item_name).filter(Boolean))].sort()
    setItemNames(names)
    setLoading(false)
  }, [loadRaids])

  useEffect(() => {
    if (!isOfficer) {
      navigate('/')
      return
    }
    loadOfficerData()
  }, [isOfficer, navigate, loadOfficerData])

  // When linked from Raids "+" with #add-raid, scroll to add-raid section
  useEffect(() => {
    if (location.hash !== '#add-raid') return
    const t = setTimeout(() => {
      if (addRaidSectionRef.current) focusAddRaid()
    }, 100)
    return () => clearTimeout(t)
  }, [location.hash])

  const loadSelectedRaid = useCallback(async () => {
    if (!selectedRaidId) {
      setRaid(null)
      setEvents([])
      setLoot([])
      setEventAttendance([])
      setAttendance([])
      return
    }
    const [r, e, l, a, ea] = await Promise.all([
      supabase.from('raids').select('*').eq('raid_id', selectedRaidId).single(),
      supabase.from('raid_events').select('*').eq('raid_id', selectedRaidId).order('event_order'),
      supabase.from('raid_loot').select('*').eq('raid_id', selectedRaidId),
      supabase.from('raid_attendance').select('*').eq('raid_id', selectedRaidId).order('character_name'),
      supabase.from('raid_event_attendance').select('event_id, char_id, character_name').eq('raid_id', selectedRaidId),
    ])
    setRaid(r.data || null)
    setEvents(e.data || [])
    setLoot(l.data || [])
    setAttendance(a.data || [])
    setEventAttendance(ea.data || [])
  }, [selectedRaidId])

  useEffect(() => {
    loadSelectedRaid()
  }, [loadSelectedRaid])

  // After adding a tic, scroll to raid view so the new tic is visible
  useEffect(() => {
    if (ticResult?.event_id && raidEditSectionRef.current) {
      raidEditSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [ticResult?.event_id])

  // Keep addToTicEventId in sync with events (default to first tic)
  useEffect(() => {
    if (events.length > 0 && (!addToTicEventId || !events.some((e) => e.event_id === addToTicEventId))) {
      setAddToTicEventId(events[0].event_id)
    }
  }, [events, addToTicEventId])

  const handleAddAttendeeToTic = async () => {
    if (!selectedRaidId || !addToTicEventId) return
    const name = addToTicCharQuery.trim()
    const char = nameToChar[name.toLowerCase()]
    if (!char) {
      setError('Select a character from the list (name must match DKP list).')
      return
    }
    const alreadyInTic = eventAttendance.some((r) => String(r.event_id) === String(addToTicEventId) && String(r.char_id) === String(char.char_id))
    if (alreadyInTic) {
      setError(`${char.name} is already in this tic.`)
      return
    }
    setMutating(true)
    setAddToTicResult(null)
    setError('')
    const { error: attErr } = await supabase.from('raid_event_attendance').insert({
      raid_id: selectedRaidId,
      event_id: addToTicEventId,
      char_id: char.char_id,
      character_name: char.name,
    })
    if (attErr) {
      setError(attErr.message)
      setMutating(false)
      return
    }
    const { data: existingRaidAtt } = await supabase.from('raid_attendance').select('char_id').eq('raid_id', selectedRaidId)
    const existingCharIds = new Set((existingRaidAtt || []).map((r) => String(r.char_id)))
    if (!existingCharIds.has(String(char.char_id))) {
      await supabase.from('raid_attendance').insert({
        raid_id: selectedRaidId,
        char_id: char.char_id,
        character_name: char.name,
      })
    }
    setAddToTicResult(char.name)
    setAddToTicCharQuery('')
    await supabase.rpc('refresh_dkp_summary')
    try { sessionStorage.removeItem('dkp_leaderboard_v2') } catch (_) {}
    loadSelectedRaid()
    setMutating(false)
  }

  const handleAddRaid = async () => {
    setMutating(true)
    setAddRaidResult(null)
    setError('')
    const { raidName, dateIso } = parseRaidString(raidPaste)
    if (!raidName.trim()) {
      setError('Could not parse a raid name. Use format like: "Thursday 02/12 9pm est: Water Minis + Cursed/Emp - February 12, 2026 8:00 PM"')
      setMutating(false)
      return
    }
    const raid_id = generateRaidId()
    const { error: err } = await supabase.from('raids').insert({
      raid_id,
      raid_pool: '',
      raid_name: raidName.trim(),
      date: dateIso || new Date().toISOString().slice(0, 10),
      date_iso: dateIso || new Date().toISOString().slice(0, 10),
      attendees: null,
      url: '',
    })
    if (err) {
      setError(err.message)
      setMutating(false)
      return
    }
    setAddRaidResult({ raid_id, raid_name: raidName.trim() })
    setRaidPaste('')
    await loadRaids()
    setSelectedRaidId(raid_id)
    setMutating(false)
  }

  const handleAddTic = async () => {
    if (!selectedRaidId) {
      setError('Select a raid first.')
      return
    }
    setMutating(true)
    setTicResult(null)
    setError('')
    const { eventTime, names } = parseChannelList(ticPaste)
    if (names.length === 0) {
      setError('No names found in the pasted list. Paste lines like "[Sun Apr 14 10:17:09 2024] Meldrath, Fridge, Geom, ..."')
      setMutating(false)
      return
    }
    const dkpValue = parseFloat(ticDkpValue) || 1
    const event_id = generateEventId(eventTime)
    const maxOrder = Math.max(0, ...events.map((e) => e.event_order || 0))
    const { error: evErr } = await supabase.from('raid_events').insert({
      raid_id: selectedRaidId,
      event_id,
      event_order: maxOrder + 1,
      event_name: 'DKP tic',
      dkp_value: String(dkpValue),
      attendee_count: String(names.length),
      event_time: eventTime || null,
    })
    if (evErr) {
      setError(evErr.message)
      setMutating(false)
      return
    }
    const matched = []
    const unmatched = []
    const duplicates = []
    const sameAccount = []
    const seenCharId = new Set()
    const seenAccountKey = new Set()
    for (const n of names) {
      const key = n.toLowerCase().trim()
      const char = nameToChar[key]
      if (!char) {
        unmatched.push(n)
        continue
      }
      if (seenCharId.has(char.char_id)) {
        duplicates.push(n)
        continue
      }
      const accountId = charIdToAccountId[char.char_id] || null
      const accountKey = accountId != null ? String(accountId) : char.char_id
      if (seenAccountKey.has(accountKey)) {
        sameAccount.push(n)
        continue
      }
      seenCharId.add(char.char_id)
      seenAccountKey.add(accountKey)
      matched.push({ char_id: char.char_id, character_name: char.name })
    }
    if (matched.length > 0) {
      const { error: attErr } = await supabase.from('raid_event_attendance').insert(
        matched.map((m) => ({
          raid_id: selectedRaidId,
          event_id,
          char_id: m.char_id,
          character_name: m.character_name,
        }))
      )
      if (attErr) {
        setError(attErr.message)
        setMutating(false)
        return
      }
      const { data: existingRaidAtt } = await supabase.from('raid_attendance').select('char_id').eq('raid_id', selectedRaidId)
      const existingCharIds = new Set((existingRaidAtt || []).map((r) => String(r.char_id)))
      const toInsert = matched.filter((m) => !existingCharIds.has(String(m.char_id)))
      if (toInsert.length > 0) {
        const { error: raidAttErr } = await supabase.from('raid_attendance').insert(
          toInsert.map((m) => ({
            raid_id: selectedRaidId,
            char_id: m.char_id,
            character_name: m.character_name,
          }))
        )
        if (raidAttErr) setError(raidAttErr.message)
      }
    }

    // Delta vs other tics in this raid: who was in a previous tic but missing from this one?
    const currentTicCharIds = new Set(matched.map((m) => String(m.char_id)))
    const seenPrev = new Set()
    const missingFromThisTic = []
    eventAttendance.forEach((row) => {
      const cid = String(row.char_id ?? '').trim()
      if (!cid || seenPrev.has(cid)) return
      if (currentTicCharIds.has(cid)) return
      seenPrev.add(cid)
      missingFromThisTic.push(row.character_name || row.char_id || cid)
    })
    missingFromThisTic.sort((a, b) => String(a).localeCompare(b))

    setTicResult({
      matched: matched.length,
      unmatched: unmatched.length > 0 ? unmatched : null,
      duplicates: duplicates.length > 0 ? duplicates : null,
      sameAccount: sameAccount.length > 0 ? sameAccount : null,
      event_id,
      missingFromThisTic: missingFromThisTic.length > 0 ? missingFromThisTic : null,
      newThisTic: events.length === 0 ? matched.map((m) => m.character_name) : matched.filter((m) => !eventAttendance.some((r) => String(r.char_id) === String(m.char_id))).map((m) => m.character_name),
    })
    setTicPaste('')
    await supabase.rpc('refresh_dkp_summary')
    try { sessionStorage.removeItem('dkp_leaderboard_v2') } catch (_) {}
    loadSelectedRaid()
    setMutating(false)
  }

  const handleAddLootManual = async () => {
    if (!selectedRaidId) {
      setError('Select a raid first.')
      return
    }
    const itemName = lootItemQuery.trim()
    const characterName = lootCharName.trim()
    const cost = parseInt(lootCost, 10)
    if (!itemName) {
      setError('Enter an item name.')
      return
    }
    const char = nameToChar[characterName.toLowerCase()]
    if (!char) {
      setError('Character not on DKP list. Pick a character from the list so the loot can be linked.')
      return
    }
    setMutating(true)
    setLootResult(null)
    setError('')
    const event_id = events.length > 0 ? events[0].event_id : 'loot'
    const { error: err } = await supabase.from('raid_loot').insert({
      raid_id: selectedRaidId,
      event_id,
      item_name: itemName,
      char_id: char.char_id,
      character_name: char.name,
      cost: String(isNaN(cost) ? 0 : cost),
    })
    if (err) {
      setError(err.message)
      setMutating(false)
      return
    }
    setLootResult({ itemName, characterName: char.name, cost: isNaN(cost) ? 0 : cost })
    setLootItemQuery('')
    setLootCharName('')
    setLootCost('0')
    setItemNames((prev) => (prev.includes(itemName) ? prev : [...prev, itemName].sort()))
    loadSelectedRaid()
    setMutating(false)
  }

  const handleAddLootFromLog = async () => {
    if (!selectedRaidId) {
      setError('Select a raid first.')
      return
    }
    const parsed = parseLootLog(lootLogPaste)
    if (parsed.length === 0) {
      setError('No loot lines parsed. Use format like: ... \'Earring of Eradication grats Barndog, 4 DKP!!!\'')
      return
    }
    setMutating(true)
    setLootResult(null)
    setError('')
    const event_id = events.length > 0 ? events[0].event_id : 'loot'
    const itemNamesList = itemNames || []
    const knownItemSet = new Set(itemNamesList.map((n) => (n || '').trim().toLowerCase()))
    const itemNameByLower = {}
    itemNamesList.forEach((n) => { if (n) itemNameByLower[n.trim().toLowerCase()] = n })
    const playerNotFound = []
    const itemNotFound = []
    let inserted = 0
    for (const row of parsed) {
      const char = nameToChar[row.characterName.toLowerCase()]
      if (!char) {
        playerNotFound.push({ itemName: row.itemName, characterName: row.characterName })
        continue
      }
      const itemKey = row.itemName.trim().toLowerCase()
      if (!knownItemSet.has(itemKey)) {
        itemNotFound.push({ itemName: row.itemName, characterName: char.name })
        continue
      }
      const canonicalItemName = itemNameByLower[itemKey] || row.itemName
      const { error: err } = await supabase.from('raid_loot').insert({
        raid_id: selectedRaidId,
        event_id,
        item_name: canonicalItemName,
        char_id: char.char_id,
        character_name: char.name,
        cost: String(row.cost),
      })
      if (!err) inserted++
    }
    const parts = []
    if (playerNotFound.length > 0) {
      parts.push(`Player not on DKP list (${playerNotFound.length}): ${playerNotFound.map((r) => `${r.characterName} (${r.itemName})`).join('; ')}. Add the character to the DKP list first or fix the name in the log.`)
    }
    if (itemNotFound.length > 0) {
      parts.push(`Item not found (${itemNotFound.length}): ${itemNotFound.map((r) => `"${r.itemName}" → ${r.characterName}`).join('; ')}. Add the item manually above (type the exact item name, pick the character, set cost), then retry from log if needed.`)
    }
    if (parts.length > 0) setError(parts.join(' '))
    setLootResult({ fromLog: true, inserted, total: parsed.length })
    if (playerNotFound.length === 0 && itemNotFound.length === 0) setLootLogPaste('')
    loadSelectedRaid()
    setMutating(false)
  }

  const handleDeleteRaid = async () => {
    if (deleteConfirm !== 'DELETE') {
      setDeleteError('Type DELETE to confirm.')
      return
    }
    if (!selectedRaidId) {
      setDeleteError('Select a raid first.')
      return
    }
    setMutating(true)
    setDeleteError('')
    const { error: err } = await supabase.rpc('delete_raid', { p_raid_id: selectedRaidId })
    if (err) {
      setDeleteError(err.message)
      setMutating(false)
      return
    }
    setSelectedRaidId('')
    setDeleteConfirm('')
    await loadRaids()
    loadSelectedRaid()
    setMutating(false)
  }

  const handleSaveEventDkp = async (eventId) => {
    const val = String(editingEventDkp).trim()
    if (val === '' || !selectedRaidId) return
    setMutating(true)
    const { error: err } = await supabase.from('raid_events').update({ dkp_value: val }).eq('raid_id', selectedRaidId).eq('event_id', eventId)
    setMutating(false)
    if (err) setError(err.message)
    else {
      setEditingEventId(null)
      loadSelectedRaid()
    }
  }

  const handleSaveLootCost = async (row) => {
    const val = String(editingLootCost).trim()
    setMutating(true)
    const { error: err } = await supabase.from('raid_loot').update({ cost: val }).eq('id', row.id)
    setMutating(false)
    if (err) setError(err.message)
    else {
      setEditingLootId(null)
      loadSelectedRaid()
    }
  }

  const handleDeleteLoot = async (row) => {
    const msg = `Are you sure you want to remove this loot?\n\n"${row.item_name || 'Item'}" from ${row.character_name || 'character'}\n\nThis cannot be undone.`
    if (!window.confirm(msg)) return
    setMutating(true)
    const { error: err } = await supabase.from('raid_loot').delete().eq('id', row.id)
    setMutating(false)
    if (err) setError(err.message)
    else loadSelectedRaid()
  }

  const handleDeleteEvent = async (eventId) => {
    if (!window.confirm('Are you sure you want to remove this DKP tic and all its attendance?\n\nThis cannot be undone.')) return
    setMutating(true)
    await supabase.from('raid_event_attendance').delete().eq('raid_id', selectedRaidId).eq('event_id', eventId)
    const { error: err } = await supabase.from('raid_events').delete().eq('raid_id', selectedRaidId).eq('event_id', eventId)
    setMutating(false)
    if (err) setError(err.message)
    else loadSelectedRaid()
  }

  const attendeesByEvent = useMemo(() => {
    const byEvent = {}
    eventAttendance.forEach((row) => {
      const eid = String(row.event_id ?? '').trim()
      if (!eid) return
      if (!byEvent[eid]) byEvent[eid] = []
      byEvent[eid].push({ name: row.character_name || row.char_id || '—', char_id: row.char_id })
    })
    Object.keys(byEvent).forEach((id) => byEvent[id].sort((a, b) => (a.name || '').localeCompare(b.name || '')))
    return byEvent
  }, [eventAttendance])

  const filteredItemNames = useMemo(() => {
    const q = lootItemQuery.toLowerCase().trim()
    if (!q) return itemNames
    return itemNames.filter((n) => n.toLowerCase().includes(q))
  }, [itemNames, lootItemQuery])

  const characterNamesList = useMemo(() => characters.map((c) => (c.name || '').trim()).filter(Boolean).sort((a, b) => a.localeCompare(b)), [characters])
  const filteredCharacterNames = useMemo(() => {
    const q = addToTicCharQuery.toLowerCase().trim()
    if (!q) return characterNamesList.slice(0, 200)
    return characterNamesList.filter((n) => n.toLowerCase().includes(q)).slice(0, 200)
  }, [characterNamesList, addToTicCharQuery])

  const addRaidSectionRef = useRef(null)
  const raidPasteRef = useRef(null)
  const raidEditSectionRef = useRef(null)
  const focusAddRaid = () => {
    addRaidSectionRef.current?.scrollIntoView({ behavior: 'smooth' })
    setTimeout(() => raidPasteRef.current?.focus(), 300)
  }

  if (!isOfficer) return null

  return (
    <div className="container">
      <h1>Officer – Raid management</h1>
      <p style={{ color: '#a1a1aa' }}>
        Add raids from Discord, paste DKP tics (channel lists), add loot manually or from logs. All edits require officer permissions.
      </p>
      <div style={{ marginBottom: '1rem' }}>
        <button type="button" className="btn" onClick={focusAddRaid} style={{ fontWeight: 'bold' }}>
          + New raid
        </button>
      </div>
      {error && <p className="error" style={{ marginBottom: '1rem' }}>{error}</p>}

      {/* Add raid */}
      <section ref={addRaidSectionRef} className="card" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ marginTop: 0 }}>Add raid</h2>
        <p style={{ color: '#71717a', fontSize: '0.9rem' }}>
          Paste a line from Discord, e.g. <code>Thursday 02/12 9pm est: Water Minis + Cursed/Emp - February 12, 2026 8:00 PM</code>
        </p>
        <textarea
          ref={raidPasteRef}
          value={raidPaste}
          onChange={(e) => setRaidPaste(e.target.value)}
          placeholder="Thursday 02/12 9pm est: Water Minis + Cursed/Emp - February 12, 2026 8:00 PM"
          rows={2}
          style={{ width: '100%', maxWidth: '600px', padding: '0.5rem', marginBottom: '0.5rem' }}
        />
        <div>
          <button type="button" className="btn" onClick={handleAddRaid} disabled={mutating || !raidPaste.trim()}>
            {mutating ? 'Creating…' : 'Create raid'}
          </button>
        </div>
        {addRaidResult && (
          <p style={{ color: '#22c55e', marginTop: '0.5rem' }}>
            Created <Link to={`/raids/${addRaidResult.raid_id}`}>{addRaidResult.raid_name}</Link>. You can add tics and loot below.
          </p>
        )}
      </section>

      {/* Raid selector */}
      <section className="card" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ marginTop: 0 }}>Select raid to edit</h2>
        <p style={{ color: '#71717a', fontSize: '0.9rem' }}>Recent raids (select to add tics, loot, or delete).</p>
        <select
          value={selectedRaidId}
          onChange={(e) => setSelectedRaidId(e.target.value)}
          style={{ padding: '0.35rem 0.5rem', minWidth: '320px' }}
        >
          <option value="">— Select raid —</option>
          {raids.map((r) => (
            <option key={r.raid_id} value={r.raid_id}>
              {r.date_iso || r.date || '—'} · {r.raid_name || r.raid_id}
            </option>
          ))}
        </select>
        {selectedRaidId && (
          <span style={{ marginLeft: '0.5rem' }}>
            <Link to={`/raids/${selectedRaidId}`}>View full raid</Link>
          </span>
        )}
      </section>

      {selectedRaidId && raid && (
        <>
          {/* Add DKP tic */}
          <section className="card" style={{ marginBottom: '1.5rem' }}>
            <h2 style={{ marginTop: 0 }}>Add DKP tic (attendance)</h2>
            <p style={{ color: '#71717a', fontSize: '0.9rem' }}>
              Paste channel member list. Names are matched to the DKP list; unmatched names are reported. No double counting.
            </p>
            <textarea
              value={ticPaste}
              onChange={(e) => setTicPaste(e.target.value)}
              placeholder="[Sun Apr 14 10:17:09 2024] Channel Nag(30) members:&#10;[Sun Apr 14 10:17:09 2024] Meldrath, Fridge, Geom, ..."
              rows={6}
              style={{ width: '100%', maxWidth: '600px', padding: '0.5rem', marginBottom: '0.5rem', fontFamily: 'monospace' }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <label>DKP per attendee:</label>
              <input
                type="number"
                min={0}
                step={0.5}
                value={ticDkpValue}
                onChange={(e) => setTicDkpValue(e.target.value)}
                style={{ width: '4rem', padding: '0.25rem' }}
              />
              <button type="button" onClick={handleAddTic} disabled={mutating || !ticPaste.trim()}>
                {mutating ? 'Adding…' : 'Add tic'}
              </button>
            </div>
            {ticResult && (
              <div style={{ marginTop: '0.5rem', padding: '0.75rem', backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: '4px' }}>
                <p style={{ color: '#22c55e', marginTop: 0 }}>Tic added. Credited <strong>{ticResult.matched}</strong> attendee(s). See raid view below.</p>
                {ticResult.unmatched?.length > 0 && (
                  <p style={{ color: '#f59e0b', marginBottom: '0.25rem' }}><strong>Unmatched</strong> (not on DKP list, no credit): {ticResult.unmatched.join(', ')}</p>
                )}
                {ticResult.duplicates?.length > 0 && (
                  <p style={{ color: '#a78bfa', marginBottom: '0.25rem' }}><strong>Duplicates</strong> (in paste again, not double-counted): {ticResult.duplicates.join(', ')}</p>
                )}
                {ticResult.sameAccount?.length > 0 && (
                  <p style={{ color: '#a78bfa', marginBottom: '0.25rem' }}><strong>Same account</strong> (other toon already credited this tic): {ticResult.sameAccount.join(', ')}</p>
                )}
                {ticResult.missingFromThisTic?.length > 0 && (
                  <p style={{ color: '#f97316', marginBottom: '0.25rem' }}><strong>Missing from this tic</strong> (were in earlier tics this raid): {ticResult.missingFromThisTic.join(', ')}</p>
                )}
                {ticResult.newThisTic?.length > 0 && (
                  <p style={{ color: '#71717a', fontSize: '0.9rem', marginBottom: 0 }}><strong>New this tic</strong> (first time this raid): {ticResult.newThisTic.join(', ')}</p>
                )}
              </div>
            )}
          </section>

          {/* Add single attendee to a tic */}
          {events.length > 0 && (
            <section className="card" style={{ marginBottom: '1.5rem' }}>
              <h2 style={{ marginTop: 0 }}>Add attendee to tic</h2>
              <p style={{ color: '#71717a', fontSize: '0.9rem' }}>Pick a tic and a character to add them to that tic (e.g. someone missed the paste).</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'flex-start' }}>
                <select
                  value={addToTicEventId}
                  onChange={(e) => { setAddToTicEventId(e.target.value); setAddToTicResult(null) }}
                  style={{ padding: '0.5rem 0.6rem', fontSize: '1rem', minWidth: '200px' }}
                >
                  {events.map((e) => (
                    <option key={e.event_id} value={e.event_id}>
                      #{e.event_order} {e.event_name} ({e.dkp_value} DKP)
                    </option>
                  ))}
                </select>
                <div style={{ position: 'relative', minWidth: '200px' }}>
                  <input
                    type="text"
                    value={addToTicCharQuery}
                    onChange={(e) => { setAddToTicCharQuery(e.target.value); setAddToTicResult(null) }}
                    onFocus={() => setShowCharDropdown(true)}
                    onBlur={() => setTimeout(() => setShowCharDropdown(false), 150)}
                    placeholder="Character name (type to filter)"
                    style={{ padding: '0.5rem 0.6rem', fontSize: '1rem', width: '100%', minWidth: '180px', boxSizing: 'border-box' }}
                  />
                  {showCharDropdown && filteredCharacterNames.length > 0 && (
                    <ul
                      className="card"
                      style={{
                        position: 'absolute',
                        top: '100%',
                        left: 0,
                        right: 0,
                        margin: 0,
                        marginTop: '2px',
                        padding: '0.25rem 0',
                        maxHeight: '240px',
                        overflowY: 'auto',
                        listStyle: 'none',
                        zIndex: 10,
                      }}
                    >
                      {filteredCharacterNames.map((n) => (
                        <li
                          key={n}
                          style={{ padding: '0.4rem 0.6rem', cursor: 'pointer' }}
                          onMouseDown={(e) => { e.preventDefault(); setAddToTicCharQuery(n); setShowCharDropdown(false) }}
                        >
                          {n}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <button type="button" className="btn" onClick={handleAddAttendeeToTic} disabled={mutating || !addToTicCharQuery.trim()}>
                  Add to tic
                </button>
              </div>
              {addToTicResult && (
                <p style={{ color: '#22c55e', marginTop: '0.5rem', marginBottom: 0 }}>Added {addToTicResult} to tic.</p>
              )}
            </section>
          )}

          {/* Add loot */}
          <section className="card" style={{ marginBottom: '1.5rem' }}>
            <h2 style={{ marginTop: 0 }}>Add loot</h2>
            <p style={{ color: '#71717a', fontSize: '0.9rem' }}>Manual: pick item (type to filter or enter a new item name), character (must be on DKP list), cost. Or paste log lines below.</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
              <div style={{ position: 'relative', flex: '1 1 320px', minWidth: '280px', maxWidth: '500px' }}>
                <input
                  type="text"
                  value={lootItemQuery}
                  onChange={(e) => setLootItemQuery(e.target.value)}
                  onFocus={() => setShowLootDropdown(true)}
                  onBlur={() => setTimeout(() => setShowLootDropdown(false), 150)}
                  placeholder="Item name (filter list or type new)"
                  list="loot-item-list"
                  style={{ width: '100%', padding: '0.5rem 0.6rem', fontSize: '1rem', boxSizing: 'border-box' }}
                />
                <datalist id="loot-item-list">
                  {filteredItemNames.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
                {showLootDropdown && filteredItemNames.length > 0 && (
                  <ul
                    className="card"
                    style={{
                      position: 'absolute',
                      top: '100%',
                      left: 0,
                      right: 0,
                      margin: 0,
                      marginTop: '2px',
                      padding: '0.25rem 0',
                      maxHeight: '280px',
                      overflowY: 'auto',
                      listStyle: 'none',
                      zIndex: 10,
                    }}
                  >
                    {filteredItemNames.map((n) => (
                      <li
                        key={n}
                        style={{ padding: '0.4rem 0.6rem', cursor: 'pointer' }}
                        onMouseDown={(e) => { e.preventDefault(); setLootItemQuery(n); setShowLootDropdown(false) }}
                      >
                        {n}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <input
                type="text"
                value={lootCharName}
                onChange={(e) => setLootCharName(e.target.value)}
                placeholder="Character name"
                style={{ padding: '0.5rem 0.6rem', minWidth: '140px', fontSize: '1rem' }}
              />
              <input
                type="number"
                min={0}
                value={lootCost}
                onChange={(e) => setLootCost(e.target.value)}
                placeholder="Cost"
                style={{ width: '5rem', padding: '0.5rem 0.6rem', fontSize: '1rem' }}
              />
              <button type="button" className="btn" onClick={handleAddLootManual} disabled={mutating || !lootItemQuery.trim()}>
                Add
              </button>
            </div>
            <p style={{ color: '#71717a', fontSize: '0.85rem', marginTop: '0.25rem' }}>Or paste loot log lines (e.g. &apos;Earring of Eradication grats Barndog, 4 DKP!!!&apos;):</p>
            <textarea
              value={lootLogPaste}
              onChange={(e) => setLootLogPaste(e.target.value)}
              placeholder="[Mon Feb 09 21:35:20 2026] Icbm says out of character, 'Earring of Eradication grats Barndog, 4 DKP!!!'"
              rows={3}
              style={{ width: '100%', maxWidth: '600px', padding: '0.5rem', marginTop: '0.25rem', fontFamily: 'monospace' }}
            />
            <button type="button" onClick={handleAddLootFromLog} disabled={mutating || !lootLogPaste.trim()} style={{ marginTop: '0.25rem' }}>
              Add from log
            </button>
            {lootResult && (
              <p style={{ color: '#22c55e', marginTop: '0.5rem' }}>
                {lootResult.fromLog ? `Added ${lootResult.inserted}/${lootResult.total} loot entries.` : `Added ${lootResult.itemName} → ${lootResult.characterName} (${lootResult.cost} DKP).`}
              </p>
            )}
          </section>

          {/* Raid edit view (like RaidDetail with inline edit) */}
          <section ref={raidEditSectionRef} className="card" style={{ marginBottom: '1.5rem' }}>
            <h2 style={{ marginTop: 0 }}>Raid: {raid.raid_name}</h2>
            <p style={{ color: '#a1a1aa', marginBottom: '1rem' }}>
              {raid.date_iso || raid.date}
              {raid.attendees != null && raid.attendees !== '' && ` · ${Math.round(Number(raid.attendees))} attendees`}
              {' · '}
              <Link to={`/raids/${selectedRaidId}`}>Open full raid page</Link>
            </p>

            <h3 style={{ marginTop: '1rem' }}>DKP by event</h3>
            <p style={{ color: '#71717a', fontSize: '0.9rem', marginTop: '-0.25rem 0 0.5rem 0' }}>
              Total: <strong>{events.reduce((sum, e) => sum + parseFloat(e.dkp_value || 0), 0).toFixed(1)}</strong> DKP
            </p>
            <table>
              <thead>
                <tr><th style={{ width: '2rem' }}></th><th>#</th><th>Event</th><th>DKP</th><th>Attendees</th><th style={{ width: '5rem' }}></th></tr>
              </thead>
              <tbody>
                {events.map((e) => {
                  const eid = String(e.event_id ?? '').trim()
                  const attendees = attendeesByEvent[eid] || []
                  const hasList = attendees.length > 0
                  const isExpanded = expandedEvents[e.event_id]
                  const isEditingDkp = editingEventId === e.event_id
                  return (
                    <Fragment key={e.event_id}>
                      <tr>
                        <td>
                          {hasList && (
                            <button type="button" className="btn btn-ghost" style={{ padding: '0.25rem', fontSize: '1rem' }} onClick={() => setExpandedEvents((prev) => ({ ...prev, [e.event_id]: !prev[e.event_id] }))} aria-expanded={isExpanded} title={isExpanded ? 'Hide attendees' : 'Show attendees'}>
                              {isExpanded ? '−' : '+'}
                            </button>
                          )}
                        </td>
                        <td>{e.event_order}</td>
                        <td>{e.event_name}</td>
                        <td>
                          {isEditingDkp ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                              <input type="text" value={editingEventDkp} onChange={(ev) => setEditingEventDkp(ev.target.value)} style={{ width: '4rem', padding: '0.2rem' }} />
                              <button type="button" className="btn btn-ghost" onClick={() => handleSaveEventDkp(e.event_id)} disabled={mutating}>Save</button>
                              <button type="button" className="btn btn-ghost" onClick={() => setEditingEventId(null)}>Cancel</button>
                            </span>
                          ) : (
                            <>
                              {e.dkp_value}
                              <button type="button" className="btn btn-ghost" style={{ marginLeft: '0.25rem', fontSize: '0.85rem' }} onClick={() => { setEditingEventId(e.event_id); setEditingEventDkp(e.dkp_value || '') }} title="Edit DKP">✎</button>
                            </>
                          )}
                        </td>
                        <td>{hasList ? `${attendees.length}${isExpanded ? '' : ' — click +'}` : (e.attendee_count ?? '—')}</td>
                        <td>
                          <button type="button" className="btn btn-ghost" style={{ fontSize: '0.85rem', color: '#f87171' }} onClick={() => handleDeleteEvent(e.event_id)} disabled={mutating} title="Remove tic">Remove</button>
                        </td>
                      </tr>
                      {hasList && isExpanded && (
                        <tr>
                          <td colSpan={6} style={{ padding: '0.5rem 1rem', verticalAlign: 'top', backgroundColor: 'rgba(0,0,0,0.2)', borderBottom: '1px solid #27272a' }}>
                            <div className="attendee-list">
                              {attendees.map((a, i) => (
                                <Link key={a.char_id || a.name || i} to={`/characters/${encodeURIComponent(a.name || '')}`}>{a.name}</Link>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>

            <h3 style={{ marginTop: '1.25rem' }}>Loot</h3>
            <table>
              <thead>
                <tr><th>Item</th><th>Character</th><th>Cost</th><th style={{ width: '6rem' }}></th></tr>
              </thead>
              <tbody>
                {loot.length === 0 && <tr><td colSpan={4}>No loot recorded</td></tr>}
                {loot.map((row, i) => {
                  const isEditingCost = editingLootId === row.id
                  return (
                    <tr key={row.id || i}>
                      <td><Link to={`/items/${encodeURIComponent(row.item_name || '')}`}>{row.item_name || '—'}</Link></td>
                      <td><Link to={`/characters/${encodeURIComponent(row.character_name || row.char_id || '')}`}>{row.character_name || row.char_id || '—'}</Link></td>
                      <td>
                        {isEditingCost ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                            <input type="text" value={editingLootCost} onChange={(ev) => setEditingLootCost(ev.target.value)} style={{ width: '4rem', padding: '0.2rem' }} />
                            <button type="button" className="btn btn-ghost" onClick={() => handleSaveLootCost(row)} disabled={mutating}>Save</button>
                            <button type="button" className="btn btn-ghost" onClick={() => setEditingLootId(null)}>Cancel</button>
                          </span>
                        ) : (
                          <>
                            {row.cost}
                            <button type="button" className="btn btn-ghost" style={{ marginLeft: '0.25rem', fontSize: '0.85rem' }} onClick={() => { setEditingLootId(row.id); setEditingLootCost(row.cost ?? '') }} title="Edit cost">✎</button>
                          </>
                        )}
                      </td>
                      <td>
                        {!isEditingCost && (
                          <button type="button" className="btn btn-ghost" style={{ fontSize: '0.85rem', color: '#f87171' }} onClick={() => handleDeleteLoot(row)}>Remove</button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            <h3 style={{ marginTop: '1.25rem' }}>Attendees</h3>
            <div className="attendee-list">
              {attendance.length > 0 ? attendance.map((a) => (
                <Link key={a.char_id || a.character_name} to={`/characters/${encodeURIComponent(a.character_name || a.char_id || '')}`}>{a.character_name || a.char_id}</Link>
              )) : (
                <span style={{ color: '#71717a' }}>None (add a DKP tic to record attendance)</span>
              )}
            </div>
          </section>

          {/* Delete raid */}
          <section className="card" style={{ marginBottom: '1.5rem', borderColor: '#7f1d1d' }}>
            <h2 style={{ marginTop: 0, color: '#f87171' }}>Delete this raid</h2>
            <p style={{ color: '#71717a', fontSize: '0.9rem' }}>
              Permanently deletes this raid and all its attendance, events, and loot. Type <strong>DELETE</strong> to confirm.
            </p>
            <input
              type="text"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder="Type DELETE"
              style={{ padding: '0.35rem', width: '12rem', marginRight: '0.5rem' }}
            />
            <button type="button" onClick={handleDeleteRaid} disabled={mutating || deleteConfirm !== 'DELETE'} style={{ background: '#7f1d1d', color: '#fff' }}>
              Delete raid
            </button>
            {deleteError && <p className="error" style={{ marginTop: '0.5rem' }}>{deleteError}</p>}
          </section>
        </>
      )}

      {loading && raids.length === 0 && <p>Loading…</p>}
    </div>
  )
}
