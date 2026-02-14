export default function Dashboard({ isOfficer }) {
  return (
    <div className="container">
      <h1>Dashboard</h1>
      <p style={{ color: '#a1a1aa' }}>
        Welcome. Use the nav to view <a href="/raids">Raids</a> and <a href="/dkp">DKP</a>.
      </p>
      {isOfficer && (
        <div className="card" style={{ borderLeft: '4px solid #fbbf24' }}>
          <strong>Officer</strong> – You have full read access. Future updates can add edit tools here.
        </div>
      )}
    </div>
  )
}
