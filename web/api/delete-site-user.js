/**
 * Server-only. Deletes a site user's auth account with the service role.
 * Never import this module from browser code, and never prefix
 * SUPABASE_SERVICE_ROLE_KEY with VITE_.
 */
import { createClient } from '@supabase/supabase-js'
import { removalBlockReason } from '../src/lib/siteAdminRemoveUser.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function send(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function header(req, name) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] || ''
  return value || ''
}

function readJsonBody(req) {
  if (req.body != null && req.body !== '') {
    if (typeof req.body === 'string') return JSON.parse(req.body)
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(req.body)) {
      const text = req.body.toString('utf8').trim()
      return text ? JSON.parse(text) : {}
    }
    if (typeof req.body === 'object') return req.body
  }
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function apiBase(supabaseUrl) {
  return String(supabaseUrl || '').replace(/\/$/, '')
}

async function fetchJson(fetchImpl, url, options) {
  const res = await fetchImpl(url, options)
  const text = await res.text()
  let body = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  return { ok: res.ok, status: res.status, body }
}

/**
 * Authorize the signed-in officer or site admin, delete the profile row, then
 * delete the auth user. Game accounts and characters are not touched.
 */
export async function removeSiteAuthUser({
  accessToken,
  profileId,
  supabaseUrl,
  anonKey,
  serviceRoleKey,
  fetchImpl = fetch,
  deleteAuthUser,
}) {
  if (!accessToken) return { status: 401, body: { error: 'Not authenticated' } }
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return { status: 500, body: { error: 'Server is missing Supabase configuration' } }
  }
  const targetId = String(profileId || '').trim()
  if (!UUID_RE.test(targetId)) return { status: 400, body: { error: 'Profile is required' } }

  const base = apiBase(supabaseUrl)
  const userHeaders = {
    apikey: anonKey,
    Authorization: `Bearer ${accessToken}`,
  }

  const authRes = await fetchJson(fetchImpl, `${base}/auth/v1/user`, { headers: userHeaders })
  const actorId = authRes.body?.id
  if (!authRes.ok || !actorId) return { status: 401, body: { error: 'Not authenticated' } }
  if (String(actorId).toLowerCase() === targetId.toLowerCase()) {
    return { status: 403, body: { error: 'You cannot remove yourself' } }
  }

  async function loadProfile(id) {
    const url = new URL(`${base}/rest/v1/profiles`)
    url.searchParams.set('id', `eq.${id}`)
    url.searchParams.set('select', 'id,role')
    const res = await fetchJson(fetchImpl, url, { headers: { ...userHeaders, Accept: 'application/json' } })
    if (!res.ok) {
      const message = res.body?.message || 'Could not read profiles'
      return { error: { status: res.status >= 500 ? 502 : 403, message } }
    }
    const row = Array.isArray(res.body) ? res.body[0] : null
    return { row: row || null }
  }

  const actorLoaded = await loadProfile(actorId)
  if (actorLoaded.error) return { status: actorLoaded.error.status, body: { error: actorLoaded.error.message } }
  const actorRole = String(actorLoaded.row?.role || '').trim().toLowerCase()
  const targetLoaded = await loadProfile(targetId)
  if (targetLoaded.error) return { status: targetLoaded.error.status, body: { error: targetLoaded.error.message } }

  // The profile row is removed before the auth user. If that second step failed,
  // a site admin can run Remove user again and delete the leftover login.
  let authUserId = targetLoaded.row?.id || targetId
  if (!targetLoaded.row) {
    if (actorRole !== 'siteadmin') return { status: 404, body: { error: 'Profile not found' } }
  } else {
    const reason = removalBlockReason(
      { id: actorId, role: actorLoaded.row?.role },
      { id: targetLoaded.row.id, role: targetLoaded.row.role }
    )
    if (reason) return { status: 403, body: { error: reason } }

    const rpcRes = await fetchJson(fetchImpl, `${base}/rest/v1/rpc/siteadmin_delete_user`, {
      method: 'POST',
      headers: { ...userHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_profile_id: targetLoaded.row.id }),
    })
    if (!rpcRes.ok) {
      const message = rpcRes.body?.message || 'Could not remove user'
      return { status: rpcRes.status >= 500 ? 502 : 403, body: { error: message } }
    }
    authUserId = targetLoaded.row.id
  }

  const removeAuth = deleteAuthUser || (async (userId) => {
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    return supabaseAdmin.auth.admin.deleteUser(userId)
  })

  let deleted
  try {
    deleted = await removeAuth(authUserId)
  } catch (err) {
    return { status: 502, body: { error: err?.message || 'Could not delete the login account' } }
  }
  const deleteErr = deleted?.error
  if (deleteErr && deleteErr.status !== 404 && !/user not found/i.test(deleteErr.message || '')) {
    const detail = deleteErr.message || 'Could not delete the login account'
    return {
      status: 502,
      body: { error: `The site profile was removed, but the login could not be deleted (${detail}). A site admin can run Remove user again to delete the login.` },
    }
  }
  return { status: 200, body: { ok: true } }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    send(res, 405, { error: 'Method not allowed' })
    return
  }
  const token = header(req, 'authorization').replace(/^Bearer\s+/i, '').trim()
  let body
  try {
    body = await readJsonBody(req)
  } catch {
    send(res, 400, { error: 'Invalid request' })
    return
  }
  const result = await removeSiteAuthUser({
    accessToken: token,
    profileId: body?.profileId,
    supabaseUrl: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  })
  send(res, result.status, result.body)
}
