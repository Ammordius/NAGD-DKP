/**
 * Sanitize a profiles-read failure for UI and console.
 * Never include tokens, anon/service keys, or full session objects.
 */

const JWT_LIKE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/
const KEY_LIKE = /^(sk_|sb_publishable_|sb_secret_)/i

/** @typedef {'initial' | 'retry' | 'refresh' | 'auto-retry'} ProfileLoadOperation */

function safeText(value, max = 200) {
  if (value == null) return ''
  const text = String(value).trim()
  if (!text) return ''
  if (JWT_LIKE.test(text) || KEY_LIKE.test(text)) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function supabaseHostFromUrl(supabaseUrl) {
  if (typeof supabaseUrl !== 'string' || !supabaseUrl.trim()) return ''
  try {
    return new URL(supabaseUrl).hostname || ''
  } catch {
    return ''
  }
}

function userIdPrefix(userId) {
  if (typeof userId !== 'string' || !userId) return ''
  return userId.slice(0, 8)
}

function normalizeHttpStatus(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 100 || n > 599) return null
  return Math.trunc(n)
}

/**
 * True for failures that often recover after a short wait (not PGRST116 / missing row).
 * @param {{ code?: string, message?: string, httpStatus?: number | null }} info
 */
export function isTransientProfileFailure(info) {
  const status = normalizeHttpStatus(info?.httpStatus)
  if (status != null && status >= 500 && status <= 599) return true
  const code = String(info?.code || '')
  if (code === 'PGRST116') return false
  const message = String(info?.message || '').toLowerCase()
  if (!message) return false
  return (
    message.includes('failed to fetch')
    || message.includes('networkerror')
    || message.includes('network request failed')
    || message.includes('load failed')
    || message.includes('fetch failed')
    || message.includes('timeout')
    || message.includes('timed out')
  )
}

/**
 * Short code users can report. No secrets.
 * Examples: AUTH-PROFILE-406-PGRST116-SESS, AUTH-PROFILE-NET-NOSESS
 * @param {ReturnType<typeof sanitizeProfileLoadError>} info
 */
export function profileLoadReportCode(info) {
  const status = normalizeHttpStatus(info.httpStatus)
  const statusPart = status != null ? String(status) : 'NA'
  let kind = 'ERR'
  if (info.code === 'PGRST116' || status === 406) kind = info.code || 'PGRST116'
  else if (isTransientProfileFailure(info)) kind = 'NET'
  else if (info.code) kind = safeText(info.code, 24).replace(/[^A-Za-z0-9_-]/g, '') || 'ERR'
  const sess = info.sessionPresent === true ? 'SESS' : info.sessionPresent === false ? 'NOSESS' : 'UNK'
  return `AUTH-PROFILE-${statusPart}-${kind}-${sess}`
}

/**
 * @param {unknown} err
 * @param {{
 *   userId?: string,
 *   supabaseUrl?: string,
 *   httpStatus?: number | null,
 *   operation?: ProfileLoadOperation,
 *   sessionExpected?: boolean,
 *   sessionPresent?: boolean | null,
 * }} [context]
 */
export function sanitizeProfileLoadError(err, context = {}) {
  const source = err && typeof err === 'object' ? err : { message: err }
  const httpStatus = normalizeHttpStatus(
    context.httpStatus != null ? context.httpStatus : source.status ?? source.statusCode,
  )
  return {
    operation: safeText(context.operation, 32) || 'initial',
    httpStatus,
    code: safeText(source.code, 64),
    message: safeText(source.message, 200),
    details: safeText(source.details, 200),
    hint: safeText(source.hint, 200),
    sessionExpected: context.sessionExpected !== false,
    sessionPresent: typeof context.sessionPresent === 'boolean' ? context.sessionPresent : null,
    userIdPrefix: userIdPrefix(context.userId),
    supabaseHost: supabaseHostFromUrl(context.supabaseUrl),
  }
}

/**
 * @param {ReturnType<typeof sanitizeProfileLoadError>} info
 */
export function formatProfileLoadDebug(info) {
  const parts = []
  const report = profileLoadReportCode(info)
  parts.push(report)
  if (info.operation) parts.push(`op: ${info.operation}`)
  if (info.httpStatus != null) parts.push(`http: ${info.httpStatus}`)
  if (info.code) parts.push(info.code)
  if (info.message) parts.push(info.message)
  else if (!info.code) parts.push('unknown error')
  if (info.details) parts.push(`details: ${info.details}`)
  if (info.hint) parts.push(`hint: ${info.hint}`)
  if (info.sessionExpected) {
    if (info.sessionPresent === true) parts.push('session: present')
    else if (info.sessionPresent === false) parts.push('session: missing')
    else parts.push('session: unknown')
  }
  if (info.userIdPrefix) parts.push(`user: ${info.userIdPrefix}…`)
  if (info.supabaseHost) parts.push(`host: ${info.supabaseHost}`)
  return `Profile read failed: ${parts.join(' — ')}`
}

/**
 * User-facing line: friendly text + report code only.
 * @param {ReturnType<typeof sanitizeProfileLoadError>} info
 */
export function formatProfileLoadUserMessage(info) {
  const code = profileLoadReportCode(info)
  if (info.code === 'PGRST116' || info.httpStatus === 406) {
    if (info.sessionPresent === false) {
      return `Your sign-in session is missing or expired. Sign in again. (${code})`
    }
    return `Your account signed in, but no usable profile row was returned. An officer can check whether your profile exists. (${code})`
  }
  if (isTransientProfileFailure(info)) {
    return `A temporary network error blocked loading your profile. Try again. (${code})`
  }
  return `Could not load your profile. (${code})`
}
