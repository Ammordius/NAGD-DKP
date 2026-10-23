import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const dir = dirname(fileURLToPath(import.meta.url))
const vercel = JSON.parse(readFileSync(join(dir, '../../vercel.json'), 'utf8'))

describe('CSP headers', () => {
  it('keeps hardening and allows the guild class-rankings host', () => {
    const csp = vercel.headers
      ?.flatMap((h) => h.headers || [])
      ?.find((h) => h.key === 'Content-Security-Policy')
      ?.value
    assert.ok(csp, 'Content-Security-Policy header missing')
    assert.match(csp, /default-src 'self'/)
    assert.match(csp, /connect-src[^;]*https:\/\/\*\.supabase\.co/)
    assert.match(csp, /connect-src[^;]*wss:\/\/\*\.supabase\.co/)
    assert.match(csp, /connect-src[^;]*https:\/\/va\.vercel-scripts\.com/)
    assert.match(csp, /connect-src[^;]*https:\/\/ammordius\.github\.io/)
    assert.doesNotMatch(csp, /connect-src[^;]*\s\*/)
  })
})
