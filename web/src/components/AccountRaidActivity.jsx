import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import ItemLink from './ItemLink'
import { getDkpMobLoot } from '../lib/staticData'
import { usePersistedState } from '../lib/usePersistedState'
import { raidMissingTics, visibleMissingTicRows } from '../lib/raidTicIdentity'
import { needsMissingRaidUniverse } from '../lib/accountDetailMissingScope'

const MIDDLE_DOT = '\u00B7'
const ACTIVITY_PAGE_SIZE = 50
/** Only paginate activity when raid count exceeds this (e.g. 1611 raids). */
const ACTIVITY_PAGINATION_THRESHOLD = 100

function normalizeShowWhichTics(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((id) => String(id ?? '').trim()).filter(Boolean))]
}

function missingTicLabel(tic) {
  const name = String(tic?.eventName ?? '').trim()
  const order = tic?.eventOrder
  if (order == null || order === '') return name || 'DKP tic'
  return name ? `Event #${order} — ${name}` : `Event #${order}`
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

/** Same viewing state as the account activity tab, keyed by game account. */
export function useAccountActivityControls(accountId) {
  const scope = accountId ? `/accounts/detail:${accountId}` : '/accounts/detail:none'
  const [onlyMissingRaids, setOnlyMissingRaids] = usePersistedState(`${scope}:onlyMissingRaids`, false)
  const [showMissingDetails, setShowMissingDetails] = usePersistedState(`${scope}:showMissingDetails`, false)
  const [showWhichTics, setShowWhichTics] = usePersistedState(`${scope}:showWhichTics`, [], normalizeShowWhichTics)
  const [activityPage, setActivityPage] = usePersistedState(`${scope}:activityPage`, 1)
  const includeMissing = needsMissingRaidUniverse(showMissingDetails, onlyMissingRaids)
  return {
    onlyMissingRaids,
    setOnlyMissingRaids,
    showMissingDetails,
    setShowMissingDetails,
    showWhichTics,
    setShowWhichTics,
    activityPage,
    setActivityPage,
    includeMissing,
  }
}

export default function AccountRaidActivity({ rows, controls }) {
  const {
    onlyMissingRaids,
    setOnlyMissingRaids,
    showMissingDetails,
    setShowMissingDetails,
    showWhichTics,
    setShowWhichTics,
    activityPage,
    setActivityPage,
  } = controls
  const [itemIdMap, setItemIdMap] = useState({})

  useEffect(() => {
    let cancelled = false
    getDkpMobLoot().then((mobLoot) => {
      if (!cancelled) setItemIdMap(buildItemIdMap(mobLoot))
    })
    return () => { cancelled = true }
  }, [])

  const activityWithMissing = useMemo(
    () => (rows || []).map((act) => ({ ...act, ...raidMissingTics(act) })),
    [rows],
  )
  const visibleActivityRows = useMemo(
    () => visibleMissingTicRows(activityWithMissing, { showMissingDetails, onlyMissingRaids }),
    [activityWithMissing, onlyMissingRaids, showMissingDetails],
  )

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Activity (earned DKP and items by raid)</h2>
      <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginBottom: '0.75rem' }}>Reverse chronological. Each raid shows DKP earned and items won by the characters on this account.</p>
      <div className="activity-tic-controls">
        <label className="activity-tic-option">
          <input
            type="checkbox"
            checked={showMissingDetails}
            onChange={(e) => setShowMissingDetails(e.target.checked)}
          />
          Show all attendance tics, highlight any missed
        </label>
        <label className="activity-tic-option">
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
          Only show attended raids with some missed tics
        </label>
      </div>
      {visibleActivityRows.length === 0 ? (
        <p style={{ color: '#71717a' }}>
          {onlyMissingRaids ? 'No raids with missing attendance tics.' : 'No raid activity recorded.'}
        </p>
      ) : (
        (() => {
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
                  <p className="activity-page-summary">
                    Showing {start + 1}–{start + activityToShow.length} of {total} raids
                    {totalPages > 1 && (
                      <span className="activity-page-summary-page">
                        {MIDDLE_DOT} Page {page} of {totalPages}
                      </span>
                    )}
                  </p>
                  <nav className="activity-pager" aria-label="Activity pagination">
                    <button
                      type="button"
                      className="btn btn-ghost activity-pager-edge"
                      disabled={page <= 1}
                      onClick={() => setActivityPage(1)}
                    >
                      {'<< First Page'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost activity-pager-prev"
                      disabled={page <= 1}
                      onClick={() => setActivityPage((p) => Math.max(1, p - 1))}
                    >
                      <span className="activity-pager-label-full">{'< Previous Page'}</span>
                      <span className="activity-pager-label-short">Previous</span>
                    </button>
                    <div className="activity-pager-status" aria-live="polite">
                      Page {page} of {totalPages}
                    </div>
                    {totalPages <= 10 && (
                      <div className="activity-pager-pages">
                        {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
                          <button
                            key={n}
                            type="button"
                            className={n === page ? 'btn' : 'btn btn-ghost'}
                            onClick={() => setActivityPage(n)}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      className="btn btn-ghost activity-pager-next"
                      disabled={page >= totalPages}
                      onClick={() => setActivityPage((p) => Math.min(totalPages, p + 1))}
                    >
                      <span className="activity-pager-label-full">{'Next Page >'}</span>
                      <span className="activity-pager-label-short">Next</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost activity-pager-edge"
                      disabled={page >= totalPages}
                      onClick={() => setActivityPage(totalPages)}
                    >
                      {'Last Page >>'}
                    </button>
                  </nav>
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
                          {act.attendanceSource === 'inferred-full-payment' && (
                            <span style={{ color: '#a1a1aa', fontWeight: 400 }}>
                              {' '}(DKP credited; attendance events unmatched)
                            </span>
                          )}
                        </span>
                      )}
                      {showMissingDetails && act.isMissingTics && (
                        <span style={{ marginLeft: '0.5rem', color: '#f97316' }}>
                          {MIDDLE_DOT} Missing {act.missingCount} tic{act.missingCount === 1 ? '' : 's'}
                          {(act.missingTics || []).length > 0 && (
                            <button
                              type="button"
                              className="activity-show-which"
                              aria-expanded={showWhichTics.includes(act.raid_id)}
                              onClick={() => {
                                const raidId = act.raid_id
                                setShowWhichTics((open) => (
                                  open.includes(raidId)
                                    ? open.filter((id) => id !== raidId)
                                    : [...open, raidId]
                                ))
                              }}
                            >
                              {showWhichTics.includes(act.raid_id) ? 'hide which' : 'show which'}
                            </button>
                          )}
                        </span>
                      )}
                    </p>
                    {showMissingDetails && act.isMissingTics && showWhichTics.includes(act.raid_id) && (act.missingTics || []).length > 0 && (
                      <ul className="activity-missing-tic-list">
                        {act.missingTics.map((tic, index) => (
                          <li key={`${tic.eventOrder ?? 'x'}-${tic.eventName}-${index}`}>
                            {missingTicLabel(tic)}
                          </li>
                        ))}
                      </ul>
                    )}
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
        })()
      )}
    </div>
  )
}
