/**
 * Thin wrappers so auth promise rejections become handled results
 * instead of unhandled rejections in the UI.
 */

/**
 * @param {{ auth: { getSession: () => Promise<{ data?: { session?: unknown }, error?: unknown }> } }} client
 * @returns {Promise<{ session: object | null, error: unknown | null }>}
 */
export async function safeGetSession(client) {
  try {
    const { data, error } = await client.auth.getSession()
    if (error) return { session: null, error }
    return { session: data?.session ?? null, error: null }
  } catch (error) {
    return { session: null, error }
  }
}

/**
 * @param {{ auth: { signOut: () => Promise<{ error?: unknown }> } }} client
 * @returns {Promise<{ ok: boolean, error: unknown | null }>}
 */
export async function safeSignOut(client) {
  try {
    const { error } = await client.auth.signOut()
    if (error) return { ok: false, error }
    return { ok: true, error: null }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * Whether a session object looks usable for an authenticated REST call.
 * Does not inspect or return token values.
 * @param {unknown} session
 */
export function sessionLooksPresent(session) {
  if (!session || typeof session !== 'object') return false
  const userId = session.user?.id
  const hasToken = typeof session.access_token === 'string' && session.access_token.length > 0
  return Boolean(userId) && hasToken
}
