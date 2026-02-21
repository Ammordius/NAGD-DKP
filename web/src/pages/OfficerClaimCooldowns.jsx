import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function OfficerClaimCooldowns({ isOfficer }) {
  const navigate = useNavigate()
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [resettingId, setResettingId] = useState(null)

  useEffect(() => {
    if (!isOfficer) {
      navigate('/officer', { replace: true })
      return
    }
    loadCooldowns()
  }, [isOfficer, navigate])

  async function loadCooldowns() {
    setLoading(true)
    setError('')
    const { data, error: e } = await supabase
      .from('profiles')
      .select('id, email, unclaim_cooldown_until, unclaim_count')
      .not('unclaim_cooldown_until', 'is', null)
      .order('unclaim_cooldown_until', { ascending: true })
    setLoading(false)
    if (e) {
      setError(e.message)
      setProfiles([])
      return
    }
    setProfiles(data || [])
  }

  async function handleResetCooldown(profileId) {
    setResettingId(profileId)
    setError('')
    const { error: rpcErr } = await supabase.rpc('reset_claim_cooldown', { p_profile_id: profileId })
    setResettingId(null)
    if (rpcErr) {
      setError(rpcErr.message)
      return
    }
    await loadCooldowns()
  }

  if (!isOfficer) return null

  return (
    <div className="container">
      <p><Link to="/officer">← Officer</Link></p>
      <h1>Admin – Claim cooldowns</h1>
      <p style={{ color: '#a1a1aa', marginBottom: '1rem' }}>
        Players who unclaimed an account must wait before claiming again (10 min → 1 day → 7 days). Only accounts with an active cooldown are listed. Remove cooldown to let them claim immediately.
      </p>
      {error && <p className="error" style={{ marginBottom: '0.75rem' }}>{error}</p>}
      {loading ? (
        <p style={{ color: '#71717a' }}>Loading…</p>
      ) : profiles.length === 0 ? (
        <p style={{ color: '#71717a' }}>No accounts currently on claim cooldown.</p>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Cooldown until</th>
                <th>Unclaim count</th>
                <th style={{ width: '10rem' }}></th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => {
                const until = p.unclaim_cooldown_until ? new Date(p.unclaim_cooldown_until) : null
                const isExpired = until && until <= new Date()
                return (
                  <tr key={p.id}>
                    <td>{p.email || <span style={{ color: '#71717a' }}>—</span>}</td>
                    <td>
                      {until ? until.toLocaleString() : '—'}
                      {isExpired && <span style={{ color: '#71717a', marginLeft: '0.5rem' }}>(expired)</span>}
                    </td>
                    <td>{p.unclaim_count ?? 0}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{ fontSize: '0.875rem' }}
                        onClick={() => handleResetCooldown(p.id)}
                        disabled={resettingId === p.id}
                      >
                        {resettingId === p.id ? 'Removing…' : 'Remove cooldown'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
