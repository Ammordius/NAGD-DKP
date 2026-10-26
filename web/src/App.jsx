import { useEffect, useState, useRef } from 'react'
import { Routes, Route, Navigate, Link, useLocation, useNavigate } from 'react-router-dom'
import { Analytics } from '@vercel/analytics/react'
import { nextAuthGate } from './lib/authGate'
import { safeGetSession, safeSignOut } from './lib/authSession'
import { consumeLastPath, persistLastPath } from './lib/lastPath'
import { loadProfileForUser } from './lib/loadProfile'
import { safeNextPath } from './lib/safeNextPath'
import { documentTitleForPath, isProductionSite } from './lib/siteTitle'
import { supabase, supabaseUrl } from './lib/supabase'
import { clearUserPageState } from './lib/pageState'
import { PageStateUserProvider } from './lib/pageStateUser'
import { RouteScrollProvider } from './lib/routeScrollView'
import { AmbianceRoot } from './lib/useAmbianceTheme'
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
import OfficerClaimCooldowns from './pages/OfficerClaimCooldowns'
import OfficerWhoParser from './pages/OfficerWhoParser'
import OfficerRaiderActivity from './pages/OfficerRaiderActivity'
import DiscordSchedule from './pages/DiscordSchedule'
import Profile from './pages/Profile'
import AuthCallback from './pages/AuthCallback'

function RequireAuth({ session, children }) {
  if (!session) {
    const path = typeof window !== 'undefined' ? window.location.pathname + window.location.search : ''
    const redirect = path ? encodeURIComponent(path) : ''
    return <Navigate to={redirect ? `/login?redirect=${redirect}` : '/login'} replace />
  }
  return children
}

function RedirectPreserve({ to }) {
  const { search, hash } = useLocation()
  return <Navigate to={`${to}${search}${hash}`} replace />
}

function RequireOfficer({ isOfficer, children }) {
  if (!isOfficer) return <Navigate to="/" replace />
  return children
}

function NotFound() {
  return (
    <div className="container">
      <h1>Page not found</h1>
      <p style={{ color: '#a1a1aa' }}>That address is not part of this site.</p>
      <p><Link to="/">Go to Home</Link></p>
    </div>
  )
}

function SiteChrome({ children }) {
  return (
    <div className="app-shell">
      {!isProductionSite() && (
        <div className="dev-site-banner" role="status">THIS IS A DEVELOPMENT / MIRROR SITE</div>
      )}
      <div className="app-shell-main">{children}</div>
      <footer className="site-footer">
        NAGD is an EverQuest guild on the TAKP emulator server. This site was created by Ammordius, with contributions from Rimidal.
      </footer>
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [profileLoadFailed, setProfileLoadFailed] = useState(false)
  const [profileLoadDebug, setProfileLoadDebug] = useState(null)
  const [profileLoadUserMessage, setProfileLoadUserMessage] = useState(null)
  const [authActionError, setAuthActionError] = useState(null)
  const [loading, setLoading] = useState(true)
  const location = useLocation()
  const navigate = useNavigate()
  const hasRestoredRef = useRef(false)
  const profileUserIdRef = useRef(null)
  const profileRequestRef = useRef(null)
  const sessionUserIdRef = useRef(null)

  function noteUserChange(nextUserId) {
    const previousUserId = sessionUserIdRef.current
    if (previousUserId && previousUserId !== nextUserId) {
      clearUserPageState(sessionStorage, previousUserId)
    }
    sessionUserIdRef.current = nextUserId
  }

  useEffect(() => {
    document.title = documentTitleForPath(location.pathname)
  }, [location.pathname])

  // Persist current route so reopening the app keeps this user on the same page
  useEffect(() => {
    const path = location.pathname + location.search
    const userId = session?.user?.id
    if (path && userId && location.pathname !== '/login' && location.pathname !== '/auth/callback') {
      persistLastPath(userId, path, localStorage)
    }
  }, [location.pathname, location.search, session])

  // Restore last page only once when app loads at / (so we don't redirect when user clicks Home)
  useEffect(() => {
    if (loading || !session) return
    if (location.pathname !== '/') return
    if (hasRestoredRef.current) return
    hasRestoredRef.current = true
    const saved = safeNextPath(consumeLastPath(session.user.id, localStorage, sessionStorage))
    if (saved !== '/' && !saved.startsWith('/login') && !saved.startsWith('/auth/callback')) {
      navigate(saved, { replace: true })
    }
  }, [loading, session, location.pathname, navigate])

  useEffect(() => {
    let cancelled = false

    function applyAuth(event, session) {
      if (cancelled) return
      const decision = nextAuthGate({
        event,
        session,
        loadedUserId: profileUserIdRef.current,
        pendingUserId: profileRequestRef.current,
      })
      if (decision.action === 'ignore') return
      if (decision.action === 'sign-out') {
        noteUserChange(null)
        profileUserIdRef.current = null
        profileRequestRef.current = null
        setSession(null)
        setProfile(null)
        setProfileLoadFailed(false)
        setProfileLoadDebug(null)
        setProfileLoadUserMessage(null)
        setAuthActionError(null)
        setLoading(false)
        return
      }
      // Hold the loading gate until this user's role is known. Officer pages
      // redirect home when isOfficer is still false. A tab return emits
      // SIGNED_IN for the same user and must not reach this branch.
      noteUserChange(decision.userId)
      profileRequestRef.current = decision.userId
      setSession(session)
      if (profileUserIdRef.current !== decision.userId) {
        setLoading(true)
        setProfileLoadFailed(false)
        setProfileLoadDebug(null)
        setProfileLoadUserMessage(null)
        setAuthActionError(null)
      }
      const userId = decision.userId
      // The auth client awaits this callback while it holds its session lock.
      // A Supabase query here deadlocks that lock when the tab becomes visible.
      setTimeout(() => {
        if (!cancelled) fetchProfile(userId, { operation: 'initial' })
      }, 0)
    }

    safeGetSession(supabase).then(({ session, error }) => {
      if (error) console.warn('[auth/getSession]', error?.message || error)
      if (!cancelled) applyAuth('GET_SESSION', session)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      applyAuth(event, session)
    })
    return () => {
      cancelled = true
      subscription?.unsubscribe()
    }
  }, [])

  async function fetchProfile(userId, { operation = 'initial', allowAutoRetry = true } = {}) {
    if (profileRequestRef.current && profileRequestRef.current !== userId) return
    profileRequestRef.current = userId
    let failed = false
    try {
      const result = await loadProfileForUser(supabase, userId, {
        supabaseUrl,
        operation,
        sessionExpected: true,
        allowAutoRetry,
      })
      if (profileRequestRef.current !== userId) return
      if (!result.ok) {
        failed = true
        console.warn('[auth/profile]', result.debugLine)
        setProfileLoadDebug(result.debugLine)
        setProfileLoadUserMessage(result.userMessage)
        // Allow a later auth event to try again. Leaving the request marked
        // in flight would ignore every future SIGNED_IN for this user.
        if (profileRequestRef.current === userId) profileRequestRef.current = null
        // A failed read is not a player. Keep a profile we already loaded.
        if (profileUserIdRef.current !== userId) setProfileLoadFailed(true)
        return
      }
      setProfile(result.profile)
      profileUserIdRef.current = userId
      setProfileLoadFailed(false)
      setProfileLoadDebug(null)
      setProfileLoadUserMessage(null)
      setAuthActionError(null)
    } catch (err) {
      failed = true
      console.warn('[auth/profile]', err?.message || err)
      setProfileLoadDebug(err?.message ? String(err.message) : 'Profile read failed')
      setProfileLoadUserMessage('Could not load your profile.')
      if (profileRequestRef.current === userId) profileRequestRef.current = null
      if (profileUserIdRef.current !== userId) setProfileLoadFailed(true)
    } finally {
      if (failed || profileRequestRef.current === userId || profileUserIdRef.current === userId) setLoading(false)
    }
  }

  async function handleProfileRetry() {
    setAuthActionError(null)
    setProfileLoadDebug(null)
    setProfileLoadUserMessage(null)
    setLoading(true)
    const userId = session?.user?.id
    if (!userId) {
      setLoading(false)
      setProfileLoadFailed(false)
      return
    }
    const { session: live, error } = await safeGetSession(supabase)
    if (error) console.warn('[auth/retry/getSession]', error?.message || error)
    if (!live?.user?.id) {
      noteUserChange(null)
      profileUserIdRef.current = null
      profileRequestRef.current = null
      setSession(null)
      setProfile(null)
      setProfileLoadFailed(false)
      setLoading(false)
      setAuthActionError('Your session expired. Sign in again.')
      return
    }
    await fetchProfile(live.user.id, { operation: 'retry', allowAutoRetry: true })
  }

  async function handleSignOut() {
    setAuthActionError(null)
    const { ok, error } = await safeSignOut(supabase)
    if (!ok) {
      const message = error?.message ? String(error.message) : 'Sign out failed. Try again.'
      console.warn('[auth/signOut]', message)
      setAuthActionError(message)
    }
  }

  if (loading) {
    return (
      <SiteChrome>
        <div className="container" style={{ paddingTop: '2rem', textAlign: 'center' }}>
          Loading…
        </div>
      </SiteChrome>
    )
  }

  if (session && profileLoadFailed) {
    return (
      <SiteChrome>
        <div className="container" style={{ paddingTop: '2rem' }}>
          <p className="error" role="alert">
            {profileLoadUserMessage || 'Could not load your profile.'}
          </p>
          {profileLoadDebug && (
            <p
              role="status"
              style={{ color: '#a1a1aa', fontSize: '0.875rem', marginTop: '0.75rem', wordBreak: 'break-word' }}
            >
              {profileLoadDebug}
            </p>
          )}
          {authActionError && (
            <p className="error" role="alert" style={{ marginTop: '0.75rem' }}>{authActionError}</p>
          )}
          <button type="button" className="btn" onClick={handleProfileRetry}>
            Retry
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ marginLeft: '0.5rem' }}
            onClick={handleSignOut}
          >
            Sign out
          </button>
        </div>
      </SiteChrome>
    )
  }

  const isOfficer = profile?.role === 'officer' || profile?.role === 'siteadmin'
  const isSiteAdmin = profile?.role === 'siteadmin'
  const roleLabel = profile?.role === 'siteadmin' ? 'Site Admin' : profile?.role === 'officer' ? 'Officer' : 'Player'

  return (
    <PageStateUserProvider userId={session?.user?.id || null}>
    <AmbianceRoot>
    <RouteScrollProvider>
    <SiteChrome>
      <nav>
        <Link to="/">Home</Link>
        <Link to="/dkp">DKP</Link>
        <Link to="/accounts">Game Accounts</Link>
        <Link to="/raids">Raids</Link>
        <Link to="/mobs">Raid Items</Link>
        <Link to="/loot">Item History</Link>
        <Link to="/loot-recipients">Character History</Link>
        {session ? (
          <>
            <Link to="/profile">My Site Profile</Link>
            {isOfficer && (
              <span className="nav-admin-group">
                <Link to="/officer/RaidAdmin">Raid Admin</Link>
                <Link to="/officer/SiteAdmin">Site Admin</Link>
              </span>
            )}
            <span className="role">{roleLabel}</span>
            <button className="btn btn-ghost" onClick={handleSignOut}>
              Sign out
            </button>
          </>
        ) : (
          <Link to="/login">Sign in</Link>
        )}
      </nav>
      {authActionError && !profileLoadFailed && (
        <div className="container" style={{ paddingTop: '0.5rem' }}>
          <p className="error" role="alert">{authActionError}</p>
        </div>
      )}
      <Routes>
        <Route path="/login" element={<Login session={session} />} />
        <Route path="/auth/callback" element={<AuthCallback session={session} />} />
        <Route path="/" element={<RequireAuth session={session}><Dashboard isOfficer={isOfficer} profile={profile} /></RequireAuth>} />
        <Route path="/raids" element={<RequireAuth session={session}><Raids isOfficer={isOfficer} /></RequireAuth>} />
        <Route path="/raids/:raidId" element={<RequireAuth session={session}><RaidDetail isOfficer={isOfficer} profile={profile} /></RequireAuth>} />
        <Route path="/dkp" element={<RequireAuth session={session}><DKP isOfficer={isOfficer} profile={profile} /></RequireAuth>} />
        <Route path="/officer" element={<RedirectPreserve to="/officer/RaidAdmin" />} />
        <Route path="/officer/RaidAdmin" element={<RequireAuth session={session}><RequireOfficer isOfficer={isOfficer}><Officer isOfficer={isOfficer} profile={profile} userId={session?.user?.id || null} /></RequireOfficer></RequireAuth>} />
        <Route path="/officer/dkp-changelog" element={<RequireAuth session={session}><RequireOfficer isOfficer={isOfficer}><DkpChangelog isOfficer={isOfficer} /></RequireOfficer></RequireAuth>} />
        <Route path="/officer/who-parser" element={<RequireAuth session={session}><RequireOfficer isOfficer={isOfficer}><OfficerWhoParser isOfficer={isOfficer} /></RequireOfficer></RequireAuth>} />
        <Route path="/officer/claim-cooldowns" element={<RedirectPreserve to="/officer/SiteAdmin" />} />
        <Route path="/officer/SiteAdmin" element={<RequireAuth session={session}><RequireOfficer isOfficer={isOfficer}><OfficerClaimCooldowns isOfficer={isOfficer} isSiteAdmin={isSiteAdmin} profile={profile} /></RequireOfficer></RequireAuth>} />
        <Route path="/officer/raider-activity" element={<RequireAuth session={session}><RequireOfficer isOfficer={isOfficer}><OfficerRaiderActivity isOfficer={isOfficer} /></RequireOfficer></RequireAuth>} />
        <Route path="/tools/discord-schedule" element={<RequireAuth session={session}><DiscordSchedule /></RequireAuth>} />
        <Route path="/loot" element={<RequireAuth session={session}><LootSearch /></RequireAuth>} />
        <Route path="/loot-recipients" element={<RequireAuth session={session}><LootRecipients /></RequireAuth>} />
        <Route path="/mobs" element={<RequireAuth session={session}><MobLoot /></RequireAuth>} />
        <Route path="/accounts" element={<RequireAuth session={session}><Accounts profile={profile} /></RequireAuth>} />
        <Route path="/accounts/:accountId" element={<RequireAuth session={session}><AccountDetail isOfficer={isOfficer} profile={profile} session={session} onProfileUpdate={() => session?.user?.id && fetchProfile(session.user.id)} /></RequireAuth>} />
        <Route path="/profile" element={<RequireAuth session={session}><Profile profile={profile} onProfileUpdate={() => session?.user?.id && fetchProfile(session.user.id)} /></RequireAuth>} />
        <Route path="/items/:itemNameEncoded" element={<RequireAuth session={session}><ItemPage isOfficer={isOfficer} /></RequireAuth>} />
        <Route path="/characters/:charKey" element={<RequireAuth session={session}><CharacterPage /></RequireAuth>} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      <Analytics />
    </SiteChrome>
    </RouteScrollProvider>
    </AmbianceRoot>
    </PageStateUserProvider>
  )
}
