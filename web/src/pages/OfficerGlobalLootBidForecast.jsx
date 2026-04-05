import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  CLASS_TO_ABBREV,
  computeUpgradesForCharacter,
  evaluateItemUpgradeForCharacter,
  itemUsableByClass,
} from '../lib/mageloUpgradeEngine'
import {
  avgDkpFromPrices,
  bidVsMarketFromPurchasesTimeAware,
  buildCharacterBalanceBullet,
  buildNameToItemId,
  buildSharedAccountSpendBullets,
  dormantToonVersusAccountNarrative,
  equipSlotKeyFromItemStats,
  estimateBidBand,
  interestScoreDormantPenalty,
  interestScoreRecentToonSpendBonus,
  interestScoreSameSlotCooldownPenalty,
  interestScoreUpgradeComponent,
  lastOnToonSpendQualityNarrative,
  lastSpendNarrative,
  mergeBidBandsForAccountRow,
  perToonShareNarrative,
  resolveItemIdFromName,
  spendArchetypeTags,
  toonBalanceFromProfile,
} from '../lib/bidForecastModel'
import { fetchBidForecastPrecomputeShard } from '../lib/bidForecastPrecomputeFetch'
import { ACTIVE_DAYS } from '../lib/dkpLeaderboard'
import { usePersistedState } from '../lib/usePersistedState'

const CLASS_RANKINGS_URL = import.meta.env.VITE_CLASS_RANKINGS_URL || '/class_rankings.json'

/** Days since last spend on a toon counts as "recent" for full upgrade list eligibility. */
const PRIORITY_RECENT_SPEND_DAYS = 35
/** With this top_toon_share and 2+ purchases, main toon qualifies as "invested". */
const PRIORITY_TOP_SHARE = 0.55

function normName(s) {
  return (s || '').trim().toLowerCase()
}

function accountLinkLabel(displayName, fallbackCharName, accountId) {
  const d = String(displayName || '').trim()
  if (d) return d
  const c = String(fallbackCharName || '').trim()
  if (c) return c
  return accountId && accountId !== '—' ? accountId : '—'
}

function findRankingChar(rankingsChars, attendeeName, attendeeClass) {
  if (!rankingsChars || !attendeeName) return null
  const n = normName(attendeeName)
  const cLower = normName(attendeeClass)
  return (
    rankingsChars.find(
      (c) => normName(c.name) === n && (!cLower || normName(c.class) === cLower),
    ) || null
  )
}

function findPrecomputedUpgrade(precomputedPayload, itemId, charName, className) {
  const list = precomputedPayload?.byItem?.[String(itemId)]
  if (!list || !Array.isArray(list)) return null
  const n = normName(charName)
  const c = normName(className)
  return list.find((e) => normName(e.name) === n && normName(e.class_name) === c) || null
}

function precomputedToUpgradeShape(pc) {
  if (!pc) return null
  return {
    eligible: true,
    isUpgrade: true,
    slotName: pc.slotName,
    slotId: pc.slotId,
    scoreDelta: pc.scoreDelta,
    hpDelta: pc.hpDelta,
    currentItemId: pc.currentItemId,
    currentItemName: pc.currentItemName,
    candidateName: pc.itemName,
    fromPrecompute: true,
    deltasDetail: pc.deltasDetail,
    focusSpellName: pc.focusSpellName,
  }
}

function formatDeltasDetail(d) {
  if (!d || typeof d !== 'object') return null
  const parts = []
  if (d.hpDelta != null) parts.push(`HP ${d.hpDelta > 0 ? '+' : ''}${d.hpDelta}`)
  if (d.manaDelta != null) parts.push(`Mana ${d.manaDelta > 0 ? '+' : ''}${d.manaDelta}`)
  if (d.acDelta != null) parts.push(`AC ${d.acDelta > 0 ? '+' : ''}${d.acDelta}`)
  if (d.svAllDelta != null) parts.push(`Resists (sum) ${d.svAllDelta > 0 ? '+' : ''}${d.svAllDelta}`)
  if (d.svDeltasByType && typeof d.svDeltasByType === 'object') {
    const inner = Object.entries(d.svDeltasByType)
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`)
    if (inner.length) parts.push(inner.join(', '))
  }
  return parts.length ? parts.join(' · ') : null
}

function characterQualifiesForUpgradeStrip(profile, charId) {
  if (!profile || !charId) return false
  const share = Number(profile.top_toon_share) || 0
  const pc = Number(profile.purchase_count) || 0
  const perToon = profile.per_toon_spent
  let topChar = null
  let topAmt = -1
  if (perToon && typeof perToon === 'object') {
    for (const [k, v] of Object.entries(perToon)) {
      const n = Number(v) || 0
      if (n > topAmt) {
        topAmt = n
        topChar = k
      }
    }
  }
  const isMainToon = topChar != null && String(topChar) === String(charId) && topAmt > 0
  const invested = share >= PRIORITY_TOP_SHARE && isMainToon && pc >= 2
  const lp = profile.last_purchase
  const days = profile.days_since_last_spend
  const recentHere =
    lp &&
    String(lp.char_id || '') === String(charId) &&
    days != null &&
    days <= PRIORITY_RECENT_SPEND_DAYS
  return invested || recentHere
}

export default function OfficerGlobalLootBidForecast({ isOfficer }) {
  const navigate = useNavigate()
  const [activityDays, setActivityDays] = useState(String(ACTIVE_DAYS))
  const [itemInput, setItemInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [forecastPayload, setForecastPayload] = useState(null)
  const [itemStats, setItemStats] = useState(null)
  const [dkpPrices, setDkpPrices] = useState(null)
  const [rankingsData, setRankingsData] = useState(null)
  const [precomputedByItem, setPrecomputedByItem] = useState(null)
  const [precomputedMeta, setPrecomputedMeta] = useState(null)
  const [precomputedLoadNote, setPrecomputedLoadNote] = useState('')
  const [precomputeShardStatus, setPrecomputeShardStatus] = useState('idle')
  const [upgradeCache, setUpgradeCache] = useState({})
  const [upgradeLoadingKey, setUpgradeLoadingKey] = useState(null)
  const [sortBy, setSortBy] = usePersistedState('/officer/global-loot-bid-forecast:sortBy', 'interest')

  useEffect(() => {
    if (!isOfficer) navigate('/')
  }, [isOfficer, navigate])

  useEffect(() => {
    let cancelled = false
    fetch('/item_stats.json')
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) setItemStats(j)
      })
      .catch(() => {
        if (!cancelled) setItemStats(null)
      })
    fetch('/dkp_prices.json')
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) setDkpPrices(j)
      })
      .catch(() => {
        if (!cancelled) setDkpPrices(null)
      })
    fetch('/bid_forecast_meta.json')
      .then((r) => {
        if (r.status === 404) return null
        if (!r.ok) return null
        return r.json()
      })
      .then((j) => {
        if (!cancelled) setPrecomputedMeta(j && typeof j === 'object' ? j : null)
      })
      .catch(() => {
        if (!cancelled) setPrecomputedMeta(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const fetchRankingsJson = useCallback(async () => {
    const r = await fetch(CLASS_RANKINGS_URL)
    if (!r.ok) throw new Error(String(r.status))
    const j = await r.json()
    setRankingsData(j)
    return j
  }, [])

  const loadRankings = useCallback(() => {
    fetchRankingsJson().catch(() => {
      setRankingsData(null)
    })
  }, [fetchRankingsJson])

  const nameToId = useMemo(() => buildNameToItemId(itemStats), [itemStats])

  const resolvedItemId = useMemo(() => {
    const t = (itemInput || '').trim()
    if (!t) return null
    if (/^\d+$/.test(t)) return t
    return resolveItemIdFromName(t, nameToId)
  }, [itemInput, nameToId])

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()

    if (!resolvedItemId) {
      setPrecomputedByItem(null)
      setPrecomputeShardStatus('idle')
      setPrecomputedLoadNote('')
      return () => ac.abort()
    }

    setPrecomputeShardStatus('loading')
    setPrecomputedLoadNote('')
    setPrecomputedByItem(null)

    fetchBidForecastPrecomputeShard(resolvedItemId, { signal: ac.signal })
      .then((result) => {
        if (cancelled) return
        if (result.ok) {
          setPrecomputedByItem(result.payload)
          setPrecomputeShardStatus('ready')
        } else if (result.absent) {
          setPrecomputedByItem(null)
          setPrecomputeShardStatus('absent')
          setPrecomputedLoadNote(
            'No CI shard for this item (bid_forecast_items/{id}.json). Live Magelo JSON will be used when needed.',
          )
        } else if (result.badShape) {
          setPrecomputedByItem(null)
          setPrecomputeShardStatus('error')
          setPrecomputedLoadNote(
            result.looksLikeHtml
              ? 'Could not load bid forecast shard (got HTML instead of JSON). Deploy web/public/bid_forecast_items from CI, or fix hosting so .json under /bid_forecast_items/ is not rewritten to index.html.'
              : 'Could not load bid forecast shard (invalid JSON). Check network or run CI precompute job.',
          )
        } else if (result.networkError) {
          setPrecomputedByItem(null)
          setPrecomputeShardStatus('error')
          setPrecomputedLoadNote('Could not load bid forecast shard (network error).')
        } else {
          setPrecomputedByItem(null)
          setPrecomputeShardStatus('error')
          setPrecomputedLoadNote(
            'Could not load bid forecast shard for this item. Check network or run CI precompute job.',
          )
        }
      })
      .catch((e) => {
        if (cancelled || e?.name === 'AbortError') return
        setPrecomputedByItem(null)
        setPrecomputeShardStatus('error')
        setPrecomputedLoadNote('Could not load bid forecast shard for this item.')
      })

    return () => {
      cancelled = true
      ac.abort()
    }
  }, [resolvedItemId])

  useEffect(() => {
    if (!forecastPayload?.roster || !resolvedItemId || !itemStats || rankingsData != null) {
      return
    }
    let needsMagelo = false
    for (const block of forecastPayload.roster) {
      for (const c of block.characters || []) {
        const name = (c.name || '').trim()
        const cls = (c.class_name || '').trim()
        const pc = findPrecomputedUpgrade(precomputedByItem, resolvedItemId, name, cls)
        if (!pc) {
          needsMagelo = true
          break
        }
      }
      if (needsMagelo) break
    }
    if (!needsMagelo) return
    loadRankings()
  }, [forecastPayload, resolvedItemId, itemStats, precomputedByItem, rankingsData, loadRankings])

  const runForecast = async () => {
    const days = Math.min(730, Math.max(1, parseInt(activityDays, 10) || ACTIVE_DAYS))
    setError('')
    setLoading(true)
    setForecastPayload(null)
    setUpgradeCache({})
    try {
      const { data, error: rpcErr } = await supabase.rpc('officer_global_bid_forecast', {
        p_activity_days: days,
      })
      if (rpcErr) throw rpcErr
      setForecastPayload(data || null)
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  const rows = useMemo(() => {
    if (!forecastPayload?.roster || !resolvedItemId || !itemStats) return []
    const roster = forecastPayload.roster
    const profiles = forecastPayload.account_profiles || {}
    const rankingsChars = rankingsData?.characters || []
    const classWeights = rankingsData?.class_weights || {}
    const focusCandidates = rankingsData?.focus_candidates || {}

    const ctx = {
      itemStats,
      classWeights,
      focusCandidates,
      spellFociiList: null,
      elementalDisplayNames: {},
    }

    const out = []
    for (const block of roster) {
      const accountId = block.account_id
      const accountDisplayName = String(block.display_name || '').trim()
      const chars = Array.isArray(block.characters) ? block.characters : []
      const prof = accountId ? profiles[accountId] : null

      for (const a of chars) {
        const charId = (a.char_id || '').trim()
        const charName = (a.name || '').trim()
        const className = (a.class_name || '').trim()

        const pc = findPrecomputedUpgrade(precomputedByItem, resolvedItemId, charName, className)
        const mageloChar = findRankingChar(rankingsChars, charName, className)

        let upgrade = null
        if (pc) {
          upgrade = precomputedToUpgradeShape(pc)
        } else if (mageloChar) {
          upgrade = evaluateItemUpgradeForCharacter(mageloChar, resolvedItemId, ctx)
        }

        if (upgrade && upgrade.eligible === false && upgrade.reason === 'class_mismatch') {
          continue
        }
        const stClasses = itemStats[String(resolvedItemId)]?.classes
        if (stClasses && className) {
          const ab = CLASS_TO_ABBREV[className]
          if (ab && !itemUsableByClass(stClasses, ab)) {
            continue
          }
        }

        const purchases = Array.isArray(prof?.recent_purchases_desc) ? prof.recent_purchases_desc : []
        const bidInfo = bidVsMarketFromPurchasesTimeAware(purchases, nameToId, dkpPrices || {})
        const currentSlotKey = equipSlotKeyFromItemStats(itemStats[String(resolvedItemId)])
        const accountBalance = prof?.balance != null ? Number(prof.balance) : 0
        const toonBalance = prof ? toonBalanceFromProfile(prof, charId) : 0
        const bidBalance = prof ? accountBalance : 0
        const tags = spendArchetypeTags(prof, bidInfo.label, bidInfo.medianRatio, {
          attendeeCharId: charId || undefined,
        })
        const anchor = avgDkpFromPrices(dkpPrices || {}, resolvedItemId, 3)
        const band = estimateBidBand(bidBalance, anchor, bidInfo.medianRatio, upgrade?.scoreDelta)

        const toonBullets = []
        if (pc) {
          toonBullets.push(
            `Upgrade vs ${pc.slotName}${pc.currentItemName ? ` (currently ${pc.currentItemName})` : ''}: score Δ ≈ ${pc.scoreDelta?.toFixed?.(3) ?? pc.scoreDelta}; HP Δ ${pc.hpDelta ?? 0}. (Precomputed CI index)`,
          )
          if (pc.focusSpellName) toonBullets.push(`Focus: ${pc.focusSpellName}`)
          const deltaFmt = formatDeltasDetail(pc.deltasDetail)
          if (deltaFmt) toonBullets.push(`Stat deltas: ${deltaFmt}`)
        } else if (mageloChar && upgrade?.eligible) {
          if (upgrade.isUpgrade) {
            toonBullets.push(
              `Upgrade vs ${upgrade.slotName}${upgrade.currentItemName ? ` (currently ${upgrade.currentItemName})` : ''}: score Δ ≈ ${upgrade.scoreDelta?.toFixed?.(3) ?? upgrade.scoreDelta}; HP Δ ${upgrade.hpDelta ?? 0}.`,
            )
          } else {
            toonBullets.push(
              `Can equip in ${upgrade.slotName} but Magelo scoring does not show a gain (sidegrade/downgrade vs current).`,
            )
          }
        } else if (!pc && !mageloChar) {
          toonBullets.push('No CI upgrade row and no matching Magelo export for this toon.')
        } else if (upgrade && !upgrade.eligible) {
          toonBullets.push(`Not a candidate for this item: ${upgrade.reason || 'unknown'}.`)
        }

        if (prof) {
          toonBullets.unshift(buildCharacterBalanceBullet(toonBalance))
          const dorm = dormantToonVersusAccountNarrative(prof, charId, charName)
          if (dorm) toonBullets.push(dorm)
          const pts = perToonShareNarrative(prof, charId)
          if (pts) toonBullets.push(pts)
          toonBullets.push(lastSpendNarrative(prof, charId))
          const spendQ = lastOnToonSpendQualityNarrative(purchases, charId, charName)
          if (spendQ) toonBullets.push(spendQ)
        }

        const classAbbrev = className ? CLASS_TO_ABBREV[className] : null
        const currentItemRow = itemStats[String(resolvedItemId)] || itemStats[Number(resolvedItemId)]

        let interestScore =
          interestScoreUpgradeComponent(!!upgrade?.isUpgrade, upgrade?.scoreDelta)
          + (prof && bidBalance > 0 ? Math.min(25, bidBalance / 8) : 0)
          + (bidInfo.medianRatio != null && bidInfo.medianRatio >= 1.1 ? 8 : 0)
        interestScore += interestScoreRecentToonSpendBonus(prof, charId, charName)
        interestScore -= interestScoreSameSlotCooldownPenalty(
          purchases,
          nameToId,
          itemStats,
          charId,
          charName,
          currentSlotKey,
          { classAbbrev: classAbbrev || null, currentItemStatsRow: currentItemRow },
        )
        interestScore -= interestScoreDormantPenalty(prof, charId, charName)

        const upgradeShort = pc
          ? `Upgrade vs ${pc.slotName} (score Δ ${pc.scoreDelta?.toFixed?.(2) ?? pc.scoreDelta})`
          : mageloChar && upgrade?.eligible && upgrade.isUpgrade
            ? `Upgrade (score Δ ${upgrade.scoreDelta?.toFixed?.(2) ?? upgrade.scoreDelta})`
            : mageloChar && upgrade?.eligible
              ? 'Equip / sidegrade'
              : !pc && !mageloChar
                ? 'No Magelo / precompute'
                : upgrade && !upgrade.eligible
                  ? (upgrade.reason || 'Not eligible')
                  : '—'
        const oneLineSummary = `${charName || charId || '—'}${className ? ` (${className})` : ''}: ${upgradeShort} · ~${Math.round(bidBalance)} DKP · band ${band.low}–${band.high}`

        const toonRowKey = `${accountId}:${charId || charName}`
        const showUpgradeStrip =
          characterQualifiesForUpgradeStrip(prof, charId) && (!!pc || !!mageloChar)

        out.push({
          toonRowKey,
          charName: charName || charId || '—',
          charId,
          className,
          accountId: accountId || '—',
          accountDisplayName,
          interestScore,
          tags,
          band,
          anchor,
          toonBullets,
          prof,
          bidInfo,
          accountBalance,
          toonBalance,
          oneLineSummary,
          upgrade,
          hasMagelo: !!mageloChar,
          hasPrecompute: !!pc,
          mageloChar,
          showUpgradeStrip,
        })
      }
    }

    const byAccount = new Map()
    for (const r of out) {
      const k = r.accountId && r.accountId !== '—' ? r.accountId : `orphan:${r.toonRowKey}`
      if (!byAccount.has(k)) byAccount.set(k, [])
      byAccount.get(k).push(r)
    }

    const merged = []
    for (const [k, group] of byAccount) {
      if (group.length === 1) {
        const g = group[0]
        merged.push({
          rowKey: g.toonRowKey,
          consolidated: false,
          accountId: g.accountId,
          accountDisplayName: g.accountDisplayName,
          interestScore: g.interestScore,
          tags: g.tags,
          band: g.band,
          anchor: g.anchor,
          charLine: `${g.charName}${g.className ? ` (${g.className})` : ''}`,
          classLabel: g.className || '—',
          collapsedSummary: g.oneLineSummary,
          toons: [g],
          sharedBullets: buildSharedAccountSpendBullets(g.prof, g.bidInfo, g.tags, null, {
            includeAccountPoolLine: false,
          }),
        })
      } else {
        const g0 = group[0]
        const accountTags = spendArchetypeTags(g0.prof, g0.bidInfo.label, g0.bidInfo.medianRatio, {
          accountLevelArchetype: true,
        })
        const sharedBullets = buildSharedAccountSpendBullets(
          g0.prof,
          g0.bidInfo,
          accountTags,
          null,
          {
            includeAccountPoolLine: true,
            accountPoolBalance: Number(g0.prof?.balance) || 0,
          },
        )
        const maxScore = Math.max(...group.map((x) => x.interestScore))
        const primary = group.reduce((a, b) => (a.interestScore >= b.interestScore ? a : b))
        const collapsedSummary = `${primary.oneLineSummary} · +${group.length - 1} more on account`
        merged.push({
          rowKey: `account:${k}`,
          consolidated: true,
          accountId: k,
          accountDisplayName: g0.accountDisplayName,
          interestScore: maxScore,
          tags: accountTags,
          band: mergeBidBandsForAccountRow(group.map((x) => x.band)),
          anchor: g0.anchor,
          charLine: group
            .map((g) => `${g.charName}${g.className ? ` (${g.className})` : ''}`)
            .join(' · '),
          classLabel: group.map((g) => g.className || '—').join(', '),
          collapsedSummary,
          toons: group,
          sharedBullets,
        })
      }
    }

    const sb = sortBy || 'interest'
    merged.sort((a, b) => {
      if (sb === 'bandHigh') {
        const vb = Number(b.band?.high) || 0
        const va = Number(a.band?.high) || 0
        if (vb !== va) return vb - va
      }
      if (sb === 'class') {
        const c = (a.classLabel || '').localeCompare(b.classLabel || '', undefined, {
          sensitivity: 'base',
        })
        if (c !== 0) return c
      }
      if (sb === 'charName') {
        const c = (a.charLine || '').localeCompare(b.charLine || '', undefined, {
          sensitivity: 'base',
        })
        if (c !== 0) return c
      }
      return b.interestScore - a.interestScore
    })
    return merged
  }, [forecastPayload, resolvedItemId, itemStats, rankingsData, dkpPrices, nameToId, precomputedByItem, sortBy])

  const loadUpgradesForToon = async (toon) => {
    const key = toon.toonRowKey
    if (upgradeCache[key] || !itemStats) return
    setUpgradeLoadingKey(key)
    try {
      let rd = rankingsData
      if (!rd) {
        try {
          rd = await fetchRankingsJson()
        } catch {
          setUpgradeCache((prev) => ({
            ...prev,
            [key]: { error: 'Could not load class rankings.' },
          }))
          return
        }
      }
      const mageloChar =
        toon.mageloChar || findRankingChar(rd.characters || [], toon.charName, toon.className)
      const ctx = {
        itemStats,
        classWeights: rd.class_weights || {},
        focusCandidates: rd.focus_candidates || {},
        spellFociiList: null,
        elementalDisplayNames: {},
      }
      if (!mageloChar) {
        setUpgradeCache((prev) => ({
          ...prev,
          [key]: { error: 'No Magelo export row for this toon (name + class).' },
        }))
        return
      }
      const result = computeUpgradesForCharacter(mageloChar, 15, false, ctx)
      setUpgradeCache((prev) => ({ ...prev, [key]: result }))
    } finally {
      setUpgradeLoadingKey(null)
    }
  }

  const renderWhyUpgradesCell = (r) => {
    const summaryStyle = {
      cursor: 'pointer',
      color: '#d4d4d8',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      listStyle: 'none',
    }
    const sharedUl =
      r.sharedBullets.length > 0 ? (
        <ul
          style={{
            margin: '0 0 0.5rem',
            paddingLeft: '1.1rem',
            color: '#a1a1aa',
          }}
        >
          {r.sharedBullets.map((text, i) => (
            <li key={`s-${i}`} style={{ marginBottom: '0.25rem' }}>
              {text}
            </li>
          ))}
        </ul>
      ) : null

    const toonBulletsUl = (t) => (
      <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
        {t.toonBullets.map((text, i) => (
          <li key={i} style={{ marginBottom: '0.25rem' }}>
            {text}
          </li>
        ))}
      </ul>
    )

    const mageloBlock = (t) => {
      const cached = upgradeCache[t.toonRowKey]
      const loadingUp = upgradeLoadingKey === t.toonRowKey
      if (!t.showUpgradeStrip) return null
      return (
        <div style={{ marginTop: '0.5rem' }}>
          {!cached && (
            <button
              type="button"
              className="btn btn-ghost"
              style={{ fontSize: '0.8rem', padding: '0.2rem 0.5rem' }}
              disabled={loadingUp || !itemStats}
              onClick={() => loadUpgradesForToon(t)}
            >
              {loadingUp
                ? 'Computing…'
                : r.consolidated && r.toons.length > 1
                  ? `Magelo upgrades (${t.charName})`
                  : 'Show top upgrades by slot (Magelo)'}
            </button>
          )}
          {cached?.error && <p style={{ color: '#fbbf24', margin: '0.25rem 0 0' }}>{cached.error}</p>}
          {cached && !cached.error && cached.bySlot?.length > 0 && (
            <div style={{ marginTop: '0.5rem' }}>
              {cached.bySlot.map((slot) => (
                <div key={slot.slotId} style={{ marginBottom: '0.75rem' }}>
                  <div style={{ fontWeight: 600, color: '#d4d4d8' }}>
                    {slot.slotName}
                    {slot.currentItemName ? ` · current: ${slot.currentItemName}` : ''}
                  </div>
                  {slot.upgrades?.length ? (
                    <ul
                      style={{
                        margin: '0.25rem 0 0',
                        paddingLeft: '1.1rem',
                        color: '#a1a1aa',
                      }}
                    >
                      {slot.upgrades.map((u) => (
                        <li key={u.itemId}>
                          {u.itemName}{' '}
                          <span style={{ color: '#86efac' }}>Δ {u.delta?.toFixed?.(2) ?? u.delta}</span>
                          {u.deltas?.hpDelta
                            ? ` · HP ${u.deltas.hpDelta > 0 ? '+' : ''}${u.deltas.hpDelta}`
                            : ''}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p style={{ margin: '0.25rem 0 0', color: '#71717a' }}>No scored upgrades in pool.</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )
    }

    if (!r.consolidated || r.toons.length === 1) {
      const t = r.toons[0]
      return (
        <details style={{ maxWidth: '36rem' }}>
          <summary style={summaryStyle} title={r.collapsedSummary}>
            {r.collapsedSummary}
          </summary>
          <div style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
            {sharedUl}
            {toonBulletsUl(t)}
            {mageloBlock(t)}
          </div>
        </details>
      )
    }

    return (
      <details style={{ maxWidth: '36rem' }}>
        <summary style={summaryStyle} title={r.collapsedSummary}>
          {r.collapsedSummary}
        </summary>
        <div style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
          {sharedUl}
          {r.toons.map((t) => (
            <details key={t.toonRowKey} style={{ marginTop: '0.65rem' }}>
              <summary
                style={{
                  ...summaryStyle,
                  color: '#e4e4e7',
                  fontWeight: 600,
                }}
                title={t.oneLineSummary}
              >
                {t.oneLineSummary}
              </summary>
              <div style={{ marginTop: '0.35rem' }}>
                {toonBulletsUl(t)}
                {mageloBlock(t)}
              </div>
            </details>
          ))}
        </div>
      </details>
    )
  }

  if (!isOfficer) return null

  const itemDisplayName =
    resolvedItemId && itemStats?.[String(resolvedItemId)]?.name
      ? itemStats[String(resolvedItemId)].name
      : itemInput.trim() || '—'

  const activityApplied = forecastPayload?.activity_days
  const stalePrecomputeDays =
    precomputedMeta?.generated_at != null
      ? (Date.now() - new Date(precomputedMeta.generated_at).getTime()) / (86400 * 1000)
      : null

  return (
    <div className="container">
      <h1>Global item bid interest (officer)</h1>
      <p style={{ color: '#a1a1aa', marginBottom: '1rem', maxWidth: '52rem' }}>
        Heuristic only: active accounts (recent raid activity or pinned in Admin, same rules as the DKP leaderboard) and
        their characters vs one item. Upgrade copy prefers the CI precompute index when present; full Magelo JSON loads
        only for live fallback or slot-deep upgrades. Uses guild sale history for paid/reference when the database RPC
        provides it. Not a prediction of bids.{' '}
        <Link to="/officer" style={{ marginLeft: '0.5rem' }}>← Officer</Link>
        {' · '}
        <Link to="/officer/loot-bid-forecast">Bid hints (by raid)</Link>
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end', marginBottom: '1rem' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span style={{ fontSize: '0.8rem', color: '#a1a1aa' }}>Activity window (days)</span>
          <input
            className="input"
            style={{ minWidth: '8rem' }}
            type="number"
            min={1}
            max={730}
            value={activityDays}
            onChange={(e) => setActivityDays(e.target.value)}
            title="Accounts with last_activity_date within this window, or listed in active_accounts"
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span style={{ fontSize: '0.8rem', color: '#a1a1aa' }}>Item (name or id)</span>
          <input
            className="input"
            style={{ minWidth: '16rem' }}
            value={itemInput}
            onChange={(e) => setItemInput(e.target.value)}
            placeholder="Item name or Allaclone id"
          />
        </label>
        <button type="button" className="btn btn-primary" disabled={loading} onClick={runForecast}>
          {loading ? 'Loading…' : 'Run'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={loadRankings}>
          Reload Magelo JSON
        </button>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span style={{ fontSize: '0.8rem', color: '#a1a1aa' }}>Sort</span>
          <select
            className="input"
            style={{ minWidth: '11rem' }}
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            <option value="interest">Interest score</option>
            <option value="bandHigh">Bid band (high)</option>
            <option value="charName">Character A–Z</option>
            <option value="class">Class A–Z</option>
          </select>
        </label>
      </div>

      {precomputeShardStatus === 'loading' && (
        <p style={{ color: '#a1a1aa', marginBottom: '0.5rem', fontSize: '0.9rem' }}>
          Loading CI upgrade index for this item…
        </p>
      )}
      {precomputedMeta?.generated_at && (
        <p style={{ color: '#71717a', marginBottom: '0.5rem', fontSize: '0.85rem' }}>
          Precomputed upgrade index: generated {precomputedMeta.generated_at}
          {stalePrecomputeDays != null && stalePrecomputeDays > 7
            ? ` (${Math.floor(stalePrecomputeDays)}d ago — consider refreshing CI)`
            : ''}
        </p>
      )}
      {precomputedLoadNote && (
        <p style={{ color: '#fbbf24', marginBottom: '0.5rem', fontSize: '0.9rem' }}>{precomputedLoadNote}</p>
      )}
      {error && <p style={{ color: '#f87171', marginBottom: '0.75rem' }}>{error}</p>}

      {forecastPayload && resolvedItemId && (
        <p style={{ color: '#a1a1aa', fontSize: '0.9rem', marginBottom: '0.75rem' }}>
          Item: <strong style={{ color: '#e4e4e7' }}>{itemDisplayName}</strong> (id {resolvedItemId})
          {activityApplied != null && (
            <>
              {' '}
              · Activity: last {activityApplied} days (or pinned accounts)
            </>
          )}
          {rows[0]?.anchor != null && (
            <>
              {' '}
              · Static anchor (avg last 3 in dkp_prices.json): ~{Math.round(rows[0].anchor)} DKP
            </>
          )}
          {stalePrecomputeDays != null && stalePrecomputeDays > 3 && (
            <>
              {' '}
              · CI upgrade index age: ~{Math.round(stalePrecomputeDays)} days
            </>
          )}
        </p>
      )}

      {forecastPayload && !resolvedItemId && itemInput.trim() && (
        <p style={{ color: '#fbbf24' }}>Could not resolve item id from name. Check spelling or enter numeric id.</p>
      )}

      {rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Interest</th>
                <th>Character</th>
                <th>Class</th>
                <th>Account</th>
                <th>Tags</th>
                <th>Bid band</th>
                <th>Why / upgrades</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.rowKey}>
                  <td>{Math.round(r.interestScore)}</td>
                  <td style={{ maxWidth: '14rem' }}>{r.charLine}</td>
                  <td style={{ maxWidth: '10rem' }}>{r.classLabel}</td>
                  <td style={{ fontSize: '0.85rem', wordBreak: 'break-all' }}>
                    {r.accountId !== '—' ? (
                      <Link to={`/accounts/${encodeURIComponent(r.accountId)}`}>
                        {accountLinkLabel(r.accountDisplayName, r.toons[0]?.charName, r.accountId)}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td style={{ fontSize: '0.8rem', maxWidth: '10rem' }}>
                    {r.tags.length ? r.tags.join(', ') : '—'}
                  </td>
                  <td style={{ fontSize: '0.85rem', whiteSpace: 'nowrap' }} title={r.band?.note || undefined}>
                    {r.band.low}–{r.band.high} (mid {r.band.mid})
                    {r.consolidated && r.band?.note ? (
                      <span style={{ color: '#71717a', fontSize: '0.72rem', marginLeft: '0.25rem' }}>(span)</span>
                    ) : null}
                  </td>
                  <td style={{ fontSize: '0.8rem', maxWidth: '36rem', verticalAlign: 'top' }}>
                    {renderWhyUpgradesCell(r)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {forecastPayload && resolvedItemId && rows.length === 0 && (
        <p style={{ color: '#71717a' }}>No matching characters (class mismatch, or missing item_stats.json).</p>
      )}
    </div>
  )
}
