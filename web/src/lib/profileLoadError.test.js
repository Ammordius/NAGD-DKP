import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatProfileLoadDebug,
  formatProfileLoadUserMessage,
  isTransientProfileFailure,
  profileLoadReportCode,
  sanitizeProfileLoadError,
} from './profileLoadError.js'

describe('sanitizeProfileLoadError', () => {
  it('keeps PostgREST code/message/details/hint and truncates user id', () => {
    const info = sanitizeProfileLoadError(
      {
        code: 'PGRST116',
        message: 'JSON object requested, multiple (or no) rows returned',
        details: 'Results contain 0 rows',
        hint: 'Check the row exists',
      },
      {
        userId: 'abcdef12-3456-7890-abcd-ef1234567890',
        supabaseUrl: 'https://xyz.supabase.co',
        httpStatus: 406,
        operation: 'initial',
        sessionExpected: true,
        sessionPresent: true,
      },
    )
    assert.equal(info.code, 'PGRST116')
    assert.equal(info.message, 'JSON object requested, multiple (or no) rows returned')
    assert.equal(info.details, 'Results contain 0 rows')
    assert.equal(info.hint, 'Check the row exists')
    assert.equal(info.httpStatus, 406)
    assert.equal(info.operation, 'initial')
    assert.equal(info.sessionExpected, true)
    assert.equal(info.sessionPresent, true)
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
    assert.equal(info.sessionPresent, null)
    assert.equal(info.operation, 'initial')
  })
})

describe('profileLoadReportCode', () => {
  it('encodes 406 / PGRST116 with session present', () => {
    assert.equal(
      profileLoadReportCode(
        sanitizeProfileLoadError(
          { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
          { httpStatus: 406, sessionPresent: true },
        ),
      ),
      'AUTH-PROFILE-406-PGRST116-SESS',
    )
  })

  it('encodes missing session and network failures', () => {
    assert.equal(
      profileLoadReportCode(
        sanitizeProfileLoadError(
          { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
          { httpStatus: 406, sessionPresent: false },
        ),
      ),
      'AUTH-PROFILE-406-PGRST116-NOSESS',
    )
    assert.equal(
      profileLoadReportCode(
        sanitizeProfileLoadError(
          { message: 'Failed to fetch' },
          { sessionPresent: true },
        ),
      ),
      'AUTH-PROFILE-NA-NET-SESS',
    )
  })
})

describe('isTransientProfileFailure', () => {
  it('treats network and 5xx as transient, not PGRST116', () => {
    assert.equal(
      isTransientProfileFailure(sanitizeProfileLoadError({ message: 'Failed to fetch' })),
      true,
    )
    assert.equal(
      isTransientProfileFailure(sanitizeProfileLoadError({ message: 'boom' }, { httpStatus: 503 })),
      true,
    )
    assert.equal(
      isTransientProfileFailure(
        sanitizeProfileLoadError({ code: 'PGRST116', message: 'JSON object requested' }, { httpStatus: 406 }),
      ),
      false,
    )
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
        {
          userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          supabaseUrl: 'https://proj.supabase.co',
          httpStatus: 406,
          operation: 'initial',
          sessionPresent: true,
        },
      ),
    )
    assert.match(text, /^Profile read failed: AUTH-PROFILE-406-PGRST116-SESS/)
    assert.match(text, /op: initial/)
    assert.match(text, /http: 406/)
    assert.match(text, /session: present/)
    assert.match(text, /user: aaaaaaaa…/)
    assert.match(text, /host: proj\.supabase\.co/)
  })

  it('falls back when only a message exists', () => {
    const text = formatProfileLoadDebug(sanitizeProfileLoadError({ message: 'Failed to fetch' }))
    assert.match(text, /^Profile read failed: AUTH-PROFILE-NA-NET-UNK/)
    assert.match(text, /Failed to fetch/)
  })
})

describe('formatProfileLoadUserMessage', () => {
  it('distinguishes missing session, missing profile, and network', () => {
    assert.match(
      formatProfileLoadUserMessage(
        sanitizeProfileLoadError(
          { code: 'PGRST116', message: 'JSON object requested' },
          { httpStatus: 406, sessionPresent: false },
        ),
      ),
      /session is missing or expired.*AUTH-PROFILE-406-PGRST116-NOSESS/,
    )
    assert.match(
      formatProfileLoadUserMessage(
        sanitizeProfileLoadError(
          { code: 'PGRST116', message: 'JSON object requested' },
          { httpStatus: 406, sessionPresent: true },
        ),
      ),
      /no usable profile row.*AUTH-PROFILE-406-PGRST116-SESS/,
    )
    assert.match(
      formatProfileLoadUserMessage(
        sanitizeProfileLoadError({ message: 'Failed to fetch' }, { sessionPresent: true }),
      ),
      /temporary network error.*AUTH-PROFILE-NA-NET-SESS/,
    )
  })
})
