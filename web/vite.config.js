import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import deleteSiteUser from './api/delete-site-user.js'
import { clientServiceRoleError } from './src/lib/clientServiceRole.js'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SITE_TITLE = 'NAGD DKP - Development'

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function resolveSiteTitle(mode) {
  const webEnv = loadEnv(mode, rootDir, '')
  const repoEnv = loadEnv(mode, path.resolve(rootDir, '..'), '')
  const value = (process.env.VITE_SITE_TITLE || webEnv.VITE_SITE_TITLE || repoEnv.VITE_SITE_TITLE || '').trim()
  return value || DEFAULT_SITE_TITLE
}

function applyServerEnv(mode) {
  const webEnv = loadEnv(mode, rootDir, '')
  const repoEnv = loadEnv(mode, path.resolve(rootDir, '..'), '')
  const serviceRoleError = clientServiceRoleError({
    VITE_SUPABASE_SERVICE_ROLE_KEY:
      process.env.VITE_SUPABASE_SERVICE_ROLE_KEY
      || webEnv.VITE_SUPABASE_SERVICE_ROLE_KEY
      || repoEnv.VITE_SUPABASE_SERVICE_ROLE_KEY,
  })
  if (serviceRoleError) throw new Error(serviceRoleError)
  const keys = [
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'VITE_SUPABASE_URL',
    'VITE_SUPABASE_ANON_KEY',
  ]
  for (const key of keys) {
    const value = webEnv[key] || repoEnv[key]
    if (!process.env[key] && value) process.env[key] = value
  }
}

export default defineConfig(({ mode }) => {
  applyServerEnv(mode)
  const title = resolveSiteTitle(mode)
  if (!(process.env.VITE_SITE_TITLE || '').trim()) process.env.VITE_SITE_TITLE = title
  return {
    plugins: [
      react(),
      {
        name: 'site-title-html',
        transformIndexHtml: {
          order: 'post',
          handler(html) {
            return html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`)
          },
        },
      },
      {
        name: 'delete-site-user-api',
        configureServer(server) {
          server.middlewares.use('/api/delete-site-user', (req, res) => {
            Promise.resolve(deleteSiteUser(req, res)).catch((err) => {
              console.error('delete-site-user failed', err?.message || err)
              if (res.headersSent) return
              res.statusCode = 500
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Could not remove user' }))
            })
          })
        },
      },
    ],
  }
})
