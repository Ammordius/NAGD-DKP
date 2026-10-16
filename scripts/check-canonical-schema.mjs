/**
 * Fail when a new SQL file is a schema entry point, or when a deployment
 * document tells the reader to run archived SQL as a required schema step.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const skipDirs = new Set(['node_modules', '.git', 'dist'])

const deploymentDocs = [
  'README.md',
  'web/README.md',
  'docs/SCHEMA_DEPLOYMENT.md',
  'docs/SCHEMA_RPC_INDEX.md',
  'docs/SCHEMA_AUDIT.md',
  'docs/SETUP-WALKTHROUGH.md',
  'docs/RESTORE-BACKUP.md',
  'docs/MIRROR-SETUP-FULL-STACK.md',
  'docs/CI-DB-RESTORE.md',
  'docs/CI-DB-BACKUP.md',
  'docs/EVENT-TIME-BACKFILL.md',
  'docs/AUTH-AND-EGRESS-PROTECTION.md',
  'docs/LOOT-TO-CHARACTER.md',
  'docs/DKP-GROUND-TRUTH.md',
]

function walk(dir, found = []) {
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, found)
    else if (name.endsWith('.sql')) found.push(relative(root, path).replaceAll('\\', '/'))
  }
  return found
}

function allowedSql(path) {
  return path === 'docs/supabase-schema-full.sql'
    || path === 'docs/full-db-hosted-inventory.sql'
    || path.startsWith('docs/sql-archive/')
    || path.startsWith('web/test/pg/')
}

const errors = []
for (const path of walk(root)) {
  if (!allowedSql(path)) errors.push(`SQL file is not the canonical schema, the archive, or a test fixture: ${path}`)
}

const verb = /\b(run|apply|execute|required)\b/i
const excused = /\b(do not|don't|never|not a schema|not an upgrade|archived|historical|provenance)\b/i

for (const doc of deploymentDocs) {
  const text = readFileSync(join(root, doc), 'utf8')
  const lines = text.split(/\n/)
  lines.forEach((line, index) => {
    const files = line.match(/[\w./-]+\.sql/g) || []
    const other = files.filter((file) => !file.endsWith('supabase-schema-full.sql'))
    if (other.length === 0) return
    if (verb.test(line) && !excused.test(line)) {
      errors.push(`${doc}:${index + 1} treats ${other.join(', ')} as a schema step`)
    }
  })
}

if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exit(1)
}

console.log('Canonical schema layout check passed')
