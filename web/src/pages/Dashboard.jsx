import { Link } from 'react-router-dom'
import DkpSiteDisclaimer from '../components/DkpSiteDisclaimer'
import MyDkpStandings from '../components/MyDkpStandings'
import { siteTitle } from '../lib/siteTitle'

export default function Dashboard({ isOfficer, profile }) {
  const displayName = (profile?.display_name || '').trim()
  return (
    <div className="container">
      <h1>{siteTitle()}</h1>
      <DkpSiteDisclaimer />
      <p style={{ color: '#a1a1aa' }}>
        Welcome{displayName ? ` ${displayName}` : ''}. Use the nav to view <Link to="/raids">Raids</Link> and <Link to="/dkp">DKP</Link>.
      </p>
      <MyDkpStandings accountId={profile?.account_id} showClaimPrompt />
      {isOfficer && (
        <div className="card" style={{ borderLeft: '4px solid #fbbf24' }}>
          <strong>Officer</strong> – You have full read access. Use the <Link to="/officer/RaidAdmin">Raid Admin</Link> tab to add raids, edit tics and loot, or delete raids.
        </div>
      )}
    </div>
  )
}
