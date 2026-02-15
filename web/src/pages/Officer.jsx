import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// --- Parsing ---

/** Parse Discord-style raid string e.g. "Thursday 02/12 9pm est: Water Minis + Cursed/Emp - February 12, 2026 8:00 PM" */
function parseRaidString(str) {
  const s = (str || '').trim()
  let raidName = ''
  let dateIso = ''
  // Try to get "February 12, 2026 8:00 PM" or similar at the end (after " - ")
  const dashMatch = s.match(/\s+-\s+([^-]+)$/)
  if (dashMatch) {
    const datePart = dashMatch[1].trim()
    raidName = s.replace(/\s+-\s+[^-]+$/, '').replace(/^[^:]+:\s*/, '').trim()
    const d = new Date(datePart)
    if (!isNaN(d.getTime())) {
      dateIso = d.toISOString().slice(0, 19).replace('T', ' ')
    }
  }
  if (!raidName && s) {
    const colonIdx = s.indexOf(':')
    if (colonIdx > 0) raidName = s.slice(colonIdx + 1).trim()
    else raidName = s
  }
  return { raidName, dateIso }
}

/** Parse channel member list lines; returns { eventTime, names[] } (names deduped, trimmed). */
function parseChannelList(paste) {
  const lines = (paste || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  let eventTime = ''
  const nameSet = new Set()
  for (const line of lines) {
    const tsMatch = line.match(/^\[([^\]]+)\]/)
    if (tsMatch) {
      const ts = tsMatch[1].trim()
      if (!eventTime) eventTime = ts
      // Skip "Channel X(N) members:"
      if (/members:\s*$/i.test(line)) continue
      const rest = line.replace(/^\[[^\]]+\]\s*/, '').trim()
      rest.split(',').forEach((n) => {
        const name = n.trim()
        if (name && !/^\d+$/.test(name)) nameSet.add(name)
      })
    }
  }
  return { eventTime, names: [...nameSet] }
}

/** Parse loot log lines e.g. "Earring of Eradication grats Barndog, 4 DKP!!!" or "... 0 DKP" */
function parseLootLog(paste) {
  const lines = (paste || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const results = []
  for (const line of lines) {
    const quoted = line.match(/'([^']+)'/)?.[1] || line
    const gratsMatch = quoted.match(/\bgrats\s+([^,]+?).*?\s+(\d+)\s*DKP/i)
    if (gratsMatch) {
      const characterName = gratsMatch[1].trim()
      const cost = parseInt(gratsMatch[2], 10)
      const itemName = quoted.replace(/\s*grats\s+[^,]+.*$/i, '').trim()
      if (itemName && characterName !== undefined) results.push({ itemName, characterName, cost: isNaN(cost) ? 0 : cost })
    }
  }
  return results
}

/** Generate a unique raid_id for officer-created raids (string, no collision with numeric imports). */
function generateRaidId() {
  return `manual-${Date.now()}`
}

/** Generate event_id for a tic (use timestamp from log or now). */
function generateEventId(eventTimeStr) {
  if (eventTimeStr) {
    const d = new Date(eventTimeStr)
    if (!isNaN(d.getTime())) return `tic-${d.getTime()}`
  }
  return `tic-${Date.now()}`
}

export default function Officer({ isOfficer }) {
  const navigate = useNavigate()
  const [raids, setRaids] = useState([])
  const [selectedRaidId, setSelectedRaidId] = useState('')
  const [raid, setRaid] = useState(null)
  const [events, setEvents] = useState([])
  const [loot, setLoot] = useState([])
  const [eventAttendance, setEventAttendance] = useState([])
  const [characters, setCharacters] = useState([])
  const [itemNames, setItemNames] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mutating, setMutating] = useState(false)

  // Add raid
  const [raidPaste, setRaidPaste] = useState('')
  const [addRaidResult, setAddRaidResult] = useState(null)

  // Add tic
  const [ticPaste, setTicPaste] = useState('')
  const [ticDkpValue, setTicDkpValue] = useState('1')
  const [ticResult, setTicResult] = useState(null)

  // Add loot manual
  const [lootItemQuery, setLootItemQuery] = useState('')
  const [lootCharName, setLootCharName] = useState('')
  const [lootCost, setLootCost] = useState('0')
  const [lootLogPaste, setLootLogPaste] = useState('')
  const [lootResult, setLootResult] = useState(null)

  // Delete
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleteError, setDeleteError] = useState('')

  const nameToChar = useMemo(() => {
    const m = {}
    characters.forEach((c) => {
      const n = (c.name || '').trim()
      if (n) m[n.toLowerCase()] = { char_id: c.char_id, name: n }
    })
    return m
  }, [characters])

  const loadRaids = useCallback(async () => {
    const { data } = await supabase
      .from('raids')
      .select('raid_id, raid_name, date_iso, date')
      .order('date_iso', { ascending: false, nullsFirst: false })
      .limit(150)
    setRaids(data || [])
  }, [])

  const loadOfficerData = useCallback(async () => {
    setLoading(true)
    setError('')
    await loadRaids()
    const [charsRes, itemsRes] = await Promise.all([
      supabase.from('characters').select('char_id, name').limit(5000),
      supabase.from('raid_loot').select('item_name').limit(10000),
    ])
    if (charsRes.data) setCharacters(charsRes.data)
    if (itemsRes.data) {
      const names = [...new Set((itemsRes.data || []).map((r) => r.item_name).filter(Boolean))].sort()
      setItemNames(names)
    }
    setLoading(false)
  }, [loadRaids])

  useEffect(() => {
    if (!isOfficer) {
      navigate('/')
      return
    }
    loadOfficerData()
  }, [isOfficer, navigate, loadOfficerData])

  const loadSelectedRaid = useCallback(async () => {
    if (!selectedRaidId) {
      setRaid(null)
      setEvents([])
      setLoot([])
      setEventAttendance([])
      return
    }
    const [r, e, l, ea] = await Promise.all([
      supabase.from('raids').select('*').eq('raid_id', selectedRaidId).single(),
      supabase.from('raid_events').select('*').eq('raid_id', selectedRaidId).order('event_order'),
      supabase.from('raid_loot').select('*').eq('raid_id', selectedRaidId),
      supabase.from('raid_event_attendance').select('event_id, char_id, character_name').eq('raid_id', selectedRaidId),
    ])
    setRaid(r.data || null)
    setEvents(e.data || [])
    setLoot(l.data || [])
    setEventAttendance(ea.data || [])
  }, [selectedRaidId])

  useEffect(() => {
    loadSelectedRaid()
  }, [loadSelectedRaid])

  const handleAddRaid = async () => {
    setMutating(true)
    setAddRaidResult(null)
    setError('')
    const { raidName, dateIso } = parseRaidString(raidPaste)
    if (!raidName.trim()) {
      setError('Could not parse a raid name. Use format like: "Thursday 02/12 9pm est: Water Minis + Cursed/Emp - February 12, 2026 8:00 PM"')
      setMutating(false)
      return
    }
    const raid_id = generateRaidId()
    const { error: err } = await supabase.from('raids').insert({
      raid_id,
      raid_pool: '',
      raid_name: raidName.trim(),
      date: dateIso || new Date().toISOString().slice(0, 10),
      date_iso: dateIso || new Date().toISOString().slice(0, 10),
      attendees: null,
      url: '',
    })
    if (err) {
      setError(err.message)
      setMutating(false)
      return
    }
    setAddRaidResult({ raid_id, raid_name: raidName.trim() })
    setRaidPaste('')
    await loadRaids()
    setSelectedRaidId(raid_id)
    setMutating(false)
  }

  const handleAddTic = async () => {
    if (!selectedRaidId) {
      setError('Select a raid first.')
      return
    }
    setMutating(true)
    setTicResult(null)
    setError('')
    const { eventTime, names } = parseChannelList(ticPaste)
    if (names.length === 0) {
      setError('No names found in the pasted list. Paste lines like "[Sun Apr 14 10:17:09 2024] Meldrath, Fridge, Geom, ..."')
      setMutating(false)
      return
    }
    const dkpValue = parseFloat(ticDkpValue) || 1
    const event_id = generateEventId(eventTime)
    const maxOrder = Math.max(0, ...events.map((e) => e.event_order || 0))
    const { error: evErr } = await supabase.from('raid_events').insert({
      raid_id: selectedRaidId,
      event_id,
      event_order: maxOrder + 1,
      event_name: 'DKP tic',
      dkp_value: String(dkpValue),
      attendee_count: String(names.length),
      event_time: eventTime || null,
    })
    if (evErr) {
      setError(evErr.message)
      setMutating(false)
      return
    }
    const matched = []
    const unmatched = []
    const seenCharId = new Set()
    for (const n of names) {
      const key = n.toLowerCase().trim()
      const char = nameToChar[key]
      if (char && !seenCharId.has(char.char_id)) {
        seenCharId.add(char.char_id)
        matched.push({ char_id: char.char_id, character_name: char.name })
      } else if (!char) {
        unmatched.push(n)
      }
    }
    if (matched.length > 0) {
      const { error: attErr } = await supabase.from('raid_event_attendance').insert(
        matched.map((m) => ({
          raid_id: selectedRaidId,
          event_id,
          char_id: m.char_id,
          character_name: m.character_name,
        }))
      )
      if (attErr) {
        setError(attErr.message)
        setMutating(false)
        return
      }
      const { data: existingRaidAtt } = await supabase.from('raid_attendance').select('char_id').eq('raid_id', selectedRaidId)
      const existingCharIds = new Set((existingRaidAtt || []).map((r) => String(r.char_id)))
      const toInsert = matched.filter((m) => !existingCharIds.has(String(m.char_id)))
      if (toInsert.length > 0) {
        const { error: raidAttErr } = await supabase.from('raid_attendance').insert(
          toInsert.map((m) => ({
            raid_id: selectedRaidId,
            char_id: m.char_id,
            character_name: m.character_name,
          }))
        )
        if (raidAttErr) setError(raidAttErr.message)
      }
    }
    setTicResult({ matched: matched.length, unmatched, event_id })
    setTicPaste('')
    loadSelectedRaid()
    setMutating(false)
  }

  const handleAddLootManual = async () => {
    if (!selectedRaidId) {
      setError('Select a raid first.')
      return
    }
    const itemName = lootItemQuery.trim()
    const characterName = lootCharName.trim()
    const cost = parseInt(lootCost, 10)
    if (!itemName) {
      setError('Enter an item name.')
      return
    }
    setMutating(true)
    setLootResult(null)
    setError('')
    const event_id = events.length > 0 ? events[0].event_id : 'loot'
    const char = nameToChar[characterName.toLowerCase()]
    const { error: err } = await supabase.from('raid_loot').insert({
      raid_id: selectedRaidId,
      event_id,
      item_name: itemName,
      char_id: char?.char_id ?? '',
      character_name: characterName || (char?.name ?? ''),
      cost: String(isNaN(cost) ? 0 : cost),
    })
    if (err) {
      setError(err.message)
      setMutating(false)
      return
    }
    setLootResult({ itemName, characterName: characterName || char?.name, cost: isNaN(cost) ? 0 : cost })
    setLootItemQuery('')
    setLootCharName('')
    setLootCost('0')
    loadSelectedRaid()
    setMutating(false)
  }

  const handleAddLootFromLog = async () => {
    if (!selectedRaidId) {
      setError('Select a raid first.')
      return
    }
    const parsed = parseLootLog(lootLogPaste)
    if (parsed.length === 0) {
      setError('No loot lines parsed. Use format like: ... \'Earring of Eradication grats Barndog, 4 DKP!!!\'')
      return
    }
    setMutating(true)
    setLootResult(null)
    setError('')
    const event_id = events.length > 0 ? events[0].event_id : 'loot'
    let inserted = 0
    for (const row of parsed) {
      const char = nameToChar[row.characterName.toLowerCase()]
      const { error: err } = await supabase.from('raid_loot').insert({
        raid_id: selectedRaidId,
        event_id,
        item_name: row.itemName,
        char_id: char?.char_id ?? '',
        character_name: row.characterName,
        cost: String(row.cost),
      })
      if (!err) inserted++
    }
    setLootResult({ fromLog: true, inserted, total: parsed.length })
    setLootLogPaste('')
    loadSelectedRaid()
    setMutating(false)
  }

  const handleDeleteRaid = async () => {
    if (deleteConfirm !== 'DELETE') {
      setDeleteError('Type DELETE to confirm.')
      return
    }
    if (!selectedRaidId) {
      setDeleteError('Select a raid first.')
      return
    }
    setMutating(true)
    setDeleteError('')
    const { error: err } = await supabase.rpc('delete_raid', { p_raid_id: selectedRaidId })
    if (err) {
      setDeleteError(err.message)
      setMutating(false)
      return
    }
    setSelectedRaidId('')
    setDeleteConfirm('')
    await loadRaids()
    loadSelectedRaid()
    setMutating(false)
  }

  const filteredItemNames = useMemo(() => {
    const q = lootItemQuery.toLowerCase().trim()
    if (!q) return itemNames.slice(0, 50)
    return itemNames.filter((n) => n.toLowerCase().includes(q)).slice(0, 50)
  }, [itemNames, lootItemQuery])

  const addRaidSectionRef = useRef(null)
  const raidPasteRef = useRef(null)
  const focusAddRaid = () => {
    addRaidSectionRef.current?.scrollIntoView({ behavior: 'smooth' })
    setTimeout(() => raidPasteRef.current?.focus(), 300)
  }

  if (!isOfficer) return null

  return (
    <div className="container">
      <h1>Officer – Raid management</h1>
      <p style={{ color: '#a1a1aa' }}>
        Add raids from Discord, paste DKP tics (channel lists), add loot manually or from logs. All edits require officer permissions.
      </p>
      <div style={{ marginBottom: '1rem' }}>
        <button type="button" className="btn" onClick={focusAddRaid} style={{ fontWeight: 'bold' }}>
          + New raid
        </button>
      </div>
      {error && <p className="error" style={{ marginBottom: '1rem' }}>{error}</p>}

      {/* Add raid */}
      <section ref={addRaidSectionRef} className="card" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ marginTop: 0 }}>Add raid</h2>
        <p style={{ color: '#71717a', fontSize: '0.9rem' }}>
          Paste a line from Discord, e.g. <code>Thursday 02/12 9pm est: Water Minis + Cursed/Emp - February 12, 2026 8:00 PM</code>
        </p>
        <textarea
          ref={raidPasteRef}
          value={raidPaste}
          onChange={(e) => setRaidPaste(e.target.value)}
          placeholder="Thursday 02/12 9pm est: Water Minis + Cursed/Emp - February 12, 2026 8:00 PM"
          rows={2}
          style={{ width: '100%', maxWidth: '600px', padding: '0.5rem', marginBottom: '0.5rem' }}
        />
        <div>
          <button type="button" className="btn" onClick={handleAddRaid} disabled={mutating || !raidPaste.trim()}>
            {mutating ? 'Creating…' : 'Create raid'}
          </button>
        </div>
        {addRaidResult && (
          <p style={{ color: '#22c55e', marginTop: '0.5rem' }}>
            Created <Link to={`/raids/${addRaidResult.raid_id}`}>{addRaidResult.raid_name}</Link>. You can add tics and loot below.
          </p>
        )}
      </section>

      {/* Raid selector */}
      <section className="card" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ marginTop: 0 }}>Select raid to edit</h2>
        <p style={{ color: '#71717a', fontSize: '0.9rem' }}>Recent raids (select to add tics, loot, or delete).</p>
        <select
          value={selectedRaidId}
          onChange={(e) => setSelectedRaidId(e.target.value)}
          style={{ padding: '0.35rem 0.5rem', minWidth: '320px' }}
        >
          <option value="">— Select raid —</option>
          {raids.map((r) => (
            <option key={r.raid_id} value={r.raid_id}>
              {r.date_iso || r.date || '—'} · {r.raid_name || r.raid_id}
            </option>
          ))}
        </select>
        {selectedRaidId && (
          <span style={{ marginLeft: '0.5rem' }}>
            <Link to={`/raids/${selectedRaidId}`}>View full raid</Link>
          </span>
        )}
      </section>

      {selectedRaidId && raid && (
        <>
          {/* Add DKP tic */}
          <section className="card" style={{ marginBottom: '1.5rem' }}>
            <h2 style={{ marginTop: 0 }}>Add DKP tic (attendance)</h2>
            <p style={{ color: '#71717a', fontSize: '0.9rem' }}>
              Paste channel member list. Names are matched to the DKP list; unmatched names are reported. No double counting.
            </p>
            <textarea
              value={ticPaste}
              onChange={(e) => setTicPaste(e.target.value)}
              placeholder="[Sun Apr 14 10:17:09 2024] Channel Nag(30) members:&#10;[Sun Apr 14 10:17:09 2024] Meldrath, Fridge, Geom, ..."
              rows={6}
              style={{ width: '100%', maxWidth: '600px', padding: '0.5rem', marginBottom: '0.5rem', fontFamily: 'monospace' }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <label>DKP per attendee:</label>
              <input
                type="number"
                min={0}
                step={0.5}
                value={ticDkpValue}
                onChange={(e) => setTicDkpValue(e.target.value)}
                style={{ width: '4rem', padding: '0.25rem' }}
              />
              <button type="button" onClick={handleAddTic} disabled={mutating || !ticPaste.trim()}>
                {mutating ? 'Adding…' : 'Add tic'}
              </button>
            </div>
            {ticResult && (
              <div style={{ marginTop: '0.5rem' }}>
                <p style={{ color: '#22c55e' }}>Credited {ticResult.matched} attendee(s).</p>
                {ticResult.unmatched?.length > 0 && (
                  <p style={{ color: '#f59e0b' }}>Unmatched (not on DKP list): {ticResult.unmatched.join(', ')}</p>
                )}
              </div>
            )}
          </section>

          {/* Add loot */}
          <section className="card" style={{ marginBottom: '1.5rem' }}>
            <h2 style={{ marginTop: 0 }}>Add loot</h2>
            <p style={{ color: '#71717a', fontSize: '0.9rem' }}>Manual: pick item (autocomplete), character, cost. Or paste log lines below.</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
              <input
                type="text"
                value={lootItemQuery}
                onChange={(e) => setLootItemQuery(e.target.value)}
                onBlur={() => {}}
                placeholder="Item name"
                list="loot-item-list"
                style={{ padding: '0.35rem', minWidth: '200px' }}
              />
              <datalist id="loot-item-list">
                {filteredItemNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
              <input
                type="text"
                value={lootCharName}
                onChange={(e) => setLootCharName(e.target.value)}
                placeholder="Character name"
                style={{ padding: '0.35rem', minWidth: '120px' }}
              />
              <input
                type="number"
                min={0}
                value={lootCost}
                onChange={(e) => setLootCost(e.target.value)}
                placeholder="Cost"
                style={{ width: '4rem', padding: '0.35rem' }}
              />
              <button type="button" onClick={handleAddLootManual} disabled={mutating || !lootItemQuery.trim()}>
                Add
              </button>
            </div>
            <p style={{ color: '#71717a', fontSize: '0.85rem', marginTop: '0.25rem' }}>Or paste loot log lines (e.g. &apos;Earring of Eradication grats Barndog, 4 DKP!!!&apos;):</p>
            <textarea
              value={lootLogPaste}
              onChange={(e) => setLootLogPaste(e.target.value)}
              placeholder="[Mon Feb 09 21:35:20 2026] Icbm says out of character, 'Earring of Eradication grats Barndog, 4 DKP!!!'"
              rows={3}
              style={{ width: '100%', maxWidth: '600px', padding: '0.5rem', marginTop: '0.25rem', fontFamily: 'monospace' }}
            />
            <button type="button" onClick={handleAddLootFromLog} disabled={mutating || !lootLogPaste.trim()} style={{ marginTop: '0.25rem' }}>
              Add from log
            </button>
            {lootResult && (
              <p style={{ color: '#22c55e', marginTop: '0.5rem' }}>
                {lootResult.fromLog ? `Added ${lootResult.inserted}/${lootResult.total} loot entries.` : `Added ${lootResult.itemName} → ${lootResult.characterName} (${lootResult.cost} DKP).`}
              </p>
            )}
          </section>

          {/* Current events & loot (read-only summary) */}
          <section className="card" style={{ marginBottom: '1.5rem' }}>
            <h2 style={{ marginTop: 0 }}>Raid summary</h2>
            <p><strong>{raid.raid_name}</strong> · {raid.date_iso || raid.date}</p>
            <p>Events: {events.length} · Loot rows: {loot.length}</p>
            <p><Link to={`/raids/${selectedRaidId}`}>Open full raid page to edit or view attendees</Link></p>
          </section>

          {/* Delete raid */}
          <section className="card" style={{ marginBottom: '1.5rem', borderColor: '#7f1d1d' }}>
            <h2 style={{ marginTop: 0, color: '#f87171' }}>Delete this raid</h2>
            <p style={{ color: '#71717a', fontSize: '0.9rem' }}>
              Permanently deletes this raid and all its attendance, events, and loot. Type <strong>DELETE</strong> to confirm.
            </p>
            <input
              type="text"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder="Type DELETE"
              style={{ padding: '0.35rem', width: '12rem', marginRight: '0.5rem' }}
            />
            <button type="button" onClick={handleDeleteRaid} disabled={mutating || deleteConfirm !== 'DELETE'} style={{ background: '#7f1d1d', color: '#fff' }}>
              Delete raid
            </button>
            {deleteError && <p className="error" style={{ marginTop: '0.5rem' }}>{deleteError}</p>}
          </section>
        </>
      )}

      {loading && raids.length === 0 && <p>Loading…</p>}
    </div>
  )
}
