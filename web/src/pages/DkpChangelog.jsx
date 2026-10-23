import { useEffect, useState, useCallback, useRef } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { usePersistedState } from '../lib/usePersistedState'
import { useScrollContentReady } from '../lib/routeScrollView'

const PAGE_SIZE = 25
const MAX_CHANGELOG_PAGES = 40

function normalizeChangelogPages(raw) {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > MAX_CHANGELOG_PAGES) return 1
  return n
}

export default function DkpChangelog({ isOfficer }) {
  const [auditLog, setAuditLog] = useState([])
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [pagesLoaded, setPagesLoaded] = usePersistedState('/officer/dkp-changelog:pages', 1, normalizeChangelogPages)
  const initialPages = useRef(pagesLoaded)
  useScrollContentReady(!loading)

  const loadPage = useCallback(async (pageNum = 0, append = false) => {
    setLoading(true)
    setLoadError('')
    const from = pageNum * PAGE_SIZE
    const to = from + PAGE_SIZE - 1
    const { data, error } = await supabase
      .from('officer_audit_log')
      .select('id,created_at,actor_display_name,action,target_type,target_id,delta')
      .order('created_at', { ascending: false })
      .range(from, to)
    setLoading(false)
    if (error) {
      setLoadError(error.message || 'Could not load the changelog')
      return
    }
    const rows = data ?? []
    setAuditLog((prev) => (append ? [...prev, ...rows] : rows))
    setHasMore(rows.length === PAGE_SIZE)
    setPage(pageNum)
    if (append) setPagesLoaded(Math.min(MAX_CHANGELOG_PAGES, pageNum + 1))
  }, [setPagesLoaded])

  useEffect(() => {
    if (!isOfficer) return undefined
    const pages = initialPages.current
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setLoadError('')
      const { data, error } = await supabase
        .from('officer_audit_log')
        .select('id,created_at,actor_display_name,action,target_type,target_id,delta')
        .order('created_at', { ascending: false })
        .range(0, pages * PAGE_SIZE - 1)
      if (cancelled) return
      setLoading(false)
      if (error) {
        setLoadError(error.message || 'Could not load the changelog')
        return
      }
      const rows = data ?? []
      setAuditLog(rows)
      setHasMore(rows.length >= pages * PAGE_SIZE)
      setPage(Math.max(0, pages - 1))
    })()
    return () => { cancelled = true }
  }, [isOfficer])

  if (!isOfficer) return <Navigate to="/" replace />

  return (
    <div className="container">
      <h1>DKP changelog</h1>
      <p style={{ color: '#a1a1aa', marginBottom: '1rem' }}>
        Who made which sensitive changes: add/delete raid, tics, loot, manual DKP edits. Officer-only. <Link to="/officer/RaidAdmin">← Raid Admin</Link>
      </p>
      {loadError && <p className="error" style={{ marginBottom: '1rem' }}>{loadError}</p>}
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Action</th>
              <th>Target</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {auditLog.length === 0 && !loading && !loadError && (
              <tr><td colSpan={5} style={{ color: '#71717a' }}>No audit entries yet.</td></tr>
            )}
            {auditLog.map((entry) => {
              const when = entry.created_at
                ? new Date(entry.created_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
                : '—'
              const who = (entry.actor_display_name || '').trim() || entry.actor_id || '—'
              const actionLabel = {
                add_raid: 'Add raid',
                add_tic: 'Add tic',
                add_attendee_to_tic: 'Add player to tic',
                add_attendees_to_tic: 'Add players to tic',
                remove_attendee_from_tic: 'Remove player from tic',
                delete_event: 'Delete tic',
                raid_deleted: 'Raid deleted',
                add_loot: 'Add loot',
                add_loot_from_log: 'Add loot from log',
                delete_loot: 'Delete loot',
                edit_event_dkp: 'Edit event DKP',
                edit_event_time: 'Edit event time',
                edit_loot_cost: 'Edit loot cost',
                edit_loot_tic: 'Move loot to tic',
                rename_raid: 'Rename raid',
                set_account_display_name: 'Edit display name',
              }[entry.action] || entry.action
              const raidId = entry.delta?.r || (entry.target_type === 'raid' ? entry.target_id : null)
              const target = entry.target_type && entry.target_id
                ? raidId
                  ? <Link to={`/raids/${raidId}`}>{entry.target_type}: {entry.target_id}</Link>
                  : `${entry.target_type}: ${entry.target_id}`
                : entry.target_type || '—'
              const d = entry.delta
              let details = '—'
              if (d && typeof d === 'object') {
                if (d.n != null && entry.action === 'add_raid') details = `Raid: ${d.n}`
                else if (entry.action === 'add_tic' && d.n != null) details = `${d.n} attendee(s), ${d.v} DKP`
                else if (entry.action === 'add_attendee_to_tic' && d.c) details = d.c
                else if (entry.action === 'add_attendees_to_tic' && d.n != null) details = `${d.n} attendee(s)`
                else if (entry.action === 'remove_attendee_from_tic' && d.c) details = d.c
                else if (entry.action === 'add_loot' && d.i) details = `${d.i} → ${d.c} (${d.cost} DKP)`
                else if (entry.action === 'add_loot_from_log' && Array.isArray(d.items) && d.items.length > 0) details = d.items.map((x) => `${x.i} (${x.c}) — ${x.cost ?? 0} DKP`).join('; ')
                else if (entry.action === 'add_loot_from_log' && d.cnt != null) details = `${d.cnt} item(s)`
                else if (entry.action === 'delete_loot' && d.i) details = d.cost != null ? `${d.i} (${d.c}) — ${d.cost} DKP` : `${d.i} (${d.c})`
                else if (entry.action === 'edit_event_dkp' && d.v != null) details = `DKP: ${d.v}`
                else if (entry.action === 'edit_loot_cost' && d.c != null) details = d.i ? `${d.i}: ${d.c} DKP` : `Cost: ${d.c}`
                else if (entry.action === 'edit_loot_tic' && d.e != null) details = d.i ? `${d.i} → ${d.e}` : `Tic: ${d.e}`
                else if (entry.action === 'rename_raid') details = `${(d.from ?? '').trim() || '—'} → ${(d.n ?? '').trim() || '—'}`
                else if (entry.action === 'set_account_display_name') details = `${(d.previous_display_name ?? '').trim() || '—'} → ${(d.new_display_name ?? '').trim() || '—'}`
                else if (entry.action === 'raid_deleted' && d.n != null) details = `Raid: ${d.n}`
                else if (d.n) details = `Raid: ${d.n}`
                else if (d.v != null) details = `DKP: ${d.v}`
                else if (d.t != null) details = `Time: ${d.t}`
                else if (d.c != null) details = String(d.c)
                else details = Object.entries(d).map(([k, v]) => `${k}=${v}`).join(', ')
              }
              return (
                <tr key={entry.id} data-scroll-anchor={String(entry.id)}>
                  <td style={{ whiteSpace: 'nowrap' }}>{when}</td>
                  <td style={{ wordBreak: 'break-word' }}>{who}</td>
                  <td>{actionLabel}</td>
                  <td style={{ fontSize: '0.875rem' }}>{target}</td>
                  <td style={{ fontSize: '0.875rem', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }} title={details}>{details}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: '0.5rem' }}>
        {loading && <span style={{ color: '#71717a' }}>Loading…</span>}
        {!loading && hasMore && (
          <button type="button" className="btn btn-ghost" onClick={() => loadPage(page + 1, true)}>
            Load next {PAGE_SIZE}
          </button>
        )}
        {!loading && auditLog.length > 0 && !hasMore && (
          <span style={{ color: '#71717a', fontSize: '0.875rem' }}>No more entries.</span>
        )}
      </div>
    </div>
  )
}
