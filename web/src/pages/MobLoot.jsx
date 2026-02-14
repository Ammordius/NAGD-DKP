import { useEffect, useState, useMemo, Fragment } from 'react'

/**
 * Lists mobs and their DKP loot from data/dkp_mob_loot.json (copied to web/public/dkp_mob_loot.json).
 * Each entry: { mob, zone, loot: [{ item_id, name, sources }] }.
 */
export default function MobLoot() {
  const [data, setData] = useState(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState({})

  useEffect(() => {
    fetch('/dkp_mob_loot.json')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => setData(json || null))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [])

  const entries = useMemo(() => {
    if (!data || typeof data !== 'object') return []
    const list = Object.entries(data)
      .filter(([_, v]) => v && typeof v === 'object' && Array.isArray(v.loot))
      .map(([key, v]) => ({
        key,
        mob: v.mob || key.replace(/\|$/, ''),
        zone: v.zone || '',
        loot: v.loot || [],
      }))
    return list.sort((a, b) => (a.mob || '').localeCompare(b.mob || ''))
  }, [data])

  const filtered = useMemo(() => {
    const q = (query || '').trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (e) =>
        (e.mob || '').toLowerCase().includes(q) ||
        (e.zone || '').toLowerCase().includes(q)
    )
  }, [entries, query])

  const toggle = (key) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  if (loading) return <div className="container">Loading mob loot…</div>
  if (!data) {
    return (
      <div className="container">
        <p className="error">Could not load dkp_mob_loot.json. Copy data/dkp_mob_loot.json to web/public/ or run the build script with --copy-dkp-mob-loot.</p>
      </div>
    )
  }

  return (
    <div className="container">
      <h1>Loot by mob</h1>
      <p style={{ color: '#71717a', marginBottom: '1rem' }}>
        DKP loot table per mob (from dkp_mob_loot.json). Search by mob or zone.
      </p>
      <div className="search-bar">
        <label>
          <span style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', color: '#a1a1aa' }}>Search mob or zone</span>
          <input
            type="search"
            placeholder="e.g. Vulak or Plane of Time"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search mob or zone"
          />
        </label>
      </div>
      <p style={{ color: '#71717a', fontSize: '0.875rem', marginBottom: '1rem' }}>
        {filtered.length} mob{filtered.length !== 1 ? 's' : ''}
      </p>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th style={{ width: '2rem' }}></th>
              <th>Mob</th>
              <th>Zone</th>
              <th>Loot count</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => {
              const isOpen = expanded[e.key]
              return (
                <Fragment key={e.key}>
                  <tr>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{ padding: '0.25rem', fontSize: '1rem' }}
                        onClick={() => toggle(e.key)}
                        aria-expanded={isOpen}
                      >
                        {isOpen ? '−' : '+'}
                      </button>
                    </td>
                    <td>{e.mob.replace(/^#/, '')}</td>
                    <td style={{ color: '#a1a1aa' }}>{e.zone || '—'}</td>
                    <td>{e.loot.length}</td>
                  </tr>
                  {isOpen && (
                    <tr key={`${e.key}-exp`}>
                      <td colSpan={4} style={{ padding: '0.5rem 1rem', verticalAlign: 'top', backgroundColor: 'rgba(0,0,0,0.2)' }}>
                        <table style={{ margin: 0 }}>
                          <thead>
                            <tr><th>Item</th><th>Sources</th></tr>
                          </thead>
                          <tbody>
                            {e.loot.map((item) => (
                              <tr key={item.item_id || item.name}>
                                <td>{item.name || '—'}</td>
                                <td style={{ fontSize: '0.875rem', color: '#a1a1aa' }}>{(item.sources || []).join(', ') || '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
