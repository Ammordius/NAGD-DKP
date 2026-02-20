import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, Link } from 'react-router-dom'
import { Analytics } from '@vercel/analytics/react'
import { supabase } from './lib/supabase'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Raids from './pages/Raids'
import RaidDetail from './pages/RaidDetail'
import DKP from './pages/DKP'
import LootSearch from './pages/LootSearch'
import MobLoot from './pages/MobLoot'
import Accounts from './pages/Accounts'
import AccountDetail from './pages/AccountDetail'
import ItemPage from './pages/ItemPage'
import CharacterPage from './pages/CharacterPage'
import LootRecipients from './pages/LootRecipients'
import Officer from './pages/Officer'
import DkpChangelog from './pages/DkpChangelog'
import Profile from './pages/Profile'

export default function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) fetchProfile(session.user.id)
      else setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session) fetchProfile(session.user.id)
      else setProfile(null)
      setLoading(false)
    })
    return () => subscription?.unsubscribe()
  }, [])

  async function fetchProfile(userId) {
    const { data } = await supabase.from('profiles').select('role, account_id').eq('id', userId).single()
    setProfile(data)
    setLoading(false)
  }

  if (loading) {
    return (
      <div className="container" style={{ paddingTop: '2rem', textAlign: 'center' }}>
        Loading…
      </div>
    )
  }

  const isOfficer = profile?.role === 'officer'

  // Require sign-in for all data; only /login is public (anon = handshake only).
  function RequireAuth({ children }) {
    if (!session) {
      const path = typeof window !== 'undefined' ? window.location.pathname + window.location.search : ''
      const redirect = path ? encodeURIComponent(path) : ''
      return <Navigate to={redirect ? `/login?redirect=${redirect}` : '/login'} replace />
    }
    return children
  }

  return (
    <>
      <nav>
        <a href="/">Home</a>
        <a href="/dkp">DKP</a>
        <a href="/accounts">Accounts</a>
        <a href="/raids">Raids</a>
        <a href="/mobs">Raid Items</a>
        <a href="/loot">Item History</a>
        <a href="/loot-recipients">Character History</a>
        {session ? (
          <>
            <a href="/profile">Profile</a>
            {isOfficer && <Link to="/officer" style={{ color: '#fbbf24' }}>Officer</Link>}
            {isOfficer && <Link to="/officer/dkp-changelog">DKP changelog</Link>}
            <span className="role">{profile?.role === 'officer' ? 'Officer' : 'Player'}</span>
            <button
              className="btn btn-ghost"
              onClick={() => supabase.auth.signOut()}
            >
              Sign out
            </button>
          </>
        ) : (
          <a href="/login">Sign in</a>
        )}
      </nav>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<RequireAuth><Dashboard isOfficer={isOfficer} /></RequireAuth>} />
        <Route path="/raids" element={<RequireAuth><Raids isOfficer={isOfficer} /></RequireAuth>} />
        <Route path="/raids/:raidId" element={<RequireAuth><RaidDetail isOfficer={isOfficer} /></RequireAuth>} />
        <Route path="/dkp" element={<RequireAuth><DKP isOfficer={isOfficer} /></RequireAuth>} />
        <Route path="/officer" element={<RequireAuth><Officer isOfficer={isOfficer} /></RequireAuth>} />
        <Route path="/officer/dkp-changelog" element={<RequireAuth><DkpChangelog isOfficer={isOfficer} /></RequireAuth>} />
        <Route path="/loot" element={<RequireAuth><LootSearch /></RequireAuth>} />
        <Route path="/loot-recipients" element={<RequireAuth><LootRecipients /></RequireAuth>} />
        <Route path="/mobs" element={<RequireAuth><MobLoot /></RequireAuth>} />
        <Route path="/accounts" element={<RequireAuth><Accounts /></RequireAuth>} />
        <Route path="/accounts/:accountId" element={<RequireAuth><AccountDetail isOfficer={isOfficer} profile={profile} session={session} /></RequireAuth>} />
        <Route path="/profile" element={<RequireAuth><Profile profile={profile} onProfileUpdate={() => session?.user?.id && fetchProfile(session.user.id)} /></RequireAuth>} />
        <Route path="/items/:itemNameEncoded" element={<RequireAuth><ItemPage /></RequireAuth>} />
        <Route path="/characters/:charKey" element={<RequireAuth><CharacterPage /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Analytics />
    </>
  )
}
