import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatProfileLoadDebug, sanitizeProfileLoadError } from './profileLoadError.js'

describe('sanitizeProfileLoadError', () => {
  it('keeps PostgREST code/message/details/hint and truncates user id', () => {
    const info = sanitizeProfileLoadError(
      {
        code: 'PGRST116',
        message: 'JSON object requested, multiple (or no) rows returned',
        details: 'Results contain 0 rows',
        hint: 'Check the row exists',
      },
      { userId: 'abcdef12-3456-7890-abcd-ef1234567890', supabaseUrl: 'https://xyz.supabase.co' },
    )
    assert.equal(info.code, 'PGRST116')
    assert.equal(info.message, 'JSON object requested, multiple (or no) rows returned')
    assert.equal(info.details, 'Results contain 0 rows')
    assert.equal(info.hint, 'Check the row exists')
    assert.equal(info.userIdPrefix, 'abcdef12')
    assert.equal(info.supabaseHost, 'xyz.supabase.co')
  })

  it('uses hostname only from supabase URL', () => {
    const info = sanitizeProfileLoadError(
      { message: 'Failed to fetch' },
      { supabaseUrl: 'https://abc123.supabase.co/rest/v1/profiles?id=eq.1' },
    )
    assert.equal(info.supabaseHost, 'abc123.supabase.co')
  })

  it('drops JWT-like and key-like strings', () => {
    const info = sanitizeProfileLoadError({
      code: '401',
      message: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.sig',
      details: 'sb_secret_abc',
      hint: 'sk_live_should_not_appear',
    })
    assert.equal(info.code, '401')
    assert.equal(info.message, '')
    assert.equal(info.details, '')
    assert.equal(info.hint, '')
  })

  it('handles plain Error and missing fields', () => {
    const info = sanitizeProfileLoadError(new Error('network down'))
    assert.equal(info.code, '')
    assert.equal(info.message, 'network down')
    assert.equal(info.userIdPrefix, '')
    assert.equal(info.supabaseHost, '')
  })
})

describe('formatProfileLoadDebug', () => {
  it('formats PGRST116 with context for screenshots', () => {
    const text = formatProfileLoadDebug(
      sanitizeProfileLoadError(
        {
          code: 'PGRST116',
          message: 'JSON object requested, multiple (or no) rows returned',
        },
        { userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', supabaseUrl: 'https://proj.supabase.co' },
      ),
    )
    assert.match(text, /^Profile read failed: PGRST116 — JSON object requested/)
    assert.match(text, /user: aaaaaaaa…/)
    assert.match(text, /host: proj\.supabase\.co/)
  })

  it('falls back when only a message exists', () => {
    assert.equal(
      formatProfileLoadDebug(sanitizeProfileLoadError({ message: 'Failed to fetch' })),
      'Profile read failed: Failed to fetch',
    )
  })
})
