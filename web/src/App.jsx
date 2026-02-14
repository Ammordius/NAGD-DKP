import { useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { supabase } from './lib/supabase'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Raids from './pages/Raids'
import RaidDetail from './pages/RaidDetail'
import DKP from './pages/DKP'

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
    const { data } = await supabase.from('profiles').select('role').eq('id', userId).single()
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

  if (!session) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  const isOfficer = profile?.role === 'officer'

  return (
    <>
      <nav>
        <a href="/">Home</a>
        <a href="/raids">Raids</a>
        <a href="/dkp">DKP</a>
        {isOfficer && <a href="/dkp" style={{ color: '#fbbf24' }}>Officer</a>}
        <span className="role">{profile?.role === 'officer' ? 'Officer' : 'Player'}</span>
        <button
          className="btn btn-ghost"
          onClick={() => supabase.auth.signOut()}
        >
          Sign out
        </button>
      </nav>
      <Routes>
        <Route path="/" element={<Dashboard isOfficer={isOfficer} />} />
        <Route path="/raids" element={<Raids />} />
        <Route path="/raids/:raidId" element={<RaidDetail />} />
        <Route path="/dkp" element={<DKP isOfficer={isOfficer} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}
