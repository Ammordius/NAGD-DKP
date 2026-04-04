import { useState } from 'react'
import { supabase } from '../lib/supabase'

function defaultDateRange() {
  const to = new Date()
  const from = new Date(to)
  from.setDate(from.getDate() - 90)
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  }
}

function formatNum(n) {
  if (n == null || n === '') return '—'
  const x = Number(n)
  if (Number.isNaN(x)) return String(n)
  return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/\.?0+$/, '')
}

function rpcErrorMessage(err) {
  if (!err) return 'Unknown error'
  return err.message || err.details || String(err)
}

/** Officer-only: aggregate bidding-portfolio stats for this account (date range required). */
export default function AccountBiddingPortfolioCard({ accountId }) {
  const dr = defaultDateRange()
  const [dateFrom, setDateFrom] = useState(dr.from)
  const [dateTo, setDateTo] = useState(dr.to)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [payload, setPayload] = useState(null)
  const [showRaw, setShowRaw] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    const from = dateFrom.trim()
    const to = dateTo.trim()
    if (!from || !to) {
      setError('Choose both from and to dates.')
      setPayload(null)
      return
    }
    setLoading(true)
    setError('')
    setPayload(null)
    const { data, error: rpcErr } = await supabase.rpc('officer_account_bidding_portfolio', {
      p_account_id: accountId,
      p_from_date: from,
      p_to_date: to,
    })
    setLoading(false)
    if (rpcErr) {
      setError(rpcErrorMessage(rpcErr))
      return
    }
    setPayload(data && typeof data === 'object' ? data : null)
  }

  return (
    <div className="card" style={{ marginTop: '1.5rem' }}>
      <h2 style={{ marginTop: 0 }}>Bidding portfolio stats (officers)</h2>
      <p style={{ color: '#71717a', fontSize: '0.9rem', marginTop: 0 }}>
        Heuristic aggregates over guild sales in the date window. Unbounded ranges are slow; keep a bounded window.
      </p>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end', marginBottom: '1rem' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span style={{ color: '#a1a1aa', fontSize: '0.85rem' }}>From</span>
          <input type="date" value={dateFrom} onChange={(ev) => setDateFrom(ev.target.value)} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span style={{ color: '#a1a1aa', fontSize: '0.85rem' }}>To</span>
          <input type="date" value={dateTo} onChange={(ev) => setDateTo(ev.target.value)} />
        </label>
        <button type="submit" className="btn" disabled={loading}>
          Run aggregate
        </button>
      </form>

      {loading && <p style={{ color: '#a1a1aa' }}>Loading…</p>}
      {error && <p className="error">{error}</p>}

      {payload && !loading && (
        <>
          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(14rem, 1fr))',
              gap: '0.5rem 1rem',
              margin: 0,
            }}
          >
            <div>
              <dt style={{ color: '#71717a', fontSize: '0.8rem' }}>Range</dt>
              <dd style={{ margin: 0 }}>
                {payload.from_date ?? '—'} → {payload.to_date ?? '—'}
              </dd>
            </div>
            <div>
              <dt style={{ color: '#71717a', fontSize: '0.8rem' }}>Loot rows won</dt>
              <dd style={{ margin: 0 }}>{formatNum(payload.loot_rows_won)}</dd>
            </div>
            <div>
              <dt style={{ color: '#71717a', fontSize: '0.8rem' }}>DKP spent on wins</dt>
              <dd style={{ margin: 0 }}>{formatNum(payload.total_dkp_spent_on_wins)}</dd>
            </div>
            <div>
              <dt style={{ color: '#71717a', fontSize: '0.8rem' }}>Auction rows present</dt>
              <dd style={{ margin: 0 }}>{formatNum(payload.auction_rows_present)}</dd>
            </div>
            <div>
              <dt style={{ color: '#71717a', fontSize: '0.8rem' }}>Could clear, not buyer</dt>
              <dd style={{ margin: 0 }}>{formatNum(payload.could_clear_but_not_buyer_count)}</dd>
            </div>
            <div>
              <dt style={{ color: '#71717a', fontSize: '0.8rem' }}>Runner-up guess hits</dt>
              <dd style={{ margin: 0 }}>{formatNum(payload.runner_up_guess_count)}</dd>
            </div>
            <div>
              <dt style={{ color: '#71717a', fontSize: '0.8rem' }}>Sum synth max (present, non-buyer)</dt>
              <dd style={{ margin: 0 }}>{formatNum(payload.sum_synthetic_max_bid_when_present_non_buyer)}</dd>
            </div>
            <div>
              <dt style={{ color: '#71717a', fontSize: '0.8rem' }}>Avg paid/ref on wins</dt>
              <dd style={{ margin: 0 }}>{formatNum(payload.avg_paid_to_ref_on_wins)}</dd>
            </div>
          </dl>

          {Array.isArray(payload.notes) && payload.notes.length > 0 && (
            <ul style={{ color: '#71717a', fontSize: '0.85rem', marginTop: '1rem' }}>
              {payload.notes.map((n, i) => (
                <li key={i}>{String(n)}</li>
              ))}
            </ul>
          )}

          <button type="button" className="btn btn-ghost" style={{ marginTop: '0.75rem' }} onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? 'Hide' : 'Show'} raw JSON
          </button>
          {showRaw && (
            <pre
              style={{
                marginTop: '0.5rem',
                padding: '0.75rem',
                background: '#18181b',
                borderRadius: 6,
                fontSize: '0.75rem',
                overflow: 'auto',
                maxHeight: '24rem',
              }}
            >
              {JSON.stringify(payload, null, 2)}
            </pre>
          )}
        </>
      )}
    </div>
  )
}
