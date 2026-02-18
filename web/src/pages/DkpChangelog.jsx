import { useEffect, useState, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const PAGE_SIZE = 25

export default function DkpChangelog({ isOfficer }) {
  const navigate = useNavigate()
  const [auditLog, setAuditLog] = useState([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(true)

  const loadPage = useCallback(async (pageNum = 0, append = false) => {
    setLoading(true)
    const from = pageNum * PAGE_SIZE
    const to = from + PAGE_SIZE - 1
    const { data, error } = await supabase
      .from('officer_audit_log')
      .select('id,created_at,actor_display_name,actor_email,action,target_type,target_id,delta')
      .order('created_at', { ascending: false })
      .range(from, to)
    setLoading(false)
    if (error) return
    const rows = data ?? []
    setAuditLog((prev) => (append ? [...prev, ...rows] : rows))
    setHasMore(rows.length === PAGE_SIZE)
    setPage(pageNum)
  }, [])

  useEffect(() => {
    if (!isOfficer) {
      navigate('/')
      return
    }
    loadPage(0, false)
  }, [isOfficer, navigate, loadPage])

  if (!isOfficer) return null

  return (
    <div className="container">
      <h1>DKP changelog</h1>
      <p style={{ color: '#a1a1aa', marginBottom: '1rem' }}>
        Who made which sensitive changes: add raid, manual DKP edits. Officer-only. <Link to="/officer">← Officer</Link>
      </p>
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
            {auditLog.length === 0 && !loading && (
              <tr><td colSpan={5} style={{ color: '#71717a' }}>No audit entries yet.</td></tr>
            )}
            {auditLog.map((entry) => {
              const when = entry.created_at
                ? new Date(entry.created_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
                : '—'
              const who = (entry.actor_display_name || '').trim() || (entry.actor_email || '').trim() || entry.actor_id || '—'
              const actionLabel = {
                add_raid: 'Add raid',
                add_tic: 'Add tic',
                add_attendee_to_tic: 'Add player to tic',
                remove_attendee_from_tic: 'Remove player from tic',
                delete_event: 'Delete tic',
                add_loot: 'Add loot',
                add_loot_from_log: 'Add loot from log',
                delete_loot: 'Delete loot',
                edit_event_dkp: 'Edit event DKP',
                edit_event_time: 'Edit event time',
                edit_loot_cost: 'Edit loot cost',
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
                else if (entry.action === 'remove_attendee_from_tic' && d.c) details = d.c
                else if (entry.action === 'add_loot' && d.i) details = `${d.i} → ${d.c} (${d.cost} DKP)`
                else if (entry.action === 'add_loot_from_log' && d.cnt != null) details = `${d.cnt} item(s)`
                else if (entry.action === 'delete_loot' && d.i) details = `${d.i} (${d.c})`
                else if (entry.action === 'edit_event_dkp' && d.v != null) details = `DKP: ${d.v}`
                else if (entry.action === 'edit_loot_cost' && d.c != null) details = `Cost: ${d.c}`
                else if (d.n) details = `Raid: ${d.n}`
                else if (d.v != null) details = `DKP: ${d.v}`
                else if (d.t != null) details = `Time: ${d.t}`
                else if (d.c != null) details = String(d.c)
                else details = Object.entries(d).map(([k, v]) => `${k}=${v}`).join(', ')
              }
              return (
                <tr key={entry.id}>
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
