/**
 * Sanitize a profiles-read failure for UI and console.
 * Never include tokens, anon/service keys, or full session objects.
 */

const JWT_LIKE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/
const KEY_LIKE = /^(sk_|sb_publishable_|sb_secret_)/i

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

/**
 * @param {unknown} err
 * @param {{ userId?: string, supabaseUrl?: string }} [context]
 */
export function sanitizeProfileLoadError(err, context = {}) {
  const source = err && typeof err === 'object' ? err : { message: err }
  return {
    code: safeText(source.code, 64),
    message: safeText(source.message, 200),
    details: safeText(source.details, 200),
    hint: safeText(source.hint, 200),
    userIdPrefix: userIdPrefix(context.userId),
    supabaseHost: supabaseHostFromUrl(context.supabaseUrl),
  }
}

/**
 * @param {ReturnType<typeof sanitizeProfileLoadError>} info
 */
export function formatProfileLoadDebug(info) {
  const parts = []
  if (info.code) parts.push(info.code)
  if (info.message) parts.push(info.message)
  else if (!info.code) parts.push('unknown error')
  if (info.details) parts.push(`details: ${info.details}`)
  if (info.hint) parts.push(`hint: ${info.hint}`)
  if (info.userIdPrefix) parts.push(`user: ${info.userIdPrefix}…`)
  if (info.supabaseHost) parts.push(`host: ${info.supabaseHost}`)
  return `Profile read failed: ${parts.join(' — ')}`
}
