import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { nextAuthGate } from './authGate.js'

const session = { user: { id: 'user-1' } }

describe('nextAuthGate', () => {
  it('loads the profile once for a new session', () => {
    assert.deepEqual(
      nextAuthGate({ event: 'INITIAL_SESSION', session, loadedUserId: null, pendingUserId: null }),
      { action: 'load-profile', userId: 'user-1' },
    )
    assert.deepEqual(
      nextAuthGate({ event: 'GET_SESSION', session, loadedUserId: null, pendingUserId: null }),
      { action: 'load-profile', userId: 'user-1' },
    )
  })

  it('ignores the same user when a tab becomes visible again', () => {
    for (const event of ['SIGNED_IN', 'TOKEN_REFRESHED', 'INITIAL_SESSION', 'USER_UPDATED']) {
      assert.deepEqual(
        nextAuthGate({ event, session, loadedUserId: 'user-1', pendingUserId: null }),
        { action: 'ignore' },
      )
    }
  })

  it('does not start a second profile load while the first is in flight', () => {
    assert.deepEqual(
      nextAuthGate({ event: 'SIGNED_IN', session, loadedUserId: null, pendingUserId: 'user-1' }),
      { action: 'ignore' },
    )
  })

  it('loads again when a different user signs in', () => {
    assert.deepEqual(
      nextAuthGate({
        event: 'SIGNED_IN',
        session: { user: { id: 'user-2' } },
        loadedUserId: 'user-1',
        pendingUserId: null,
      }),
      { action: 'load-profile', userId: 'user-2' },
    )
  })

  it('signs out only on a real sign-out or an initial empty session', () => {
    assert.deepEqual(
      nextAuthGate({ event: 'SIGNED_OUT', session: null, loadedUserId: 'user-1', pendingUserId: null }),
      { action: 'sign-out' },
    )
    assert.deepEqual(
      nextAuthGate({ event: 'GET_SESSION', session: null, loadedUserId: null, pendingUserId: null }),
      { action: 'sign-out' },
    )
    assert.deepEqual(
      nextAuthGate({ event: 'INITIAL_SESSION', session: null, loadedUserId: null, pendingUserId: null }),
      { action: 'sign-out' },
    )
  })

  it('keeps the current page when a null session arrives after login', () => {
    assert.deepEqual(
      nextAuthGate({ event: 'SIGNED_IN', session: null, loadedUserId: 'user-1', pendingUserId: null }),
      { action: 'ignore' },
    )
    assert.deepEqual(
      nextAuthGate({ event: 'INITIAL_SESSION', session: null, loadedUserId: null, pendingUserId: 'user-1' }),
      { action: 'ignore' },
    )
  })
})
