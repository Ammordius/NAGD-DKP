import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import useSWR from 'swr'
import { fetchAccountDetail } from '../pages/AccountDetail.jsx'
import { accountDetailSwrKey } from '../lib/accountDetailMissingScope'
import { useDkpData } from '../lib/dkpLeaderboard'
import { supabase } from '../lib/supabase'
import { fetchAllRpcByRange } from '../lib/fetchAllRpcByRange'
import { buildItemLast3FromSaleRows } from '../lib/recentItemSaleCosts'
import { getItemSources, getDkpMobLoot } from '../lib/staticData'
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
  loadClassRankings,
  collectRaidLootItemIds,
  resetUpgradeCaches,
} from '../lib/roastBot/index.js'
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

function buildKnownSources(itemSources, mobLoot) {
  /** @type {Record<string, { zone?: string, mob?: string }>} */
  const out = {}
  const add = (name, zone, mob) => {
    const key = String(name || '').trim().toLowerCase()
    if (!key) return
    if (!out[key]) out[key] = {}
    if (zone && !out[key].zone) out[key].zone = zone
    if (mob && !out[key].mob) out[key].mob = mob
  }
  if (itemSources && typeof itemSources === 'object') {
    for (const [name, info] of Object.entries(itemSources)) {
      if (Array.isArray(info)) {
        for (const row of info) add(name, row.zone || row.raid || row.source, row.mob || row.npc)
      } else if (info && typeof info === 'object') {
        add(name, info.zone || info.raid || info.source, info.mob || info.npc)
      }
    }
  }
  if (mobLoot && typeof mobLoot === 'object') {
    for (const [mob, items] of Object.entries(mobLoot)) {
      const list = Array.isArray(items) ? items : items?.items || []
      for (const it of list) {
        const name = typeof it === 'string' ? it : it?.name || it?.item_name
        add(name, it?.zone, mob)
      }
    }
  }
  return out
}

function needsMageloContext(text, pendingIntent) {
  const lower = String(text || '').toLowerCase()
  if (pendingIntent === 'gear_assessment' || pendingIntent === 'upgrades') return true
  return /upgrade|what should i buy|recommend|improve|gear|geared|well.?geared|gear check|buy for/.test(lower)
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
      const [itemSources, mobLoot] = await Promise.all([getItemSources(), getDkpMobLoot()])
      return { itemSources, mobLoot }
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
    const knownItemSources = buildKnownSources(staticBundle?.itemSources, staticBundle?.mobLoot)

    const itemCatalog = []
    const seen = new Set()
    for (const p of lootRows) {
      const name = p.item_name
      if (!name || seen.has(name.toLowerCase())) continue
      seen.add(name.toLowerCase())
      itemCatalog.push({ name, itemId: p.item_id })
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
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [messages, open])

  const ensureUpgradeContext = useCallback(async () => {
    // Always try loadClassRankings (retryable after failure); refresh React ctx when rankings arrive
    const [rankings, itemStats, raidItemIds] = await Promise.all([
      loadClassRankings(),
      ensureItemStatsLoaded().then(() =>
        fetch('/item_stats.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      ),
      collectRaidLootItemIds(),
    ])
    const ctx = { rankings, itemStats, raidItemIds }
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
        if (needsMageloContext(text, convState.pendingIntent)) {
          ctx = await ensureUpgradeContext()
        }
        const result = handleMessage({
          text,
          facts,
          state: { ...convState },
          upgradeContext: ctx,
        })
        setConvState(result.state)
        setMessages((m) => [...m, { role: 'bot', ...result.response }])
        setSuggestions(result.suggestions)
      } finally {
        setBusy(false)
      }
    },
    [busy, convState, facts, upgradeContext, ensureUpgradeContext],
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
            <button
              type="button"
              className="roast-bot-close"
              aria-label="Close chat"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </div>

          {(facts.characters || []).length > 1 ? (
            <div className={`roast-bot-char-select${pendingChar ? ' roast-bot-char-select-pending' : ''}`}>
              <label>
                {pendingChar ? 'Which character?' : 'Character'}
                <select
                  data-testid="roast-bot-character"
                  value={convState.selectedCharacterId || ''}
                  onChange={(e) => onCharSelect(e.target.value)}
                >
                  <option value="">Auto</option>
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

          <div className="roast-bot-messages" ref={listRef} data-testid="roast-bot-messages">
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
