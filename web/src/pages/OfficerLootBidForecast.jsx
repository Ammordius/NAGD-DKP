import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  CLASS_TO_ABBREV,
  evaluateItemUpgradeForCharacter,
  itemUsableByClass,
} from '../lib/mageloUpgradeEngine'
import {
  archetypeDescription,
  avgDkpFromPrices,
  bidVsMarketFromPurchasesTimeAware,
  buildNameToItemId,
  estimateBidBand,
  lastSpendNarrative,
  perToonShareNarrative,
  resolveItemIdFromName,
  spendArchetypeTags,
} from '../lib/bidForecastModel'

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

export default function OfficerLootBidForecast({ isOfficer }) {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const raidIdParam = searchParams.get('raid') || ''

  const [raidInput, setRaidInput] = useState(raidIdParam)
  const [itemInput, setItemInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [forecastPayload, setForecastPayload] = useState(null)
  const [itemStats, setItemStats] = useState(null)
  const [dkpPrices, setDkpPrices] = useState(null)
  const [rankingsData, setRankingsData] = useState(null)
  const [rankingsError, setRankingsError] = useState('')

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
          `Could not load class rankings from ${CLASS_RANKINGS_URL}. Set VITE_CLASS_RANKINGS_URL or add class_rankings.json to web/public for upgrade scoring.`,
        )
      })
  }, [])

  useEffect(() => {
    loadRankings()
  }, [loadRankings])

  const nameToId = useMemo(() => buildNameToItemId(itemStats), [itemStats])

  const resolvedItemId = useMemo(() => {
    const t = (itemInput || '').trim()
    if (!t) return null
    if (/^\d+$/.test(t)) return t
    return resolveItemIdFromName(t, nameToId)
  }, [itemInput, nameToId])

  const runForecast = async () => {
    const rid = (raidInput || '').trim()
    if (!rid) {
      setError('Enter a raid id.')
      return
    }
    setError('')
    setLoading(true)
    setForecastPayload(null)
    setSearchParams({ raid: rid })
    try {
      const { data, error: rpcErr } = await supabase.rpc('officer_loot_bid_forecast', {
        p_raid_id: rid,
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
    if (!forecastPayload?.attendees || !resolvedItemId || !itemStats) return []
    const attendees = forecastPayload.attendees
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
    for (const a of attendees) {
      const charId = (a.char_id || '').trim()
      const charName = (a.character_name || '').trim()
      const className = (a.class_name || '').trim()
      const accountId = a.account_id
      const prof = accountId ? profiles[accountId] : null

      const mageloChar = findRankingChar(rankingsChars, charName, className)
      let upgrade = null
      if (mageloChar) {
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
      const tags = spendArchetypeTags(prof, bidInfo.label, bidInfo.medianRatio)
      const archetypeText = archetypeDescription(tags)
      const balance = prof?.balance != null ? Number(prof.balance) : 0
      const anchor = avgDkpFromPrices(dkpPrices || {}, resolvedItemId, 3)
      const band = estimateBidBand(balance, anchor, bidInfo.medianRatio, upgrade?.scoreDelta)

      const reasons = []
      if (mageloChar && upgrade?.eligible) {
        if (upgrade.isUpgrade) {
          reasons.push(
            `Upgrade vs ${upgrade.slotName}${upgrade.currentItemName ? ` (currently ${upgrade.currentItemName})` : ''}: score Δ ≈ ${upgrade.scoreDelta?.toFixed?.(3) ?? upgrade.scoreDelta}; HP Δ ${upgrade.hpDelta ?? 0}.`,
          )
        } else {
          reasons.push(
            `Can equip in ${upgrade.slotName} but Magelo scoring does not show a gain (sidegrade/downgrade vs current).`,
          )
        }
      } else if (!mageloChar) {
        reasons.push('No matching Magelo export for this toon — upgrade line skipped.')
      } else if (upgrade && !upgrade.eligible) {
        reasons.push(`Not a candidate for this item: ${upgrade.reason || 'unknown'}.`)
      }

      if (prof) {
        reasons.push(lastSpendNarrative(prof, charId))
        const pts = perToonShareNarrative(prof, charId)
        if (pts) reasons.push(pts)
        reasons.push(`Account balance (earned − spent): ~${Math.round(balance)} DKP.`)
        reasons.push(archetypeText)
        if (bidInfo.medianRatio != null) {
          reasons.push(`Vs recent reference prices for matched items: median paid/reference ≈ ${bidInfo.medianRatio.toFixed(2)} (${bidInfo.label}).`)
        }
      } else {
        reasons.push('No linked account — DKP spend profile unavailable.')
      }

      const interestScore =
        (upgrade?.isUpgrade ? 50 + Math.min(40, (upgrade.scoreDelta || 0) * 200) : 0)
        + (prof && balance > 0 ? Math.min(25, balance / 8) : 0)
        + (bidInfo.medianRatio != null && bidInfo.medianRatio >= 1.1 ? 8 : 0)

      out.push({
        charName: charName || charId || '—',
        className,
        accountId: accountId || '—',
        interestScore,
        tags,
        band,
        anchor,
        reasons,
        upgrade,
        hasMagelo: !!mageloChar,
      })
    }

    out.sort((x, y) => y.interestScore - x.interestScore)
    return out
  }, [forecastPayload, resolvedItemId, itemStats, rankingsData, dkpPrices, nameToId])

  if (!isOfficer) return null

  const itemDisplayName =
    resolvedItemId && itemStats?.[String(resolvedItemId)]?.name
      ? itemStats[String(resolvedItemId)].name
      : itemInput.trim() || '—'

  return (
    <div className="container">
      <h1>Loot bid interest (officer)</h1>
      <p style={{ color: '#a1a1aa', marginBottom: '1rem', maxWidth: '52rem' }}>
        Heuristic only: who on this raid might care about an item, using linked-account spend patterns (last purchase,
        per-toon concentration, balance) and optional Magelo/class_rankings upgrade scoring. Not a prediction of bids.
        <Link to="/officer" style={{ marginLeft: '0.5rem' }}>← Officer</Link>
        {' · '}
        <Link to="/officer/global-loot-bid-forecast">Global (active roster)</Link>
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end', marginBottom: '1rem' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span style={{ fontSize: '0.8rem', color: '#a1a1aa' }}>Raid id</span>
          <input
            className="input"
            style={{ minWidth: '14rem' }}
            value={raidInput}
            onChange={(e) => setRaidInput(e.target.value)}
            placeholder="e.g. raid_2025_01_01_abc"
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
      </div>

      {rankingsError && (
        <p style={{ color: '#fbbf24', marginBottom: '0.75rem' }}>{rankingsError}</p>
      )}
      {error && <p style={{ color: '#f87171', marginBottom: '0.75rem' }}>{error}</p>}

      {forecastPayload && resolvedItemId && (
        <p style={{ color: '#a1a1aa', fontSize: '0.9rem', marginBottom: '0.75rem' }}>
          Item: <strong style={{ color: '#e4e4e7' }}>{itemDisplayName}</strong> (id {resolvedItemId})
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
                <th>Character</th>
                <th>Class</th>
                <th>Account</th>
                <th>Tags</th>
                <th>Bid band (heuristic)</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.charName}-${r.accountId}`}>
                  <td>{Math.round(r.interestScore)}</td>
                  <td>{r.charName}</td>
                  <td>{r.className || '—'}</td>
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
                  <td style={{ fontSize: '0.85rem', whiteSpace: 'nowrap' }}>
                    {r.band.low}–{r.band.high} (mid {r.band.mid})
                  </td>
                  <td style={{ fontSize: '0.8rem', maxWidth: '28rem', verticalAlign: 'top' }}>
                    <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
                      {r.reasons.map((t, i) => (
                        <li key={i} style={{ marginBottom: '0.25rem' }}>
                          {t}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {forecastPayload && resolvedItemId && rows.length === 0 && (
        <p style={{ color: '#71717a' }}>No attendees or missing item_stats.json.</p>
      )}
    </div>
  )
}
