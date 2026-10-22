import { useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { safeNextPath } from '../lib/safeNextPath'
import { supabase } from '../lib/supabase'
import { siteTitle } from '../lib/siteTitle'

export default function Login({ session }) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const redirectTo = safeNextPath(searchParams.get('redirect'))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState(searchParams.get('error') || '')
  const [loading, setLoading] = useState(false)
  const [isSignUp, setIsSignUp] = useState(false)

  if (session) {
    return <Navigate to={redirectTo} replace />
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (isSignUp) {
        const name = displayName.trim()
        if (!name || name.length > 32) {
          setError('Display name must be 1-32 characters')
          return
        }
        const { error: err } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { display_name: name } },
        })
        if (err) throw err
        setError('Check your email to confirm sign up, then sign in.')
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password })
        if (err) throw err
        navigate(redirectTo, { replace: true })
      }
    } catch (err) {
      setError(err.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  async function handleDiscord() {
    setError('')
    setLoading(true)
    try {
      const { error: err } = await supabase.auth.signInWithOAuth({
        provider: 'discord',
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(redirectTo)}`,
          scopes: 'identify email',
        },
      })
      if (err) throw err
    } catch (err) {
      setError(err.message || 'Something went wrong')
      setLoading(false)
    }
  }

  return (
    <div className="container" style={{ maxWidth: 360, paddingTop: '3rem' }}>
      <div className="card">
        <h1 style={{ marginTop: 0 }}>{siteTitle()}</h1>
        <p style={{ color: '#71717a', marginBottom: '1.5rem' }}>
          {isSignUp ? 'Create an account' : 'Sign in'}
        </p>
        {error && <div className="error" style={{ marginBottom: '1rem' }}>{error}</div>}
        <button
          type="button"
          className="btn btn-discord"
          disabled={loading}
          onClick={handleDiscord}
          style={{ width: '100%' }}
        >
          {loading ? '…' : 'Continue with Discord'}
        </button>
        <p style={{ color: '#71717a', textAlign: 'center', margin: '1rem 0' }}>or</p>
        <form onSubmit={handleSubmit}>
          {isSignUp && (
            <div className="form-group">
              <label>Display Name</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="How you should appear on the site"
                required
                maxLength={32}
                autoComplete="nickname"
              />
            </div>
          )}
          <div className="form-group">
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
            />
          </div>
          <button type="submit" className="btn" disabled={loading} style={{ width: '100%', marginTop: '0.5rem' }}>
            {loading ? '…' : isSignUp ? 'Sign up' : 'Sign in'}
          </button>
        </form>
        {import.meta.env.VITE_ALLOW_SIGNUP !== 'false' && (
          <button
            type="button"
            className="btn btn-ghost"
            style={{ marginTop: '1rem', width: '100%' }}
            onClick={() => { setIsSignUp((v) => !v); setError(''); }}
          >
            {isSignUp ? 'Already have an account? Sign in' : 'Need an account? Sign up'}
          </button>
        )}
        {import.meta.env.VITE_ALLOW_SIGNUP === 'false' && (
          <p style={{ marginTop: '1rem', color: '#71717a', fontSize: '0.9rem' }}>
            New users must be invited by an officer.
          </p>
        )}
      </div>
    </div>
  )
}
