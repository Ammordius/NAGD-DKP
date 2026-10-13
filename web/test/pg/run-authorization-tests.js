/**
 * Disposable Postgres checks for grants, RLS, and RPC authorization.
 * Set DKP_PG_TEST=1 to fail when Docker is unavailable. Otherwise a missing
 * Docker daemon skips the suite and says the database behavior is unverified.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const container = `nagddkp-authz-${process.pid}`
const required = process.env.DKP_PG_TEST === '1'
const admin1 = '33333333-3333-4333-8333-333333333333'
const admin2 = '44444444-4444-4444-8444-444444444444'

function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    if (input != null) child.stdin.end(input)
    else child.stdin.end()
  })
}

async function dockerAvailable() {
  const result = await run('docker', ['info'])
  return result.code === 0
}

async function psql(sql) {
  const result = await run(
    'docker',
    ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
    sql
  )
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `psql exited ${result.code}`)
  }
  return result.stdout
}

async function psqlAllowFail(sql) {
  return run(
    'docker',
    ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
    sql
  )
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForPostgres() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await run('docker', [
      'exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-c', 'SELECT 1',
    ])
    if (result.code === 0) return
    await sleep(1000)
  }
  throw new Error('Postgres did not become ready')
}

async function waitForHeldLock() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await psqlAllowFail(`
SELECT 1
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
JOIN pg_class c ON c.oid = l.relation
WHERE c.relname = 'profiles'
  AND l.granted
  AND a.query LIKE '%_demote_holding_lock%'
`)
    if (result.code === 0 && /^\s*1\s*$/m.test(result.stdout)) return
    await sleep(250)
  }
  throw new Error('Timed out waiting for the site-admin row lock')
}

async function concurrentDemotion() {
  const hold = `SELECT public._demote_holding_lock('${admin1}'::uuid, '${admin2}'::uuid);`
  const challenger = `
SET statement_timeout = '20s';
SET SESSION AUTHORIZATION authenticated;
SELECT set_config('request.jwt.claim.sub', '${admin2}', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT public.siteadmin_set_role('${admin1}'::uuid, 'officer');
`
  const first = psqlAllowFail(hold)
  await waitForHeldLock()
  const second = await psqlAllowFail(challenger)
  const firstResult = await first
  if (firstResult.code !== 0) {
    throw new Error(`Lock holder failed to demote the other site admin:\n${firstResult.stderr}`)
  }
  if (second.code === 0) {
    throw new Error('Concurrent demotion removed both site admins')
  }
  const count = await psql("SELECT count(*) FROM public.profiles WHERE role = 'siteadmin'")
  if (!/^\s*1\s*$/m.test(count)) {
    throw new Error(`Expected one site admin after concurrent demotion, got:\n${count}`)
  }
  const still = await psql(
    `SELECT role FROM public.profiles WHERE id = '${admin1}'`
  )
  if (!/siteadmin/.test(still)) {
    throw new Error(`The lock holder was demoted:\n${still}`)
  }
}

async function main() {
  if (!(await dockerAvailable())) {
    const message = 'PostgreSQL authorization tests were not run (Docker is unavailable). Database grants, RLS, and RPC checks are unverified.'
    if (required) {
      console.error(message)
      process.exit(1)
    }
    console.warn(message)
    return
  }

  await run('docker', ['rm', '-f', container])
  const started = await run('docker', [
    'run', '-d', '--name', container,
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
    '-e', 'POSTGRES_PASSWORD=postgres',
    'postgres:16',
  ])
  if (started.code !== 0) {
    throw new Error(started.stderr || 'could not start Postgres')
  }
  await waitForPostgres()
  await psql(readFileSync(join(here, 'auth-stub.sql'), 'utf8'))
  await psql(readFileSync(join(repoRoot, 'docs', 'supabase-schema-full.sql'), 'utf8'))
  await psql(readFileSync(join(here, 'assertions.sql'), 'utf8'))
  await concurrentDemotion()
  console.log('PostgreSQL authorization tests passed')
}

try {
  await main()
} catch (err) {
  console.error(err?.message || err)
  process.exitCode = 1
} finally {
  if (await dockerAvailable()) {
    await run('docker', ['rm', '-f', container])
  }
}
