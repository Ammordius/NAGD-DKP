import ItemCard from '../components/ItemCard'
import ItemLink from '../components/ItemLink'
import { getItemStatsCached } from '../lib/itemStats'

export default function Dashboard({ isOfficer }) {
  const hammerStats = getItemStatsCached(21886)
  return (
    <div className="container">
      <h1>Dashboard</h1>
      <p style={{ color: '#a1a1aa' }}>
        Welcome. Use the nav to view <a href="/raids">Raids</a> and <a href="/dkp">DKP</a>.
      </p>
      {isOfficer && (
        <div className="card" style={{ borderLeft: '4px solid #fbbf24' }}>
          <strong>Officer</strong> – You have full read access. Use the <a href="/officer">Officer</a> tab to add raids, edit tics and loot, or delete raids.
        </div>
      )}
      <div className="card" style={{ borderLeft: '4px solid #7c3aed' }}>
        <h3 style={{ marginTop: 0 }}>Item card preview</h3>
        <p style={{ color: '#a1a1aa', fontSize: '0.875rem', marginBottom: '1rem' }}>
          Hover over item links on <a href="/mobs">Mob loot</a> or item pages to see stat previews (Discord-style). Example:
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'flex-start' }}>
          <ItemCard name="Hammer of Hours" itemId={21886} stats={hammerStats} />
          <div style={{ fontSize: '0.875rem', color: '#71717a', maxWidth: '200px' }}>
            Or hover this link: <ItemLink itemName="Hammer of Hours" itemId={21886}>Hammer of Hours</ItemLink>
          </div>
        </div>
      </div>
    </div>
  )
}
