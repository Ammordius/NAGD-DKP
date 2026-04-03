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
import { ACTIVE_DAYS } from '../lib/dkpLeaderboard'

const CLASS_RANKINGS_URL = import.meta.env.VITE_CLASS_RANKINGS_URL || '/class_rankings.json'

/** Days since last spend on a toon counts as "recent" for full upgrade list eligibility. */
const PRIORITY_RECENT_SPEND_DAYS = 35
/** With this top_toon_share and 2+ purchases, main toon qualifies as "invested". */
const PRIORITY_TOP_SHARE = 0.55

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
  const [rankingsError, setRankingsError] = useState('')
  const [upgradeCache, setUpgradeCache] = useState({})
  const [upgradeLoadingKey, setUpgradeLoadingKey] = useState(null)

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

  const upgradeCtx = useMemo(() => {
    if (!itemStats || !rankingsData) return null
    return {
      itemStats,
      classWeights: rankingsData.class_weights || {},
      focusCandidates: rankingsData.focus_candidates || {},
      spellFociiList: null,
      elementalDisplayNames: {},
    }
  }, [itemStats, rankingsData])

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
      const chars = Array.isArray(block.characters) ? block.characters : []
      const prof = accountId ? profiles[accountId] : null

      for (const a of chars) {
        const charId = (a.char_id || '').trim()
        const charName = (a.name || '').trim()
        const className = (a.class_name || '').trim()

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
            reasons.push(
              `Vs reference prices (guild history when available, else dkp_prices.json): median paid/ref ≈ ${bidInfo.medianRatio.toFixed(2)} (${bidInfo.label}).`,
            )
          }
        } else {
          reasons.push('No linked account — DKP spend profile unavailable.')
        }

        const interestScore =
          (upgrade?.isUpgrade ? 50 + Math.min(40, (upgrade.scoreDelta || 0) * 200) : 0)
          + (prof && balance > 0 ? Math.min(25, balance / 8) : 0)
          + (bidInfo.medianRatio != null && bidInfo.medianRatio >= 1.1 ? 8 : 0)

        const rowKey = `${accountId}:${charId || charName}`
        const showUpgradeStrip =
          !!mageloChar && !!upgradeCtx && characterQualifiesForUpgradeStrip(prof, charId)

        out.push({
          rowKey,
          charName: charName || charId || '—',
          charId,
          className,
          accountId: accountId || '—',
          interestScore,
          tags,
          band,
          anchor,
          reasons,
          upgrade,
          hasMagelo: !!mageloChar,
          mageloChar,
          showUpgradeStrip,
        })
      }
    }

    out.sort((x, y) => y.interestScore - x.interestScore)
    return out
  }, [forecastPayload, resolvedItemId, itemStats, rankingsData, dkpPrices, nameToId, upgradeCtx])

  const loadUpgradesForRow = (row) => {
    const key = row.rowKey
    if (upgradeCache[key] || !row.mageloChar || !upgradeCtx) return
    setUpgradeLoadingKey(key)
    try {
      const result = computeUpgradesForCharacter(row.mageloChar, 15, false, upgradeCtx)
      setUpgradeCache((prev) => ({ ...prev, [key]: result }))
    } finally {
      setUpgradeLoadingKey(null)
    }
  }

  if (!isOfficer) return null

  const itemDisplayName =
    resolvedItemId && itemStats?.[String(resolvedItemId)]?.name
      ? itemStats[String(resolvedItemId)].name
      : itemInput.trim() || '—'

  const activityApplied = forecastPayload?.activity_days

  return (
    <div className="container">
      <h1>Global item bid interest (officer)</h1>
      <p style={{ color: '#a1a1aa', marginBottom: '1rem', maxWidth: '52rem' }}>
        Heuristic only: active accounts (recent raid activity or pinned in Admin, same rules as the DKP leaderboard) and
        their characters vs one item. Uses guild sale history for paid/reference when the database RPC provides it.
        Not a prediction of bids.{' '}
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
      </div>

      {rankingsError && (
        <p style={{ color: '#fbbf24', marginBottom: '0.75rem' }}>{rankingsError}</p>
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
              {rows.map((r) => {
                const cached = upgradeCache[r.rowKey]
                const loadingUp = upgradeLoadingKey === r.rowKey
                return (
                  <tr key={r.rowKey}>
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
                    <td style={{ fontSize: '0.8rem', maxWidth: '32rem', verticalAlign: 'top' }}>
                      <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
                        {r.reasons.map((t, i) => (
                          <li key={i} style={{ marginBottom: '0.25rem' }}>
                            {t}
                          </li>
                        ))}
                      </ul>
                      {r.showUpgradeStrip && (
                        <div style={{ marginTop: '0.5rem' }}>
                          {!cached && (
                            <button
                              type="button"
                              className="btn btn-ghost"
                              style={{ fontSize: '0.8rem', padding: '0.2rem 0.5rem' }}
                              disabled={loadingUp || !upgradeCtx}
                              onClick={() => loadUpgradesForRow(r)}
                            >
                              {loadingUp ? 'Computing…' : 'Show top upgrades by slot (Magelo)'}
                            </button>
                          )}
                          {cached?.error && (
                            <p style={{ color: '#fbbf24', margin: '0.25rem 0 0' }}>{cached.error}</p>
                          )}
                          {cached && !cached.error && cached.bySlot?.length > 0 && (
                            <div style={{ marginTop: '0.5rem' }}>
                              {cached.bySlot.map((slot) => (
                                <div key={slot.slotId} style={{ marginBottom: '0.75rem' }}>
                                  <div style={{ fontWeight: 600, color: '#d4d4d8' }}>
                                    {slot.slotName}
                                    {slot.currentItemName
                                      ? ` · current: ${slot.currentItemName}`
                                      : ''}
                                  </div>
                                  {slot.upgrades?.length ? (
                                    <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.1rem', color: '#a1a1aa' }}>
                                      {slot.upgrades.map((u) => (
                                        <li key={u.itemId}>
                                          {u.itemName}{' '}
                                          <span style={{ color: '#86efac' }}>Δ {u.delta?.toFixed?.(2) ?? u.delta}</span>
                                          {u.deltas?.hpDelta ? ` · HP ${u.deltas.hpDelta > 0 ? '+' : ''}${u.deltas.hpDelta}` : ''}
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
                      )}
                    </td>
                  </tr>
                )
              })}
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
