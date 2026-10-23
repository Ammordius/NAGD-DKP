import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { clientServiceRoleError } from './clientServiceRole.js'

describe('clientServiceRoleError', () => {
  it('allows a build that does not set the Vite-prefixed service role', () => {
    assert.equal(clientServiceRoleError({}), '')
    assert.equal(clientServiceRoleError({ VITE_SUPABASE_SERVICE_ROLE_KEY: '   ' }), '')
    assert.equal(clientServiceRoleError({ SUPABASE_SERVICE_ROLE_KEY: 'secret' }), '')
  })

  it('rejects a Vite-prefixed service role key', () => {
    const message = clientServiceRoleError({ VITE_SUPABASE_SERVICE_ROLE_KEY: 'eyJsecret' })
    assert.match(message, /VITE_SUPABASE_SERVICE_ROLE_KEY must not be set/)
  })
})
