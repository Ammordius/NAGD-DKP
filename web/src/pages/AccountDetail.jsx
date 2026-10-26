import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom'
import useSWR, { useSWRConfig } from 'swr'
import { supabase } from '../lib/supabase'
import { DKP_DATA_KEY, useDkpData } from '../lib/dkpLeaderboard'
import {
  linkedCharacterOptions,
  selectLinkedCharacter,
  displayNamePreview,
  isDisplayNameUnchanged,
} from '../lib/accountDisplayNameChange'
import { useCharToAccountMap } from '../lib/useCharToAccountMap'
import AssignedLootDisclaimer from '../components/AssignedLootDisclaimer'
import AccountBiddingPortfolioCard from '../components/AccountBiddingPortfolioCard'
import DkpSiteDisclaimer from '../components/DkpSiteDisclaimer'
import ItemLink from '../components/ItemLink'
import AccountLootHistoryTab from '../components/AccountLootHistoryTab'
import { getDkpMobLoot } from '../lib/staticData'
import { formatAccountCharacter, formatCharacterClassSpentLine } from '../lib/formatAccountCharacter'
import { ACCOUNTS_LIST_CACHE_KEY } from '../lib/cache'
import { usePersistedState } from '../lib/usePersistedState'
import { useScrollContentReady } from '../lib/routeScrollView'
import { fetchLootForAccountChars } from '../lib/accountData'
import { aggregateLootSpent, sumCharacterSpent } from '../lib/characterSpent'
import { fetchChunkedIn } from '../lib/fetchChunkedIn'
import { raidMissingTics, ticFractionsByRaid, visibleMissingTicRows } from '../lib/raidTicIdentity'
import {
  accountDetailSessionKey,
  accountDetailSwrKey,
  needsMissingRaidUniverse,
} from '../lib/accountDetailMissingScope'

const MAGELO_BASE = 'https://www.takproject.net/magelo/character.php?char='

const ACCOUNT_TABS = ['activity', 'characters', 'loot', 'history']

function normalizeAccountTab(raw) {
  const t = (raw || '').trim().toLowerCase()
  return ACCOUNT_TABS.includes(t) ? t : 'activity'
}

function buildItemIdMap(mobLoot) {
  const map = {}
  if (!mobLoot || typeof mobLoot !== 'object') return map
  Object.values(mobLoot).forEach((entry) => {
    (entry?.loot || []).forEach((item) => {
      if (item?.name && item?.item_id != null) {
        const key = item.name.trim().toLowerCase()
        if (map[key] == null) map[key] = item.item_id
      }
    })
  })
  return map
}
const MIDDLE_DOT = '\u00B7'

const PAGE = 1000
const ACTIVITY_PAGE_SIZE = 50
/** Only paginate activity when raid count exceeds this (e.g. 1611 raids). */
const ACTIVITY_PAGINATION_THRESHOLD = 100
async function fetchAll(table, select = '*', filter, opts) {
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

/** SWR deduplication: 60s so revisiting the same account shows cached data without full reload. */
const ACCOUNT_DEDUPING_INTERVAL_MS = 60_000

function getAccountDetailFromSession(accountId, includeMissing = false) {
  const key = accountDetailSessionKey(accountId, includeMissing)
  if (!key) return undefined
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
}

function setAccountDetailInSession(accountId, data, includeMissing = false) {
  const key = accountDetailSessionKey(accountId, includeMissing)
  if (!key || !data) return
  try {
    sessionStorage.setItem(key, JSON.stringify(data))
  } catch (_) { /* ignore */ }
}

async function fetchAccountDetail(accountId, includeMissing = false) {
  const accRes = await supabase.from('accounts').select('account_id, toon_names, display_name, toon_count').eq('account_id', accountId).single()
  if (accRes.error || !accRes.data) throw new Error(accRes.error?.message || 'Account not found')
  const caRes = await supabase.from('character_account').select('char_id').eq('account_id', accountId)
  const charIds = (caRes.data || []).map((r) => r.char_id).filter(Boolean)
  if (charIds.length === 0) {
    return { account: accRes.data, characters: [], raids: {}, activityByRaid: [], dkpByCharacterKey: { earned: {}, spent: {} } }
  }
  const [chRes, attRes, attDkpByAccountRes, attDkpRes] = await Promise.all([
    supabase.from('characters').select('char_id, name, class_name, level').in('char_id', charIds),
    fetchAll('raid_attendance', 'raid_id, char_id, character_name', (q) => q.in('char_id', charIds)),
    fetchAll('raid_attendance_dkp_by_account', 'raid_id, account_id, dkp_earned', (q) => q.eq('account_id', accountId), { order: { column: 'raid_id', ascending: true } }),
    (async () => {
      const cr = await supabase.from('characters').select('char_id, name').in('char_id', charIds)
      const ch = cr.data || []
      const characterKeys = [...new Set([...charIds, ...ch.map((c) => c.name).filter(Boolean)])]
      if (characterKeys.length === 0) return { data: [] }
      return fetchAll('raid_attendance_dkp', 'raid_id, character_key, dkp_earned', (q) => q.in('character_key', characterKeys), { order: { column: 'raid_id', ascending: true } })
    })(),
  ])
  const chars = (chRes.data || []).map((c) => ({ ...c, displayName: c.name || c.char_id }))
  const charNames = [...new Set(chars.map((c) => (c.name || '').trim()).filter(Boolean))]
  const lootRes = await fetchLootForAccountChars(
    charIds,
    charNames,
    'id, raid_id, char_id, character_name, item_name, cost, assigned_char_id, assigned_character_name',
    { order: { column: 'id', ascending: true } },
  )
  if (lootRes.error) throw new Error(lootRes.error?.message || 'Failed to load loot')
  const attendanceColumns = 'id, raid_id, event_id, char_id, character_name'
  const [eventAttByIdRes, eventAttByNameRes, eventAttByAccountRes] = await Promise.all([
    fetchChunkedIn(supabase, 'raid_event_attendance', attendanceColumns, 'char_id', charIds, 'id'),
    fetchChunkedIn(supabase, 'raid_event_attendance', attendanceColumns, 'character_name', charNames, 'id'),
    fetchAll('raid_event_attendance', attendanceColumns, (q) => q.eq('account_id', accountId), { order: { column: 'id', ascending: true } }),
  ])
  if (eventAttByIdRes?.error) throw new Error(eventAttByIdRes.error?.message || 'Failed to load event attendance')
  if (eventAttByNameRes?.error) throw new Error(eventAttByNameRes.error?.message || 'Failed to load event attendance')
  if (eventAttByAccountRes?.error) throw new Error(eventAttByAccountRes.error?.message || 'Failed to load event attendance')
  const eventAttByKey = {}
  ;[...(eventAttByIdRes.data || []), ...(eventAttByNameRes.data || []), ...(eventAttByAccountRes.data || [])].forEach((row) => {
    const key = `${row?.raid_id || ''}|${row?.event_id || ''}|${row?.char_id || ''}|${row?.character_name || ''}`
    if (!eventAttByKey[key]) eventAttByKey[key] = row
  })
  const eventAttResData = Object.values(eventAttByKey)
  const attDkp = !attDkpByAccountRes.error && attDkpByAccountRes.data?.length > 0
    ? attDkpByAccountRes.data.map((r) => ({ raid_id: r.raid_id, character_key: r.account_id, dkp_earned: r.dkp_earned }))
    : (attDkpRes?.error ? [] : (attDkpRes?.data || []))
  const earnedByKey = {}
  attDkp.forEach((row) => {
    const k = (row.character_key || '').trim()
    if (k) earnedByKey[k] = (earnedByKey[k] || 0) + parseFloat(row.dkp_earned || 0)
  })
  const spentByKey = aggregateLootSpent(lootRes.data || [])
  const dkpByCharacterKey = { earned: earnedByKey, spent: spentByKey }

  const raidIds = new Set(
    [
      ...(attRes.data || []).map((r) => r.raid_id),
      ...(eventAttResData || []).map((r) => r.raid_id),
      ...(lootRes.data || []).map((r) => r.raid_id),
      ...attDkp.map((r) => r.raid_id),
    ].map((id) => String(id ?? '').trim()).filter(Boolean),
  )
  if (raidIds.size === 0) {
    return { account: accRes.data, characters: chars, raids: {}, activityByRaid: [], dkpByCharacterKey }
  }
  const raidList = [...raidIds]
  const [rRes, totalsRes, eventsRes, allPositiveEventsRes] = await Promise.all([
    fetchChunkedIn(supabase, 'raids', 'raid_id, raid_name, date_iso', 'raid_id', raidList, 'raid_id'),
    fetchChunkedIn(supabase, 'raid_dkp_totals', 'raid_id, total_dkp', 'raid_id', raidList, 'raid_id'),
    fetchChunkedIn(supabase, 'raid_events', 'id, raid_id, event_id, event_order, event_name, dkp_value', 'raid_id', raidList, 'id'),
    includeMissing
      ? fetchAll('raid_events', 'id, raid_id, event_id, event_order, event_name, dkp_value', (q) => q.gt('dkp_value', 0), { order: { column: 'id', ascending: true } })
      : Promise.resolve({ data: [], error: null }),
  ])
  if (rRes?.error) throw new Error(rRes.error?.message || 'Failed to load raids')
  if (totalsRes?.error) throw new Error(totalsRes.error?.message || 'Failed to load raid totals')
  if (eventsRes?.error) throw new Error(eventsRes.error?.message || 'Failed to load raid events')
  if (allPositiveEventsRes?.error) throw new Error(allPositiveEventsRes.error?.message || 'Failed to load raid events')
  const rMap = {}
  ;(rRes.data || []).forEach((row) => { rMap[String(row.raid_id ?? '').trim()] = row })
  const totalRaidDkp = {}
  ;(totalsRes.data || []).forEach((row) => { totalRaidDkp[String(row.raid_id ?? '').trim()] = parseFloat(row.total_dkp || 0) })
  const accountEventRows = eventsRes.data || []
  const accountEventRaidIds = new Set(
    accountEventRows.map((row) => String(row?.raid_id ?? '').trim()).filter(Boolean),
  )
  const universeEventRows = (allPositiveEventsRes.data || []).filter(
    (row) => !accountEventRaidIds.has(String(row?.raid_id ?? '').trim()),
  )
  const fractions = ticFractionsByRaid([...accountEventRows, ...universeEventRows], eventAttResData)
  // Include raids where this account had no activity so "only missing" can show full absences.
  const allPositiveTicRaidIds = new Set(
    (allPositiveEventsRes.data || []).map((row) => String(row?.raid_id ?? '').trim()).filter(Boolean),
  )
  const missingRaidIdsFromUniverse = [...allPositiveTicRaidIds].filter((rid) => !raidIds.has(rid))
  let universeRaidMap = {}
  let universeRaidTotalsMap = {}
  if (missingRaidIdsFromUniverse.length > 0) {
    const [universeRaidsRes, universeTotalsRes] = await Promise.all([
      fetchChunkedIn(supabase, 'raids', 'raid_id, raid_name, date_iso', 'raid_id', missingRaidIdsFromUniverse, 'raid_id'),
      fetchChunkedIn(supabase, 'raid_dkp_totals', 'raid_id, total_dkp', 'raid_id', missingRaidIdsFromUniverse, 'raid_id'),
    ])
    if (universeRaidsRes?.error) throw new Error(universeRaidsRes.error?.message || 'Failed to load raid universe')
    if (universeTotalsRes?.error) throw new Error(universeTotalsRes.error?.message || 'Failed to load raid totals universe')
    ;(universeRaidsRes.data || []).forEach((row) => { universeRaidMap[String(row.raid_id ?? '').trim()] = row })
    ;(universeTotalsRes.data || []).forEach((row) => { universeRaidTotalsMap[String(row.raid_id ?? '').trim()] = parseFloat(row.total_dkp || 0) })
  }
  const dkpByRaid = {}
  attDkp.forEach((row) => {
    const raidKey = String(row.raid_id ?? '').trim()
    if (!raidKey) return
    if (!dkpByRaid[raidKey]) dkpByRaid[raidKey] = 0
    dkpByRaid[raidKey] += parseFloat(row.dkp_earned || 0)
  })
  const lootByRaid = {}
  ;(lootRes.data || []).forEach((row) => {
    const raidKey = String(row.raid_id ?? '').trim()
    if (!raidKey) return
    if (!lootByRaid[raidKey]) lootByRaid[raidKey] = []
    lootByRaid[raidKey].push(row)
  })
  const allRaidIdsForActivity = [...new Set([...raidList, ...missingRaidIdsFromUniverse])]
  const activityByRaid = allRaidIdsForActivity.map((raidId) => {
    const raidKey = String(raidId ?? '').trim()
    const fraction = fractions.get(raidKey) || null
    const storedTotal = totalRaidDkp[raidKey] ?? universeRaidTotalsMap[raidKey] ?? 0
    return {
      raid_id: raidKey,
      date: ((rMap[raidKey]?.date_iso || universeRaidMap[raidKey]?.date_iso) || '').slice(0, 10),
      raid_name: rMap[raidKey]?.raid_name || universeRaidMap[raidKey]?.raid_name || raidKey,
      dkpEarned: dkpByRaid[raidKey] ?? 0,
      dkpRaidTotal: accountEventRaidIds.has(raidKey) && fraction ? fraction.totalDkp : storedTotal,
      ticEarned: fraction ? fraction.ticEarned : 0,
      ticTotal: fraction ? fraction.ticTotal : 0,
      items: lootByRaid[raidKey] || [],
    }
  }).sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  return { account: accRes.data, characters: chars, raids: rMap, activityByRaid, dkpByCharacterKey }
}

function spentFromActivity(activityByRaid) {
  const rows = []
  for (const act of activityByRaid || []) {
    for (const row of act.items || []) rows.push(row)
  }
  return aggregateLootSpent(rows)
}

function patchLootAssignment(data, lootId, charId, charName) {
  if (!data) return data
  const activityByRaid = (data.activityByRaid || []).map((act) => ({
    ...act,
    items: (act.items || []).map((item) => (
      String(item.id) === String(lootId)
        ? {
            ...item,
            assigned_char_id: charId || null,
            assigned_character_name: charName || null,
          }
        : item
    )),
  }))
  return {
    ...data,
    activityByRaid,
    dkpByCharacterKey: {
      ...(data.dkpByCharacterKey || { earned: {}, spent: {} }),
      spent: spentFromActivity(activityByRaid),
    },
  }
}

export default function AccountDetail({ isOfficer, profile, session, onProfileUpdate }) {
  const { accountId } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = normalizeAccountTab(searchParams.get('tab'))
  const setTab = useCallback(
    (next) => {
      setSearchParams(
        (prev) => {
          const n = new URLSearchParams(prev)
          if (next === 'activity') n.delete('tab')
          else n.set('tab', next)
          return n
        },
        { replace: true }
      )
    },
    [setSearchParams]
  )
  const { getAccountDisplayName } = useCharToAccountMap()
  const { mutate: globalMutate } = useSWRConfig()
  const [onlyMissingRaids, setOnlyMissingRaids] = usePersistedState(
    accountId ? `/accounts/detail:${accountId}:onlyMissingRaids` : '/accounts/detail:none:onlyMissingRaids',
    false
  )
  const [showMissingDetails, setShowMissingDetails] = usePersistedState(
    accountId ? `/accounts/detail:${accountId}:showMissingDetails` : '/accounts/detail:none:showMissingDetails',
    false
  )
  // Either control needs the positive-DKP raid universe (missing absences / tic details).
  const includeMissing = needsMissingRaidUniverse(showMissingDetails, onlyMissingRaids)
  const cacheKey = accountDetailSwrKey(accountId, includeMissing)
  const fallbackData = cacheKey ? getAccountDetailFromSession(accountId, includeMissing) : undefined
  const { data: swrData, error: swrError, isLoading, mutate } = useSWR(
    cacheKey,
    () => fetchAccountDetail(accountId, includeMissing),
    {
      fallbackData,
      dedupingInterval: ACCOUNT_DEDUPING_INTERVAL_MS,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      onSuccess: (data) => {
        if (accountId && data) setAccountDetailInSession(accountId, data, includeMissing)
      },
    }
  )
  const account = swrData?.account ?? null
  const characters = swrData?.characters ?? []
  const raids = swrData?.raids ?? {}
  const activityByRaid = swrData?.activityByRaid ?? []
  const dkpByCharacterKey = swrData?.dkpByCharacterKey ?? { earned: {}, spent: {} }
  const loading = isLoading && !swrData
  useScrollContentReady(!loading)
  const error = swrError?.message ?? ''
  const [activityPage, setActivityPage] = usePersistedState(
    accountId ? `/accounts/detail:${accountId}:activityPage` : '/accounts/detail:none:activityPage',
    1
  )
  const [addCharOpen, setAddCharOpen] = useState(false)
  const [addCharInput, setAddCharInput] = useState('')
  const [addCharError, setAddCharError] = useState('')
  const [addCharLoading, setAddCharLoading] = useState(false)
  const [addCharReveal, setAddCharReveal] = useState(0)
  const addCharSectionRef = useRef(null)
  const addCharNameRef = useRef(null)

  useEffect(() => {
    if (!addCharReveal) return
    const section = addCharSectionRef.current
    if (!section) return
    section.scrollIntoView({ behavior: 'smooth', block: 'start' })
    addCharNameRef.current?.focus({ preventScroll: true })
  }, [addCharReveal])

  const openAddCharacter = () => {
    setAddCharOpen(true)
    setAddCharError('')
    setAddCharInput('')
    setAddCharReveal((n) => n + 1)
  }
  const [claimLoading, setClaimLoading] = useState(false)
  const [claimError, setClaimError] = useState('')
  const [myAccountId, setMyAccountId] = useState(profile?.account_id ?? null)
  const isMyAccount = myAccountId === accountId
  const canAddChar = isOfficer || isMyAccount
  const canEditLoot = isOfficer || isMyAccount
  const [savingLootIds, setSavingLootIds] = useState(() => new Set())
  const [pendingAssign, setPendingAssign] = useState({})
  const [lootAssignError, setLootAssignError] = useState('')
  const assignChainRef = useRef(Promise.resolve())
  const [displayNameEditorOpen, setDisplayNameEditorOpen] = useState(false)
  const [displayNameQuery, setDisplayNameQuery] = useState('')
  const [displayNameCharId, setDisplayNameCharId] = useState('')
  const [displayNameError, setDisplayNameError] = useState('')
  const [displayNameSaving, setDisplayNameSaving] = useState(false)
  const [mobLoot, setMobLoot] = useState(null)
  const { accountTotalsByAccountId } = useDkpData()

  useEffect(() => {
    getDkpMobLoot().then(setMobLoot)
  }, [])

  useEffect(() => {
    if (!accountId || !profile) return
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      supabase.from('profiles').select('account_id').eq('id', user.id).single().then(({ data }) => {
        setMyAccountId(data?.account_id ?? null)
      })
    })
  }, [accountId, profile])

  const displayName = account?.display_name?.trim() || account?.toon_names?.split(',')[0]?.trim() || accountId
  const linkedToonCount = characters.length

  /** Header figures are account_dkp_summary. A per-raid cache or loot-list gap is a warning only. */
  const accountDkp = useMemo(() => {
    const summary = accountTotalsByAccountId[accountId] || {}
    let pageSpent = 0
    for (const act of activityByRaid) {
      for (const it of act.items || []) {
        const c = parseFloat(it.cost)
        if (Number.isFinite(c)) pageSpent += c
      }
    }
    pageSpent = Math.round(pageSpent)
    const pageEarned = Math.round(
      activityByRaid.reduce((s, a) => s + (Number(a.dkpEarned) || 0), 0),
    )
    const earned = Math.round(Number(summary.earned) || 0)
    const spent = Math.round(Number(summary.spent) || 0)
    const balance = earned - spent
    const staleSummary =
      (earned > 0 || spent > 0 || pageEarned > 0 || pageSpent > 0) &&
      (Math.abs(pageEarned - earned) > 1 || Math.abs(pageSpent - spent) > 1)
    return { earned, spent, balance, staleSummary }
  }, [accountId, accountTotalsByAccountId, activityByRaid])

  async function handleClaimAccount() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      navigate(`/login?redirect=${encodeURIComponent(`/accounts/${accountId}`)}`, { replace: true })
      return
    }
    setClaimLoading(true)
    setClaimError('')
    const { error: rpcErr } = await supabase.rpc('claim_account', { p_account_id: accountId })
    setClaimLoading(false)
    if (rpcErr) {
      setClaimError(rpcErr.message)
      return
    }
    setMyAccountId(accountId)
    onProfileUpdate?.()
  }

  async function handleAddCharacter() {
    const raw = addCharInput.trim()
    if (!raw) {
      setAddCharError('Enter a character name')
      return
    }
    setAddCharError('')
    setAddCharLoading(true)
    const { error: rpcErr } = await supabase.rpc('add_character_to_my_account', {
      p_character_name: raw,
      p_account_id: accountId,
    })
    setAddCharLoading(false)
    if (rpcErr) {
      setAddCharError(rpcErr.message)
      return
    }
    setAddCharOpen(false)
    setAddCharInput('')
    mutate()
  }

  async function handleSetDisplayName() {
    let chosen
    try {
      chosen = selectLinkedCharacter(characters, displayNameCharId)
    } catch (err) {
      setDisplayNameError(err.message)
      return
    }
    if (isDisplayNameUnchanged(account?.display_name, chosen.name)) {
      setDisplayNameError('')
      return
    }
    setDisplayNameError('')
    setDisplayNameSaving(true)
    const { error: rpcErr } = await supabase.rpc('officer_set_account_display_name', {
      p_account_id: accountId,
      p_char_id: chosen.charId,
    })
    setDisplayNameSaving(false)
    if (rpcErr) {
      setDisplayNameError(rpcErr.message)
      return
    }
    try {
      sessionStorage.removeItem(accountDetailSessionKey(accountId, false))
      sessionStorage.removeItem(accountDetailSessionKey(accountId, true))
    } catch (_) {}
    try { sessionStorage.removeItem(ACCOUNTS_LIST_CACHE_KEY) } catch (_) {}
    setDisplayNameEditorOpen(false)
    setDisplayNameQuery('')
    setDisplayNameCharId('')
    await mutate()
    await globalMutate(DKP_DATA_KEY)
    await globalMutate('char-to-account-map')
  }

  const itemIdMap = useMemo(() => buildItemIdMap(mobLoot), [mobLoot])

  const sortedCharacters = useMemo(() => {
    const spentOf = (c) => {
      return sumCharacterSpent(dkpByCharacterKey.spent, c)
    }
    return [...characters].sort((a, b) => {
      const ds = spentOf(b) - spentOf(a)
      if (ds !== 0) return ds
      return String(a.name || a.char_id).localeCompare(String(b.name || b.char_id))
    })
  }, [characters, dkpByCharacterKey])

  function enqueueAssign(task) {
    const run = assignChainRef.current.then(task, task)
    assignChainRef.current = run.then(() => {}, () => {})
    return run
  }

  function handleAssignLoot(row, val) {
    const lootKey = String(row.id)
    const previous = {
      assigned_char_id: (row.assigned_char_id || '').trim() || null,
      assigned_character_name: (row.assigned_character_name || '').trim() || null,
    }
    let cid = null
    let cname = null
    if (val !== '') {
      const character = sortedCharacters.find((ch) => (ch.char_id || ch.name) === val)
      cid = character?.char_id || val
      cname = character?.name || character?.displayName || val
    }
    setLootAssignError('')
    setPendingAssign((prev) => ({ ...prev, [lootKey]: val }))
    setSavingLootIds((prev) => {
      const next = new Set(prev)
      next.add(lootKey)
      return next
    })

    enqueueAssign(async () => {
      try {
        let patched = null
        await mutate((current) => {
          patched = patchLootAssignment(current, row.id, cid, cname)
          return patched
        }, { revalidate: false })
        if (accountId && patched) setAccountDetailInSession(accountId, patched, includeMissing)

        // Assignment does not change account DKP. Skip refresh_account_dkp_summary_for_raid
        // so the click is not blocked on a raid-wide summary rebuild.
        const { error: rpcError } = await supabase.rpc('update_single_raid_loot_assignment', {
          p_loot_id: row.id,
          p_assigned_char_id: cid,
          p_assigned_character_name: cname,
        })
        if (rpcError) throw new Error(rpcError.message)
      } catch (err) {
        setLootAssignError(err?.message || 'Could not update assignment')
        let reverted = null
        await mutate((current) => {
          reverted = patchLootAssignment(
            current,
            row.id,
            previous.assigned_char_id,
            previous.assigned_character_name,
          )
          return reverted
        }, { revalidate: false })
        if (accountId && reverted) setAccountDetailInSession(accountId, reverted, includeMissing)
      } finally {
        setPendingAssign((prev) => {
          if (!Object.prototype.hasOwnProperty.call(prev, lootKey)) return prev
          const next = { ...prev }
          delete next[lootKey]
          return next
        })
        setSavingLootIds((prev) => {
          const next = new Set(prev)
          next.delete(lootKey)
          return next
        })
      }
    })
  }

  const activityWithMissing = useMemo(
    () => activityByRaid.map((act) => ({ ...act, ...raidMissingTics(act) })),
    [activityByRaid],
  )

  const visibleActivityRows = useMemo(
    () => visibleMissingTicRows(activityWithMissing, { showMissingDetails, onlyMissingRaids }),
    [activityWithMissing, onlyMissingRaids, showMissingDetails],
  )

  const allDisplayNameChoices = useMemo(() => linkedCharacterOptions(characters), [characters])
  const displayNameChoices = useMemo(
    () => linkedCharacterOptions(characters, displayNameQuery),
    [characters, displayNameQuery]
  )
  const selectedDisplayNameChoice = displayNameChoices.find((option) => option.charId === displayNameCharId) || null
  const displayNameChangePreview = selectedDisplayNameChoice
    ? displayNamePreview(account?.display_name, selectedDisplayNameChoice.name)
    : null
  const displayNameAlreadySet = displayNameChangePreview
    ? isDisplayNameUnchanged(displayNameChangePreview.current, displayNameChangePreview.proposed)
    : false
  const canEditDisplayName = Boolean(isOfficer) && allDisplayNameChoices.length > 0

  if (loading) return <div className="container">Loading account...</div>
  if (error) return <div className="container"><span className="error">{error}</span> <Link to="/accounts">← Accounts</Link></div>
  if (!account) return <div className="container">Account not found. <Link to="/accounts">← Accounts</Link></div>

  return (
    <div className="container">
      <p><Link to="/accounts">← Accounts</Link></p>
      <h1>{displayName}</h1>
      <DkpSiteDisclaimer />
      <p style={{ color: '#a1a1aa', marginBottom: '1rem' }}>
        Account <code>{accountId}</code>
        <span style={{ marginLeft: '0.5rem' }}>({linkedToonCount} toons)</span>
        {(activityByRaid.length > 0 || accountDkp.earned > 0 || accountDkp.spent > 0) && (
          <span style={{ marginLeft: '0.5rem' }}>
            {MIDDLE_DOT}{' '}
            <strong>DKP total: {Number(accountDkp.balance).toFixed(0)}</strong>
            <span style={{ color: '#a1a1aa', fontWeight: 400 }}>
              {' '}(earned {accountDkp.earned} · spent {accountDkp.spent})
            </span>
            {accountDkp.staleSummary && (
              <span style={{ color: '#f59e0b', fontSize: '0.8rem' }}>
                {' '}· per-raid cache differs from these totals
              </span>
            )}
          </span>
        )}
        {isMyAccount && <span style={{ marginLeft: '0.5rem', color: '#a78bfa' }}> {MIDDLE_DOT} This is your account</span>}
        {!isMyAccount && (
          session ? (
            !myAccountId && (
              (() => {
                const cooldownUntil = profile?.unclaim_cooldown_until ? new Date(profile.unclaim_cooldown_until) : null
                const onCooldown = cooldownUntil && cooldownUntil > new Date()
                return (
                  <span style={{ marginLeft: '0.5rem' }}>
                    {onCooldown ? (
                      <span style={{ color: '#f59e0b', fontSize: '0.875rem' }}>
                        You can claim again after {cooldownUntil.toLocaleString()}. An officer can remove this cooldown.
                      </span>
                    ) : (
                      <>
                        <button type="button" className="btn btn-ghost" style={{ fontSize: '0.875rem' }} onClick={handleClaimAccount} disabled={claimLoading}>
                          {claimLoading ? 'Claiming...' : 'Claim this account'}
                        </button>
                        {claimError && (
                          <span className="error" style={{ marginLeft: '0.5rem', fontSize: '0.875rem' }}>{claimError}</span>
                        )}
                      </>
                    )}
                  </span>
                )
              })()
            )
          ) : (
            <Link to={`/login?redirect=${encodeURIComponent(`/accounts/${accountId}`)}`} className="btn btn-ghost" style={{ marginLeft: '0.5rem', fontSize: '0.875rem' }}>
              Sign in to claim this account
            </Link>
          )
        )}
      </p>

      {canEditDisplayName && (
        <div className="display-name-editor" style={{ marginBottom: '1rem' }}>
          {!displayNameEditorOpen ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setDisplayNameEditorOpen(true)
                setDisplayNameError('')
                setDisplayNameQuery('')
                setDisplayNameCharId('')
              }}
            >
              Edit display name
            </button>
          ) : (
            <div className="card">
              <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Edit display name</h2>
              <p style={{ color: '#a1a1aa', fontSize: '0.875rem' }}>
                Choose a character linked to this account. The filter only narrows that list.
              </p>
              <div className="form-group">
                <label htmlFor="display-name-filter">Find character</label>
                <input
                  id="display-name-filter"
                  type="search"
                  value={displayNameQuery}
                  onChange={(e) => setDisplayNameQuery(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="form-group">
                <label htmlFor="display-name-character">Linked character</label>
                <select
                  id="display-name-character"
                  value={selectedDisplayNameChoice ? selectedDisplayNameChoice.charId : ''}
                  onChange={(e) => {
                    setDisplayNameCharId(e.target.value)
                    setDisplayNameError('')
                  }}
                >
                  <option value="">Select a character</option>
                  {displayNameChoices.map((option) => {
                    const duplicate = displayNameChoices.filter((choice) => choice.name === option.name).length > 1
                    return (
                      <option key={option.charId} value={option.charId}>
                        {duplicate ? `${option.name} (${option.charId})` : option.name}
                      </option>
                    )
                  })}
                </select>
              </div>
              <p style={{ marginBottom: '0.5rem' }}>
                Current display name: <strong>{(account.display_name || '').trim() || '(not set)'}</strong>
              </p>
              {displayNameChangePreview && (
                <p style={{ marginTop: 0 }}>
                  New display name: <strong>{displayNameChangePreview.proposed}</strong>
                </p>
              )}
              {displayNameAlreadySet && (
                <p style={{ color: '#a1a1aa', fontSize: '0.875rem' }}>Display name is already this character.</p>
              )}
              {displayNameError && <p className="error">{displayNameError}</p>}
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  type="button"
                  className="btn"
                  onClick={handleSetDisplayName}
                  disabled={!selectedDisplayNameChoice || displayNameAlreadySet || displayNameSaving}
                >
                  {displayNameSaving ? 'Saving...' : 'Confirm'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setDisplayNameEditorOpen(false)
                    setDisplayNameError('')
                  }}
                  disabled={displayNameSaving}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', borderBottom: '1px solid #27272a', paddingBottom: '0.5rem' }}>
        <button
          type="button"
          className={tab === 'activity' ? 'btn' : 'btn btn-ghost'}
          onClick={() => setTab('activity')}
        >
          Activity
        </button>
        <button
          type="button"
          className={tab === 'characters' ? 'btn' : 'btn btn-ghost'}
          onClick={() => setTab('characters')}
        >
          Characters
        </button>
        <button
          type="button"
          className={tab === 'loot' ? 'btn' : 'btn btn-ghost'}
          onClick={() => setTab('loot')}
        >
          Loot
        </button>
        <button
          type="button"
          className={tab === 'history' ? 'btn' : 'btn btn-ghost'}
          onClick={() => setTab('history')}
        >
          History
        </button>
      </div>

      {tab === 'characters' && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0 }}>Characters</h2>
            {canAddChar && (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ padding: '0.35rem 0.65rem', fontSize: '0.95rem', lineHeight: 1.2, display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
                onClick={openAddCharacter}
                title="Add an alt to this account"
              >
                <span aria-hidden="true" style={{ fontSize: '1.25rem', fontWeight: 600, lineHeight: 1 }}>+</span>
                Add character
              </button>
            )}
          </div>
          {characters.length === 0 ? (
            <p style={{ color: '#71717a' }}>No characters linked to this account.{canAddChar && ' Use + Add character to add one.'}</p>
          ) : (
            <ul style={{ listStyle: 'none', paddingLeft: 0, margin: 0 }}>
              {sortedCharacters.map((c) => {
                const name = c.name || c.char_id
                const mageloUrl = `${MAGELO_BASE}${encodeURIComponent(name)}`
                const spent = sumCharacterSpent(dkpByCharacterKey.spent, c)
                const meta = formatCharacterClassSpentLine(c, spent)
                return (
                  <li key={c.char_id || c.name} style={{ marginBottom: '0.5rem' }}>
                    <Link to={`/characters/${encodeURIComponent(name)}`}>{name}</Link>
                    <span style={{ color: '#71717a', fontSize: '0.9rem', marginLeft: '0.5rem' }}>
                      {meta}
                    </span>
                    {' '}{MIDDLE_DOT}{' '}
                    <a href={mageloUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.9rem', color: '#a78bfa' }}>
                      Magelo
                    </a>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {tab === 'loot' && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Loot assignments</h2>
          <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginBottom: '0.25rem' }}>
            {canEditLoot
              ? 'Assign each item to the character that has it, or leave Unassigned. Changes save immediately.'
              : 'Items won by characters on this account. Assignments are set by the account owner or officers.'}
          </p>
          <div style={{ marginBottom: '1rem' }}>
            <AssignedLootDisclaimer />
          </div>
          {lootAssignError && <p style={{ color: '#f87171', fontSize: '0.875rem', marginBottom: '0.5rem' }}>{lootAssignError}</p>}
          {activityByRaid.length === 0 ? (
            <p style={{ color: '#71717a' }}>No loot recorded.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #27272a', textAlign: 'left' }}>
                  <th style={{ padding: '0.5rem 0.75rem' }}>Raid</th>
                  <th style={{ padding: '0.5rem 0.75rem' }}>Item</th>
                  <th style={{ padding: '0.5rem 0.75rem' }}>Buyer</th>
                  <th style={{ padding: '0.5rem 0.75rem' }}>Assigned to</th>
                  <th style={{ padding: '0.5rem 0.75rem' }}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {activityByRaid.flatMap((act) => (act.items || []).map((row) => ({ ...row, _raid_name: act.raid_name, _raid_id: act.raid_id, _date: act.date }))).map((row) => {
                  const hasAssignment = (row.assigned_character_name || row.assigned_char_id || '').trim()
                  const currentCharId = (row.assigned_char_id || '').trim() || null
                  const currentCharName = (row.assigned_character_name || '').trim() || null
                  const lootKey = String(row.id)
                  const isSaving = savingLootIds.has(lootKey)
                  const selectValue = Object.prototype.hasOwnProperty.call(pendingAssign, lootKey)
                    ? pendingAssign[lootKey]
                    : ((currentCharId || currentCharName || '').trim() || '')
                  return (
                    <tr key={row.id} data-scroll-anchor={String(row.id)} style={{ borderBottom: '1px solid #27272a' }}>
                      <td style={{ padding: '0.5rem 0.75rem', fontSize: '0.9rem' }}>
                        <Link to={`/raids/${row._raid_id}`}>{row._raid_name || row._raid_id}</Link>
                        {row._date && <span style={{ color: '#71717a', marginLeft: '0.25rem' }}>{row._date}</span>}
                      </td>
                      <td style={{ padding: '0.5rem 0.75rem' }}>
                        <ItemLink itemName={row.item_name || ''} itemId={itemIdMap[(row.item_name || '').trim().toLowerCase()]}>{row.item_name || '—'}</ItemLink>
                      </td>
                      <td style={{ padding: '0.5rem 0.75rem', color: '#a1a1aa' }}>
                        {(() => {
                          const charName = row.character_name || row.char_id || '—'
                          const accountName = getAccountDisplayName?.(row.character_name || row.char_id)
                          const label = formatAccountCharacter(accountName, charName)
                          return label
                        })()}
                      </td>
                      <td style={{ padding: '0.5rem 0.75rem' }}>
                        {canEditLoot ? (
                          <span className="loot-assign-field">
                            <select
                              value={selectValue}
                              disabled={isSaving}
                              aria-busy={isSaving}
                              title={isSaving ? 'Updating, please wait...' : 'Assigned to'}
                              onChange={(e) => handleAssignLoot(row, e.target.value)}
                              style={{ minWidth: '10rem', padding: '0.25rem 0.5rem', background: '#18181b', color: '#e4e4e7', border: '1px solid #27272a', borderRadius: '4px' }}
                            >
                              <option value="">Unassigned</option>
                              {sortedCharacters.map((c) => {
                                const id = c.char_id || c.name
                                const label = c.name || c.char_id
                                return <option key={id} value={id}>{label}</option>
                              })}
                            </select>
                            {isSaving && (
                              <span className="loot-assign-status" role="status">Updating, please wait...</span>
                            )}
                          </span>
                        ) : (
                          <span style={hasAssignment ? {} : { color: '#71717a' }}>{hasAssignment ? (row.assigned_character_name || row.assigned_char_id) : 'Unassigned'}</span>
                        )}
                      </td>
                      <td style={{ padding: '0.5rem 0.75rem', color: '#a1a1aa' }}>{row.cost != null && row.cost !== '' ? row.cost : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'history' && (
        <AccountLootHistoryTab
          activityByRaid={activityByRaid}
          dkpByCharacterKey={dkpByCharacterKey}
          characters={characters}
        />
      )}

      {addCharOpen && (
        <div ref={addCharSectionRef} className="card" style={{ marginTop: '1rem', maxWidth: '24rem', scrollMarginTop: '1rem' }}>
          <h3 style={{ marginTop: 0 }}>Add character to account</h3>
          <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginBottom: '0.75rem' }}>Enter character name. If they’re not in the database, we’ll add them.</p>
          <input
            ref={addCharNameRef}
            type="text"
            className="input"
            placeholder="Character name (required)"
            value={addCharInput}
            onChange={(e) => setAddCharInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddCharacter()}
            style={{ marginBottom: '0.5rem', width: '100%' }}
          />
          {addCharError && <p style={{ color: '#f87171', fontSize: '0.875rem', marginBottom: '0.5rem' }}>{addCharError}</p>}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" className="btn" onClick={handleAddCharacter} disabled={addCharLoading}>
              {addCharLoading ? 'Adding...' : 'Add'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => { setAddCharOpen(false); setAddCharError(''); setAddCharInput(''); }} disabled={addCharLoading}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {tab === 'activity' && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Activity (earned DKP and items by raid)</h2>
          <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginBottom: '0.75rem' }}>Reverse chronological. Each raid shows DKP earned and items won by the characters on this account.</p>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', color: '#d4d4d8' }}>
              <input
                type="checkbox"
                checked={showMissingDetails}
                onChange={(e) => setShowMissingDetails(e.target.checked)}
              />
              Show missing tic details
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', color: '#d4d4d8' }}>
              <input
                type="checkbox"
                checked={onlyMissingRaids}
                onChange={(e) => {
                  const checked = e.target.checked
                  setOnlyMissingRaids(checked)
                  if (checked) setShowMissingDetails(true)
                  setActivityPage(1)
                }}
              />
              Only show raids with missing tics
            </label>
          </div>
          {visibleActivityRows.length === 0 ? (
            <p style={{ color: '#71717a' }}>
              {onlyMissingRaids ? 'No raids with missing attendance tics.' : 'No raid activity recorded.'}
            </p>
          ) : (
            <>
              {(() => {
                const total = visibleActivityRows.length
                const usePagination = total > ACTIVITY_PAGINATION_THRESHOLD
                const totalPages = usePagination ? Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE)) : 1
                const page = Math.min(Math.max(1, activityPage), totalPages)
                const start = usePagination ? (page - 1) * ACTIVITY_PAGE_SIZE : 0
                const activityToShow = usePagination ? visibleActivityRows.slice(start, start + ACTIVITY_PAGE_SIZE) : visibleActivityRows
                return (
                  <>
                    {usePagination && (
                      <>
                        <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginBottom: '0.75rem' }}>
                          Showing {start + 1}–{start + activityToShow.length} of {total} raids
                          {totalPages > 1 && (
                            <span style={{ marginLeft: '0.5rem' }}>
                              {MIDDLE_DOT} Page {page} of {totalPages}
                            </span>
                          )}
                        </p>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap' }}>
                          {totalPages > 10 && (
                            <button
                              type="button"
                              className="btn btn-ghost"
                              disabled={page <= 1}
                              onClick={() => setActivityPage(1)}
                            >
                              First
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={page <= 1}
                            onClick={() => setActivityPage((p) => Math.max(1, p - 1))}
                          >
                            Previous
                          </button>
                          {totalPages <= 10 && (
                            Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
                              <button
                                key={n}
                                type="button"
                                className={n === page ? 'btn' : 'btn btn-ghost'}
                                style={{ minWidth: '2.25rem', padding: '0.25rem 0.5rem' }}
                                onClick={() => setActivityPage(n)}
                              >
                                {n}
                              </button>
                            ))
                          )}
                          <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={page >= totalPages}
                            onClick={() => setActivityPage((p) => Math.min(totalPages, p + 1))}
                          >
                            Next
                          </button>
                          {totalPages > 10 && (
                            <button
                              type="button"
                              className="btn btn-ghost"
                              disabled={page >= totalPages}
                              onClick={() => setActivityPage(totalPages)}
                            >
                              Last
                            </button>
                          )}
                        </div>
                      </>
                    )}
                    <ul style={{ listStyle: 'none', paddingLeft: 0, margin: 0 }}>
                      {activityToShow.map((act) => (
                        <li
                          key={act.raid_id}
                          style={{
                            marginBottom: '1.5rem',
                            paddingBottom: '1rem',
                            borderBottom: '1px solid #27272a',
                            borderLeft: showMissingDetails && act.isMissingTics ? '3px solid #f97316' : '3px solid transparent',
                            paddingLeft: showMissingDetails && act.isMissingTics ? '0.5rem' : 0,
                          }}
                        >
                          <p style={{ margin: '0 0 0.25rem 0' }}>
                            <Link to={`/raids/${act.raid_id}`}><strong>{act.raid_name}</strong></Link>
                            {act.date && <span style={{ color: '#71717a', marginLeft: '0.5rem' }}>{act.date}</span>}
                            <span style={{ marginLeft: '0.5rem' }}>{MIDDLE_DOT} <strong>Earned: {Number(act.dkpEarned ?? 0).toFixed(0)}{act.dkpRaidTotal != null && act.dkpRaidTotal > 0 ? ` / ${Number(act.dkpRaidTotal).toFixed(0)}` : ''}</strong> DKP</span>
                            {showMissingDetails && act.ticTotal > 0 && (
                              <span style={{ marginLeft: '0.5rem' }}>
                                {MIDDLE_DOT} <strong>{act.ticEarned}/{act.ticTotal} tics</strong>
                              </span>
                            )}
                            {showMissingDetails && act.isMissingTics && (
                              <span style={{ marginLeft: '0.5rem', color: '#f97316' }}>
                                {MIDDLE_DOT} Missing {act.missingCount} tic{act.missingCount === 1 ? '' : 's'}
                              </span>
                            )}
                          </p>
                          {act.items.length > 0 && (
                            <ul style={{ margin: '0.25rem 0 0 1.25rem', paddingLeft: 0, listStyle: 'none' }}>
                              {act.items.map((row, i) => {
                                const hasAssignment = (row.assigned_character_name || row.assigned_char_id || '').trim()
                                const charName = hasAssignment ? (row.assigned_character_name || row.assigned_char_id) : 'Unassigned'
                                return (
                                  <li key={i} style={{ marginBottom: '0.25rem', fontSize: '0.9rem' }}>
                                    <ItemLink itemName={row.item_name || ''} itemId={itemIdMap[(row.item_name || '').trim().toLowerCase()]}>{row.item_name || '—'}</ItemLink>
                                    {' '}{MIDDLE_DOT}{' '}
                                    {hasAssignment ? (
                                      <Link to={`/characters/${encodeURIComponent(charName)}`}>{charName}</Link>
                                    ) : (
                                      <span style={{ color: '#71717a' }}>{charName}</span>
                                    )}
                                    {row.cost != null && row.cost !== '' && <> {MIDDLE_DOT} {row.cost} DKP</>}
                                  </li>
                                )
                              })}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )
              })()}
            </>
          )}
        </div>
      )}

      {isOfficer && accountId && <AccountBiddingPortfolioCard accountId={accountId} />}
    </div>
  )
}
