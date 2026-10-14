import { useEffect, useState, useCallback, useMemo, useRef, Fragment } from 'react'
import { Link, useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import useSWRConfig from 'swr'
import { supabase } from '../lib/supabase'
import { getDkpMobLoot, getRaidItemSources } from '../lib/staticData'
import { logOfficerAudit } from '../lib/officerAudit'
import { findDuplicateAccountName } from '../lib/accountNameTaken'
import { formatAccountCharacter, formatAccountCharacters } from '../lib/formatAccountCharacter'
import { DKP_DATA_KEY } from '../lib/dkpLeaderboard'
import { groupRaidLootByEvent } from '../lib/groupRaidLootByEvent'
import { buildItemNameToIdMap, buildLootMobLookups, subgroupLootRowsByMob } from '../lib/lootMobSubgroups'
import {
  parseRaidString,
  parseChannelList,
  parseLootLogByMatch,
  indexCharactersByName,
  classifyTicAttendance,
} from '../lib/officerRaidParse'
import {
  defaultTicFields,
  displayTicEventName,
  dkpTicEventName,
  eventFieldsForTimeSave,
  eventTimeToStore,
  fieldsForEdit,
  firstEqStampInPaste,
  floorNowInZone,
  formatRaidSchedule,
  formatStoredClock,
  newTicTimestamp,
  raidLocalCalendarDate,
  raidStartToStore,
} from '../lib/ticDateTime'
import { profileTimeZone } from '../lib/siteTimeZone'
import TicDateTimeFields from '../components/TicDateTimeFields'
import TicMemberPicker from '../components/TicMemberPicker'
import AttendeeCountCell from '../components/AttendeeCountCell'
import { normalizeUiPreferences, readTicDraft, writeTicDraft } from '../lib/uiPreferences'
import { buildAccountAdminRows, filterAccountAdminRows } from '../lib/siteAdminCharacters'

/** Generate a unique raid_id for officer-created raids (string, no collision with numeric imports). */
function generateRaidId() {
  return `manual-${Date.now()}`
}

function ticOptionLabel(event, raidDateIso, timeZone) {
  const order = event?.event_order != null && event.event_order !== '' ? `#${event.event_order} ` : ''
  return `${order}${displayTicEventName(event, raidDateIso, timeZone)}`
}

function ResultNames({ label, names, tone }) {
  if (!names?.length) return null
  return (
    <div className={`officer-result-group officer-result-group--${tone}`}>
      <div className="officer-result-label">{label} ({names.length})</div>
      <div className="officer-result-names">
        {names.map((name, i) => (
          <span key={`${i}-${name}`} className="officer-result-name">{name}</span>
        ))}
      </div>
    </div>
  )
}

export default function Officer({ isOfficer, profile }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedRaidId = (searchParams.get('raid') || '').trim()
  const setSelectedRaidId = useCallback((raidId) => {
    const v = typeof raidId === 'string' ? raidId.trim() : ''
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (v) next.set('raid', v)
        else next.delete('raid')
        return next
      },
      { replace: true }
    )
  }, [setSearchParams])
  const { mutate: globalMutate } = useSWRConfig()
  const [raids, setRaids] = useState([])
  const [raid, setRaid] = useState(null)
  const [events, setEvents] = useState([])
  const [loot, setLoot] = useState([])
  const [eventAttendance, setEventAttendance] = useState([])
  const [characters, setCharacters] = useState([])
  const [charIdToAccountId, setCharIdToAccountId] = useState({})
  const [accountIdToDisplayName, setAccountIdToDisplayName] = useState({})
  const [accounts, setAccounts] = useState([])
  const uiPrefs = normalizeUiPreferences(profile?.ui_preferences)
  const siteZone = profileTimeZone(profile?.ui_preferences)
  const showTicCharacterPicker = uiPrefs.showTicCharacterPicker
  const useCharacterAdminSelectors = uiPrefs.useCharacterAdminSelectors
  const raidNameOnly = uiPrefs.raidNameOnly
  const [itemNames, setItemNames] = useState([])
  const [jsonLootItemNames, setJsonLootItemNames] = useState([])
  const [lootMobJson, setLootMobJson] = useState(null)
  const [raidItemSourcesJson, setRaidItemSourcesJson] = useState(null)
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
  const [raidDate, setRaidDate] = useState('')
  const [raidTime, setRaidTime] = useState('')
  const [raidWhenTouched, setRaidWhenTouched] = useState(false)
  const [addRaidResult, setAddRaidResult] = useState(null)
  const [showCreateRaid, setShowCreateRaid] = useState(() => window.location.hash === '#add-raid')
  const [raidPickerQuery, setRaidPickerQuery] = useState('')
  const [showRaidPicker, setShowRaidPicker] = useState(false)

  // Add tic
  const [ticPaste, setTicPaste] = useState('')
  const [ticDate, setTicDate] = useState('')
  const [ticTime, setTicTime] = useState('')
  const [ticDateTimeTouched, setTicDateTimeTouched] = useState(false)
  const [ticDkpValue, setTicDkpValue] = useState('1')
  const [ticResult, setTicResult] = useState(null)
  const [ticDestination, setTicDestination] = useState('new')
  const [appendEventId, setAppendEventId] = useState('')
  const [ticResolutions, setTicResolutions] = useState({})
  const [ticExcludedCharIds, setTicExcludedCharIds] = useState([])
  const [ticAttendingIds, setTicAttendingIds] = useState([])
  const [ticMemberQuery, setTicMemberQuery] = useState('')
  const [availableHighlight, setAvailableHighlight] = useState([])
  const [attendingHighlight, setAttendingHighlight] = useState([])
  const availableAnchorRef = useRef(null)
  const attendingAnchorRef = useRef(null)

  // Add loot manual
  const [lootItemQuery, setLootItemQuery] = useState('')
  const [lootCharName, setLootCharName] = useState('')
  const [lootCharId, setLootCharId] = useState('')
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
  const [editingEventDate, setEditingEventDate] = useState('')
  const [editingEventTime, setEditingEventTime] = useState('')
  const [editingLootId, setEditingLootId] = useState(null)
  const [editingLootCost, setEditingLootCost] = useState('')
  const [editingRaidName, setEditingRaidName] = useState(false)
  const [raidNameDraft, setRaidNameDraft] = useState('')
  const [raidNameError, setRaidNameError] = useState('')
  const [lootEventId, setLootEventId] = useState('')
  const [expandedEvents, setExpandedEvents] = useState({})
  const [showLootDropdown, setShowLootDropdown] = useState(false)
  const [showLootCharDropdown, setShowLootCharDropdown] = useState(false)

  const nameToChar = useMemo(() => {
    const m = {}
    characters.forEach((c) => {
      const n = (c.name || '').trim()
      if (n) m[n.toLowerCase()] = { char_id: c.char_id, name: n }
    })
    return m
  }, [characters])

  const nameToChars = useMemo(() => indexCharactersByName(characters), [characters])

  const memberRows = useMemo(() => {
    const rows = []
    const seenCharId = new Set()
    for (const c of characters) {
      const charId = c?.char_id != null ? String(c.char_id).trim() : ''
      const name = (c?.name || '').trim()
      if (!charId || !name || seenCharId.has(charId)) continue
      seenCharId.add(charId)
      const accId = charIdToAccountId[charId]
      const accName = accId ? (accountIdToDisplayName[accId] || String(accId)) : ''
      rows.push({
        char_id: charId,
        name,
        label: accName ? `${name} (${accName})` : name,
      })
    }
    const counts = new Map()
    for (const row of rows) counts.set(row.label, (counts.get(row.label) || 0) + 1)
    return rows.map((row) => (
      counts.get(row.label) > 1 ? { ...row, label: `${row.label} (${row.char_id})` } : row
    ))
  }, [characters, charIdToAccountId, accountIdToDisplayName])

  const attendingMembers = useMemo(() => {
    const byId = new Map(memberRows.map((row) => [row.char_id, row]))
    return ticAttendingIds.map((id) => byId.get(id) || { char_id: id, name: id, label: id })
  }, [memberRows, ticAttendingIds])

  const availableMembers = useMemo(() => {
    const attendingIds = new Set(ticAttendingIds)
    const q = ticMemberQuery.toLowerCase().trim()
    return memberRows
      .filter((row) => !attendingIds.has(row.char_id))
      .filter((row) => !q || row.label.toLowerCase().includes(q))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [memberRows, ticAttendingIds, ticMemberQuery])

  const ticPreview = useMemo(() => {
    const existingAttendees = ticDestination === 'existing'
      ? eventAttendance.filter((row) => String(row.event_id) === String(appendEventId))
      : []
    return classifyTicAttendance(parseChannelList(ticPaste).names, {
      nameToChars,
      charIdToAccountId,
      existingAttendees,
      resolutions: ticResolutions,
      excludedCharIds: ticExcludedCharIds,
      explicitChars: attendingMembers.map((row) => ({ char_id: row.char_id, name: row.name })),
    })
  }, [ticPaste, ticDestination, appendEventId, eventAttendance, nameToChars, charIdToAccountId, ticResolutions, ticExcludedCharIds, attendingMembers])

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
    const accRes = await supabase.from('accounts').select('account_id, display_name, toon_names').limit(5000)
    const accNames = {}
    ;(accRes.data || []).forEach((a) => {
      if (a?.account_id) accNames[a.account_id] = (a.display_name || '').trim() || a.account_id
    })
    setAccounts(accRes.data || [])
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
      const [mobData, raidSrc] = await Promise.all([getDkpMobLoot(), getRaidItemSources()])
      setLootMobJson(mobData)
      setRaidItemSourcesJson(raidSrc)
      if (mobData) {
        const fromJson = new Set()
        Object.values(mobData).forEach((entry) => {
          ;(entry?.loot || []).forEach((l) => { if (l?.name) fromJson.add(l.name) })
        })
        setJsonLootItemNames([...fromJson])
      } else setJsonLootItemNames([])
    } catch (_) {
      setLootMobJson(null)
      setRaidItemSourcesJson(null)
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

  // When linked from Raids "+" with #add-raid, open the create panel
  useEffect(() => {
    if (location.hash !== '#add-raid') return
    setShowCreateRaid(true)
    const t = setTimeout(() => raidPasteRef.current?.focus(), 100)
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
      supabase.from('raid_loot_with_assignment').select('*').eq('raid_id', selectedRaidId),
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
    setEditingRaidName(false)
    setRaidNameDraft('')
    setRaidNameError('')
    loadSelectedRaid()
  }, [loadSelectedRaid])

  // After adding a tic, scroll to raid view so the new tic is visible
  useEffect(() => {
    if (ticResult?.event_id && raidEditSectionRef.current) {
      raidEditSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [ticResult?.event_id])

  useEffect(() => {
    if (events.length > 0 && (!appendEventId || !events.some((e) => e.event_id === appendEventId))) {
      setAppendEventId(events[0].event_id)
    } else if (events.length === 0) {
      if (appendEventId) setAppendEventId('')
      if (ticDestination === 'existing') setTicDestination('new')
    }
  }, [events, appendEventId, ticDestination])

  useEffect(() => {
    if (events.length > 0 && (!lootEventId || !events.some((e) => e.event_id === lootEventId))) {
      setLootEventId(events[0].event_id)
    } else if (events.length === 0 && lootEventId) {
      setLootEventId('')
    }
  }, [events, lootEventId])

  const handleCreateAccount = async () => {
    setNewAccountError('')
    setNewAccountResult(null)
    const displayName = newAccountDisplayName.trim()
    if (!displayName) {
      setNewAccountError('Enter a display name.')
      return
    }
    setNewAccountLoading(true)
    try {
      const duplicate = await findDuplicateAccountName(supabase, displayName)
      if (duplicate.taken) {
        setNewAccountError(duplicate.message)
        setNewAccountLoading(false)
        return
      }
    } catch (err) {
      setNewAccountError(err.message || 'Could not check existing accounts.')
      setNewAccountLoading(false)
      return
    }
    const { data: accountId, error: rpcErr } = await supabase.rpc('create_account', {
      p_display_name: displayName,
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
      setError('Enter the Raid Name.')
      setMutating(false)
      return
    }
    let dateVal = dateIso
    if (!dateVal) {
      const fields = raidWhenTouched
        ? { date: raidDate, time: raidTime }
        : floorNowInZone(new Date(), siteZone)
      const stamped = raidStartToStore(fields.date, fields.time, siteZone)
      if (!stamped.ok) {
        setError(stamped.error || 'Enter a raid date and time.')
        setMutating(false)
        return
      }
      dateVal = stamped.stored
    }
    const raid_id = generateRaidId()
    const { error: err } = await supabase.from('raids').insert({
      raid_id,
      raid_pool: '',
      raid_name: raidName.trim(),
      date: dateVal,
      date_iso: dateVal,
      attendees: null,
      url: '',
    })
    if (err) {
      setError(err.message)
      setMutating(false)
      return
    }
    await logOfficerAudit(supabase, {
      action: 'add_raid',
      target_type: 'raid',
      target_id: raid_id,
      delta: { r: raid_id, n: raidName.trim() },
    })
    setAddRaidResult({ raid_id, raid_name: raidName.trim() })
    setRaidPaste('')
    setShowCreateRaid(false)
    const newRaidRow = { raid_id, raid_name: raidName.trim(), date_iso: dateVal, date: dateVal }
    setRaids((prev) => {
      if (prev.some((r) => r.raid_id === raid_id)) return prev
      return [newRaidRow, ...prev]
    })
    setSelectedRaidId(raid_id)
    await loadRaids()
    setRaids((prev) => {
      if (prev.some((r) => r.raid_id === raid_id)) return prev
      return [newRaidRow, ...prev]
    })
    setMutating(false)
  }

  const handleAddTic = async () => {
    if (!selectedRaidId) {
      setError('Select a raid first.')
      return
    }
    const appending = ticDestination === 'existing'
    if (appending && !appendEventId) {
      setError('Select a tic first.')
      return
    }
    let timestamp = null
    if (!appending) {
      timestamp = newTicTimestamp(ticDate, ticTime, siteZone)
      if (!timestamp.ok) {
        setError(timestamp.error)
        return
      }
    }
    setMutating(true)
    setTicResult(null)
    setError('')
    const { names } = parseChannelList(ticPaste)
    if (names.length === 0 && ticAttendingIds.length === 0) {
      setError(showTicCharacterPicker
        ? 'No names found. Paste a channel log, one name per line, a comma-separated list, or move characters to Attending.'
        : 'No names found. Paste a channel log, one name per line, or a comma-separated list.')
      setMutating(false)
      return
    }
    const preview = ticPreview
    const duplicateDisplay = preview.duplicates.map((n) => getAccountCharacterDisplay(n))
    const sameAccountDisplay = preview.sameAccount.map((row) => getAccountCharacterDisplay(row.char_id))
    const alreadyDisplay = preview.alreadyPresent.map((row) => getAccountCharacterDisplay(row.char_id))
    const bucketResult = {
      unmatched: preview.unmatched.length > 0 ? preview.unmatched : null,
      duplicatesDisplay: duplicateDisplay.length > 0 ? duplicateDisplay : null,
      sameAccountDisplay: sameAccountDisplay.length > 0 ? sameAccountDisplay : null,
      alreadyPresentDisplay: alreadyDisplay.length > 0 ? alreadyDisplay : null,
    }

    if (preview.toAdd.length === 0) {
      setTicResult({
        appended: appending,
        added: 0,
        alreadyPresentCount: preview.alreadyPresent.length,
        matched: 0,
        matchedDisplay: [],
        ...bucketResult,
        event_id: appending ? appendEventId : null,
        missingFromThisTicDisplay: null,
        newThisTicDisplay: null,
        noTicAdded: true,
      })
      setMutating(false)
      return
    }

    if (appending) {
      const { data, error: attErr } = await supabase.rpc('add_attendees_to_existing_tic', {
        p_raid_id: selectedRaidId,
        p_event_id: appendEventId,
        p_attendees: preview.toAdd,
      })
      if (attErr) {
        setError(attErr.message)
        setMutating(false)
        return
      }
      const added = Number(data?.added || 0)
      const alreadyFromServer = Number(data?.already_present || 0)
      const invalidNames = Array.isArray(data?.invalid_names) ? data.invalid_names : []
      const sameFromServer = Array.isArray(data?.skipped_same_account_names) ? data.skipped_same_account_names : []
      const alreadyFromServerNames = Array.isArray(data?.already_present_names) ? data.already_present_names : []
      const matchedDisplay = added === preview.toAdd.length
        ? preview.toAdd.map((row) => getAccountCharacterDisplay(row.char_id))
        : (Array.isArray(data?.added_names) ? data.added_names : []).map((name) => getAccountCharacterDisplay(name))
      if (added > 0) {
        await logOfficerAudit(supabase, {
          action: 'add_attendees_to_tic',
          target_type: 'raid_event',
          target_id: appendEventId,
          delta: { r: selectedRaidId, e: appendEventId, n: added },
        })
      }
      setTicResult({
        appended: true,
        added,
        alreadyPresentCount: preview.alreadyPresent.length + alreadyFromServer,
        matched: added,
        matchedDisplay,
        unmatched: [...preview.unmatched, ...invalidNames].length > 0 ? [...preview.unmatched, ...invalidNames] : null,
        duplicatesDisplay: bucketResult.duplicatesDisplay,
        sameAccountDisplay: [...sameAccountDisplay, ...sameFromServer].length > 0 ? [...sameAccountDisplay, ...sameFromServer] : null,
        alreadyPresentDisplay: [...alreadyDisplay, ...alreadyFromServerNames.map((name) => getAccountCharacterDisplay(name))].length > 0
          ? [...alreadyDisplay, ...alreadyFromServerNames.map((name) => getAccountCharacterDisplay(name))]
          : null,
        event_id: appendEventId,
        missingFromThisTicDisplay: null,
        newThisTicDisplay: null,
        noTicAdded: added === 0,
      })
      setTicPaste('')
      setTicResolutions({})
      setTicExcludedCharIds([])
      setTicAttendingIds([])
      setAvailableHighlight([])
      setAttendingHighlight([])
      setExpandedEvents((prev) => ({ ...prev, [appendEventId]: true }))
      try { sessionStorage.removeItem('dkp_leaderboard_v2') } catch (_) {}
      await loadSelectedRaid()
      globalMutate(DKP_DATA_KEY)
      setMutating(false)
      return
    }

    const dkpValue = parseFloat(ticDkpValue) || 1
    const event_id = timestamp.eventId
    const maxOrder = Math.max(0, ...events.map((e) => e.event_order || 0))
    const nextOrder = maxOrder + 1
    const matched = preview.toAdd
    const onTime = nextOrder === 1
    const eventName = dkpTicEventName(ticTime, { onTime }) || (onTime ? 'on-time' : 'DKP tic')

    const { error: evErr } = await supabase.rpc('add_officer_tic', {
      p_raid_id: selectedRaidId,
      p_event_id: event_id,
      p_event_order: nextOrder,
      p_event_name: eventName,
      p_dkp_value: String(dkpValue),
      p_event_time: timestamp.stored,
      p_attendees: matched,
    })
    if (evErr) {
      setError(evErr.message)
      setMutating(false)
      return
    }

    // Delta vs other tics in this raid: account-based so toon swaps are not shown as missing/new
    const currentTicAccountKeys = new Set(matched.map((m) => String(charIdToAccountId[m.char_id] ?? m.char_id)))
    const seenPrevAccount = new Set()
    const missingFromThisTic = []
    eventAttendance.forEach((row) => {
      const cid = String(row.char_id ?? '').trim()
      if (!cid) return
      const accountKey = String(charIdToAccountId[row.char_id] ?? row.char_id)
      if (currentTicAccountKeys.has(accountKey)) return
      if (seenPrevAccount.has(accountKey)) return
      seenPrevAccount.add(accountKey)
      missingFromThisTic.push(row.character_name || row.char_id || cid)
    })
    missingFromThisTic.sort((a, b) => String(a).localeCompare(b))
    const prevTicAccountKeys = new Set(eventAttendance.map((r) => String(charIdToAccountId[r.char_id] ?? r.char_id)))
    const newThisTic = events.length === 0
      ? matched.map((m) => m.character_name)
      : matched.filter((m) => !prevTicAccountKeys.has(String(charIdToAccountId[m.char_id] ?? m.char_id))).map((m) => m.character_name)

    const fmt = (charId) => getAccountCharacterDisplay(charId)
    const resolve = (s) => nameToChar[String(s).toLowerCase().trim()] || null

    setTicResult({
      appended: false,
      matched: matched.length,
      matchedDisplay: matched.map((m) => fmt(m.char_id)),
      ...bucketResult,
      event_id,
      missingFromThisTicDisplay: missingFromThisTic.length > 0 ? missingFromThisTic.map((s) => { const c = resolve(s); return c ? fmt(c.char_id) : s }) : null,
      newThisTicDisplay: newThisTic.length > 0 ? newThisTic.map((s) => { const c = resolve(s); return c ? fmt(c.char_id) : s }) : null,
      noTicAdded: false,
    })
    setTicPaste('')
    setTicResolutions({})
    setTicExcludedCharIds([])
    setTicAttendingIds([])
    setAvailableHighlight([])
    setAttendingHighlight([])
    setExpandedEvents((prev) => ({ ...prev, [event_id]: true }))
    await logOfficerAudit(supabase, {
      action: 'add_tic',
      target_type: 'raid_event',
      target_id: event_id,
      delta: { r: selectedRaidId, e: event_id, v: String(dkpValue), n: matched.length },
    })
    try { sessionStorage.removeItem('dkp_leaderboard_v2') } catch (_) {}
    await loadSelectedRaid()
    globalMutate(DKP_DATA_KEY)
    setMutating(false)
  }

  const handleAddEmptyTic = async () => {
    if (!selectedRaidId) {
      setError('Select a raid first.')
      return
    }
    if (events.length > 0) return
    const timestamp = newTicTimestamp(ticDate, ticTime, siteZone)
    if (!timestamp.ok) {
      setError(timestamp.error)
      return
    }
    setMutating(true)
    setError('')
    const event_id = timestamp.eventId
    const dkpValue = String(parseFloat(ticDkpValue) || 1)
    const { error: evErr } = await supabase.from('raid_events').insert({
      raid_id: selectedRaidId,
      event_id,
      event_order: 1,
      event_name: dkpTicEventName(ticTime, { onTime: true }) || 'on-time',
      dkp_value: dkpValue,
      attendee_count: '0',
      event_time: timestamp.stored,
    })
    if (evErr) {
      setError(evErr.message)
      setMutating(false)
      return
    }
    await logOfficerAudit(supabase, {
      action: 'add_tic',
      target_type: 'raid_event',
      target_id: event_id,
      delta: { r: selectedRaidId, e: event_id, v: dkpValue, n: 0 },
    })
    try { sessionStorage.removeItem('dkp_leaderboard_v2') } catch (_) {}
    await loadSelectedRaid()
    globalMutate(DKP_DATA_KEY)
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
    const picked = lootCharId
      ? characters.find((row) => String(row.char_id) === String(lootCharId) && (row.name || '').trim())
      : null
    const char = picked
      ? { char_id: picked.char_id, name: picked.name.trim() }
      : nameToChar[characterName.toLowerCase()]
    if (!char) {
      setError(useCharacterAdminSelectors
        ? 'Character not on DKP list. Pick a character from the list so the loot can be linked.'
        : 'Select an account from the list so the loot can be linked to a character.')
      return
    }
    setMutating(true)
    setLootResult(null)
    setError('')
    const event_id = lootEventId || (events.length > 0 ? events[0].event_id : 'loot')
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
    await logOfficerAudit(supabase, {
      action: 'add_loot',
      target_type: 'raid_loot',
      target_id: null,
      delta: { r: selectedRaidId, i: itemName, c: char.name, cost: String(isNaN(cost) ? 0 : cost) },
    })
    const recipientAccountId = (() => {
      const a = charIdToAccountId[String(char.char_id)] ?? charIdToAccountId[char.char_id]
      return a ? String(a) : null
    })()
    setLootResult({
      itemName,
      characterName: char.name,
      cost: isNaN(cost) ? 0 : cost,
      unlinkedAccountWarning: !recipientAccountId
        ? `${char.name} is not linked to any DKP account. This loot will not count toward account totals until you link this character on that account’s page (Characters tab).`
        : undefined,
    })
    setLootItemQuery('')
    setLootCharName('')
    setLootCost('0')
    setItemNames((prev) => {
      const key = itemName.trim().toLowerCase()
      if (prev.some((n) => (n || '').trim().toLowerCase() === key)) return prev
      return [...prev, itemName].sort((a, b) => a.localeCompare(b))
    })
    try { sessionStorage.removeItem('dkp_leaderboard_v2') } catch (_) {}
    await loadSelectedRaid()
    globalMutate(DKP_DATA_KEY)
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
    const event_id = lootEventId || (events.length > 0 ? events[0].event_id : 'loot')
    const knownItemSet = new Set(allItemNamesForLootLog.map((n) => (n || '').trim().toLowerCase()))
    const itemNameByLower = {}
    allItemNamesForLootLog.forEach((n) => { if (n) itemNameByLower[n.trim().toLowerCase()] = n })
    const playerNotFound = []
    const itemNotFound = []
    const missingDkpAmount = []
    const insertedItems = []
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
          if (!err) {
            inserted++
            insertedItems.push({ i: canonicalItemName, c: char.name, cost: String(line.cost) })
          }
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
    const unlinkedNamesFromLog = [...new Set(
      insertedItems
        .map((item) => {
          const ch = nameToChar[(item.c || '').toLowerCase()]
          if (!ch) return null
          const aid = charIdToAccountId[String(ch.char_id)] ?? charIdToAccountId[ch.char_id]
          return aid ? null : ch.name
        })
        .filter(Boolean)
    )]
    if (inserted > 0) {
      await logOfficerAudit(supabase, {
        action: 'add_loot_from_log',
        target_type: 'raid_loot',
        target_id: null,
        delta: { r: selectedRaidId, cnt: inserted, items: insertedItems },
      })
      try { sessionStorage.removeItem('dkp_leaderboard_v2') } catch (_) {}
    }
    setLootResult({
      fromLog: true,
      inserted,
      total: totalRows,
      insertedItems,
      unlinkedAccountWarning:
        unlinkedNamesFromLog.length > 0
          ? `These characters are not linked to any DKP account — loot will not count toward account totals until linked on the account page: ${unlinkedNamesFromLog.join(', ')}.`
          : undefined,
    })
    if (playerNotFound.length === 0 && itemNotFound.length === 0) setLootLogPaste('')
    await loadSelectedRaid()
    globalMutate(DKP_DATA_KEY)
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
    const raidName = raid?.raid_name ?? selectedRaidId
    const { error: err } = await supabase.rpc('delete_raid', { p_raid_id: selectedRaidId })
    if (err) {
      setDeleteError(err.message)
      setMutating(false)
      return
    }
    await logOfficerAudit(supabase, {
      action: 'raid_deleted',
      target_type: 'raid',
      target_id: selectedRaidId,
      delta: { r: selectedRaidId, n: raidName },
    })
    const { error: refreshErr } = await supabase.rpc('refresh_account_dkp_summary')
    if (refreshErr) setDeleteError(refreshErr.message)
    try { sessionStorage.removeItem('dkp_leaderboard_v2') } catch (_) {}
    globalMutate(DKP_DATA_KEY)
    setSelectedRaidId('')
    setDeleteConfirm('')
    await loadRaids()
    loadSelectedRaid()
    setMutating(false)
  }

  const handleSaveRaidName = async () => {
    if (!selectedRaidId) return
    const next = raidNameDraft.trim()
    if (!next) {
      setRaidNameError('Enter a raid name.')
      return
    }
    const current = (raid?.raid_name || '').trim()
    if (next === current) {
      setEditingRaidName(false)
      setRaidNameError('')
      return
    }
    setMutating(true)
    setRaidNameError('')
    const { error: err } = await supabase.from('raids').update({ raid_name: next }).eq('raid_id', selectedRaidId)
    setMutating(false)
    if (err) {
      setRaidNameError(err.message)
      return
    }
    await logOfficerAudit(supabase, {
      action: 'rename_raid',
      target_type: 'raid',
      target_id: selectedRaidId,
      delta: { r: selectedRaidId, from: current, n: next },
    })
    setEditingRaidName(false)
    setRaid((prev) => (prev ? { ...prev, raid_name: next } : prev))
    setRaids((prev) => prev.map((row) => (row.raid_id === selectedRaidId ? { ...row, raid_name: next } : row)))
  }

  const handleSaveEventDkp = async (eventId) => {
    const val = String(editingEventDkp).trim()
    if (val === '' || !selectedRaidId) return
    setMutating(true)
    const { error: err } = await supabase.from('raid_events').update({ dkp_value: val }).eq('raid_id', selectedRaidId).eq('event_id', eventId)
    setMutating(false)
    if (err) setError(err.message)
    else {
      await logOfficerAudit(supabase, {
        action: 'edit_event_dkp',
        target_type: 'raid_event',
        target_id: eventId,
        delta: { r: selectedRaidId, e: eventId, v: val },
      })
      setEditingEventId(null)
      loadSelectedRaid()
      globalMutate(DKP_DATA_KEY)
    }
  }

  const handleSaveEventTime = async (eventId) => {
    if (!selectedRaidId) return
    const existing = events.find((e) => e.event_id === eventId)
    const result = eventTimeToStore({
      original: existing?.event_time ?? '',
      date: editingEventDate,
      time: editingEventTime,
      raidDateIso: raid?.date_iso || raid?.date || '',
      eventId,
      timeZone: siteZone,
    })
    if (!result.ok) {
      setError(result.error)
      return
    }
    if (result.unchanged) {
      setError('')
      setEditingEventTimeId(null)
      return
    }
    setMutating(true)
    const patch = eventFieldsForTimeSave(existing?.event_name, result.stored, editingEventTime, existing?.event_order)
    const { error: err } = await supabase.from('raid_events').update(patch).eq('raid_id', selectedRaidId).eq('event_id', eventId)
    setMutating(false)
    if (err) setError(err.message)
    else {
      setError('')
      await logOfficerAudit(supabase, {
        action: 'edit_event_time',
        target_type: 'raid_event',
        target_id: eventId,
        delta: { r: selectedRaidId, e: eventId, t: result.stored },
      })
      setEditingEventTimeId(null)
      loadSelectedRaid()
      globalMutate(DKP_DATA_KEY)
    }
  }

  const handleSaveLootCost = async (row) => {
    const val = String(editingLootCost).trim()
    setMutating(true)
    const { error: err } = await supabase.from('raid_loot').update({ cost: val }).eq('id', row.id)
    setMutating(false)
    if (err) setError(err.message)
    else {
      await logOfficerAudit(supabase, {
        action: 'edit_loot_cost',
        target_type: 'raid_loot',
        target_id: String(row.id),
        delta: { r: selectedRaidId, l: row.id, i: row.item_name, c: val },
      })
      setEditingLootId(null)
      try { sessionStorage.removeItem('dkp_leaderboard_v2') } catch (_) {}
      loadSelectedRaid()
      globalMutate(DKP_DATA_KEY)
    }
  }

  const handleSaveLootEvent = async (row, eventId) => {
    if (!row?.id || !eventId || String(eventId) === String(row.event_id ?? '')) return
    const tic = events.find((e) => String(e.event_id) === String(eventId))
    setMutating(true)
    const { error: err } = await supabase.from('raid_loot').update({ event_id: eventId }).eq('id', row.id)
    setMutating(false)
    if (err) setError(err.message)
    else {
      await logOfficerAudit(supabase, {
        action: 'edit_loot_tic',
        target_type: 'raid_loot',
        target_id: String(row.id),
        delta: { r: selectedRaidId, l: row.id, i: row.item_name, e: tic ? ticOptionLabel(tic, raid?.date_iso || raid?.date || '', siteZone) : eventId },
      })
      try { sessionStorage.removeItem('dkp_leaderboard_v2') } catch (_) {}
      loadSelectedRaid()
      globalMutate(DKP_DATA_KEY)
    }
  }

  const handleDeleteLoot = async (row) => {
    const msg = `Are you sure you want to remove this loot?\n\n"${row.item_name || 'Item'}" from ${row.character_name || 'character'}\n\nThis cannot be undone.`
    if (!window.confirm(msg)) return
    setMutating(true)
    const { error: err } = await supabase.from('raid_loot').delete().eq('id', row.id)
    setMutating(false)
    if (err) setError(err.message)
    else {
      await logOfficerAudit(supabase, {
        action: 'delete_loot',
        target_type: 'raid_loot',
        target_id: String(row.id),
        delta: { r: selectedRaidId, l: row.id, i: row.item_name, c: row.character_name, cost: row.cost },
      })
      try { sessionStorage.removeItem('dkp_leaderboard_v2') } catch (_) {}
      loadSelectedRaid()
      globalMutate(DKP_DATA_KEY)
    }
  }

  const handleDeleteEvent = async (eventId) => {
    if (!window.confirm('Are you sure you want to remove this DKP tic and all its attendance?\n\nThis cannot be undone.')) return
    const attendeesOnTic = (eventAttendance || []).filter((r) => String(r.event_id) === String(eventId))
    const accountIdsOnTic = [...new Set(
      attendeesOnTic.map((r) => charIdToAccountId[String(r.char_id)] ?? charIdToAccountId[r.char_id]).filter(Boolean)
    )].map(String)
    setMutating(true)
    setError(null)
    const { error: err } = await supabase.rpc('delete_tic', {
      p_raid_id: selectedRaidId,
      p_event_id: eventId,
      p_extra_account_ids: accountIdsOnTic,
    })
    if (err) {
      setMutating(false)
      setError(err.message)
      return
    }
    await logOfficerAudit(supabase, {
      action: 'delete_event',
      target_type: 'raid_event',
      target_id: eventId,
      delta: { r: selectedRaidId, e: eventId },
    })
    try { sessionStorage.removeItem('dkp_leaderboard_v2') } catch (_) {}
    loadSelectedRaid()
    globalMutate(DKP_DATA_KEY)
    setMutating(false)
  }

  const handleRemoveAttendeeFromTic = async (eventId, charId, charName) => {
    if (!selectedRaidId || !window.confirm(`Remove ${charName || charId} from this tic?`)) return
    const removedAccountId = charIdToAccountId[charId] ? String(charIdToAccountId[charId]) : null
    setMutating(true)
    setError(null)
    const { error: rpcErr } = await supabase.rpc('remove_attendee_from_tic', {
      p_raid_id: selectedRaidId,
      p_event_id: eventId,
      p_char_id: String(charId ?? ''),
      p_extra_account_ids: removedAccountId ? [removedAccountId] : [],
    })
    if (rpcErr) {
      setMutating(false)
      setError(rpcErr.message)
      return
    }
    await logOfficerAudit(supabase, {
      action: 'remove_attendee_from_tic',
      target_type: 'raid_event_attendance',
      target_id: eventId,
      delta: { r: selectedRaidId, e: eventId, c: charName },
    })
    try { sessionStorage.removeItem('dkp_leaderboard_v2') } catch (_) {}
    loadSelectedRaid()
    globalMutate(DKP_DATA_KEY)
    setMutating(false)
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

  const raidDateIso = raid?.date_iso || raid?.date || ''
  const lootSections = useMemo(() => groupRaidLootByEvent(loot, events, raidDateIso, siteZone), [loot, events, raidDateIso, siteZone])
  const officerItemNameToId = useMemo(() => buildItemNameToIdMap(lootMobJson), [lootMobJson])
  const officerMobLookups = useMemo(
    () => buildLootMobLookups(lootMobJson, raidItemSourcesJson),
    [lootMobJson, raidItemSourcesJson]
  )
  const lootSectionsWithMobs = useMemo(
    () =>
      lootSections.map((section) => ({
        ...section,
        mobGroups: subgroupLootRowsByMob(section.rows, officerItemNameToId, officerMobLookups),
      })),
    [lootSections, officerItemNameToId, officerMobLookups]
  )

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
  const characterAccountRows = useMemo(
    () => Object.entries(charIdToAccountId).map(([char_id, account_id]) => ({ char_id, account_id })),
    [charIdToAccountId]
  )
  const accountAdminRows = useMemo(
    () => buildAccountAdminRows(characters, characterAccountRows, accounts),
    [characters, characterAccountRows, accounts]
  )
  const filteredLootCharacterNames = useMemo(() => {
    const q = lootCharName.toLowerCase().trim()
    if (!q) return characterNamesList.slice(0, 200)
    return characterNamesList.filter((n) => n.toLowerCase().includes(q)).slice(0, 200)
  }, [characterNamesList, lootCharName])
  const filteredLootAccounts = useMemo(
    () => filterAccountAdminRows(accountAdminRows, lootCharName).slice(0, 200),
    [accountAdminRows, lootCharName]
  )

  const showLootCharDropdownList = showLootCharDropdown

  const filteredRaids = useMemo(() => {
    const q = raidPickerQuery.toLowerCase().trim()
    const list = !q
      ? raids
      : raids.filter((r) => {
          const shown = formatRaidSchedule(r.date_iso || r.date || '', siteZone).label
          const label = `${shown} ${r.date_iso || r.date || ''} ${r.raid_name || ''} ${r.raid_id || ''}`.toLowerCase()
          return label.includes(q)
        })
    return list.slice(0, q ? 80 : 40)
  }, [raids, raidPickerQuery, siteZone])

  const selectedRaidLabel = useMemo(() => {
    const row = raid || raids.find((r) => r.raid_id === selectedRaidId)
    if (!row) return ''
    const shown = formatRaidSchedule(row.date_iso || row.date || '', siteZone).label
    return `${shown || '—'} · ${row.raid_name || row.raid_id}`
  }, [raid, raids, selectedRaidId, siteZone])

  const attendeeCount = attendance.length > 0
    ? attendance.length
    : (raid?.attendees != null && raid.attendees !== '' ? Math.round(Number(raid.attendees)) : 0)

  const addRaidSectionRef = useRef(null)
  const raidPasteRef = useRef(null)
  const raidEditSectionRef = useRef(null)
  const ticPasteRef = useRef(ticPaste)
  ticPasteRef.current = ticPaste
  const ticDraftRef = useRef(null)
  ticDraftRef.current = {
    ticPaste,
    ticResolutions,
    ticExcludedCharIds,
    ticAttendingIds,
    ticDestination,
    ticDkpValue,
    ticDate,
    ticTime,
    ticDateTimeTouched,
  }
  const ticRaidRef = useRef(selectedRaidId)
  const skipTicDraftWrite = useRef(true)

  useEffect(() => {
    const previousRaidId = ticRaidRef.current
    if (previousRaidId && previousRaidId !== selectedRaidId) {
      writeTicDraft(sessionStorage, previousRaidId, ticDraftRef.current)
    }
    ticRaidRef.current = selectedRaidId
    skipTicDraftWrite.current = true
    const draft = readTicDraft(sessionStorage, selectedRaidId)
    if (draft) {
      setTicPaste(draft.ticPaste)
      setTicResolutions(draft.ticResolutions)
      setTicExcludedCharIds(draft.ticExcludedCharIds)
      setTicAttendingIds(draft.ticAttendingIds)
      setTicDestination(draft.ticDestination)
      setTicDkpValue(draft.ticDkpValue)
      setTicDate(draft.ticDate)
      setTicTime(draft.ticTime)
      setTicDateTimeTouched(draft.ticDateTimeTouched)
    } else {
      const defaults = defaultTicFields(raid?.date_iso || raid?.date || '', new Date(), siteZone)
      setTicPaste('')
      setTicResolutions({})
      setTicExcludedCharIds([])
      setTicDestination('new')
      setTicDkpValue('1')
      setTicDate(defaults.date)
      setTicTime(defaults.time)
      setTicDateTimeTouched(false)
      setTicAttendingIds([])
    }
    setAvailableHighlight([])
    setAttendingHighlight([])
    setTicMemberQuery('')
    availableAnchorRef.current = null
    attendingAnchorRef.current = null
  }, [selectedRaidId, siteZone])

  useEffect(() => {
    if (skipTicDraftWrite.current) {
      skipTicDraftWrite.current = false
      return
    }
    if (!selectedRaidId) return
    writeTicDraft(sessionStorage, selectedRaidId, {
      ticPaste,
      ticResolutions,
      ticExcludedCharIds,
      ticAttendingIds,
      ticDestination,
      ticDkpValue,
      ticDate,
      ticTime,
      ticDateTimeTouched,
    })
  }, [selectedRaidId, ticPaste, ticResolutions, ticExcludedCharIds, ticAttendingIds, ticDestination, ticDkpValue, ticDate, ticTime, ticDateTimeTouched])

  useEffect(() => {
    if (firstEqStampInPaste(ticPaste, siteZone)) return
    const date = raidLocalCalendarDate(raid?.date_iso || raid?.date || '', siteZone)
    if (!date) return
    setTicDate((current) => (ticDateTimeTouched && current ? current : date))
  }, [raid?.date_iso, raid?.date, ticDateTimeTouched, ticPaste, siteZone])

  useEffect(() => {
    if (ticDateTimeTouched) return
    const stamp = firstEqStampInPaste(ticPaste, siteZone)
    if (!stamp) return
    setTicDate(stamp.date)
    setTicTime(stamp.time)
  }, [ticPaste, ticDateTimeTouched, siteZone])

  useEffect(() => {
    if (!showCreateRaid || raidWhenTouched) return
    const nowFields = floorNowInZone(new Date(), siteZone)
    setRaidDate(nowFields.date)
    setRaidTime(nowFields.time)
  }, [showCreateRaid, raidWhenTouched, siteZone])

  const focusAddRaid = () => {
    setRaidWhenTouched(false)
    setShowCreateRaid(true)
    setTimeout(() => {
      addRaidSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      raidPasteRef.current?.focus()
    }, 50)
  }

  if (!isOfficer) return null

  const appendEvent = events.find((e) => e.event_id === appendEventId) || null
  const showTicPreview = ticPreview.resolved.length > 0
    || ticPreview.ambiguous.length > 0
    || ticPreview.unmatched.length > 0
    || ticPreview.duplicates.length > 0
    || ticPreview.sameAccount.length > 0
    || ticPreview.alreadyPresent.length > 0
  const toggleTicChar = (charId) => {
    setTicExcludedCharIds((prev) => (
      prev.includes(charId) ? prev.filter((id) => id !== charId) : [...prev, charId]
    ))
  }

  const highlightMember = (id, index, shiftKey, rows, setHighlight, anchorRef) => {
    if (shiftKey && anchorRef.current != null) {
      const start = Math.min(anchorRef.current, index)
      const end = Math.max(anchorRef.current, index)
      const range = rows.slice(start, end + 1).map((row) => row.char_id)
      setHighlight((prev) => [...new Set([...prev, ...range])])
      return
    }
    anchorRef.current = index
    setHighlight((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const moveToAttending = (ids) => {
    const unique = [...new Set((ids || []).map((id) => String(id)).filter(Boolean))]
    if (unique.length === 0) return
    setTicAttendingIds((prev) => [...new Set([...prev, ...unique])])
    setAvailableHighlight((prev) => prev.filter((id) => !unique.includes(id)))
    setTicResult(null)
  }

  const moveToAvailable = (ids) => {
    const drop = new Set((ids || []).map((id) => String(id)))
    if (drop.size === 0) return
    setTicAttendingIds((prev) => prev.filter((id) => !drop.has(id)))
    setAttendingHighlight((prev) => prev.filter((id) => !drop.has(id)))
    setTicExcludedCharIds((prev) => prev.filter((id) => !drop.has(String(id))))
    setTicResult(null)
  }

  return (
    <div className="container container--officer">
      <h1>Raid Admin</h1>
      <p style={{ color: '#a1a1aa' }}>
        Add raids from Discord, paste DKP tics (channel lists), add loot manually or from logs. All edits require officer permissions.
      </p>
      <section className="card officer-tools">
        <h2 style={{ marginTop: 0 }}>Officer tools</h2>
        <p style={{ marginBottom: 0 }}>
          <Link to="/officer/dkp-changelog">DKP changelog</Link>
          {' · '}
          <Link to="/officer/who-parser">Who parser</Link>
          {' · '}
          <Link to="/tools/discord-schedule">Discord schedule</Link>
          {' · '}
          <Link to="/officer/raider-activity">Raider Activity</Link>
        </p>
        <details>
          <summary>Create new DKP account</summary>
          <p className="officer-hint">
            Create an account that a player can then claim on the account page. Share the account link with them.
            {' '}
            <strong>Link every character</strong> that may appear on tics or receive loot (open the account → Characters → add); otherwise tics or loot may not count toward that account’s totals.
          </p>
          <div className="officer-field-row">
            <input
              type="text"
              placeholder="Display name (e.g. player main)"
              value={newAccountDisplayName}
              onChange={(e) => setNewAccountDisplayName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateAccount()}
            />
            <button type="button" className="btn" onClick={handleCreateAccount} disabled={newAccountLoading}>
              {newAccountLoading ? 'Creating…' : 'Create account'}
            </button>
          </div>
          {newAccountError && <p className="error" style={{ marginTop: '0.5rem', marginBottom: 0 }}>{newAccountError}</p>}
          {newAccountResult && (
            <p className="officer-success" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
              Created. <Link to={`/accounts/${newAccountResult}`}>View account</Link> — add characters on the Characters tab (create does not auto-attach toons), then share the link so the player can claim it.
            </p>
          )}
        </details>
      </section>

      <div className="officer-raid-bar">
        <div className="officer-raid-picker">
          <input
            type="search"
            value={raidPickerQuery}
            onChange={(e) => { setRaidPickerQuery(e.target.value); setShowRaidPicker(true) }}
            onFocus={() => setShowRaidPicker(true)}
            onBlur={() => setTimeout(() => setShowRaidPicker(false), 200)}
            placeholder={selectedRaidLabel || 'Search raids by name or date'}
            aria-label="Search raids"
            aria-expanded={showRaidPicker}
            aria-controls="officer-raid-picker-list"
            autoComplete="off"
          />
          {showRaidPicker && (
            <ul id="officer-raid-picker-list" className="officer-raid-picker-list" role="listbox">
              {filteredRaids.length === 0 ? (
                <li className="officer-raid-picker-empty">{raids.length === 0 ? 'Loading raids…' : 'No matching raids'}</li>
              ) : (
                filteredRaids.map((r) => (
                  <li
                    key={r.raid_id}
                    role="option"
                    aria-selected={r.raid_id === selectedRaidId}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      setSelectedRaidId(r.raid_id)
                      setRaidPickerQuery('')
                      setShowRaidPicker(false)
                    }}
                  >
                    {formatRaidSchedule(r.date_iso || r.date || '', siteZone).label || '—'} · {r.raid_name || r.raid_id}
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
        {selectedRaidId && raid && (
          <p className="officer-raid-status">
            {events.length} tics · {loot.length} loot · {attendeeCount} attendees
          </p>
        )}
        <div className="officer-raid-bar-actions">
          {selectedRaidId && <Link to={`/raids/${selectedRaidId}`}>View raid</Link>}
          <button type="button" className="btn" onClick={focusAddRaid}>+ New raid</button>
        </div>
      </div>
      {error && <p className="error officer-error" role="alert">{error}</p>}
      {addRaidResult && !showCreateRaid && (
        <p className="officer-success">
          Created <Link to={`/raids/${addRaidResult.raid_id}`}>{addRaidResult.raid_name}</Link>. Add tics and loot below.
        </p>
      )}

      {showCreateRaid && (
        <section ref={addRaidSectionRef} className="card officer-create">
          <h2 style={{ marginTop: 0 }}>Add raid</h2>
          <p className="officer-hint">
            {raidNameOnly
              ? 'Enter the Raid Name. Date and time use your profile timezone unless the text includes a Discord date.'
              : 'Paste a Discord raid line. The name is the text after the colon, and the date is the text after the last dash. When that line has no date, the date and time below are your profile timezone.'}
          </p>
          <textarea
            ref={raidPasteRef}
            className="officer-paste"
            value={raidPaste}
            onChange={(e) => setRaidPaste(e.target.value)}
            placeholder={raidNameOnly
              ? 'Enter the Raid Name'
              : 'Friday 10/09 12:46pm est: Water Minis - October 9, 2026 12:46 PM'}
            rows={raidNameOnly ? 2 : 3}
            aria-label={raidNameOnly ? 'Raid name' : 'Discord raid line'}
          />
          {parseRaidString(raidPaste).dateIso ? (
            <p className="officer-hint">The Discord date in the text is stored for this raid.</p>
          ) : (
            <div className="officer-field-row" style={{ marginTop: '0.5rem' }}>
              <TicDateTimeFields
                idPrefix="new-raid"
                date={raidDate}
                time={raidTime}
                dateLabel="Date"
                timeLabel="Time"
                onDateChange={(value) => { setRaidWhenTouched(true); setRaidDate(value) }}
                onTimeChange={(value) => { setRaidWhenTouched(true); setRaidTime(value) }}
              />
            </div>
          )}
          <div className="officer-field-row" style={{ marginTop: '0.5rem' }}>
            <button type="button" className="btn" onClick={handleAddRaid} disabled={mutating || !raidPaste.trim()}>
              {mutating ? 'Creating…' : 'Create raid'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setShowCreateRaid(false)}>Cancel</button>
          </div>
        </section>
      )}

      {!selectedRaidId && !showCreateRaid && (
        <p className="officer-empty">Select a raid above, or create one.</p>
      )}
      {selectedRaidId && !raid && <p>Loading raid…</p>}

      {selectedRaidId && raid && (
        <div className="officer-workspace">
          <div className="officer-col">
          <section className="card">
            <h2 style={{ marginTop: 0 }}>Add DKP tic (attendance)</h2>
            <p className="officer-hint">
              {showTicCharacterPicker
                ? 'Paste a channel member list, one name per line, or a comma-separated list. Or move characters to Attending. Names are matched to the DKP list before anything is saved.'
                : 'Paste a channel member list, one name per line, or a comma-separated list. Names are matched to the DKP list before anything is saved.'}
            </p>
            <details className="officer-hint">
              <summary>How matching works</summary>
              <p>
                Each comma-separated name is matched by exact character name (case-insensitive). Only names on the DKP list receive credit. One credit per account per tic — duplicates in the paste and other toons on the same account are skipped and listed. A name shared by more than one character stays out until you pick one. DKP is credited to the character&apos;s linked account.
              </p>
            </details>
            <div className="officer-tic-choice" role="radiogroup" aria-label="Tic destination">
              <label>
                <input
                  type="radio"
                  name="tic-destination"
                  checked={ticDestination === 'new'}
                  onChange={() => { setTicDestination('new'); setTicResult(null) }}
                />
                New tic
              </label>
              <label>
                <input
                  type="radio"
                  name="tic-destination"
                  checked={ticDestination === 'existing'}
                  disabled={events.length === 0}
                  onChange={() => { setTicDestination('existing'); setTicResult(null) }}
                />
                Existing tic
              </label>
              {ticDestination === 'existing' && (
                <select
                  value={appendEventId}
                  onChange={(e) => { setAppendEventId(e.target.value); setTicResult(null) }}
                  aria-label="Existing tic to add attendance to"
                >
                  {events.map((e) => (
                    <option key={e.event_id} value={e.event_id}>
                      #{e.event_order} {displayTicEventName(e, raidDateIso, siteZone)} ({e.dkp_value} DKP)
                    </option>
                  ))}
                </select>
              )}
            </div>
            <textarea
              className="officer-paste"
              value={ticPaste}
              onChange={(e) => { setTicPaste(e.target.value); setTicResult(null) }}
              placeholder="Channel log, one name per line, or Name1, Name2, Name3"
              rows={5}
            />
            {showTicCharacterPicker ? (
              <TicMemberPicker
                memberQuery={ticMemberQuery}
                onMemberQueryChange={setTicMemberQuery}
                availableMembers={availableMembers}
                attendingMembers={attendingMembers}
                availableHighlight={availableHighlight}
                attendingHighlight={attendingHighlight}
                onAvailableClick={(id, index, shiftKey) => highlightMember(id, index, shiftKey, availableMembers, setAvailableHighlight, availableAnchorRef)}
                onAttendingClick={(id, index, shiftKey) => highlightMember(id, index, shiftKey, attendingMembers, setAttendingHighlight, attendingAnchorRef)}
                onMoveToAttending={moveToAttending}
                onMoveToAvailable={moveToAvailable}
                charactersLoading={characters.length === 0}
              />
            ) : ticAttendingIds.length > 0 && (
              <p className="officer-hint">
                {ticAttendingIds.length} character{ticAttendingIds.length === 1 ? '' : 's'} remain selected and will be included
                {attendingMembers.length > 0 ? `: ${attendingMembers.map((row) => row.label).join(', ')}` : ''}.
                {' '}
                <button type="button" className="btn btn-ghost" onClick={() => moveToAvailable(ticAttendingIds)}>
                  Clear selected characters
                </button>
              </p>
            )}
            {ticDestination === 'new' && (
              <>
                <div className="officer-field-row" style={{ marginTop: '0.5rem' }}>
                  <TicDateTimeFields
                    idPrefix="new-tic"
                    date={ticDate}
                    time={ticTime}
                    onDateChange={(value) => { setTicDateTimeTouched(true); setTicDate(value) }}
                    onTimeChange={(value) => { setTicDateTimeTouched(true); setTicTime(value) }}
                  />
                </div>
                <p className="officer-hint">Date starts as this raid&apos;s date. Time starts as now, Eastern, to the second. A channel timestamp fills these until you edit them.</p>
              </>
            )}
            {ticDestination === 'existing' && appendEvent && (
              <p className="officer-hint">
                #{appendEvent.event_order} {displayTicEventName(appendEvent, raidDateIso, siteZone)} · {appendEvent.dkp_value} DKP
                {appendEvent.event_time ? ` · ${appendEvent.event_time}` : ''}. People already on this tic stay on it.
              </p>
            )}
            {showTicPreview && (
              <div className="officer-result">
                {ticPreview.resolved.length > 0 && (
                  <div className="officer-result-group officer-result-group--ok">
                    <div className="officer-result-label">Resolved ({ticPreview.toAdd.length} selected)</div>
                    <div className="officer-result-names">
                      {ticPreview.resolved.map((row) => (
                        <label key={row.char_id} className="officer-result-name">
                          <input
                            type="checkbox"
                            checked={row.selected}
                            onChange={() => toggleTicChar(row.char_id)}
                          />
                          {getAccountCharacterDisplay(row.char_id)}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                {ticPreview.ambiguous.length > 0 && (
                  <div className="officer-result-group officer-result-group--warn">
                    <div className="officer-result-label">Ambiguous ({ticPreview.ambiguous.length})</div>
                    {ticPreview.ambiguous.map((row) => {
                      const key = row.pasteName.toLowerCase().trim()
                      return (
                        <div key={key} className="officer-resolve-row">
                          <span>{row.pasteName}</span>
                          <select
                            aria-label={`Choose character for ${row.pasteName}`}
                            value={ticResolutions[key] || ''}
                            onChange={(e) => setTicResolutions((prev) => ({ ...prev, [key]: e.target.value }))}
                          >
                            <option value="">Choose character</option>
                            {row.candidates.map((c) => (
                              <option key={c.char_id} value={c.char_id}>
                                {getAccountCharacterDisplay(c.char_id)} ({c.char_id})
                              </option>
                            ))}
                          </select>
                        </div>
                      )
                    })}
                  </div>
                )}
                <ResultNames label="Unmatched (not on DKP list)" names={ticPreview.unmatched} tone="warn" />
                <ResultNames label="Duplicates (not double-counted)" names={ticPreview.duplicates} tone="accent" />
                <ResultNames label="Same account (other toon already credited)" names={ticPreview.sameAccount.map((row) => getAccountCharacterDisplay(row.char_id))} tone="accent" />
                <ResultNames label="Already on this tic" names={ticPreview.alreadyPresent.map((row) => getAccountCharacterDisplay(row.char_id))} tone="muted" />
              </div>
            )}
            <div className="officer-field-row">
              {ticDestination === 'new' && (
                <>
                  <span className="officer-inline-label">DKP per attendee</span>
                  <input
                    className="officer-dkp-input"
                    type="number"
                    min={0}
                    step={0.5}
                    value={ticDkpValue}
                    onChange={(e) => setTicDkpValue(e.target.value)}
                  />
                </>
              )}
              <button
                type="button"
                className="btn"
                onClick={handleAddTic}
                disabled={mutating || (!ticPaste.trim() && ticAttendingIds.length === 0) || (ticDestination === 'existing' && !appendEventId)}
              >
                {mutating ? 'Adding…' : (ticDestination === 'existing' ? 'Add to tic' : 'Add tic')}
              </button>
            </div>
            {ticResult && (
              <div className="officer-result">
                {ticResult.appended ? (
                  ticResult.added > 0 ? (
                    <p className="officer-result-banner officer-result-banner--ok">
                      Added <strong>{ticResult.added}</strong>. Already on this tic: <strong>{ticResult.alreadyPresentCount || 0}</strong>.
                    </p>
                  ) : (
                    <p className="officer-result-banner officer-result-banner--warn">
                      <strong>No one new to add.</strong> Already on this tic: <strong>{ticResult.alreadyPresentCount || 0}</strong>.
                    </p>
                  )
                ) : ticResult.noTicAdded ? (
                  <p className="officer-result-banner officer-result-banner--warn"><strong>No tic added.</strong> No selected names were ready to credit.</p>
                ) : (
                  <p className="officer-result-banner officer-result-banner--ok">Tic added. Credited <strong>{ticResult.matched}</strong> attendee(s). Names shown as account (character).</p>
                )}
                <ResultNames label="Credited" names={ticResult.matchedDisplay} tone="ok" />
                <ResultNames label="Unmatched (not on DKP list)" names={ticResult.unmatched} tone="warn" />
                <ResultNames label="Duplicates (not double-counted)" names={ticResult.duplicatesDisplay} tone="accent" />
                <ResultNames label="Same account (other toon already credited)" names={ticResult.sameAccountDisplay} tone="accent" />
                <ResultNames label="Already on this tic" names={ticResult.alreadyPresentDisplay} tone="muted" />
                <ResultNames label="Missing from this tic" names={ticResult.missingFromThisTicDisplay} tone="alert" />
                <ResultNames label="New this tic" names={ticResult.newThisTicDisplay} tone="muted" />
              </div>
            )}
          </section>

          {/* Add loot */}
          <section className={`card${(showLootDropdown && filteredItemNames.length > 0) || showLootCharDropdownList ? ' officer-card--menu-open' : ''}`}>
            <h2 style={{ marginTop: 0 }}>Add loot</h2>
            <p className="officer-hint">
              {useCharacterAdminSelectors
                ? 'Pick an item, a character on the DKP list, a tic, and a cost. New loot starts on the first tic unless you pick another.'
                : 'Pick an item, an account, a tic, and a cost. The list shows the account and the character that will be credited. New loot starts on the first tic unless you pick another.'}
            </p>
            <div className="officer-loot-fields">
              <div className="officer-suggest-wrap">
                <input
                  type="text"
                  name="dkp-loot-item"
                  value={lootItemQuery}
                  onChange={(e) => { setLootItemQuery(e.target.value); setShowLootDropdown(true) }}
                  onFocus={() => setShowLootDropdown(true)}
                  onBlur={() => setTimeout(() => setShowLootDropdown(false), 150)}
                  placeholder="Item name (filter list or type new)"
                  autoComplete="off"
                />
                {showLootDropdown && filteredItemNames.length > 0 && (
                  <ul key={lootItemQuery} className="card officer-suggest" style={{ maxHeight: '280px' }}>
                    {filteredItemNames.map((n) => (
                      <li
                        key={n}
                        onMouseDown={(e) => { e.preventDefault(); setLootItemQuery(n); setShowLootDropdown(false) }}
                      >
                        {n}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="officer-suggest-wrap">
                <input
                  type="text"
                  name="dkp-loot-character"
                  value={lootCharName}
                  onChange={(e) => { setLootCharName(e.target.value); setLootCharId(''); setError(''); setShowLootCharDropdown(true) }}
                  onFocus={() => setShowLootCharDropdown(true)}
                  onBlur={() => setTimeout(() => setShowLootCharDropdown(false), 200)}
                  placeholder={useCharacterAdminSelectors ? 'Character name (type to filter)' : 'Account, character, or alt'}
                  autoComplete="off"
                  aria-expanded={showLootCharDropdownList}
                  aria-haspopup="listbox"
                  aria-controls="loot-char-list"
                  aria-label={useCharacterAdminSelectors ? 'Loot character' : 'Loot account'}
                />
                {showLootCharDropdownList && (
                  <ul key={lootCharName} id="loot-char-list" className="card officer-suggest" role="listbox" onMouseDown={(e) => e.preventDefault()}>
                    {useCharacterAdminSelectors ? (
                      filteredLootCharacterNames.length === 0 ? (
                        <li style={{ color: '#71717a', cursor: 'default' }}>
                          {characterNamesList.length === 0 ? 'Loading characters…' : (lootCharName.trim() ? 'No matching characters' : 'Type to filter')}
                        </li>
                      ) : (
                        filteredLootCharacterNames.map((n) => (
                          <li
                            key={n}
                            role="option"
                            onMouseDown={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              const matches = characters.filter((row) => (row.name || '').trim().toLowerCase() === n.toLowerCase())
                              setLootCharName(n)
                              setLootCharId(matches.length === 1 ? String(matches[0].char_id) : '')
                              setTimeout(() => setShowLootCharDropdown(false), 0)
                            }}
                          >
                            {n}
                          </li>
                        ))
                      )
                    ) : filteredLootAccounts.length === 0 ? (
                      <li style={{ color: '#71717a', cursor: 'default' }}>
                        {accountAdminRows.length === 0 ? 'Loading accounts…' : (lootCharName.trim() ? 'No matching accounts' : 'Type to filter')}
                      </li>
                    ) : (
                      filteredLootAccounts.map((row) => (
                        <li
                          key={row.key}
                          role="option"
                          onMouseDown={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            setLootCharName(row.label)
                            setLootCharId(row.char_id ? String(row.char_id) : '')
                            setTimeout(() => setShowLootCharDropdown(false), 0)
                          }}
                        >
                          {row.label}
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </div>
              {events.length > 0 && (
                <select
                  value={lootEventId}
                  onChange={(e) => setLootEventId(e.target.value)}
                  aria-label="Tic for new loot"
                >
                  {events.map((e) => (
                    <option key={e.event_id} value={e.event_id}>{ticOptionLabel(e, raidDateIso, siteZone)}</option>
                  ))}
                </select>
              )}
              <div className="officer-loot-actions">
                <input
                  className="officer-cost"
                  type="number"
                  min={0}
                  value={lootCost}
                  onChange={(e) => setLootCost(e.target.value)}
                  placeholder="Cost"
                  aria-label="Loot cost"
                />
                <button type="button" className="btn" onClick={handleAddLootManual} disabled={mutating || !lootItemQuery.trim()}>
                  Add
                </button>
              </div>
            </div>
            <hr className="officer-divider" />
            <p className="officer-hint">Paste log award line here. The line must contain the full character name, a number, and the word &quot;DKP&quot;. A shorter name inside that name is not added, so deepmind does not also add mind. If the format does not match it will error. Refer to the example below.</p>
            <textarea
              className="officer-paste"
              value={lootLogPaste}
              onChange={(e) => setLootLogPaste(e.target.value)}
              placeholder="[Mon Feb 09 21:35:20 2026] Icbm says out of character, 'Earring of Eradication grats Barndog, 4 DKP!!!'"
              rows={3}
            />
            <button type="button" className="btn" onClick={handleAddLootFromLog} disabled={mutating || !lootLogPaste.trim()} style={{ marginTop: '0.5rem' }}>
              Add from log
            </button>
            {lootResult && (
              <div className="officer-result">
                <p className="officer-result-banner officer-result-banner--ok">
                  {lootResult.fromLog
                    ? `Added ${lootResult.inserted}/${lootResult.total} loot entries.`
                    : `Added: ${lootResult.itemName} → ${lootResult.characterName} (${lootResult.cost} DKP).`}
                </p>
                {lootResult.insertedItems?.length > 0 && (
                  <div className="officer-result-names">
                    {lootResult.insertedItems.map((entry, i) => (
                      <span key={`${i}-${entry.i}`} className="officer-result-name">{entry.i} → {entry.c} ({entry.cost} DKP)</span>
                    ))}
                  </div>
                )}
                {lootResult.unlinkedAccountWarning && (
                  <p className="officer-warn" style={{ marginTop: '0.35rem', marginBottom: 0 }} role="status">
                    {lootResult.unlinkedAccountWarning}
                  </p>
                )}
              </div>
            )}
          </section>
          </div>

          <div className="officer-col">
          <section ref={raidEditSectionRef} className="card">
            <h2 style={{ marginTop: 0 }}>
              {editingRaidName ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', flexWrap: 'wrap' }}>
                  Raid:{' '}
                  <input
                    type="text"
                    value={raidNameDraft}
                    onChange={(ev) => setRaidNameDraft(ev.target.value)}
                    onKeyDown={(ev) => { if (ev.key === 'Enter') handleSaveRaidName() }}
                    style={{ fontSize: '1rem', padding: '0.2rem 0.4rem', minWidth: '16rem' }}
                    aria-label="Raid name"
                  />
                  <button type="button" className="btn btn-ghost" onClick={handleSaveRaidName} disabled={mutating}>Save</button>
                  <button type="button" className="btn btn-ghost" onClick={() => { setEditingRaidName(false); setRaidNameError('') }}>Cancel</button>
                </span>
              ) : (
                <>
                  Raid: {raid.raid_name}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ marginLeft: '0.35rem', fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
                    onClick={() => { setEditingRaidName(true); setRaidNameDraft(raid.raid_name || ''); setRaidNameError('') }}
                    title="Edit title"
                  >
                    <span aria-hidden="true">✎</span>
                    Edit title
                  </button>
                </>
              )}
            </h2>
            {raidNameError && <p className="error" role="alert">{raidNameError}</p>}
            <p style={{ color: '#a1a1aa', marginBottom: '1rem' }}>
              {formatRaidSchedule(raid.date_iso || raid.date, siteZone).label || raid.date_iso || raid.date}
              {` · ${attendance.length > 0 ? attendance.length : (raid.attendees != null && raid.attendees !== '' ? Math.round(Number(raid.attendees)) : '—')} attendees`}
              {' · '}
              <Link to={`/raids/${selectedRaidId}`}>View raid</Link>
            </p>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginTop: '1rem' }}>
              <h3 style={{ margin: 0 }}>DKP by event</h3>
              {events.length === 0 && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ padding: '0.25rem 0.5rem', fontSize: '1.25rem', lineHeight: 1 }}
                  onClick={handleAddEmptyTic}
                  disabled={mutating}
                  title="Add tic"
                >
                  +
                </button>
              )}
            </div>
            <p className="officer-hint">
              Total: <strong>{events.reduce((sum, e) => sum + parseFloat(e.dkp_value || 0), 0).toFixed(1)}</strong> DKP
            </p>
            <div className="officer-table-scroll">
            <table>
              <thead>
                <tr><th>#</th><th>Event</th><th>DKP</th><th>Time</th><th>Attendees</th><th style={{ width: '5rem' }}></th></tr>
              </thead>
              <tbody>
                {events.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ color: '#71717a' }}>No tics. Use + to add a tic, then search for a character.</td>
                  </tr>
                )}
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
                        <td>{e.event_order}</td>
                        <td>{displayTicEventName(e, raidDateIso, siteZone)}</td>
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
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', flexWrap: 'wrap' }}>
                              <TicDateTimeFields
                                idPrefix={`officer-tic-${e.event_id}`}
                                labelled={false}
                                date={editingEventDate}
                                time={editingEventTime}
                                onDateChange={setEditingEventDate}
                                onTimeChange={setEditingEventTime}
                              />
                              {fieldsForEdit(e.event_time, raid?.date_iso || raid?.date || '', siteZone).unparsed && e.event_time ? (
                                <span className="officer-hint">Stored: {e.event_time}</span>
                              ) : null}
                              <button type="button" className="btn btn-ghost" onClick={() => handleSaveEventTime(e.event_id)} disabled={mutating}>Save</button>
                              <button type="button" className="btn btn-ghost" onClick={() => setEditingEventTimeId(null)}>Cancel</button>
                            </span>
                          ) : (
                            <>
                              {formatStoredClock(e.event_time, raidDateIso, siteZone) || '—'}
                              <button type="button" className="btn btn-ghost" style={{ marginLeft: '0.25rem', fontSize: '0.85rem' }} onClick={() => {
                                const fields = fieldsForEdit(e.event_time, raid?.date_iso || raid?.date || '', siteZone)
                                setEditingEventTimeId(e.event_id)
                                setEditingEventDate(fields.date)
                                setEditingEventTime(fields.time)
                              }} title="Edit tic time">✎</button>
                            </>
                          )}
                        </td>
                        <td>
                          {hasList ? (
                            <AttendeeCountCell
                              count={attendees.length}
                              expanded={isExpanded}
                              onToggle={() => setExpandedEvents((prev) => ({ ...prev, [e.event_id]: !prev[e.event_id] }))}
                            />
                          ) : (
                            e.attendee_count && e.attendee_count !== '0' ? e.attendee_count : '—'
                          )}
                        </td>
                        <td>
                          <button type="button" className="btn btn-ghost" style={{ fontSize: '0.85rem', color: '#f87171' }} onClick={() => handleDeleteEvent(e.event_id)} disabled={mutating} title="Remove tic">Remove</button>
                        </td>
                      </tr>
                      {hasList && isExpanded && (
                        <tr>
                          <td colSpan={6} style={{ padding: '0.5rem 1rem', verticalAlign: 'top', backgroundColor: 'rgba(0,0,0,0.2)', borderBottom: '1px solid #27272a' }}>
                            <div className="attendee-list">
                              {groupAttendeesByAccount(
                                attendees.map((a) => ({ character_name: a.name, name: a.name, char_id: a.char_id })),
                                getAccountId,
                                getAccountDisplayName
                              ).flatMap((group) =>
                                group.names.map((name, i) => {
                                  const charId = group.charIds[i]
                                  const label = formatAccountCharacter(group.accountDisplayName, name)
                                  const to = group.accountId ? `/accounts/${group.accountId}` : `/characters/${encodeURIComponent(name || '')}`
                                  return (
                                    <span key={charId ?? name} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', marginRight: '0.5rem' }}>
                                      <Link to={to}>{label}</Link>
                                      <button type="button" className="btn btn-ghost" style={{ fontSize: '0.75rem', color: '#f87171' }} onClick={() => handleRemoveAttendeeFromTic(e.event_id, charId, name)} disabled={mutating} title="Remove from tic">−</button>
                                    </span>
                                  )
                                })
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
            </div>

            <h3 style={{ marginTop: '1.25rem' }}>Loot</h3>
            <div className="officer-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Character</th>
                  <th>Cost</th>
                  <th>Tic</th>
                  <th style={{ width: '6rem' }}></th>
                </tr>
              </thead>
              <tbody>
                {loot.length === 0 && <tr><td colSpan={5}>No loot recorded</td></tr>}
                {lootSectionsWithMobs.map((section) => (
                  <Fragment key={section.key}>
                    <tr>
                      <td
                        colSpan={5}
                        style={{
                          padding: '0.5rem 0.75rem',
                          backgroundColor: 'rgba(0,0,0,0.25)',
                          borderBottom: '1px solid #27272a',
                          fontWeight: 600,
                          color: '#e4e4e7',
                        }}
                      >
                        {section.title}
                      </td>
                    </tr>
                    {section.mobGroups.map((mobGroup) => (
                      <Fragment key={`${section.key}-${mobGroup.key}`}>
                        {mobGroup.title != null && (
                          <tr>
                            <td
                              colSpan={5}
                              style={{
                                padding: '0.35rem 0.75rem 0.35rem 1.5rem',
                                backgroundColor: 'rgba(0,0,0,0.12)',
                                borderBottom: '1px solid #27272a',
                                fontWeight: 500,
                                fontSize: '0.9rem',
                                color: '#a1a1aa',
                              }}
                            >
                              {mobGroup.title}
                            </td>
                          </tr>
                        )}
                        {mobGroup.rows.map((row, i) => {
                          const isEditingCost = editingLootId === row.id
                          return (
                            <tr key={row.id || `${section.key}-${mobGroup.key}-${i}`}>
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
                                {events.length > 0 && row.id != null ? (
                                  <select
                                    aria-label={`Tic for ${row.item_name || 'loot'}`}
                                    value={events.some((e) => String(e.event_id) === String(row.event_id ?? '')) ? String(row.event_id) : ''}
                                    disabled={mutating}
                                    onChange={(ev) => handleSaveLootEvent(row, ev.target.value)}
                                    style={{ maxWidth: '18rem', fontSize: '0.85rem' }}
                                  >
                                    {!events.some((e) => String(e.event_id) === String(row.event_id ?? '')) && (
                                      <option value="">Misc</option>
                                    )}
                                    {events.map((e) => (
                                      <option key={e.event_id} value={e.event_id}>{ticOptionLabel(e, raidDateIso, siteZone)}</option>
                                    ))}
                                  </select>
                                ) : (
                                  '—'
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
                      </Fragment>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
            </div>

            <h3 style={{ marginTop: '1.25rem' }}>Attendees</h3>
            <div className="attendee-list">
              {attendance.length > 0 ? groupAttendeesByAccount(attendance, getAccountId, getAccountDisplayName).map((group) => {
                const label = formatAccountCharacters(group.accountDisplayName, group.names)
                const to = group.accountId
                  ? `/accounts/${group.accountId}`
                  : `/characters/${encodeURIComponent(group.names[0] || '')}`
                return <Link key={group.accountId ?? group.names[0]} to={to}>{label}</Link>
              }) : (
                <span style={{ color: '#71717a' }}>None (add a DKP tic to record attendance)</span>
              )}
            </div>

            <details className="officer-delete">
              <summary>Delete this raid</summary>
              <p className="officer-hint">
                Permanently deletes this raid and all its attendance, events, and loot. Type <strong>DELETE</strong> to confirm.
              </p>
              <div className="officer-field-row">
                <input
                  type="text"
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  placeholder="Type DELETE"
                  style={{ maxWidth: '12rem' }}
                />
                <button type="button" className="btn officer-btn-danger" onClick={handleDeleteRaid} disabled={mutating || deleteConfirm !== 'DELETE'}>
                  Delete raid
                </button>
              </div>
              {deleteError && <p className="error" style={{ marginTop: '0.5rem' }}>{deleteError}</p>}
            </details>
          </section>
          </div>
        </div>
      )}

      {loading && raids.length === 0 && <p>Loading…</p>}
    </div>
  )
}
