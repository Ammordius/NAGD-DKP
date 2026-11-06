import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import useSWR from 'swr'
import { fetchAccountDetail } from '../pages/AccountDetail.jsx'
import { accountDetailSwrKey } from '../lib/accountDetailMissingScope'
import { useDkpData } from '../lib/dkpLeaderboard'
import { supabase } from '../lib/supabase'
import { fetchAllRpcByRange } from '../lib/fetchAllRpcByRange'
import { buildItemLast3FromSaleRows } from '../lib/recentItemSaleCosts'
import { getItemSources, getDkpMobLoot, getRaidItemSources } from '../lib/staticData'
import {
  buildKnownItemSources,
  catalogEntriesFromKnownSources,
} from '../lib/itemSourceLookup.js'
import {
  BOT_NAME,
  BOT_TAGLINE,
  buildAccountFacts,
  lootRowsFromAccountDetail,
  attendanceRowsFromAccountDetail,
  raidsByIdFromAccountDetail,
  startConversation,
  handleMessage,
  resetIfIdentityChanged,
  createConversationState,
  selectCharacterId,
  isUpgradeSlotFollowUp,
  isCharacterSwapFollowUp,
  extractCharacterSwapFollowUp,
  loadClassRankings,
  collectRaidLootItemIds,
  resetUpgradeCaches,
  INTENTS,
} from '../lib/roastBot/index.js'
import { recognizeDiscovery, runDiscovery } from '../lib/roastBot/discovery/index.js'
import { extractWhoIsName, looksLikeWhoIs, lookupWhoIs } from '../lib/roastBot/whoIs.js'
import {
  extractSpendCharacterName,
  looksLikeCharacterDkpSpent,
  lookupCharacterDkpSpent,
} from '../lib/roastBot/characterSpendLookup.js'
import {
  isCharacterDkpSpentQuestion,
  isQuarmEligibilityQuestion,
  isCharacterStatsQuestion,
} from '../lib/roastBot/intents.js'
import { ensureItemStatsLoaded } from '../lib/itemStats'
import './RoastBot.css'

async function fetchSaleCosts() {
  try {
    const rows = await fetchAllRpcByRange(supabase, 'recent_item_sale_costs', { p_limit: 3 })
    return buildItemLast3FromSaleRows(rows || [])
  } catch {
    return {}
  }
}

function needsMageloContext(text, pendingIntent, lastIntent = null) {
  const lower = String(text || '').toLowerCase()
  if (
    pendingIntent === 'gear_assessment' ||
    pendingIntent === 'upgrades' ||
    pendingIntent === 'item_fit' ||
    pendingIntent === 'quarm_eligibility' ||
    pendingIntent === 'character_stats'
  ) {
    return true
  }
  if (isUpgradeSlotFollowUp(text, { lastIntent, pendingIntent })) {
    return true
  }
  if (
    isCharacterSwapFollowUp(text, { lastIntent, pendingIntent }) &&
    (lastIntent === 'gear_assessment' ||
      lastIntent === 'upgrades' ||
      lastIntent === 'quarm_eligibility' ||
      lastIntent === 'character_stats' ||
      lastIntent === 'character_roast')
  ) {
    return true
  }
  if (isQuarmEligibilityQuestion(lower) || isCharacterStatsQuestion(lower)) {
    return true
  }
  return /upgrade|what should i buy|recommend|improve|gear|geared|well.?geared|gear check|buy for|could use|who needs|which of my toons|is this an upgrade/.test(
    lower,
  )
}

function needsDiscoveryItemStats(text) {
  return /shoulder|pauldron|caster|priest|healer|tank|melee|hybrid|slot\b|arms?\b|sleeve|wrist|bracer|head|helm|chest|legs?|feet|boot|hands?|glove|gauntlet|cloak|cape|neck|waist|belt|face|mask|earring|\bring\b/i.test(
    String(text || ''),
  )
}

/** Render a discovery table cell: link object, plain string, or empty. */
function renderTableCell(cell) {
  if (cell == null || cell === '') return '—'
  if (typeof cell === 'string' || typeof cell === 'number') return String(cell)
  if (cell.to && cell.label) {
    return <Link to={cell.to}>{cell.label}</Link>
  }
  return cell.label || '—'
}

/**
 * Floating DKP Inquisitor chat. Authenticated users only (parent gates mount).
 * Bot-specific network fetches are gated on `open` (except shared SWR caches when warm).
 */
export default function RoastBot({ profile, session, factsOverride = null, openOnMount = false }) {
  const location = useLocation()
  const hide =
    location.pathname === '/login' ||
    location.pathname.startsWith('/auth/')

  const accountId = profile?.account_id || null
  const userId = session?.user?.id || null

  const [open, setOpen] = useState(openOnMount)
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState([])
  const [suggestions, setSuggestions] = useState([])
  const [convState, setConvState] = useState(() => createConversationState())
  const [factsLoading, setFactsLoading] = useState(false)
  const [factsError, setFactsError] = useState(null)
  const [upgradeContext, setUpgradeContext] = useState(null)
  const [busy, setBusy] = useState(false)
  const listRef = useRef(null)
  const stickToBottomRef = useRef(true)
  const startedRef = useRef(false)

  const botActive = open && !factsOverride

  const swrKey = botActive && accountId ? accountDetailSwrKey(accountId, false) : null
  const { data: accountDetail, error: accountError, isLoading: accountLoading } = useSWR(
    swrKey,
    () => fetchAccountDetail(accountId, false),
    { revalidateOnFocus: false, revalidateOnReconnect: false, dedupingInterval: 60_000 },
  )

  const { accountTotalsByAccountId, accountList, isLoading: dkpLoading } = useDkpData(
    undefined,
    { enabled: botActive && Boolean(userId) },
  )

  const { data: saleCosts } = useSWR(
    botActive && userId ? 'roast-bot-sale-costs' : null,
    fetchSaleCosts,
    { revalidateOnFocus: false, dedupingInterval: 300_000 },
  )

  const { data: staticBundle } = useSWR(
    botActive && userId ? 'roast-bot-static-sources' : null,
    async () => {
      const [itemSources, mobLoot, raidItemSources] = await Promise.all([
        getItemSources(),
        getDkpMobLoot(),
        getRaidItemSources(),
      ])
      return { itemSources, mobLoot, raidItemSources }
    },
    { revalidateOnFocus: false, dedupingInterval: 600_000 },
  )

  const facts = useMemo(() => {
    if (factsOverride) return factsOverride
    if (!open) {
      return buildAccountFacts({ accountId: accountId || null })
    }
    const totals = accountId ? accountTotalsByAccountId?.[accountId] : null
    const guildBalances = (accountList || [])
      .map((row) => Number(row.balance ?? row.dkp_balance))
      .filter((n) => Number.isFinite(n))

    const detail = accountDetail
    const lootRows = lootRowsFromAccountDetail(detail)
    const attendanceRows = attendanceRowsFromAccountDetail(detail)
    const raidsById = raidsByIdFromAccountDetail(detail)
    const knownItemSources = buildKnownItemSources({
      itemSources: staticBundle?.itemSources,
      mobLoot: staticBundle?.mobLoot,
      raidItemSources: staticBundle?.raidItemSources,
    })

    const itemCatalog = []
    const seen = new Set()
    for (const p of lootRows) {
      const name = p.item_name
      if (!name || seen.has(name.toLowerCase())) continue
      seen.add(name.toLowerCase())
      itemCatalog.push({ name, itemId: p.item_id })
    }
    for (const entry of catalogEntriesFromKnownSources(knownItemSources)) {
      const key = String(entry.name || '').toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      itemCatalog.push(entry)
    }

    /** @type {Record<string, number[]>} */
    const comparableSalesByItem = {}
    for (const [key, entry] of Object.entries(saleCosts || {})) {
      comparableSalesByItem[key] = (entry.values || []).map(Number).filter((n) => Number.isFinite(n))
    }

    return buildAccountFacts({
      accountId,
      accountName: detail?.account?.display_name || null,
      currentDkp: totals?.balance ?? null,
      earnedDkp: totals?.earned ?? null,
      spentDkp: totals?.spent ?? null,
      guildBalances,
      characters: detail?.characters || [],
      lootRows,
      attendanceRows,
      raidsById,
      guildRaidCountInWindow: null,
      recentItemPrices: saleCosts || {},
      knownItemSources,
      itemCatalog,
      comparableSalesByItem,
    })
  }, [
    factsOverride,
    open,
    accountId,
    accountDetail,
    accountTotalsByAccountId,
    accountList,
    saleCosts,
    staticBundle,
  ])

  useEffect(() => {
    if (factsOverride) {
      setFactsLoading(false)
      return
    }
    if (!open) {
      setFactsLoading(false)
      return
    }
    setFactsLoading(Boolean(accountId) && (accountLoading || dkpLoading))
    setFactsError(accountError?.message || null)
  }, [factsOverride, open, accountId, accountLoading, dkpLoading, accountError])

  useEffect(() => {
    const next = resetIfIdentityChanged(convState, { userId, accountId })
    if (next !== convState) {
      setConvState(next)
      startedRef.current = false
      setMessages([])
      setUpgradeContext(null)
      resetUpgradeCaches()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to identity
  }, [userId, accountId])

  useEffect(() => {
    if (!open || startedRef.current || factsLoading) return
    const { response, state, suggestions: chips } = startConversation(facts)
    startedRef.current = true
    setConvState((prev) => ({
      ...state,
      authUserId: userId,
      accountId,
      selectedCharacterId: prev.selectedCharacterId,
      recentTemplateIds: state.recentTemplateIds,
    }))
    setMessages([{ role: 'bot', ...response }])
    setSuggestions(chips)
  }, [open, factsLoading, facts, userId, accountId])

  useEffect(() => {
    if (!open) return
    stickToBottomRef.current = true
  }, [open])

  useEffect(() => {
    const el = listRef.current
    if (!el || !open) return
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, open])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const onMessagesScroll = () => {
    const el = listRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distanceFromBottom < 80
  }

  const ensureUpgradeContext = useCallback(async () => {
    // Always try loadClassRankings (retryable after failure); refresh React ctx when rankings arrive
    const [rankingsResult, itemStats, raidItemIds] = await Promise.all([
      loadClassRankings(),
      ensureItemStatsLoaded().then(() =>
        fetch('/item_stats.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      ),
      collectRaidLootItemIds(),
    ])
    const rankings = rankingsResult?.ok ? rankingsResult.rankings : null
    const rankingsError = rankingsResult?.ok
      ? null
      : {
          error: rankingsResult?.error || 'unknown',
          status: rankingsResult?.status,
        }
    const ctx = { rankings, rankingsError, itemStats, raidItemIds }
    setUpgradeContext(ctx)
    return ctx
  }, [])

  const send = useCallback(
    async (raw) => {
      const text = String(raw || '').trim()
      if (!text || busy) return
      setBusy(true)
      setMessages((m) => [...m, { role: 'user', text }])
      setInput('')
      try {
        let ctx = upgradeContext
        if (needsMageloContext(text, convState.pendingIntent, convState.lastIntent)) {
          ctx = await ensureUpgradeContext()
        }

        let discoveryResult = null
        let discoveryAnswer = null
        let discoveryRecognition = null
        let whoIsResult = null
        let whoIsName = null
        let characterSpendResult = null
        const skipDiscoveryForUpgradeSlot = isUpgradeSlotFollowUp(text, convState)
        const characterSwap = isCharacterSwapFollowUp(text, convState)
        const swapName = characterSwap ? extractCharacterSwapFollowUp(text) : null
        if (!factsOverride) {
          if (looksLikeWhoIs(text) || (characterSwap && convState.lastIntent === INTENTS.WHO_IS)) {
            whoIsName = looksLikeWhoIs(text) ? extractWhoIsName(text) : swapName
            if (whoIsName) {
              try {
                whoIsResult = await lookupWhoIs(supabase, whoIsName)
              } catch {
                whoIsResult = {
                  status: 'not_found',
                  characterName: whoIsName,
                  accountId: null,
                  accountName: null,
                  lastRaidDate: null,
                  charId: null,
                }
              }
            }
          } else if (
            isCharacterDkpSpentQuestion(text) ||
            looksLikeCharacterDkpSpent(text) ||
            (characterSwap && convState.lastIntent === INTENTS.CHARACTER_DKP_SPENT)
          ) {
            const spendName =
              characterSwap && convState.lastIntent === INTENTS.CHARACTER_DKP_SPENT
                ? swapName
                : extractSpendCharacterName(text, {
                    characters: facts.characters || [],
                  })
            if (spendName) {
              try {
                characterSpendResult = await lookupCharacterDkpSpent(supabase, spendName)
              } catch {
                characterSpendResult = {
                  status: 'error',
                  characterName: spendName,
                  charId: null,
                  totalSpent: null,
                  error: 'lookup_failed',
                }
              }
            }
          } else if (!skipDiscoveryForUpgradeSlot && !characterSwap) {
            const prev = convState.lastDiscovery?.query || null
            const prevPrimary = convState.lastDiscovery?.primary || null
            discoveryRecognition = recognizeDiscovery(text, { prev, prevPrimary })
            if (
              discoveryRecognition.status === 'recognized' ||
              discoveryRecognition.status === 'ambiguous' ||
              discoveryRecognition.status === 'unsupported'
            ) {
              let itemStats = ctx?.itemStats || {}
              if (needsDiscoveryItemStats(text) || needsDiscoveryItemStats(prev?.raw || '')) {
                await ensureItemStatsLoaded()
                itemStats = await fetch('/item_stats.json')
                  .then((r) => (r.ok ? r.json() : {}))
                  .catch(() => ({}))
              }
              const run = await runDiscovery(supabase, text, {
                knownItemSources: facts.knownItemSources,
                itemCatalog: facts.itemCatalog,
                itemStats,
                prev,
                prevPrimary,
                recognition: discoveryRecognition,
              })
              if (run) {
                discoveryResult = run.result
                discoveryAnswer = run.answer
                discoveryRecognition = run.recognition || discoveryRecognition
              }
            } else {
              discoveryRecognition = null
            }
          }
        }

        const result = handleMessage({
          text,
          facts,
          state: { ...convState },
          upgradeContext: ctx,
          discoveryResult,
          discoveryAnswer,
          discoveryRecognition,
          whoIsResult,
          whoIsName,
          characterSpendResult,
        })
        setConvState(result.state)
        setMessages((m) => [...m, { role: 'bot', ...result.response }])
        setSuggestions(result.suggestions)
      } finally {
        setBusy(false)
      }
    },
    [busy, convState, facts, factsOverride, upgradeContext, ensureUpgradeContext],
  )

  const onCharSelect = (charId) => {
    setConvState((s) => {
      const next = { ...s }
      selectCharacterId(next, charId || null, facts)
      return next
    })
  }

  if (hide) return null

  const pendingChar = convState.pendingSlots?.includes('character')

  return (
    <div className="roast-bot-root" data-testid="roast-bot" data-open={open ? '1' : '0'}>
      {open ? (
        <div
          className="roast-bot-panel"
          role="dialog"
          aria-label={BOT_NAME}
          data-testid="roast-bot-panel"
        >
          <div className="roast-bot-header">
            <div>
              <h2>{BOT_NAME}</h2>
              <p className="roast-bot-tagline">{BOT_TAGLINE}</p>
            </div>
            <div className="roast-bot-header-actions">
              <button
                type="button"
                className="roast-bot-restart"
                data-testid="roast-bot-restart"
                aria-label="New judgment"
                disabled={busy || factsLoading}
                onClick={() => {
                  const { response, state, suggestions: chips } = startConversation(facts)
                  startedRef.current = true
                  setConvState({
                    ...state,
                    authUserId: userId,
                    accountId,
                    selectedCharacterId: convState.selectedCharacterId || null,
                  })
                  setMessages([{ role: 'bot', ...response }])
                  setSuggestions(chips)
                  setInput('')
                  setUpgradeContext(null)
                }}
              >
                New judgment
              </button>
              <button
                type="button"
                className="roast-bot-close"
                aria-label="Close chat"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
          </div>

          {(facts.characters || []).length > 1 ? (
            <div className={`roast-bot-char-select${pendingChar ? ' roast-bot-char-select-pending' : ''}`}>
              <label>
                {pendingChar
                  ? 'Which character?'
                  : 'Character (upgrades & attributed buys)'}
                <select
                  data-testid="roast-bot-character"
                  value={convState.selectedCharacterId || ''}
                  onChange={(e) => onCharSelect(e.target.value)}
                >
                  <option value="">Auto (account-wide spending)</option>
                  {facts.characters.map((c) => (
                    <option key={c.char_id || c.name} value={c.char_id || ''}>
                      {c.name}
                      {c.class_name ? ` (${c.class_name})` : ''}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}

          <div
            className="roast-bot-messages"
            ref={listRef}
            data-testid="roast-bot-messages"
            onScroll={onMessagesScroll}
          >
            {factsLoading ? (
              <div className="roast-bot-loading" data-testid="roast-bot-loading">
                Reviewing your loot history…
              </div>
            ) : null}
            {factsError ? (
              <div className="roast-bot-loading">
                Could not load account facts. I can still insult you generically.
              </div>
            ) : null}
            {messages.map((msg, i) => (
              <div
                key={`${msg.role}-${i}`}
                className={`roast-bot-msg roast-bot-msg-${msg.role}`}
                data-testid={msg.role === 'bot' ? 'roast-bot-reply' : 'roast-bot-user-msg'}
              >
                <div>{msg.text}</div>
                {msg.table?.rows?.length ? (
                  <div className="roast-bot-table-wrap">
                    <table className="roast-bot-table">
                      <thead>
                        <tr>
                          {(msg.table.columns || []).map((col) => (
                            <th key={col}>{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {msg.table.rows.map((row, rowIdx) => (
                          <tr key={`row-${rowIdx}`}>
                            {(msg.table.columns || []).map((col) => {
                              const key = col.toLowerCase()
                              const cell = row[key]
                              return (
                                <td key={`${rowIdx}-${col}`}>
                                  {renderTableCell(cell)}
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                {msg.links?.length ? (
                  <div className="roast-bot-links">
                    {msg.links.map((link) => (
                      <Link key={`${link.type}-${link.to}`} to={link.to}>
                        {link.label}
                      </Link>
                    ))}
                  </div>
                ) : null}
                {msg.cards?.length ? (
                  <div className="roast-bot-cards">
                    {msg.cards.map((card) => (
                      <div key={`${card.itemName}-${card.slot}`} className="roast-bot-card">
                        <Link to={card.to}>{card.itemName}</Link>
                        {card.slot ? ` · ${card.slot}` : ''}
                        {card.upgrade ? ` · ${card.upgrade}` : ''}
                        {card.lastSale != null ? ` · last sale ${card.lastSale} DKP` : ''}
                        {card.zone ? ` · ${card.zone}` : ''}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div className="roast-bot-chips" data-testid="roast-bot-chips">
            {suggestions.map((chip) => (
              <button
                key={chip}
                type="button"
                className="roast-bot-chip"
                onClick={() => send(chip)}
                disabled={busy || factsLoading}
              >
                {chip}
              </button>
            ))}
          </div>

          <form
            className="roast-bot-input-row"
            onSubmit={(e) => {
              e.preventDefault()
              send(input)
            }}
          >
            <input
              data-testid="roast-bot-input"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about loot, DKP, or bad decisions…"
              aria-label="Message the DKP Inquisitor"
              disabled={busy}
            />
            <button
              type="submit"
              className="roast-bot-send"
              data-testid="roast-bot-send"
              disabled={busy || !input.trim()}
            >
              Send
            </button>
          </form>
        </div>
      ) : null}

      <button
        type="button"
        className="roast-bot-toggle"
        data-testid="roast-bot-toggle"
        aria-label={open ? 'Close DKP Inquisitor' : 'Open DKP Inquisitor'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ☠
      </button>
    </div>
  )
}
