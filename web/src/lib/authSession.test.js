import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { safeGetSession, safeSignOut, sessionLooksPresent } from './authSession.js'

describe('sessionLooksPresent', () => {
  it('requires user id and access_token without exposing them', () => {
    assert.equal(sessionLooksPresent(null), false)
    assert.equal(sessionLooksPresent({}), false)
    assert.equal(sessionLooksPresent({ user: { id: 'u1' } }), false)
    assert.equal(sessionLooksPresent({ user: { id: 'u1' }, access_token: 'tok' }), true)
  })
})

describe('safeGetSession', () => {
  it('returns session on success', async () => {
    const session = { user: { id: 'u1' }, access_token: 'tok' }
    const client = {
      auth: {
        getSession: async () => ({ data: { session }, error: null }),
      },
    }
    assert.deepEqual(await safeGetSession(client), { session, error: null })
  })

  it('swallows thrown errors and auth errors', async () => {
    const boom = new Error('lock busy')
    assert.deepEqual(
      await safeGetSession({ auth: { getSession: async () => { throw boom } } }),
      { session: null, error: boom },
    )
    const authErr = { message: 'nope' }
    assert.deepEqual(
      await safeGetSession({ auth: { getSession: async () => ({ data: { session: null }, error: authErr }) } }),
      { session: null, error: authErr },
    )
  })
})

describe('safeSignOut', () => {
  it('reports ok or error without throwing', async () => {
    assert.deepEqual(
      await safeSignOut({ auth: { signOut: async () => ({ error: null }) } }),
      { ok: true, error: null },
    )
    const err = new Error('sign out failed')
    assert.deepEqual(
      await safeSignOut({ auth: { signOut: async () => { throw err } } }),
      { ok: false, error: err },
    )
    const apiErr = { message: 'denied' }
    assert.deepEqual(
      await safeSignOut({ auth: { signOut: async () => ({ error: apiErr }) } }),
      { ok: false, error: apiErr },
    )
  })
})
