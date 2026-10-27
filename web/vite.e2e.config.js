import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: path.join(rootDir, 'e2e/harness'),
  publicDir: path.join(rootDir, 'e2e/public'),
  plugins: [
    {
      name: 'supabase-mock',
      enforce: 'pre',
      resolveId(source) {
        const normalized = source.replaceAll('\\', '/')
        // Match relative imports used across pages (`../lib/supabase`) and libs (`./supabase`).
        if (
          normalized === '../lib/supabase' ||
          normalized === './supabase' ||
          normalized === './supabase.js' ||
          normalized.endsWith('/lib/supabase') ||
          normalized.endsWith('/lib/supabase.js') ||
          normalized.endsWith('/supabase.js') ||
          /(^|\/)supabase$/.test(normalized)
        ) {
          return path.join(rootDir, 'e2e/harness/supabaseMock.js')
        }
        return null
      },
    },
    react(),
  ],
  server: {
    host: '127.0.0.1',
    port: 4178,
    strictPort: true,
  },
})
