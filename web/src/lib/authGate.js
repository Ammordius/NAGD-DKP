/**
 * How the signed-in shell should react to a Supabase auth event.
 *
 * Returning to a browser tab makes auth-js recover the session and emit
 * SIGNED_IN (or TOKEN_REFRESHED) for the same user. That is not a new login.
 * Reloading the profile or flipping the app loading gate unmounts every page.
 *
 * @param {{ event: string, session: { user?: { id?: string } } | null, loadedUserId: string | null, pendingUserId: string | null }} input
 * @returns {{ action: 'ignore' } | { action: 'sign-out' } | { action: 'load-profile', userId: string }}
 */
export function nextAuthGate({ event, session, loadedUserId, pendingUserId }) {
  const userId = session?.user?.id ? String(session.user.id) : ''
  if (!userId) {
    if (event === 'SIGNED_OUT') return { action: 'sign-out' }
    // First check found nobody. A later null event must not sign out a user
    // we already accepted — tab recovery can emit one.
    if ((event === 'INITIAL_SESSION' || event === 'GET_SESSION') && !loadedUserId && !pendingUserId) {
      return { action: 'sign-out' }
    }
    return { action: 'ignore' }
  }
  if (loadedUserId === userId || pendingUserId === userId) return { action: 'ignore' }
  return { action: 'load-profile', userId }
}
