import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// Supabase/PostgREST returns at most 1000 rows per query. Paginate to fetch all rows.
const PAGE_SIZE = 1000
async function fetchAllRows(table, select = '*') {
  const all = []
  let from = 0
  while (true) {
    const to = from + PAGE_SIZE - 1
    const { data, error } = await supabase.from(table).select(select).range(from, to)
    if (error) return { data: null, error }
    all.push(...(data || []))
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return { data: all, error: null }
}

export default function DKP({ isOfficer }) {
  const [leaderboard, setLeaderboard] = useState([])
  const [accountLeaderboard, setAccountLeaderboard] = useState([])
  const [view, setView] = useState('character') // 'character' | 'account'
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    // DKP earned: per-event attendance when raid_event_attendance exists, else raid-level attendance
    // DKP spent: sum loot cost per character. Use fetchAllRows so we get all data (Supabase caps at 1000/query).
    Promise.all([
      fetchAllRows('raid_attendance', 'raid_id, char_id, character_name'),
      fetchAllRows('raid_events', 'raid_id, event_id, dkp_value'),
      fetchAllRows('raid_event_attendance', 'raid_id, event_id, char_id, character_name'),
      fetchAllRows('raid_loot', 'char_id, character_name, cost'),
      fetchAllRows('character_account', 'char_id, account_id'),
      fetchAllRows('accounts', 'account_id, toon_names'),
      supabase.from('dkp_adjustments').select('character_name, earned_delta, spent_delta').limit(1000),
    ]).then(([att, ev, evAtt, loot, ca, acc, adj]) => {
      const err = att.error || ev.error || evAtt.error || loot.error || ca.error || acc.error
      if (err) { setError(err.message); setLoading(false); return }
      const adjustments = (adj && !adj.error && adj.data) ? adj.data : []
      // If raid_event_attendance table is missing or empty, we fall back to raid_attendance
      const eventAttendance = evAtt.error ? [] : (evAtt.data || [])
      // (raid_id, event_id) -> dkp_value for that event
      const eventDkp = {}
      ;(ev.data || []).forEach((e) => {
        const k = `${e.raid_id}|${e.event_id}`
        eventDkp[k] = (eventDkp[k] || 0) + parseFloat(e.dkp_value || 0)
      })
      const earned = {}
      const usePerEvent = eventAttendance.length > 0
      if (usePerEvent) {
        eventAttendance.forEach((a) => {
          const key = a.char_id || a.character_name || 'unknown'
          if (!earned[key]) earned[key] = { name: a.character_name || key, earned: 0 }
          const dkp = eventDkp[`${a.raid_id}|${a.event_id}`] || 0
          earned[key].earned += dkp
          if (a.character_name) earned[key].name = a.character_name
        })
      } else {
        const evByRaid = {}
        ;(ev.data || []).forEach((e) => {
          evByRaid[e.raid_id] = (evByRaid[e.raid_id] || 0) + parseFloat(e.dkp_value || 0)
        })
        ;(att.data || []).forEach((a) => {
          const key = a.char_id || a.character_name || 'unknown'
          if (!earned[key]) earned[key] = { name: a.character_name || key, earned: 0 }
          earned[key].earned += evByRaid[a.raid_id] || 0
          if (a.character_name) earned[key].name = a.character_name
        })
      }
      const spent = {}
      ;(loot.data || []).forEach((row) => {
        const key = row.char_id || row.character_name
        if (!key) return
        spent[key] = (spent[key] || 0) + parseInt(row.cost || 0, 10)
      })
      const list = Object.entries(earned).map(([key, v]) => ({
        char_id: key,
        name: typeof v === 'object' ? v.name : key,
        earned: typeof v === 'object' ? v.earned : v,
        spent: spent[key] || 0,
      }))
      const adjustmentsMap = {}
      adjustments.forEach((row) => {
        const n = (row.character_name || '').trim()
        if (n) adjustmentsMap[n] = { earned_delta: Number(row.earned_delta) || 0, spent_delta: Number(row.spent_delta) | 0 }
      })
      list.forEach((r) => {
        const adjRow = adjustmentsMap[(r.name || '').trim()] || adjustmentsMap[(r.name || '').trim().replace(/^\(\*\)\s*/, '')]
        if (adjRow) {
          r.earned += adjRow.earned_delta
          r.spent += adjRow.spent_delta || 0
        }
        r.balance = r.earned - r.spent
      })
      list.sort((a, b) => b.balance - a.balance)
      setLeaderboard(list)

      // Roll up by account: char_id -> account_id, then sum earned/spent per account
      const charToAccount = {}
      ;(ca.data || []).forEach((r) => { charToAccount[String(r.char_id)] = r.account_id })
      const accountNames = {}
      ;(acc.data || []).forEach((r) => {
        const first = (r.toon_names || '').split(',')[0]?.trim() || r.account_id
        accountNames[r.account_id] = first
      })
      const byAccount = {}
      list.forEach((r) => {
        const aid = charToAccount[String(r.char_id)] ?? '_no_account_'
        if (!byAccount[aid]) byAccount[aid] = { account_id: aid, earned: 0, spent: 0, name: accountNames[aid] || (aid === '_no_account_' ? '(no account)' : aid) }
        byAccount[aid].earned += r.earned
        byAccount[aid].spent += r.spent
      })
      const accountList = Object.values(byAccount).map((r) => ({ ...r, balance: r.earned - r.spent }))
      accountList.sort((a, b) => b.balance - a.balance)
      setAccountLeaderboard(accountList)
      setLoading(false)
    })
  }, [])

  if (loading) return <div className="container">Loading DKP…</div>
  if (error) return <div className="container"><span className="error">{error}</span></div>

  const showList = view === 'account' ? accountLeaderboard : leaderboard
  const colLabel = view === 'account' ? 'Account (first toon)' : 'Character'

  return (
    <div className="container">
      <h1>DKP Leaderboard</h1>
      <p style={{ color: '#71717a' }}>
        Earned (raid attendance × event DKP) minus spent (loot). Toggle to view by character or by account (all toons on same account summed).
      </p>
      <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem' }}>
        <button type="button" onClick={() => setView('character')} style={{ fontWeight: view === 'character' ? 'bold' : 'normal' }}>By character</button>
        <button type="button" onClick={() => setView('account')} style={{ fontWeight: view === 'account' ? 'bold' : 'normal' }}>By account</button>
      </div>
      {showList.length === 0 && (
        <p style={{ color: '#f59e0b', marginBottom: '1rem' }}>
          No DKP data. Make sure you’re logged in and the app is using the same Supabase project where you imported the CSVs (check Vercel env: VITE_SUPABASE_URL).
        </p>
      )}
      {showList.length > 0 && showList.every((r) => Number(r.spent) === 0) && (
        <p style={{ color: '#f59e0b', marginBottom: '1rem' }}>
          Spent is 0 for all characters. Import <code>data/raid_loot.csv</code> into the <strong>raid_loot</strong> table in Supabase so loot costs are included. See docs/SETUP-WALKTHROUGH.md.
        </p>
      )}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>{colLabel}</th>
              <th>Earned</th>
              <th>Spent</th>
              <th>Balance</th>
            </tr>
          </thead>
          <tbody>
            {showList.slice(0, 200).map((r, i) => (
              <tr key={view === 'account' ? r.account_id + i : r.char_id}>
                <td>{r.name}</td>
                <td>{Number(r.earned).toFixed(1)}</td>
                <td>{r.spent}</td>
                <td><strong>{Number(r.balance).toFixed(1)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
