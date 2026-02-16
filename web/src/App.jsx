import { useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
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

  return (
    <>
      <nav>
        <a href="/">Home</a>
        <a href="/raids">Raids</a>
        <a href="/dkp">DKP</a>
        <a href="/loot">Loot search</a>
        <a href="/loot-recipients">Loot recipients</a>
        <a href="/mobs">Mob loot</a>
        <a href="/accounts">Accounts</a>
        {session ? (
          <>
            <a href="/profile">Profile</a>
            {isOfficer && <a href="/officer" style={{ color: '#fbbf24' }}>Officer</a>}
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
        <Route path="/" element={<Dashboard isOfficer={isOfficer} />} />
        <Route path="/raids" element={<Raids isOfficer={isOfficer} />} />
        <Route path="/raids/:raidId" element={<RaidDetail isOfficer={isOfficer} />} />
        <Route path="/dkp" element={<DKP isOfficer={isOfficer} />} />
        <Route path="/officer" element={session ? <Officer isOfficer={isOfficer} /> : <Navigate to="/login?redirect=%2Fofficer" replace />} />
        <Route path="/loot" element={<LootSearch />} />
        <Route path="/loot-recipients" element={<LootRecipients />} />
        <Route path="/mobs" element={<MobLoot />} />
        <Route path="/accounts" element={<Accounts />} />
        <Route path="/accounts/:accountId" element={<AccountDetail isOfficer={isOfficer} profile={profile} session={session} />} />
        <Route path="/profile" element={session ? <Profile profile={profile} onProfileUpdate={() => session?.user?.id && fetchProfile(session.user.id)} /> : <Navigate to="/login?redirect=%2Fprofile" replace />} />
        <Route path="/items/:itemNameEncoded" element={<ItemPage />} />
        <Route path="/characters/:charKey" element={<CharacterPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}
