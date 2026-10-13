import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import deleteSiteUser from './api/delete-site-user.js'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

function applyServerEnv(mode) {
  const webEnv = loadEnv(mode, rootDir, '')
  const repoEnv = loadEnv(mode, path.resolve(rootDir, '..'), '')
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
  return {
    plugins: [
      react(),
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
