import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { safeGetSession } from '../lib/authSession'
import { safeNextPath } from '../lib/safeNextPath'
import { supabase } from '../lib/supabase'

export default function AuthCallback({ session }) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const next = safeNextPath(searchParams.get('next'))

  useEffect(() => {
    const oauthError = searchParams.get('error_description') || searchParams.get('error')
    if (oauthError) {
      navigate(`/login?error=${encodeURIComponent(oauthError)}`, { replace: true })
      return
    }

    if (session) {
      navigate(next, { replace: true })
      return
    }

    let settled = false
    const go = (sess) => {
      if (settled) return
      settled = true
      if (sess) navigate(next, { replace: true })
      else navigate('/login?error=' + encodeURIComponent('Discord sign-in failed. Try again.'), { replace: true })
    }

    safeGetSession(supabase).then(({ session: sess, error }) => {
      if (error) console.warn('[auth/callback/getSession]', error?.message || error)
      if (sess) go(sess)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, sess) => {
      if (sess) go(sess)
    })

    const timeout = setTimeout(() => {
      if (!settled) go(null)
    }, 10000)

    return () => {
      settled = true
      subscription?.unsubscribe()
      clearTimeout(timeout)
    }
  }, [session, next, navigate, searchParams])

  return (
    <div className="container" style={{ paddingTop: '2rem', textAlign: 'center' }}>
      Signing in…
    </div>
  )
}
