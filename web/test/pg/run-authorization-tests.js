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

async function assertReapplyPreservesRows() {
  const keeper = '77777777-7777-4777-8777-777777777777'
  await psql(`
INSERT INTO auth.users (id, email) VALUES ('${keeper}', 'upgrade-keep@example.com');
UPDATE public.profiles SET display_name = 'Kept Player' WHERE id = '${keeper}';
INSERT INTO public.accounts (account_id, display_name) VALUES ('acct-upgrade', 'Upgrade Account');
INSERT INTO public.characters (char_id, name) VALUES ('char-upgrade', 'Upgrade');
INSERT INTO public.character_account (char_id, account_id) VALUES ('char-upgrade', 'acct-upgrade');
INSERT INTO public.raids (raid_id, raid_name, date_iso) VALUES ('raid-upgrade', 'Upgrade Raid', '2026-01-01');
INSERT INTO public.raid_events (raid_id, event_id, event_order, event_name, dkp_value, event_time)
VALUES ('raid-upgrade', 'evt-upgrade', 1, 'Named', '1', '9:00 pm');
INSERT INTO public.raid_loot (raid_id, event_id, item_name, char_id, character_name, cost)
VALUES ('raid-upgrade', 'evt-upgrade', 'Upgrade Item', 'char-upgrade', 'Upgrade', '1');
INSERT INTO public.raid_event_attendance (raid_id, event_id, char_id, character_name, account_id)
VALUES ('raid-upgrade', 'evt-upgrade', 'char-upgrade', 'Upgrade', 'acct-upgrade');
`)
  const snapshotSql = `
SELECT json_build_object(
  'accounts', (SELECT count(*) FROM public.accounts),
  'characters', (SELECT count(*) FROM public.characters),
  'links', (SELECT count(*) FROM public.character_account),
  'raids', (SELECT count(*) FROM public.raids),
  'events', (SELECT count(*) FROM public.raid_events),
  'loot', (SELECT count(*) FROM public.raid_loot),
  'attendance', (SELECT count(*) FROM public.raid_event_attendance),
  'profiles', (SELECT count(*) FROM public.profiles),
  'account_name', (SELECT display_name FROM public.accounts WHERE account_id = 'acct-upgrade'),
  'profile_name', (SELECT display_name FROM public.profiles WHERE id = '${keeper}'),
  'profile_role', (SELECT role FROM public.profiles WHERE id = '${keeper}'),
  'item', (SELECT item_name FROM public.raid_loot WHERE raid_id = 'raid-upgrade'),
  'event_time', (SELECT event_time FROM public.raid_events WHERE raid_id = 'raid-upgrade' AND event_id = 'evt-upgrade'),
  'att_account', (SELECT account_id FROM public.raid_event_attendance WHERE raid_id = 'raid-upgrade'),
  'loot_cost', (SELECT cost FROM public.raid_loot WHERE raid_id = 'raid-upgrade')
)::text
`
  const before = (await psql(snapshotSql)).trim()
  await psql(readFileSync(join(repoRoot, 'docs', 'supabase-schema-full.sql'), 'utf8'))
  const after = (await psql(snapshotSql)).trim()
  if (before !== after) {
    throw new Error(`Re-applying the schema changed populated rows.\nBefore: ${before}\nAfter: ${after}`)
  }
  const grants = await psql(`
SELECT to_regprocedure('public.update_raid_event_times(jsonb)') IS NOT NULL AS exists,
       has_function_privilege('anon', 'public.update_raid_event_times(jsonb)', 'EXECUTE') AS anon_exec,
       has_function_privilege('service_role', 'public.update_raid_event_times(jsonb)', 'EXECUTE') AS service_exec
`)
  if (!/t\s*\|\s*f\s*\|\s*t/.test(grants.replace(/\s+/g, ' '))) {
    throw new Error(`update_raid_event_times grants were not service_role only:\n${grants}`)
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
  await assertReapplyPreservesRows()
  await psql(readFileSync(join(here, 'dkp-calculation.sql'), 'utf8'))
  console.log('PostgreSQL authorization and DKP calculation tests passed')
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
