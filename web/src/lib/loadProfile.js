import { safeGetSession, sessionLooksPresent } from './authSession.js'
import {
  formatProfileLoadDebug,
  formatProfileLoadUserMessage,
  isTransientProfileFailure,
  sanitizeProfileLoadError,
} from './profileLoadError.js'

const PROFILE_SELECT = 'role, account_id, unclaim_cooldown_until, display_name, ui_preferences'

/**
 * @param {{
 *   from: (table: string) => {
 *     select: (cols: string) => {
 *       eq: (col: string, val: string) => {
 *         single: () => Promise<{ data?: unknown, error?: unknown, status?: number }>
 *       }
 *     }
 *   },
 *   auth: { getSession: () => Promise<unknown> }
 * }} client
 * @param {string} userId
 * @param {{
 *   supabaseUrl?: string,
 *   operation?: import('./profileLoadError.js').ProfileLoadOperation,
 *   sessionExpected?: boolean,
 *   allowAutoRetry?: boolean,
 *   delayMs?: (ms: number) => Promise<void>,
 * }} [options]
 */
export async function loadProfileForUser(client, userId, options = {}) {
  const {
    supabaseUrl = '',
    operation = 'initial',
    sessionExpected = true,
    allowAutoRetry = true,
    delayMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options

  const attempt = async (op) => {
    const { data, error, status } = await client
      .from('profiles')
      .select(PROFILE_SELECT)
      .eq('id', userId)
      .single()

    if (!error) {
      return { ok: true, profile: data, diagnostic: null, userMessage: null, debugLine: null }
    }

    const { session } = await safeGetSession(client)
    const sessionPresent = sessionLooksPresent(session)
    const info = sanitizeProfileLoadError(error, {
      userId,
      supabaseUrl,
      httpStatus: status,
      operation: op,
      sessionExpected,
      sessionPresent,
    })
    return {
      ok: false,
      profile: null,
      diagnostic: info,
      userMessage: formatProfileLoadUserMessage(info),
      debugLine: formatProfileLoadDebug(info),
      canAutoRetry: isTransientProfileFailure(info),
    }
  }

  let result = await attempt(operation)
  if (result.ok) return result

  if (allowAutoRetry && result.canAutoRetry) {
    await delayMs(400)
    result = await attempt('auto-retry')
    if (result.ok) return result
  }

  return {
    ok: false,
    profile: null,
    diagnostic: result.diagnostic,
    userMessage: result.userMessage,
    debugLine: result.debugLine,
  }
}
