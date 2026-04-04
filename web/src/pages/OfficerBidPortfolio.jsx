import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
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

export default function OfficerBidPortfolio({ isOfficer }) {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const lootParam = (searchParams.get('loot') || '').trim()
  const raidParam = (searchParams.get('raid') || '').trim()
  const accountParam = (searchParams.get('account') || '').trim()

  const [lootInput, setLootInput] = useState(lootParam)
  const [lootLoading, setLootLoading] = useState(false)
  const [lootError, setLootError] = useState('')
  const [lootPayload, setLootPayload] = useState(null)

  const dr = defaultDateRange()
  const [accountIdInput, setAccountIdInput] = useState(accountParam)
  const [dateFrom, setDateFrom] = useState(dr.from)
  const [dateTo, setDateTo] = useState(dr.to)
  const [accountLoading, setAccountLoading] = useState(false)
  const [accountError, setAccountError] = useState('')
  const [accountPayload, setAccountPayload] = useState(null)

  const [showRawLoot, setShowRawLoot] = useState(false)
  const [showRawAccount, setShowRawAccount] = useState(false)

  useEffect(() => {
    if (!isOfficer) navigate('/')
  }, [isOfficer, navigate])

  useEffect(() => {
    setLootInput(lootParam)
  }, [lootParam])

  useEffect(() => {
    if (accountParam) setAccountIdInput(accountParam)
  }, [accountParam])

  const fetchLootPortfolio = useCallback(async (lootIdStr) => {
    const id = parseInt(lootIdStr, 10)
    if (!lootIdStr || Number.isNaN(id) || id < 1) {
      setLootPayload(null)
      setLootError('')
      return
    }
    setLootLoading(true)
    setLootError('')
    setLootPayload(null)
    const { data, error: rpcErr } = await supabase.rpc('officer_bid_portfolio_for_loot', {
      p_loot_id: id,
    })
    setLootLoading(false)
    if (rpcErr) {
      setLootError(rpcErrorMessage(rpcErr))
      return
    }
    setLootPayload(data && typeof data === 'object' ? data : null)
  }, [])

  useEffect(() => {
    if (!isOfficer) return
    if (lootParam) fetchLootPortfolio(lootParam)
    else {
      setLootPayload(null)
      setLootError('')
    }
  }, [isOfficer, lootParam, fetchLootPortfolio])

  const sortedAttendees = useMemo(() => {
    const list = Array.isArray(lootPayload?.attendees) ? [...lootPayload.attendees] : []
    list.sort((a, b) => {
      const pa = a.pool_before != null ? Number(a.pool_before) : -Infinity
      const pb = b.pool_before != null ? Number(b.pool_before) : -Infinity
      if (pb !== pa) return pb - pa
      return String(a.account_id || '').localeCompare(String(b.account_id || ''))
    })
    return list
  }, [lootPayload])

  const runnerUp = lootPayload?.runner_up_account_guess ?? null

  function applyLootQuery(nextLoot, nextRaid) {
    const p = new URLSearchParams(searchParams)
    if (nextLoot) p.set('loot', String(nextLoot))
    else p.delete('loot')
    if (nextRaid) p.set('raid', nextRaid)
    else p.delete('raid')
    setSearchParams(p, { replace: true })
  }

  function handleLootSubmit(e) {
    e.preventDefault()
    const v = lootInput.trim()
    if (!v) {
      applyLootQuery('', raidParam)
      return
    }
    applyLootQuery(v, raidParam)
  }

  async function handleAccountSubmit(e) {
    e.preventDefault()
    const aid = accountIdInput.trim()
    if (!aid) {
      setAccountError('Enter an account id.')
      setAccountPayload(null)
      return
    }
    const from = dateFrom.trim()
    const to = dateTo.trim()
    if (!from || !to) {
      setAccountError('Choose both from and to dates.')
      setAccountPayload(null)
      return
    }
    setAccountLoading(true)
    setAccountError('')
    setAccountPayload(null)
    const { data, error: rpcErr } = await supabase.rpc('officer_account_bidding_portfolio', {
      p_account_id: aid,
      p_from_date: from,
      p_to_date: to,
    })
    setAccountLoading(false)
    if (rpcErr) {
      setAccountError(rpcErrorMessage(rpcErr))
      return
    }
    setAccountPayload(data && typeof data === 'object' ? data : null)
  }

  if (!isOfficer) return null

  const sale = lootPayload?.sale || {}

  return (
    <div className="container" style={{ paddingBottom: '2rem' }}>
      <h1 style={{ marginBottom: '0.5rem' }}>Bid portfolio</h1>
      <p style={{ color: '#a1a1aa', marginBottom: '1.25rem', maxWidth: '52rem' }}>
        Heuristic reconstruction only — there is no auction bid log.{' '}
        <strong>Runner-up guess</strong> is the non-buyer attendee with the highest reconstructed DKP pool before this sale among those
        whose pool was at least the clearing price (tie-break by account id).{' '}
        <strong>Synthetic max bid</strong> uses <code>LEAST(pool, P-1)</code> as a teaching scaffold.
        {raidParam ? (
          <>
            {' '}
            Context raid: <code>{raidParam}</code>
            {' · '}
            <Link to={`/officer?raid=${encodeURIComponent(raidParam)}`}>Back to officer raid</Link>
          </>
        ) : null}
      </p>

      <section className="card" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ marginTop: 0 }}>By loot row</h2>
        <form onSubmit={handleLootSubmit} style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', marginBottom: '1rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <span style={{ color: '#a1a1aa' }}>Loot id</span>
            <input
              type="text"
              inputMode="numeric"
              value={lootInput}
              onChange={(ev) => setLootInput(ev.target.value)}
              placeholder="raid_loot.id"
              style={{ width: '8rem', padding: '0.35rem 0.5rem' }}
            />
          </label>
          <button type="submit" className="btn" disabled={lootLoading}>
            Load
          </button>
          {lootParam ? (
            <span style={{ color: '#71717a', fontSize: '0.9rem' }}>
              URL: <code>?loot={lootParam}</code>
            </span>
          ) : null}
        </form>

        {lootLoading && <p style={{ color: '#a1a1aa' }}>Loading portfolio…</p>}
        {lootError && <p className="error">{lootError}</p>}

        {lootPayload && !lootLoading && (
          <>
            <div style={{ marginBottom: '1rem', color: '#e4e4e7' }}>
              <div>
                <strong>{sale.item_name || '—'}</strong>
                {sale.norm_name ? (
                  <span style={{ color: '#71717a', marginLeft: '0.5rem' }}>({sale.norm_name})</span>
                ) : null}
              </div>
              <div style={{ fontSize: '0.9rem', color: '#a1a1aa', marginTop: '0.25rem' }}>
                Raid <code>{lootPayload.raid_id || sale.raid_id || '—'}</code>
                {sale.raid_date != null ? ` · ${sale.raid_date}` : ''}
                {' · '}
                Sim: <code>{lootPayload.sim_mode || '—'}</code>
              </div>
              <div style={{ marginTop: '0.5rem' }}>
                Clearing: <strong>{formatNum(sale.cost_num)}</strong>
                {sale.cost_text ? <span style={{ color: '#71717a' }}> ({sale.cost_text})</span> : null}
                {' · '}
                Buyer:{' '}
                {sale.buyer_account_id ? (
                  <Link to={`/accounts/${encodeURIComponent(sale.buyer_account_id)}`}>{sale.buyer_account_id}</Link>
                ) : (
                  '—'
                )}
              </div>
              <div style={{ marginTop: '0.35rem' }}>
                Ref at sale: {formatNum(sale.ref_price_at_sale)} · Paid/ref: {formatNum(sale.paid_to_ref_ratio)}
              </div>
              <div style={{ marginTop: '0.35rem' }}>
                Next guild sale (same norm):{' '}
                {sale.next_guild_sale_loot_id != null ? (
                  <>
                    loot <code>{sale.next_guild_sale_loot_id}</code>
                    {sale.next_guild_sale_buyer_account_id ? (
                      <>
                        {' '}
                        →{' '}
                        <Link to={`/accounts/${encodeURIComponent(sale.next_guild_sale_buyer_account_id)}`}>
                          {sale.next_guild_sale_buyer_account_id}
                        </Link>
                      </>
                    ) : null}
                  </>
                ) : (
                  '—'
                )}
              </div>
              <div style={{ marginTop: '0.75rem', padding: '0.5rem 0.75rem', background: 'rgba(251, 191, 36, 0.08)', borderRadius: 6 }}>
                <strong>Runner-up guess:</strong>{' '}
                {runnerUp ? (
                  <Link to={`/accounts/${encodeURIComponent(runnerUp)}`}>{runnerUp}</Link>
                ) : (
                  '—'
                )}
              </div>
            </div>

            {Array.isArray(lootPayload.notes) && lootPayload.notes.length > 0 && (
              <ul style={{ color: '#71717a', fontSize: '0.85rem', marginBottom: '1rem' }}>
                {lootPayload.notes.map((n, i) => (
                  <li key={i}>{String(n)}</li>
                ))}
              </ul>
            )}

            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Pool before</th>
                    <th>Could clear</th>
                    <th>Synth max</th>
                    <th>Buyer</th>
                    <th>Runner-up</th>
                    <th>Median paid prior</th>
                    <th>Purchases prior</th>
                    <th>Median paid/ref prior</th>
                    <th>Later same item</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedAttendees.length === 0 ? (
                    <tr>
                      <td colSpan={10} style={{ color: '#71717a' }}>
                        No attendee rows (check attendance for this raid/event).
                      </td>
                    </tr>
                  ) : (
                    sortedAttendees.map((row) => {
                      const aid = row.account_id
                      const isBuyer = row.is_buyer === true
                      const isRunner = runnerUp != null && String(runnerUp) === String(aid)
                      return (
                        <tr
                          key={String(aid)}
                          style={{
                            background: isBuyer ? 'rgba(34, 197, 94, 0.12)' : isRunner ? 'rgba(251, 191, 36, 0.1)' : undefined,
                          }}
                        >
                          <td>
                            {aid ? <Link to={`/accounts/${encodeURIComponent(aid)}`}>{aid}</Link> : '—'}
                          </td>
                          <td>{formatNum(row.pool_before)}</td>
                          <td>{row.could_clear ? 'Yes' : 'No'}</td>
                          <td>{formatNum(row.synthetic_max_bid)}</td>
                          <td>{isBuyer ? 'Yes' : ''}</td>
                          <td>{isRunner ? 'Guess' : ''}</td>
                          <td>{formatNum(row.median_paid_prior)}</td>
                          <td>{row.purchase_count_prior != null ? String(row.purchase_count_prior) : '—'}</td>
                          <td>{formatNum(row.median_paid_to_ref_prior)}</td>
                          <td>
                            {row.later_bought_same_norm
                              ? row.first_later_loot_id != null
                                ? `Yes (loot ${row.first_later_loot_id})`
                                : 'Yes'
                              : ''}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

            <button type="button" className="btn btn-ghost" style={{ marginTop: '0.75rem' }} onClick={() => setShowRawLoot((v) => !v)}>
              {showRawLoot ? 'Hide' : 'Show'} raw JSON
            </button>
            {showRawLoot && (
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
                {JSON.stringify(lootPayload, null, 2)}
              </pre>
            )}
          </>
        )}
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>By account (date range required)</h2>
        <p style={{ color: '#71717a', fontSize: '0.9rem', marginTop: 0 }}>
          Unbounded date ranges scan all guild sales and can be very slow. Pick a bounded window.
        </p>
        <form onSubmit={handleAccountSubmit} style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end', marginBottom: '1rem' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span style={{ color: '#a1a1aa', fontSize: '0.85rem' }}>Account id</span>
            <input
              type="text"
              value={accountIdInput}
              onChange={(ev) => setAccountIdInput(ev.target.value)}
              style={{ minWidth: '14rem', padding: '0.35rem 0.5rem' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span style={{ color: '#a1a1aa', fontSize: '0.85rem' }}>From</span>
            <input type="date" value={dateFrom} onChange={(ev) => setDateFrom(ev.target.value)} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span style={{ color: '#a1a1aa', fontSize: '0.85rem' }}>To</span>
            <input type="date" value={dateTo} onChange={(ev) => setDateTo(ev.target.value)} />
          </label>
          <button type="submit" className="btn" disabled={accountLoading}>
            Run aggregate
          </button>
        </form>

        {accountLoading && <p style={{ color: '#a1a1aa' }}>Loading aggregates…</p>}
        {accountError && <p className="error">{accountError}</p>}

        {accountPayload && !accountLoading && (
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
                <dt style={{ color: '#71717a', fontSize: '0.8rem' }}>Account</dt>
                <dd style={{ margin: 0 }}>
                  {accountPayload.account_id ? (
                    <Link to={`/accounts/${encodeURIComponent(accountPayload.account_id)}`}>{accountPayload.account_id}</Link>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              <div>
                <dt style={{ color: '#71717a', fontSize: '0.8rem' }}>Range</dt>
                <dd style={{ margin: 0 }}>
                  {accountPayload.from_date ?? '—'} → {accountPayload.to_date ?? '—'}
                </dd>
              </div>
              <div>
                <dt style={{ color: '#71717a', fontSize: '0.8rem' }}>Loot rows won</dt>
                <dd style={{ margin: 0 }}>{formatNum(accountPayload.loot_rows_won)}</dd>
              </div>
              <div>
                <dt style={{ color: '#71717a', fontSize: '0.8rem' }}>DKP spent on wins</dt>
                <dd style={{ margin: 0 }}>{formatNum(accountPayload.total_dkp_spent_on_wins)}</dd>
              </div>
              <div>
                <dt style={{ color: '#71717a', fontSize: '0.8rem' }}>Auction rows present</dt>
                <dd style={{ margin: 0 }}>{formatNum(accountPayload.auction_rows_present)}</dd>
              </div>
              <div>
                <dt style={{ color: '#71717a', fontSize: '0.8rem' }}>Could clear, not buyer</dt>
                <dd style={{ margin: 0 }}>{formatNum(accountPayload.could_clear_but_not_buyer_count)}</dd>
              </div>
              <div>
                <dt style={{ color: '#71717a', fontSize: '0.8rem' }}>Runner-up guess hits</dt>
                <dd style={{ margin: 0 }}>{formatNum(accountPayload.runner_up_guess_count)}</dd>
              </div>
              <div>
                <dt style={{ color: '#71717a', fontSize: '0.8rem' }}>Sum synth max (present, non-buyer)</dt>
                <dd style={{ margin: 0 }}>{formatNum(accountPayload.sum_synthetic_max_bid_when_present_non_buyer)}</dd>
              </div>
              <div>
                <dt style={{ color: '#71717a', fontSize: '0.8rem' }}>Avg paid/ref on wins</dt>
                <dd style={{ margin: 0 }}>{formatNum(accountPayload.avg_paid_to_ref_on_wins)}</dd>
              </div>
            </dl>

            {Array.isArray(accountPayload.notes) && accountPayload.notes.length > 0 && (
              <ul style={{ color: '#71717a', fontSize: '0.85rem', marginTop: '1rem' }}>
                {accountPayload.notes.map((n, i) => (
                  <li key={i}>{String(n)}</li>
                ))}
              </ul>
            )}

            <button type="button" className="btn btn-ghost" style={{ marginTop: '0.75rem' }} onClick={() => setShowRawAccount((v) => !v)}>
              {showRawAccount ? 'Hide' : 'Show'} raw JSON
            </button>
            {showRawAccount && (
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
                {JSON.stringify(accountPayload, null, 2)}
              </pre>
            )}
          </>
        )}
      </section>

      <p style={{ marginTop: '1.5rem', fontSize: '0.9rem' }}>
        <Link to="/officer/loot-bid-forecast">Bid hints</Link>
        {' · '}
        <Link to="/officer/global-loot-bid-forecast">Global bid</Link>
        {' · '}
        <Link to="/officer">Officer</Link>
      </p>
    </div>
  )
}
