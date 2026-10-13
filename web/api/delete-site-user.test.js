import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import handler, { removeSiteAuthUser } from './delete-site-user.js'

const ACTOR = '55555555-5555-5555-5555-555555555555'
const TARGET = '11111111-1111-1111-1111-111111111111'
const OTHER_ADMIN = '66666666-6666-6666-6666-666666666666'
const OFFICER = '33333333-3333-3333-3333-333333333333'

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body == null ? '' : JSON.stringify(body)),
  }
}

function mockFetch({ actorRole = 'siteadmin', targetRole = 'player', targetId = TARGET, rpcStatus = 200, missingTarget = false }) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const href = String(url)
    calls.push({ href, options })
    if (href.endsWith('/auth/v1/user')) return jsonResponse(200, { id: ACTOR })
    if (href.includes('/rest/v1/profiles')) {
      const id = new URL(href).searchParams.get('id') || ''
      if (id.includes(ACTOR)) return jsonResponse(200, [{ id: ACTOR, role: actorRole }])
      if (!missingTarget && id.toLowerCase().includes(targetId.toLowerCase())) {
        return jsonResponse(200, [{ id: targetId, role: targetRole }])
      }
      return jsonResponse(200, [])
    }
    if (href.endsWith('/rest/v1/rpc/siteadmin_delete_user')) {
      if (rpcStatus >= 400) return jsonResponse(rpcStatus, { message: 'Profile not found' })
      return jsonResponse(rpcStatus, null)
    }
    throw new Error(`unexpected url ${href}`)
  }
  return { fetchImpl, calls }
}

const baseArgs = {
  supabaseUrl: 'https://example.supabase.co',
  anonKey: 'anon-key',
  serviceRoleKey: 'service-role-key',
}

describe('removeSiteAuthUser', () => {
  it('lets an officer remove a player', async () => {
    const { fetchImpl } = mockFetch({ actorRole: 'officer', targetRole: 'player' })
    const deleted = []
    const result = await removeSiteAuthUser({
      ...baseArgs,
      accessToken: 'user-jwt',
      profileId: TARGET,
      fetchImpl,
      deleteAuthUser: async (userId) => {
        deleted.push(userId)
        return { error: null }
      },
    })
    assert.equal(result.status, 200)
    assert.deepEqual(deleted, [TARGET])
  })

  it('deletes the profile, then the auth user', async () => {
    const { fetchImpl, calls } = mockFetch({})
    const deleted = []
    const result = await removeSiteAuthUser({
      ...baseArgs,
      accessToken: 'user-jwt',
      profileId: TARGET,
      fetchImpl,
      deleteAuthUser: async (userId) => {
        deleted.push(userId)
        return { data: { user: { id: userId } }, error: null }
      },
    })
    assert.deepEqual(result, { status: 200, body: { ok: true } })
    assert.deepEqual(deleted, [TARGET])
    const rpc = calls.find((call) => call.href.endsWith('/rest/v1/rpc/siteadmin_delete_user'))
    assert.equal(rpc.options.headers.Authorization, 'Bearer user-jwt')
    assert.equal(rpc.options.headers.apikey, 'anon-key')
    assert.equal(JSON.parse(rpc.options.body).p_profile_id, TARGET)
    assert.equal(calls.some((call) => String(call.options?.headers?.apikey) === 'service-role-key'), false)
  })

  it('does not delete the auth user when the profile delete is refused', async () => {
    const { fetchImpl } = mockFetch({ rpcStatus: 400 })
    let called = false
    const result = await removeSiteAuthUser({
      ...baseArgs,
      accessToken: 'user-jwt',
      profileId: TARGET,
      fetchImpl,
      deleteAuthUser: async () => {
        called = true
        return { error: null }
      },
    })
    assert.equal(result.status, 403)
    assert.equal(result.body.error, 'Profile not found')
    assert.equal(called, false)
  })

  it('refuses site admins, officers, and self without deleting', async () => {
    const cases = [
      { actorRole: 'siteadmin', targetRole: 'siteadmin', targetId: OTHER_ADMIN, error: 'Site admins cannot be removed' },
      { actorRole: 'officer', targetRole: 'officer', targetId: OFFICER, error: 'Officers cannot remove other officers' },
      { actorRole: 'officer', targetRole: 'siteadmin', targetId: OTHER_ADMIN, error: 'Site admins cannot be removed' },
    ]
    for (const item of cases) {
      const { fetchImpl } = mockFetch(item)
      let called = false
      const result = await removeSiteAuthUser({
        ...baseArgs,
        accessToken: 'user-jwt',
        profileId: item.targetId,
        fetchImpl,
        deleteAuthUser: async () => {
          called = true
          return { error: null }
        },
      })
      assert.equal(result.status, 403)
      assert.equal(result.body.error, item.error)
      assert.equal(called, false)
    }
  })

  it('refuses self removal before any profile write', async () => {
    const { fetchImpl, calls } = mockFetch({})
    const result = await removeSiteAuthUser({
      ...baseArgs,
      accessToken: 'user-jwt',
      profileId: ACTOR,
      fetchImpl,
      deleteAuthUser: async () => ({ error: null }),
    })
    assert.equal(result.status, 403)
    assert.equal(result.body.error, 'You cannot remove yourself')
    assert.equal(calls.some((call) => call.href.includes('siteadmin_delete_user')), false)
  })

  it('lets a site admin delete a leftover login when the profile is already gone', async () => {
    const orphan = '99999999-9999-9999-9999-999999999999'
    const { fetchImpl, calls } = mockFetch({ actorRole: 'siteadmin', targetId: orphan, missingTarget: true })
    const deleted = []
    const result = await removeSiteAuthUser({
      ...baseArgs,
      accessToken: 'user-jwt',
      profileId: orphan,
      fetchImpl,
      deleteAuthUser: async (userId) => {
        deleted.push(userId)
        return { error: null }
      },
    })
    assert.equal(result.status, 200)
    assert.deepEqual(deleted, [orphan])
    assert.equal(calls.some((call) => call.href.includes('siteadmin_delete_user')), false)
  })

  it('does not let an officer delete a login that has no profile', async () => {
    const orphan = '99999999-9999-9999-9999-999999999999'
    const { fetchImpl } = mockFetch({ actorRole: 'officer', targetId: orphan, missingTarget: true })
    let called = false
    const result = await removeSiteAuthUser({
      ...baseArgs,
      accessToken: 'user-jwt',
      profileId: orphan,
      fetchImpl,
      deleteAuthUser: async () => {
        called = true
        return { error: null }
      },
    })
    assert.equal(result.status, 404)
    assert.equal(called, false)
  })

  it('does not put the service role key in an error', async () => {
    const { fetchImpl } = mockFetch({})
    const result = await removeSiteAuthUser({
      ...baseArgs,
      accessToken: 'user-jwt',
      profileId: TARGET,
      fetchImpl,
      deleteAuthUser: async () => ({ error: { message: 'delete failed', status: 500 } }),
    })
    assert.equal(result.status, 502)
    assert.equal(JSON.stringify(result).includes('service-role-key'), false)
  })
})

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[key] = value },
    end(payload) { this.body = payload },
  }
}

describe('delete-site-user handler', () => {
  it('rejects non-POST', async () => {
    const res = mockRes()
    await handler({ method: 'GET', headers: {}, body: {} }, res)
    assert.equal(res.statusCode, 405)
  })

  it('rejects a missing token', async () => {
    const res = mockRes()
    await handler({ method: 'POST', headers: {}, body: { profileId: TARGET } }, res)
    assert.equal(res.statusCode, 401)
    assert.equal(JSON.parse(res.body).error, 'Not authenticated')
  })

  it('reports missing server configuration without calling auth', async () => {
    const previous = {
      url: process.env.SUPABASE_URL,
      viteUrl: process.env.VITE_SUPABASE_URL,
      anon: process.env.SUPABASE_ANON_KEY,
      viteAnon: process.env.VITE_SUPABASE_ANON_KEY,
      service: process.env.SUPABASE_SERVICE_ROLE_KEY,
    }
    delete process.env.SUPABASE_URL
    delete process.env.VITE_SUPABASE_URL
    delete process.env.SUPABASE_ANON_KEY
    delete process.env.VITE_SUPABASE_ANON_KEY
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    try {
      const res = mockRes()
      await handler({
        method: 'POST',
        headers: { authorization: 'Bearer token' },
        body: { profileId: TARGET },
      }, res)
      assert.equal(res.statusCode, 500)
      assert.equal(JSON.parse(res.body).error, 'Server is missing Supabase configuration')
    } finally {
      for (const [key, value] of Object.entries({
        SUPABASE_URL: previous.url,
        VITE_SUPABASE_URL: previous.viteUrl,
        SUPABASE_ANON_KEY: previous.anon,
        VITE_SUPABASE_ANON_KEY: previous.viteAnon,
        SUPABASE_SERVICE_ROLE_KEY: previous.service,
      })) {
        if (value == null) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
