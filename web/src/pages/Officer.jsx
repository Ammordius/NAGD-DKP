import { useEffect, useState, useCallback, useMemo, useRef, Fragment } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getDkpMobLoot } from '../lib/staticData'

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

/**
 * Parse loot log by matching against known character names and item names.
 * - Look for character names (tied to account/DKP list) that appear in the line.
 * - Look for any loot item that appears in the line (DKP raid_loot or JSON loot list); longest match wins.
 * - Look for number + "dkp" for cost (default 0).
 * Returns per-line: { rawLine, itemName, characterNames[], cost, hasDkp }.
 * 3 matches → add; 1 or 2 matches → report what's missing.
 */
function parseLootLogByMatch(paste, characterNamesList, itemNamesList) {
  const lines = (paste || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const results = []
  const chars = (characterNamesList || []).filter(Boolean).sort((a, b) => (b?.length || 0) - (a?.length || 0))
  const items = (itemNamesList || []).filter(Boolean).sort((a, b) => (b?.length || 0) - (a?.length || 0))
  for (const line of lines) {
    const quoted = (line.match(/'([^']+)'/)?.[1] || line).trim()
    if (!quoted) continue
    const lower = quoted.toLowerCase()
    const characterNames = chars.filter((name) => name && lower.includes(name.toLowerCase()))
    let itemName = ''
    for (const name of items) {
      if (name && lower.includes(name.toLowerCase())) {
        itemName = name
        break
      }
    }
    const dkpMatch = quoted.match(/(\d+)\s*dkp/i)
    const cost = dkpMatch ? parseInt(dkpMatch[1], 10) : 0
    const hasDkp = !!dkpMatch
    results.push({ rawLine: quoted, itemName, characterNames: [...characterNames], cost: isNaN(cost) ? 0 : cost, hasDkp })
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
  const [accountIdToDisplayName, setAccountIdToDisplayName] = useState({})
  const [itemNames, setItemNames] = useState([])
  const [jsonLootItemNames, setJsonLootItemNames] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mutating, setMutating] = useState(false)

  // Create new DKP account (officer-only)
  const [newAccountDisplayName, setNewAccountDisplayName] = useState('')
  const [newAccountLoading, setNewAccountLoading] = useState(false)
  const [newAccountResult, setNewAccountResult] = useState(null)
  const [newAccountError, setNewAccountError] = useState('')

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
  const [editingEventTimeId, setEditingEventTimeId] = useState(null)
  const [editingEventTimeValue, setEditingEventTimeValue] = useState('')
  const [editingLootId, setEditingLootId] = useState(null)
  const [editingLootCost, setEditingLootCost] = useState('')
  const [expandedEvents, setExpandedEvents] = useState({})
  const [showLootDropdown, setShowLootDropdown] = useState(false)
  const [showLootCharDropdown, setShowLootCharDropdown] = useState(false)

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

  const getAccountId = useMemo(() => {
    const nameToAcc = {}
    characters.forEach((c) => {
      const acc = charIdToAccountId[c.char_id]
      if (acc && (c.name || '').trim()) nameToAcc[(c.name || '').trim()] = acc
    })
    return (key) => {
      if (key == null || key === '') return null
      const k = String(key).trim()
      return charIdToAccountId[k] ?? nameToAcc[k] ?? null
    }
  }, [characters, charIdToAccountId])

  const charIdToName = useMemo(() => {
    const m = {}
    characters.forEach((c) => { if (c?.char_id && c?.name) m[String(c.char_id)] = c.name })
    return m
  }, [characters])

  const getAccountCharacterDisplay = useMemo(() => {
    return (key) => {
      if (key == null || key === '') return ''
      const accId = getAccountId(key)
      const accName = accId ? (accountIdToDisplayName[accId] || accId) : null
      const charName = nameToChar[String(key).toLowerCase().trim()]?.name || charIdToName[String(key)] || key
      return accName ? `${accName} (${charName})` : (charName || key)
    }
  }, [getAccountId, accountIdToDisplayName, nameToChar, charIdToName])

  const getAccountDisplayName = useMemo(() => {
    return (key) => {
      if (key == null || key === '') return null
      const accId = getAccountId(key)
      return accId ? (accountIdToDisplayName[accId] || accId) : null
    }
  }, [getAccountId, accountIdToDisplayName])

  const groupAttendeesByAccount = useCallback((attendeeList, getAccId, getAccDisplayName) => {
    const byKey = new Map()
    for (const a of attendeeList) {
      const name = (a.character_name ?? a.name ?? a.char_id ?? '').toString().trim() || '—'
      const charId = a.char_id ?? a.character_name
      const accId = getAccId(name !== '—' ? name : charId)
      const key = accId != null ? `account:${accId}` : `char:${String(charId ?? name).trim()}`
      if (!byKey.has(key)) {
        byKey.set(key, {
          accountId: accId ?? null,
          accountDisplayName: accId ? (getAccDisplayName(name !== '—' ? name : charId) ?? accId) : null,
          names: [],
          charIds: [],
        })
      }
      const entry = byKey.get(key)
      if (!entry.names.includes(name)) {
        entry.names.push(name)
        entry.charIds.push(charId)
      }
    }
    const list = [...byKey.values()]
    list.sort((a, b) => {
      const aLabel = a.accountDisplayName || a.names[0] || ''
      const bLabel = b.accountDisplayName || b.names[0] || ''
      return String(aLabel).localeCompare(String(bLabel))
    })
    return list
  }, [])

  const allItemNamesForLootLog = useMemo(() => {
    const byLower = new Map()
    ;(itemNames || []).forEach((n) => { if (n) byLower.set(n.trim().toLowerCase(), n.trim()) })
    ;(jsonLootItemNames || []).forEach((n) => { if (n) byLower.set(n.trim().toLowerCase(), n.trim()) })
    return [...byLower.values()]
  }, [itemNames, jsonLootItemNames])

  const characterNamesForLootLog = useMemo(() => characters.map((c) => (c.name || '').trim()).filter(Boolean), [characters])

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
    // Load all characters (paginate so newly added / account-linked characters are never excluded)
    const allChars = []
    let charFrom = 0
    const charPageSize = 1000
    while (true) {
      const { data: charPage } = await supabase.from('characters').select('char_id, name').range(charFrom, charFrom + charPageSize - 1)
      if (!charPage?.length) break
      allChars.push(...charPage)
      if (charPage.length < charPageSize) break
      charFrom += charPageSize
    }
    setCharacters(allChars)
    const allCa = []
    let caFrom = 0
    const caPageSize = 1000
    while (true) {
      const { data: caPage } = await supabase.from('character_account').select('char_id, account_id').range(caFrom, caFrom + caPageSize - 1)
      if (!caPage?.length) break
      allCa.push(...caPage)
      if (caPage.length < caPageSize) break
      caFrom += caPageSize
    }
    const map = {}
    allCa.forEach((r) => {
      if (r.char_id && r.account_id && map[r.char_id] == null) map[r.char_id] = r.account_id
    })
    setCharIdToAccountId(map)
    const accRes = await supabase.from('accounts').select('account_id, display_name').limit(5000)
    const accNames = {}
    ;(accRes.data || []).forEach((a) => {
      if (a?.account_id) accNames[a.account_id] = (a.display_name || '').trim() || a.account_id
    })
    setAccountIdToDisplayName(accNames)
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
    // Merge duplicate items by case-insensitive name (keep first occurrence as canonical)
    const byLower = new Map()
    allItemRows.forEach((r) => {
      const n = (r.item_name || '').trim()
      if (!n) return
      const key = n.toLowerCase()
      if (!byLower.has(key)) byLower.set(key, n)
    })
    const names = [...byLower.values()].sort((a, b) => a.localeCompare(b))
    setItemNames(names)
    try {
      const data = await getDkpMobLoot()
      if (data) {
        const fromJson = new Set()
        Object.values(data).forEach((entry) => {
          ;(entry?.loot || []).forEach((l) => { if (l?.name) fromJson.add(l.name) })
        })
        setJsonLootItemNames([...fromJson])
      } else setJsonLootItemNames([])
    } catch (_) {
      setJsonLootItemNames([])
    }
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
    const { count } = await supabase.from('raid_attendance').select('*', { count: 'exact', head: true }).eq('raid_id', selectedRaidId)
    if (count != null) await supabase.from('raids').update({ attendees: String(count) }).eq('raid_id', selectedRaidId)
    loadSelectedRaid()
    setMutating(false)
  }

  const handleCreateAccount = async () => {
    setNewAccountError('')
    setNewAccountResult(null)
    setNewAccountLoading(true)
    const { data: accountId, error: rpcErr } = await supabase.rpc('create_account', {
      p_display_name: newAccountDisplayName.trim() || null,
    })
    setNewAccountLoading(false)
    if (rpcErr) {
      setNewAccountError(rpcErr.message)
      return
    }
    setNewAccountResult(accountId)
    setNewAccountDisplayName('')
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
    const isFirstTic = events.length === 0
    const addedAt = new Date().toISOString()
    const { error: evErr } = await supabase.from('raid_events').insert({
      raid_id: selectedRaidId,
      event_id,
      event_order: maxOrder + 1,
      event_name: isFirstTic ? 'On-time' : 'DKP tic',
      dkp_value: String(dkpValue),
      attendee_count: String(names.length),
      event_time: eventTime || addedAt,
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
    const newThisTic = events.length === 0 ? matched.map((m) => m.character_name) : matched.filter((m) => !eventAttendance.some((r) => String(r.char_id) === String(m.char_id))).map((m) => m.character_name)

    const charIdToName = {}
    characters.forEach((c) => { if (c?.char_id && c?.name) charIdToName[String(c.char_id)] = c.name })
    const fmt = (charId, charName) => {
      const accId = charIdToAccountId[charId]
      const accName = accId ? (accountIdToDisplayName[accId] || accId) : null
      return accName ? `${accName} (${charName || charId})` : (charName || charId)
    }
    const resolve = (s) => nameToChar[String(s).toLowerCase().trim()] || (charIdToName[String(s)] ? { char_id: s, name: charIdToName[String(s)] } : null)

    setTicResult({
      matched: matched.length,
      matchedDisplay: matched.map((m) => fmt(m.char_id, m.character_name)),
      unmatched: unmatched.length > 0 ? unmatched : null,
      duplicatesDisplay: duplicates.length > 0 ? duplicates.map((n) => { const c = resolve(n); return c ? fmt(c.char_id, c.name) : n }) : null,
      sameAccountDisplay: sameAccount.length > 0 ? sameAccount.map((n) => { const c = resolve(n); return c ? fmt(c.char_id, c.name) : n }) : null,
      event_id,
      missingFromThisTicDisplay: missingFromThisTic.length > 0 ? missingFromThisTic.map((s) => { const c = resolve(s); return c ? fmt(c.char_id, c.name) : s }) : null,
      newThisTicDisplay: newThisTic.length > 0 ? newThisTic.map((s) => { const c = resolve(s); return c ? fmt(c.char_id, c.name) : s }) : null,
    })
    setTicPaste('')
    await supabase.rpc('refresh_dkp_summary')
    try { sessionStorage.removeItem('dkp_leaderboard_v2') } catch (_) {}
    const { count } = await supabase.from('raid_attendance').select('*', { count: 'exact', head: true }).eq('raid_id', selectedRaidId)
    if (count != null) await supabase.from('raids').update({ attendees: String(count) }).eq('raid_id', selectedRaidId)
    loadSelectedRaid()
    setMutating(false)
  }

  const handleAddLootManual = async () => {
    if (!selectedRaidId) {
      setError('Select a raid first.')
      return
    }
    const itemNameRaw = lootItemQuery.trim()
    const characterName = lootCharName.trim()
    const cost = parseInt(lootCost, 10)
    if (!itemNameRaw) {
      setError('Enter an item name.')
      return
    }
    const itemName = itemNameToCanonical[itemNameRaw.toLowerCase()] || itemNameRaw
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
    setItemNames((prev) => {
      const key = itemName.trim().toLowerCase()
      if (prev.some((n) => (n || '').trim().toLowerCase() === key)) return prev
      return [...prev, itemName].sort((a, b) => a.localeCompare(b))
    })
    loadSelectedRaid()
    setMutating(false)
  }

  const handleAddLootFromLog = async () => {
    if (!selectedRaidId) {
      setError('Select a raid first.')
      return
    }
    const lineResults = parseLootLogByMatch(lootLogPaste, characterNamesForLootLog, allItemNamesForLootLog)
    if (lineResults.length === 0) {
      setError('No lines to parse. Paste log lines containing character names (on DKP list), item names (from DKP or loot list), and optional "N DKP".')
      return
    }
    setMutating(true)
    setLootResult(null)
    setError('')
    const event_id = events.length > 0 ? events[0].event_id : 'loot'
    const knownItemSet = new Set(allItemNamesForLootLog.map((n) => (n || '').trim().toLowerCase()))
    const itemNameByLower = {}
    allItemNamesForLootLog.forEach((n) => { if (n) itemNameByLower[n.trim().toLowerCase()] = n })
    const playerNotFound = []
    const itemNotFound = []
    const missingDkpAmount = []
    let inserted = 0
    for (const line of lineResults) {
      const characterNames = line.characterNames.length > 0 ? line.characterNames : ['']
      for (const characterName of characterNames) {
        const char = characterName ? nameToChar[characterName.toLowerCase()] : null
        const hasChar = !!char
        const itemKey = (line.itemName || '').trim().toLowerCase()
        const hasItem = !!line.itemName && knownItemSet.has(itemKey)
        const canonicalItemName = itemNameByLower[itemKey] || line.itemName
        if (hasChar && hasItem) {
          if (!line.hasDkp && line.cost === 0) missingDkpAmount.push({ itemName: canonicalItemName, characterName: char.name })
          const { error: err } = await supabase.from('raid_loot').insert({
            raid_id: selectedRaidId,
            event_id,
            item_name: canonicalItemName,
            char_id: char.char_id,
            character_name: char.name,
            cost: String(line.cost),
          })
          if (!err) inserted++
          continue
        }
        if (!hasChar) playerNotFound.push({ itemName: line.itemName || line.rawLine, characterName: characterName || '(no character matched)' })
        if (!hasItem) itemNotFound.push({ itemName: line.itemName || line.rawLine, characterName: char?.name || characterName || '?' })
      }
    }
    const totalRows = lineResults.reduce((sum, l) => sum + (l.characterNames.length > 0 ? l.characterNames.length : 1), 0)
    const parts = []
    if (playerNotFound.length > 0) {
      parts.push(`Missing character (${playerNotFound.length}): ${playerNotFound.map((r) => `${r.characterName} (${r.itemName})`).join('; ')}. Character must be on DKP list.`)
    }
    if (itemNotFound.length > 0) {
      parts.push(`Missing item (${itemNotFound.length}): ${itemNotFound.map((r) => `"${r.itemName}" → ${r.characterName}`).join('; ')}. Item must exist in DKP loot or JSON loot list.`)
    }
    if (missingDkpAmount.length > 0) {
      parts.push(`No DKP amount in line (used 0) (${missingDkpAmount.length}): ${missingDkpAmount.map((r) => `"${r.itemName}" → ${r.characterName}`).join('; ')}.`)
    }
    if (parts.length > 0) setError(parts.join(' '))
    setLootResult({ fromLog: true, inserted, total: totalRows })
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

  const handleSaveEventTime = async (eventId) => {
    if (!selectedRaidId) return
    const val = String(editingEventTimeValue).trim()
    setMutating(true)
    const { error: err } = await supabase.from('raid_events').update({ event_time: val || null }).eq('raid_id', selectedRaidId).eq('event_id', eventId)
    setMutating(false)
    if (err) setError(err.message)
    else {
      setEditingEventTimeId(null)
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
    if (err) {
      setMutating(false)
      setError(err.message)
      return
    }
    // Remove from raid_attendance anyone who is no longer in any remaining event (they were only on the deleted tic).
    const { data: remainingEventAtt } = await supabase.from('raid_event_attendance').select('char_id').eq('raid_id', selectedRaidId)
    const charIdsStillInEvents = new Set((remainingEventAtt || []).map((r) => String(r.char_id ?? '')).filter(Boolean))
    const { data: raidAtt } = await supabase.from('raid_attendance').select('char_id').eq('raid_id', selectedRaidId)
    for (const row of raidAtt || []) {
      const cid = String(row.char_id ?? '').trim()
      if (cid && !charIdsStillInEvents.has(cid)) {
        await supabase.from('raid_attendance').delete().eq('raid_id', selectedRaidId).eq('char_id', row.char_id)
      }
    }
    const { count } = await supabase.from('raid_attendance').select('*', { count: 'exact', head: true }).eq('raid_id', selectedRaidId)
    if (count != null) await supabase.from('raids').update({ attendees: String(count) }).eq('raid_id', selectedRaidId)
    setMutating(false)
    loadSelectedRaid()
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

  const itemNameToCanonical = useMemo(() => {
    const m = {}
    itemNames.forEach((n) => { if (n) m[n.trim().toLowerCase()] = n })
    return m
  }, [itemNames])

  const characterNamesList = useMemo(() => characters.map((c) => (c.name || '').trim()).filter(Boolean).sort((a, b) => a.localeCompare(b)), [characters])
  const filteredCharacterNames = useMemo(() => {
    const q = addToTicCharQuery.toLowerCase().trim()
    if (!q) return characterNamesList.slice(0, 200)
    return characterNamesList.filter((n) => n.toLowerCase().includes(q)).slice(0, 200)
  }, [characterNamesList, addToTicCharQuery])

  const filteredLootCharacterNames = useMemo(() => {
    const q = lootCharName.toLowerCase().trim()
    if (!q) return characterNamesList.slice(0, 200)
    return characterNamesList.filter((n) => n.toLowerCase().includes(q)).slice(0, 200)
  }, [characterNamesList, lootCharName])

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

      {/* Create new DKP account (officer-only); player claims it on the account page */}
      <section className="card" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ marginTop: 0 }}>Create new DKP account</h2>
        <p style={{ color: '#71717a', fontSize: '0.9rem', marginBottom: '0.75rem' }}>
          Create an account that a player can then claim on the account page. Share the account link with them.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Display name (e.g. player main)"
            value={newAccountDisplayName}
            onChange={(e) => setNewAccountDisplayName(e.target.value)}
            style={{ padding: '0.35rem 0.5rem', minWidth: '200px' }}
            onKeyDown={(e) => e.key === 'Enter' && handleCreateAccount()}
          />
          <button type="button" className="btn" onClick={handleCreateAccount} disabled={newAccountLoading}>
            {newAccountLoading ? 'Creating…' : 'Create account'}
          </button>
        </div>
        {newAccountError && <p className="error" style={{ marginTop: '0.5rem', marginBottom: 0 }}>{newAccountError}</p>}
        {newAccountResult && (
          <p style={{ color: '#22c55e', marginTop: '0.5rem', marginBottom: 0 }}>
            Created. <Link to={`/accounts/${newAccountResult}`}>View account</Link> — share this link so the player can claim it.
          </p>
        )}
      </section>

      {selectedRaidId && raid && (
        <>
          {/* Add DKP tic: paste and result close together so officers see what was done */}
          <section className="card" style={{ marginBottom: '1.5rem' }}>
            <h2 style={{ marginTop: 0 }}>Add DKP tic (attendance)</h2>
            <p style={{ color: '#a1a1aa', fontSize: '0.9rem', marginBottom: '0.5rem' }}>
              <strong>Matching:</strong> Paste the channel member list below. Each comma-separated name is matched to the DKP list by <strong>exact character name</strong> (case-insensitive). Only names that match a character on the DKP list receive credit. One credit per <strong>account</strong> per tic—duplicate character names in the paste and other toons on the same account are skipped and listed so you can verify.
            </p>
            <textarea
              value={ticPaste}
              onChange={(e) => setTicPaste(e.target.value)}
              placeholder="[Sun Apr 14 10:17:09 2024] Channel Nag(30) members:&#10;[Sun Apr 14 10:17:09 2024] Meldrath, Fridge, Geom, ..."
              rows={5}
              style={{ width: '100%', maxWidth: '600px', padding: '0.5rem', marginBottom: '0.35rem', fontFamily: 'monospace' }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
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
              <div style={{ marginTop: 0, padding: '0.75rem', backgroundColor: 'rgba(0,0,0,0.25)', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.08)' }}>
                <p style={{ color: '#22c55e', marginTop: 0, marginBottom: '0.5rem' }}><strong>Result:</strong> Tic added. Credited <strong>{ticResult.matched}</strong> attendee(s). Names shown as account (character).</p>
                {ticResult.matchedDisplay?.length > 0 && (
                  <p style={{ color: '#22c55e', marginBottom: '0.25rem', fontSize: '0.9rem' }}><strong>Credited:</strong> {ticResult.matchedDisplay.join(', ')}</p>
                )}
                {ticResult.unmatched?.length > 0 && (
                  <p style={{ color: '#f59e0b', marginBottom: '0.25rem' }}><strong>Unmatched</strong> (not on DKP list—no credit): {ticResult.unmatched.join(', ')}</p>
                )}
                {ticResult.duplicatesDisplay?.length > 0 && (
                  <p style={{ color: '#a78bfa', marginBottom: '0.25rem' }}><strong>Duplicates</strong> (in paste again—not double-counted): {ticResult.duplicatesDisplay.join(', ')}</p>
                )}
                {ticResult.sameAccountDisplay?.length > 0 && (
                  <p style={{ color: '#a78bfa', marginBottom: '0.25rem' }}><strong>Same account</strong> (other toon already credited this tic): {ticResult.sameAccountDisplay.join(', ')}</p>
                )}
                {ticResult.missingFromThisTicDisplay?.length > 0 && (
                  <p style={{ color: '#f97316', marginBottom: '0.25rem' }}><strong>Missing from this tic</strong> (were in earlier tics this raid): {ticResult.missingFromThisTicDisplay.join(', ')}</p>
                )}
                {ticResult.newThisTicDisplay?.length > 0 && (
                  <p style={{ color: '#71717a', fontSize: '0.9rem', marginBottom: 0 }}><strong>New this tic</strong> (first time this raid): {ticResult.newThisTicDisplay.join(', ')}</p>
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
              <div style={{ position: 'relative', minWidth: '200px' }}>
                <input
                  type="text"
                  value={lootCharName}
                  onChange={(e) => { setLootCharName(e.target.value); setError('') }}
                  onFocus={() => setShowLootCharDropdown(true)}
                  onBlur={() => setTimeout(() => setShowLootCharDropdown(false), 150)}
                  placeholder="Character name (type to filter)"
                  style={{ padding: '0.5rem 0.6rem', fontSize: '1rem', width: '100%', minWidth: '180px', boxSizing: 'border-box' }}
                />
                {showLootCharDropdown && filteredLootCharacterNames.length > 0 && (
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
                    {filteredLootCharacterNames.map((n) => (
                      <li
                        key={n}
                        style={{ padding: '0.4rem 0.6rem', cursor: 'pointer' }}
                        onMouseDown={(e) => { e.preventDefault(); setLootCharName(n); setShowLootCharDropdown(false) }}
                      >
                        {n}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
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
            <p style={{ color: '#71717a', fontSize: '0.85rem', marginTop: '0.25rem' }}>Or paste loot log lines. Lines are matched by: character name (on DKP list), item name (in DKP loot or dkp_mob_loot.json), and optional &apos;N DKP&apos;. All 3 matched → added; 1 or 2 matched → shows what&apos;s missing.</p>
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
            {error && (
              <div className="error" role="alert" style={{ marginTop: '0.5rem', padding: '0.5rem 0.75rem', backgroundColor: 'rgba(248,113,113,0.15)', borderRadius: '4px', border: '1px solid #f87171' }}>
                <strong>What went wrong:</strong> {error}
              </div>
            )}
          </section>

          {/* Raid edit view (like RaidDetail with inline edit) */}
          <section ref={raidEditSectionRef} className="card" style={{ marginBottom: '1.5rem' }}>
            <h2 style={{ marginTop: 0 }}>Raid: {raid.raid_name}</h2>
            <p style={{ color: '#a1a1aa', marginBottom: '1rem' }}>
              {raid.date_iso || raid.date}
              {` · ${attendance.length > 0 ? attendance.length : (raid.attendees != null && raid.attendees !== '' ? Math.round(Number(raid.attendees)) : '—')} attendees`}
              {' · '}
              <Link to={`/raids/${selectedRaidId}`}>Open full raid page</Link>
            </p>

            <h3 style={{ marginTop: '1rem' }}>DKP by event</h3>
            <p style={{ color: '#71717a', fontSize: '0.9rem', marginTop: '-0.25rem 0 0.5rem 0' }}>
              Total: <strong>{events.reduce((sum, e) => sum + parseFloat(e.dkp_value || 0), 0).toFixed(1)}</strong> DKP
            </p>
            <table>
              <thead>
                <tr><th style={{ width: '2rem' }}></th><th>#</th><th>Event</th><th>DKP</th><th>Time</th><th>Attendees</th><th style={{ width: '5rem' }}></th></tr>
              </thead>
              <tbody>
                {events.map((e) => {
                  const eid = String(e.event_id ?? '').trim()
                  const attendees = attendeesByEvent[eid] || []
                  const hasList = attendees.length > 0
                  const isExpanded = expandedEvents[e.event_id]
                  const isEditingDkp = editingEventId === e.event_id
                  const isEditingTime = editingEventTimeId === e.event_id
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
                        <td>
                          {isEditingTime ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                              <input type="text" value={editingEventTimeValue} onChange={(ev) => setEditingEventTimeValue(ev.target.value)} style={{ width: '12rem', padding: '0.2rem' }} placeholder="e.g. Sun Apr 14 10:17:09 2024" />
                              <button type="button" className="btn btn-ghost" onClick={() => handleSaveEventTime(e.event_id)} disabled={mutating}>Save</button>
                              <button type="button" className="btn btn-ghost" onClick={() => setEditingEventTimeId(null)}>Cancel</button>
                            </span>
                          ) : (
                            <>
                              {e.event_time || '—'}
                              <button type="button" className="btn btn-ghost" style={{ marginLeft: '0.25rem', fontSize: '0.85rem' }} onClick={() => { setEditingEventTimeId(e.event_id); setEditingEventTimeValue(e.event_time || '') }} title="Edit tic time">✎</button>
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
                          <td colSpan={7} style={{ padding: '0.5rem 1rem', verticalAlign: 'top', backgroundColor: 'rgba(0,0,0,0.2)', borderBottom: '1px solid #27272a' }}>
                            <div className="attendee-list">
                              {groupAttendeesByAccount(
                                attendees.map((a) => ({ character_name: a.name, name: a.name, char_id: a.char_id })),
                                getAccountId,
                                getAccountDisplayName
                              ).map((group) => {
                                const label = group.accountDisplayName
                                  ? `${group.accountDisplayName} (${group.names.join(', ')})`
                                  : group.names[0] || '—'
                                const to = group.accountId
                                  ? `/accounts/${group.accountId}`
                                  : `/characters/${encodeURIComponent(group.names[0] || '')}`
                                return <Link key={group.accountId ?? group.names[0]} to={to}>{label}</Link>
                              })}
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
                      <td>
                        {(() => {
                          const charName = row.character_name || row.char_id || '—'
                          const accountId = getAccountId(row.character_name || row.char_id)
                          const to = accountId ? `/accounts/${accountId}` : `/characters/${encodeURIComponent(charName)}`
                          return <Link to={to}>{charName}</Link>
                        })()}
                      </td>
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
              {attendance.length > 0 ? groupAttendeesByAccount(attendance, getAccountId, getAccountDisplayName).map((group) => {
                const label = group.accountDisplayName
                  ? `${group.accountDisplayName} (${group.names.join(', ')})`
                  : group.names[0] || '—'
                const to = group.accountId
                  ? `/accounts/${group.accountId}`
                  : `/characters/${encodeURIComponent(group.names[0] || '')}`
                return <Link key={group.accountId ?? group.names[0]} to={to}>{label}</Link>
              }) : (
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
