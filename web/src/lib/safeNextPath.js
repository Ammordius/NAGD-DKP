/**
 * Same-origin path for post-login navigation.
 * Rejects protocol-relative URLs and backslash forms that browsers treat as `//host`.
 */
export function safeNextPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return '/'
  if (value[0] !== '/' || value[1] === '/' || value[1] === '\\') return '/'
  if (/[\u0000-\u001F\u007F\\]/.test(value)) return '/'
  if (/%5c|%2f%2f/i.test(value)) return '/'
  return value
}
