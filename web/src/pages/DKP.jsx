import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export default function DKP({ isOfficer }) {
  const [leaderboard, setLeaderboard] = useState([])
  const [accountLeaderboard, setAccountLeaderboard] = useState([])
  const [view, setView] = useState('character') // 'character' | 'account'
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    // DKP earned: sum event dkp for each character's raid attendance
    // DKP spent: sum loot cost per character
    // Then optionally roll up by account (character_account + accounts)
    Promise.all([
      supabase.from('raid_attendance').select('raid_id, char_id, character_name'),
      supabase.from('raid_events').select('raid_id, dkp_value'),
      supabase.from('raid_loot').select('char_id, character_name, cost'),
      supabase.from('character_account').select('char_id, account_id'),
      supabase.from('accounts').select('account_id, toon_names'),
    ]).then(([att, ev, loot, ca, acc]) => {
      if (att.error) { setError(att.error.message); setLoading(false); return }
      const evByRaid = {}
      ;(ev.data || []).forEach((e) => {
        evByRaid[e.raid_id] = (evByRaid[e.raid_id] || 0) + parseFloat(e.dkp_value || 0)
      })
      const earned = {}
      ;(att.data || []).forEach((a) => {
        const key = a.char_id || a.character_name || 'unknown'
        if (!earned[key]) earned[key] = { name: a.character_name || key, earned: 0 }
        earned[key].earned += evByRaid[a.raid_id] || 0
        if (a.character_name) earned[key].name = a.character_name
      })
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
      list.forEach((r) => { r.balance = r.earned - r.spent })
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
