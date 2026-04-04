import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  CLASS_TO_ABBREV,
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
  estimateBidBand,
  interestScoreDormantPenalty,
  lastSpendNarrative,
  mergeBidBandsForAccountRow,
  perToonShareNarrative,
  resolveItemIdFromName,
  spendArchetypeTags,
  toonBalanceFromProfile,
} from '../lib/bidForecastModel'
import { ACTIVE_DAYS } from '../lib/dkpLeaderboard'
import { usePersistedState } from '../lib/usePersistedState'

const CLASS_RANKINGS_URL = import.meta.env.VITE_CLASS_RANKINGS_URL || '/class_rankings.json'

function normName(s) {
  return (s || '').trim().toLowerCase()
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

/** Normalize raid vs global RPC payloads into one list of people + account_id. */
function normalizedForecastPeople(payload) {
  if (!payload) return []
  if (Array.isArray(payload.roster)) {
    const rows = []
    for (const block of payload.roster) {
      const aid = block.account_id
      for (const c of block.characters || []) {
        rows.push({
          char_id: (c.char_id || '').trim(),
          character_name: (c.name || '').trim(),
          class_name: (c.class_name || '').trim(),
          account_id: aid,
        })
      }
    }
    return rows
  }
  if (Array.isArray(payload.attendees)) {
    return payload.attendees.map((a) => ({
      char_id: (a.char_id || '').trim(),
      character_name: (a.character_name || '').trim(),
      class_name: (a.class_name || '').trim(),
      account_id: a.account_id,
    }))
  }
  return []
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

export default function OfficerLootBidForecast({ isOfficer }) {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const raidIdParam = searchParams.get('raid') || ''

  const [raidInput, setRaidInput] = useState(raidIdParam)
  const [activityDays, setActivityDays] = useState(String(ACTIVE_DAYS))
  const [itemInput, setItemInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [forecastPayload, setForecastPayload] = useState(null)
  const [itemStats, setItemStats] = useState(null)
  const [dkpPrices, setDkpPrices] = useState(null)
  const [rankingsData, setRankingsData] = useState(null)
  const [rankingsError, setRankingsError] = useState('')
  const [precomputedByItem, setPrecomputedByItem] = useState(null)
  const [precomputedMeta, setPrecomputedMeta] = useState(null)
  const [precomputedLoadNote, setPrecomputedLoadNote] = useState('')
  const [precomputeReady, setPrecomputeReady] = useState(false)
  const [sortBy, setSortBy] = usePersistedState('/officer/loot-bid-forecast:sortBy', 'interest')

  useEffect(() => {
    if (!isOfficer) navigate('/')
  }, [isOfficer, navigate])

  useEffect(() => {
    setRaidInput(raidIdParam)
  }, [raidIdParam])

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
    fetch('/bid_forecast_by_item.json')
      .then((r) => {
        if (r.status === 404) return null
        if (!r.ok) throw new Error(String(r.status))
        return r.json()
      })
      .then((j) => {
        if (!cancelled) setPrecomputedByItem(j && typeof j === 'object' ? j : null)
      })
      .catch(() => {
        if (!cancelled) {
          setPrecomputedByItem(null)
          setPrecomputedLoadNote('No bid_forecast_by_item.json (CI precompute not deployed yet).')
        }
      })
      .finally(() => {
        if (!cancelled) setPrecomputeReady(true)
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

  const loadRankings = useCallback(() => {
    setRankingsError('')
    fetch(CLASS_RANKINGS_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`)
        return r.json()
      })
      .then((j) => setRankingsData(j))
      .catch(() => {
        setRankingsData(null)
        setRankingsError(
          `Could not load class rankings from ${CLASS_RANKINGS_URL}. Set VITE_CLASS_RANKINGS_URL or add class_rankings.json to web/public for live upgrade scoring (fallback when precompute misses).`,
        )
      })
  }, [])

  const nameToId = useMemo(() => buildNameToItemId(itemStats), [itemStats])

  const resolvedItemId = useMemo(() => {
    const t = (itemInput || '').trim()
    if (!t) return null
    if (/^\d+$/.test(t)) return t
    return resolveItemIdFromName(t, nameToId)
  }, [itemInput, nameToId])

  useEffect(() => {
    if (
      !precomputeReady ||
      !forecastPayload ||
      !resolvedItemId ||
      !itemStats ||
      rankingsData != null
    ) {
      return
    }
    const people = normalizedForecastPeople(forecastPayload)
    if (!people.length) return
    let needsMagelo = false
    for (const a of people) {
      const name = (a.character_name || '').trim()
      const cls = (a.class_name || '').trim()
      const pc = findPrecomputedUpgrade(precomputedByItem, resolvedItemId, name, cls)
      if (!pc) {
        needsMagelo = true
        break
      }
    }
    if (!needsMagelo) return
    loadRankings()
  }, [
    precomputeReady,
    forecastPayload,
    resolvedItemId,
    itemStats,
    precomputedByItem,
    rankingsData,
    loadRankings,
  ])

  const runForecast = async () => {
    const rid = (raidInput || '').trim()
    setError('')
    setLoading(true)
    setForecastPayload(null)
    try {
      if (rid) {
        setSearchParams({ raid: rid })
        const { data, error: rpcErr } = await supabase.rpc('officer_loot_bid_forecast', {
          p_raid_id: rid,
        })
        if (rpcErr) throw rpcErr
        setForecastPayload(data || null)
      } else {
        setSearchParams({})
        const days = Math.min(730, Math.max(1, parseInt(activityDays, 10) || ACTIVE_DAYS))
        const { data, error: rpcErr } = await supabase.rpc('officer_global_bid_forecast', {
          p_activity_days: days,
        })
        if (rpcErr) throw rpcErr
        setForecastPayload(data || null)
      }
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  const forecastPeople = useMemo(
    () => normalizedForecastPeople(forecastPayload),
    [forecastPayload],
  )

  const rows = useMemo(() => {
    if (!forecastPayload || !resolvedItemId || !itemStats) return []
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
    for (const a of forecastPeople) {
      const charId = a.char_id
      const charName = a.character_name
      const className = a.class_name
      const accountId = a.account_id
      const prof = accountId ? profiles[accountId] : null

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
      const accountBalance = prof?.balance != null ? Number(prof.balance) : 0
      const toonBalance = prof ? toonBalanceFromProfile(prof, charId) : 0
      const tags = spendArchetypeTags(prof, bidInfo.label, bidInfo.medianRatio, {
        attendeeCharId: charId || undefined,
        longSaveBalance: toonBalance,
      })
      const anchor = avgDkpFromPrices(dkpPrices || {}, resolvedItemId, 3)
      const band = estimateBidBand(toonBalance, anchor, bidInfo.medianRatio, upgrade?.scoreDelta)

      const summaryLinePre =
        pc != null
          ? `Upgrade vs ${pc.slotName}${pc.currentItemName ? ` (currently ${pc.currentItemName})` : ''}: score Δ ≈ ${pc.scoreDelta?.toFixed?.(3) ?? pc.scoreDelta}; HP Δ ${pc.hpDelta ?? 0}. (Precomputed CI index)`
          : null

      const toonDetailBullets = []
      if (summaryLinePre) toonDetailBullets.push(summaryLinePre)
      if (pc?.focusSpellName) toonDetailBullets.push(`Focus: ${pc.focusSpellName}`)
      const deltaFmt = formatDeltasDetail(pc?.deltasDetail)
      if (deltaFmt) toonDetailBullets.push(`Stat deltas: ${deltaFmt}`)

      if (!pc) {
        if (mageloChar && upgrade?.eligible) {
          if (upgrade.isUpgrade) {
            toonDetailBullets.push(
              `Upgrade vs ${upgrade.slotName}${upgrade.currentItemName ? ` (currently ${upgrade.currentItemName})` : ''}: score Δ ≈ ${upgrade.scoreDelta?.toFixed?.(3) ?? upgrade.scoreDelta}; HP Δ ${upgrade.hpDelta ?? 0}.`,
            )
          } else {
            toonDetailBullets.push(
              `Can equip in ${upgrade.slotName} but Magelo scoring does not show a gain (sidegrade/downgrade vs current).`,
            )
          }
        } else if (!mageloChar) {
          toonDetailBullets.push('No matching Magelo export for this toon — live upgrade line skipped.')
        } else if (upgrade && !upgrade.eligible) {
          toonDetailBullets.push(`Not a candidate for this item: ${upgrade.reason || 'unknown'}.`)
        }
      }

      if (prof) {
        toonDetailBullets.unshift(buildCharacterBalanceBullet(toonBalance))
        const dorm = dormantToonVersusAccountNarrative(prof, charId, charName)
        if (dorm) toonDetailBullets.push(dorm)
        const pts = perToonShareNarrative(prof, charId)
        if (pts) toonDetailBullets.push(pts)
        toonDetailBullets.push(lastSpendNarrative(prof, charId))
      }

      let interestScore =
        (upgrade?.isUpgrade ? 50 + Math.min(40, (upgrade.scoreDelta || 0) * 200) : 0)
        + (prof && toonBalance > 0 ? Math.min(25, toonBalance / 8) : 0)
        + (bidInfo.medianRatio != null && bidInfo.medianRatio >= 1.1 ? 8 : 0)
      interestScore -= interestScoreDormantPenalty(prof, charId, charName)

      const summaryLine =
        summaryLinePre
        || (upgrade?.eligible && upgrade?.isUpgrade
          ? `Upgrade · score Δ ≈ ${upgrade.scoreDelta?.toFixed?.(3) ?? upgrade.scoreDelta}`
          : upgrade?.eligible === false
            ? (upgrade.reason || 'Not eligible')
            : upgrade?.isUpgrade === false
              ? 'Sidegrade / no gain (live)'
              : '—')

      const oneLineSummary = `${charName || charId || '—'}${className ? ` (${className})` : ''}: ${summaryLine} · ~${Math.round(toonBalance)} DKP · band ${band.low}–${band.high}`

      const toonRowKey = `${accountId}:${charId || charName}`
      out.push({
        toonRowKey,
        charName: charName || charId || '—',
        charId,
        className,
        accountId: accountId || '—',
        interestScore,
        tags,
        band,
        anchor,
        toonDetailBullets,
        prof,
        bidInfo,
        accountBalance,
        toonBalance,
        oneLineSummary,
        upgrade,
        hasMagelo: !!mageloChar,
        hasPrecompute: !!pc,
        summaryLine,
      })
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
        const bidRatioLabel = Array.isArray(forecastPayload.roster)
          ? null
          : 'Vs recent reference prices for matched items'
        merged.push({
          rowKey: g.toonRowKey,
          consolidated: false,
          accountId: g.accountId,
          interestScore: g.interestScore,
          tags: g.tags,
          band: g.band,
          anchor: g.anchor,
          charLine: `${g.charName}${g.className ? ` (${g.className})` : ''}`,
          classLabel: g.className || '—',
          summaryLine: g.summaryLine,
          collapsedSummary: g.oneLineSummary,
          toons: [g],
          sharedBullets: buildSharedAccountSpendBullets(g.prof, g.bidInfo, g.tags, bidRatioLabel, {
            includeAccountPoolLine: false,
          }),
          hasPrecompute: g.hasPrecompute,
        })
      } else {
        const g0 = group[0]
        const accountTags = spendArchetypeTags(g0.prof, g0.bidInfo.label, g0.bidInfo.medianRatio, {
          accountLevelArchetype: true,
        })
        const bidRatioLabel = Array.isArray(forecastPayload.roster)
          ? null
          : 'Vs recent reference prices for matched items'
        const sharedBullets = buildSharedAccountSpendBullets(
          g0.prof,
          g0.bidInfo,
          accountTags,
          bidRatioLabel,
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
          interestScore: maxScore,
          tags: accountTags,
          band: mergeBidBandsForAccountRow(group.map((x) => x.band)),
          anchor: g0.anchor,
          charLine: group
            .map((g) => `${g.charName}${g.className ? ` (${g.className})` : ''}`)
            .join(' · '),
          classLabel: group.map((g) => g.className || '—').join(', '),
          summaryLine: group.map((g) => `${g.charName}: ${g.summaryLine}`).join(' · '),
          collapsedSummary,
          toons: group,
          sharedBullets,
          hasPrecompute: group.some((g) => g.hasPrecompute),
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
  }, [
    forecastPayload,
    forecastPeople,
    resolvedItemId,
    itemStats,
    rankingsData,
    dkpPrices,
    nameToId,
    precomputedByItem,
    sortBy,
  ])

  if (!isOfficer) return null

  const itemDisplayName =
    resolvedItemId && itemStats?.[String(resolvedItemId)]?.name
      ? itemStats[String(resolvedItemId)].name
      : itemInput.trim() || '—'

  const isGlobalMode = !((raidInput || '').trim())
  const stalePrecomputeDays =
    precomputedMeta?.generated_at != null
      ? (Date.now() - new Date(precomputedMeta.generated_at).getTime()) / (86400 * 1000)
      : null

  return (
    <div className="container">
      <h1>Loot bid interest (officer)</h1>
      <p style={{ color: '#a1a1aa', marginBottom: '1rem', maxWidth: '52rem' }}>
        Heuristic only: who might care about an item, using linked-account spend patterns (last purchase,
        per-toon concentration, balance) and Magelo-style upgrade scoring (precomputed CI index when
        available, else live class_rankings). Leave raid id blank to use the{' '}
        <strong style={{ color: '#e4e4e7' }}>active guild roster</strong> (same idea as Global bid). Not a
        prediction of bids.
        <Link to="/officer" style={{ marginLeft: '0.5rem' }}>← Officer</Link>
        {' · '}
        <Link to="/officer/global-loot-bid-forecast">Global bid</Link>
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end', marginBottom: '1rem' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span style={{ fontSize: '0.8rem', color: '#a1a1aa' }}>Raid id (optional)</span>
          <input
            className="input"
            style={{ minWidth: '14rem' }}
            value={raidInput}
            onChange={(e) => setRaidInput(e.target.value)}
            placeholder="Blank = active roster"
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span style={{ fontSize: '0.8rem', color: '#a1a1aa' }}>Activity days (blank roster)</span>
          <input
            className="input"
            style={{ minWidth: '6rem' }}
            value={activityDays}
            onChange={(e) => setActivityDays(e.target.value)}
            disabled={!isGlobalMode}
            title="Used when raid id is empty (officer_global_bid_forecast)"
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

      {precomputedLoadNote && (
        <p style={{ color: '#fbbf24', marginBottom: '0.5rem', fontSize: '0.9rem' }}>{precomputedLoadNote}</p>
      )}
      {precomputedMeta?.generated_at && (
        <p style={{ color: '#71717a', marginBottom: '0.5rem', fontSize: '0.85rem' }}>
          Precomputed upgrade index: generated {precomputedMeta.generated_at}
          {stalePrecomputeDays != null && stalePrecomputeDays > 7
            ? ` (${Math.floor(stalePrecomputeDays)}d ago — consider refreshing CI)`
            : ''}
        </p>
      )}
      {rankingsError && (
        <p style={{ color: '#fbbf24', marginBottom: '0.75rem' }}>{rankingsError}</p>
      )}
      {error && <p style={{ color: '#f87171', marginBottom: '0.75rem' }}>{error}</p>}

      {forecastPayload && resolvedItemId && (
        <p style={{ color: '#a1a1aa', fontSize: '0.9rem', marginBottom: '0.75rem' }}>
          Item: <strong style={{ color: '#e4e4e7' }}>{itemDisplayName}</strong> (id {resolvedItemId})
          {Array.isArray(forecastPayload.roster) && (
            <span> · Active roster ({activityDays}d window)</span>
          )}
          {rows[0]?.anchor != null && (
            <>
              {' '}
              · Recent sale anchor (avg last 3 in dkp_prices.json): ~{Math.round(rows[0].anchor)} DKP
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
                <th>Bid band</th>
                <th>Character</th>
                <th>Class</th>
                <th>Account</th>
                <th>Tags</th>
                <th>Upgrade (summary)</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.rowKey}>
                  <td>{Math.round(r.interestScore)}</td>
                  <td style={{ fontSize: '0.85rem', whiteSpace: 'nowrap' }} title={r.band?.note || undefined}>
                    {r.band.low}–{r.band.high} (mid {r.band.mid})
                    {r.consolidated && r.band?.note ? (
                      <span style={{ color: '#71717a', fontSize: '0.72rem', marginLeft: '0.25rem' }}>(span)</span>
                    ) : null}
                  </td>
                  <td style={{ maxWidth: '14rem' }}>{r.charLine}</td>
                  <td style={{ maxWidth: '10rem' }}>{r.classLabel}</td>
                  <td style={{ fontSize: '0.85rem', wordBreak: 'break-all' }}>
                    {r.accountId !== '—' ? (
                      <Link to={`/accounts/${encodeURIComponent(r.accountId)}`}>Account</Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td style={{ fontSize: '0.8rem', maxWidth: '10rem' }}>
                    {r.tags.length ? r.tags.join(', ') : '—'}
                  </td>
                  <td style={{ fontSize: '0.8rem', maxWidth: '14rem', verticalAlign: 'top' }}>
                    {r.summaryLine}
                  </td>
                  <td style={{ fontSize: '0.8rem', maxWidth: '28rem', verticalAlign: 'top' }}>
                    <details style={{ maxWidth: '28rem' }}>
                      <summary
                        style={{
                          cursor: 'pointer',
                          color: '#d4d4d8',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          listStyle: 'none',
                        }}
                        title={r.collapsedSummary}
                      >
                        {r.collapsedSummary}
                      </summary>
                      <div style={{ marginTop: '0.5rem' }}>
                        {r.sharedBullets.length > 0 && (
                          <ul
                            style={{
                              margin: '0 0 0.5rem',
                              paddingLeft: '1.1rem',
                              color: '#a1a1aa',
                            }}
                          >
                            {r.sharedBullets.map((text, i) => (
                              <li key={`s-${i}`} style={{ marginBottom: '0.35rem' }}>
                                {text}
                              </li>
                            ))}
                          </ul>
                        )}
                        {!r.consolidated || r.toons.length === 1 ? (
                          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
                            {r.toons[0].toonDetailBullets.map((text, i) => (
                              <li key={i} style={{ marginBottom: '0.35rem' }}>
                                {text}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          r.toons.map((t) => (
                            <details key={t.toonRowKey} style={{ marginTop: '0.65rem' }}>
                              <summary
                                style={{
                                  cursor: 'pointer',
                                  color: '#e4e4e7',
                                  fontWeight: 600,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                  listStyle: 'none',
                                }}
                                title={t.oneLineSummary}
                              >
                                {t.oneLineSummary}
                              </summary>
                              <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1.1rem' }}>
                                {t.toonDetailBullets.map((text, i) => (
                                  <li key={i} style={{ marginBottom: '0.35rem' }}>
                                    {text}
                                  </li>
                                ))}
                              </ul>
                            </details>
                          ))
                        )}
                      </div>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {forecastPayload && resolvedItemId && rows.length === 0 && (
        <p style={{ color: '#71717a' }}>
          No matching characters (wrong item for these classes, or empty roster / attendees).
        </p>
      )}
    </div>
  )
}
