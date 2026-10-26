import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadProfileForUser } from './loadProfile.js'

function mockClient({ query, session }) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                single: async () => query(),
              }
            },
          }
        },
      }
    },
    auth: {
      getSession: async () => ({ data: { session: session ?? null }, error: null }),
    },
  }
}

describe('loadProfileForUser', () => {
  it('returns profile on success', async () => {
    const profile = { role: 'player', display_name: 'A' }
    const result = await loadProfileForUser(
      mockClient({ query: () => ({ data: profile, error: null, status: 200 }) }),
      'user-1',
      { supabaseUrl: 'https://proj.supabase.co', allowAutoRetry: false },
    )
    assert.equal(result.ok, true)
    assert.deepEqual(result.profile, profile)
  })

  it('classifies zero-row / 406 with session present', async () => {
    const result = await loadProfileForUser(
      mockClient({
        query: () => ({
          data: null,
          error: {
            code: 'PGRST116',
            message: 'JSON object requested, multiple (or no) rows returned',
            details: 'Results contain 0 rows',
          },
          status: 406,
        }),
        session: { user: { id: 'user-1' }, access_token: 'tok' },
      }),
      'user-1',
      { supabaseUrl: 'https://proj.supabase.co', operation: 'initial', allowAutoRetry: false },
    )
    assert.equal(result.ok, false)
    assert.equal(result.diagnostic.code, 'PGRST116')
    assert.equal(result.diagnostic.httpStatus, 406)
    assert.equal(result.diagnostic.sessionPresent, true)
    assert.match(result.userMessage, /no usable profile row/)
    assert.match(result.debugLine, /AUTH-PROFILE-406-PGRST116-SESS/)
  })

  it('classifies RLS-like empty result when session is missing', async () => {
    const result = await loadProfileForUser(
      mockClient({
        query: () => ({
          data: null,
          error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
          status: 406,
        }),
        session: null,
      }),
      'user-1',
      { allowAutoRetry: false },
    )
    assert.equal(result.diagnostic.sessionPresent, false)
    assert.match(result.userMessage, /session is missing or expired/)
    assert.match(result.debugLine, /AUTH-PROFILE-406-PGRST116-NOSESS/)
  })

  it('auto-retries once for transient network failure then recovers', async () => {
    let calls = 0
    const delays = []
    const profile = { role: 'officer', display_name: 'O' }
    const client = mockClient({
      query: () => {
        calls += 1
        if (calls === 1) {
          return { data: null, error: { message: 'Failed to fetch' }, status: undefined }
        }
        return { data: profile, error: null, status: 200 }
      },
      session: { user: { id: 'user-1' }, access_token: 'tok' },
    })
    const result = await loadProfileForUser(client, 'user-1', {
      allowAutoRetry: true,
      delayMs: async (ms) => { delays.push(ms) },
    })
    assert.equal(calls, 2)
    assert.deepEqual(delays, [400])
    assert.equal(result.ok, true)
    assert.deepEqual(result.profile, profile)
  })

  it('does not auto-retry PGRST116', async () => {
    let calls = 0
    const result = await loadProfileForUser(
      mockClient({
        query: () => {
          calls += 1
          return {
            data: null,
            error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
            status: 406,
          }
        },
        session: { user: { id: 'user-1' }, access_token: 'tok' },
      }),
      'user-1',
      {
        allowAutoRetry: true,
        delayMs: async () => { throw new Error('should not delay') },
      },
    )
    assert.equal(calls, 1)
    assert.equal(result.ok, false)
    assert.equal(result.diagnostic.code, 'PGRST116')
  })
})
