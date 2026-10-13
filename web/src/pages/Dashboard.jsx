import { Link } from 'react-router-dom'

export default function Dashboard({ isOfficer }) {
  return (
    <div className="container">
      <h1>Dashboard</h1>
      <p style={{ color: '#a1a1aa' }}>
        Welcome. Use the nav to view <Link to="/raids">Raids</Link> and <Link to="/dkp">DKP</Link>.
      </p>
      {isOfficer && (
        <div className="card" style={{ borderLeft: '4px solid #fbbf24' }}>
          <strong>Officer</strong> – You have full read access. Use the <Link to="/officer/RaidAdmin">Raid Admin</Link> tab to add raids, edit tics and loot, or delete raids.
        </div>
      )}
    </div>
  )
}
