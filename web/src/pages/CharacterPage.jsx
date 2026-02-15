import { useEffect, useState, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const MAGELO_BASE = 'https://www.takproject.net/magelo/character.php?char='

export default function CharacterPage() {
  const { charKey } = useParams()
  const charIdOrName = useMemo(() => (charKey ? decodeURIComponent(charKey) : ''), [charKey])
  const [attendance, setAttendance] = useState([])
  const [loot, setLoot] = useState([])
  const [raids, setRaids] = useState({})
  const [eventsByRaid, setEventsByRaid] = useState({})
  const [eventAttendance, setEventAttendance] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!charIdOrName) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    // Fetch by char_id or character_name
    const charFilter = (table, col) => {
      return supabase.from(table).or(`char_id.eq.${charIdOrName},character_name.eq.${charIdOrName}`)
    }
    Promise.all([
      supabase.from('raid_attendance').select('raid_id, char_id, character_name').or(`char_id.eq.${charIdOrName},character_name.eq.${charIdOrName}`).limit(2000),
      supabase.from('raid_loot').select('id, raid_id, item_name, character_name, cost').or(`char_id.eq.${charIdOrName},character_name.eq.${charIdOrName}`).limit(2000),
      supabase.from('raid_event_attendance').select('raid_id, event_id, char_id, character_name').or(`char_id.eq.${charIdOrName},character_name.eq.${charIdOrName}`).limit(10000),
    ]).then(([attRes, lootRes, evAttRes]) => {
      if (attRes.error) {
        setError(attRes.error.message)
        setLoading(false)
        return
      }
      setAttendance(attRes.data || [])
      setLoot(lootRes.data || [])
      setEventAttendance(evAttRes.data || [])
      const raidIds = new Set([
        ...(attRes.data || []).map((r) => r.raid_id),
        ...(lootRes.data || []).map((r) => r.raid_id),
      ])
      if (raidIds.size === 0) {
        setRaids({})
        setEventsByRaid({})
        setLoading(false)
        return
      }
      Promise.all([
        supabase.from('raids').select('raid_id, raid_name, date_iso').in('raid_id', [...raidIds]),
        supabase.from('raid_events').select('raid_id, event_id, dkp_value').in('raid_id', [...raidIds]),
      ]).then(([rRes, eRes]) => {
        const rMap = {}
        ;(rRes.data || []).forEach((row) => { rMap[row.raid_id] = row })
        setRaids(rMap)
        const eventDkp = {}
        ;(eRes.data || []).forEach((ev) => {
          eventDkp[`${ev.raid_id}|${ev.event_id}`] = parseFloat(ev.dkp_value || 0)
        })
        const evByRaid = {}
        if (evAttRes.data?.length > 0) {
          evAttRes.data.forEach((a) => {
            const k = `${a.raid_id}|${a.event_id}`
            if (!evByRaid[a.raid_id]) evByRaid[a.raid_id] = 0
            evByRaid[a.raid_id] += eventDkp[k] || 0
          })
        } else {
          (attRes.data || []).forEach((a) => {
            (eRes.data || []).filter((e) => e.raid_id === a.raid_id).forEach((ev) => {
              if (!evByRaid[a.raid_id]) evByRaid[a.raid_id] = 0
              evByRaid[a.raid_id] += parseFloat(ev.dkp_value || 0)
            })
          })
        }
        setEventsByRaid(evByRaid)
        setLoading(false)
      })
    })
  }, [charIdOrName])

  const displayName = useMemo(() => {
    const fromAtt = attendance[0]?.character_name || attendance[0]?.char_id
    const fromLoot = loot[0]?.character_name
    return fromAtt || fromLoot || charIdOrName
  }, [attendance, loot, charIdOrName])

  const raidList = useMemo(() => {
    const byRaid = new Map()
    attendance.forEach((a) => {
      if (!byRaid.has(a.raid_id)) byRaid.set(a.raid_id, { raid_id: a.raid_id })
    })
    return [...byRaid.values()].map((r) => ({
      ...r,
      date: raids[r.raid_id]?.date_iso?.slice(0, 10),
      raid_name: raids[r.raid_id]?.raid_name || r.raid_id,
      dkp: eventsByRaid[r.raid_id] ?? (eventAttendance.length > 0 ? null : 0),
    })).sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  }, [attendance, raids, eventsByRaid, eventAttendance.length])

  const lootWithRaid = useMemo(() => {
    return loot.map((row) => ({
      ...row,
      date: raids[row.raid_id]?.date_iso?.slice(0, 10),
      raid_name: raids[row.raid_id]?.raid_name || row.raid_id,
    })).sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  }, [loot, raids])

  if (loading) return <div className="container">Loading character…</div>
  if (error) return <div className="container"><span className="error">{error}</span> <Link to="/dkp">← DKP</Link></div>

  const mageloUrl = `${MAGELO_BASE}${encodeURIComponent(displayName)}`

  return (
    <div className="container">
      <p><Link to="/dkp">← DKP</Link> · <Link to="/accounts">Accounts</Link></p>
      <h1>{displayName}</h1>
      <p style={{ color: '#a1a1aa', marginBottom: '1rem' }}>
        <a href={mageloUrl} target="_blank" rel="noopener noreferrer">View on TAKP Magelo</a>
      </p>

      <h2>Raid history</h2>
      <div className="card">
        {raidList.length === 0 ? (
          <p style={{ color: '#71717a' }}>No raid attendance recorded.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Raid</th>
                <th>DKP earned</th>
              </tr>
            </thead>
            <tbody>
              {raidList.map((r) => (
                <tr key={r.raid_id}>
                  <td>{r.date || '—'}</td>
                  <td><Link to={`/raids/${r.raid_id}`}>{r.raid_name}</Link></td>
                  <td>{r.dkp != null ? Number(r.dkp).toFixed(1) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Item history</h2>
      <div className="card">
        {lootWithRaid.length === 0 ? (
          <p style={{ color: '#71717a' }}>No loot recorded.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Item</th>
                <th>Raid</th>
                <th>Cost (DKP)</th>
              </tr>
            </thead>
            <tbody>
              {lootWithRaid.map((row, i) => (
                <tr key={row.id || i}>
                  <td>{row.date || '—'}</td>
                  <td><Link to={`/items/${encodeURIComponent(row.item_name || '')}`}>{row.item_name || '—'}</Link></td>
                  <td><Link to={`/raids/${row.raid_id}`}>{row.raid_name}</Link></td>
                  <td>{row.cost ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
