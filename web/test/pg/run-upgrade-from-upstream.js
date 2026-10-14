/**
 * Upgrade a populated database from origin/main's schema file.
 * Disposable Postgres only. Does not read DATABASE_URL or contact Supabase.
 *
 * origin/main (442f99afe) already installs from docs/supabase-schema-full.sql
 * and drops raid_loot assignment columns at the end of that file. This script
 * applies that file, loads rows, puts the assignment columns back so the
 * copy-then-drop path still runs, then applies the current canonical file twice.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const upstream = '442f99afe73422fdd27edf3ee3a2edb8a064af95'
const container = `nagddkp-upgrade-${process.pid}`
const kept = '11111111-1111-4111-8111-111111111111'
const discord = '88888888-8888-4888-8888-888888888888'
const plain = '99999999-9999-4999-8999-999999999999'

function run(command, args, input, cwd = repoRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function psql(sql, singleTransaction = false) {
  const args = ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
  if (singleTransaction) args.push('--single-transaction')
  const result = await run('docker', args, sql)
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `psql exited ${result.code}`)
  }
  return result.stdout
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

const seedSql = `
INSERT INTO auth.users (id, email, raw_user_meta_data, raw_app_meta_data) VALUES
  ('${kept}', 'kept@example.com', '{}'::jsonb, '{}'::jsonb),
  ('${discord}', 'blank@example.com', '{"full_name":"Blank Discord"}'::jsonb, '{"provider":"discord"}'::jsonb),
  ('${plain}', 'plain@example.com', '{}'::jsonb, '{}'::jsonb);

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS display_name TEXT;
UPDATE public.profiles SET display_name = 'Kept Player', role = 'officer' WHERE id = '${kept}';

INSERT INTO public.accounts (account_id, display_name) VALUES
  ('acct-live', 'Live Account'),
  ('acct-stale', 'Stale Account');
INSERT INTO public.characters (char_id, name) VALUES
  ('char-up', 'Up Char'),
  ('char-stale', 'Stale Char'),
  ('char-move', 'Move Name'),
  ('char-keep', 'Keep Name'),
  ('char-column', 'Column Name');
INSERT INTO public.character_account (char_id, account_id) VALUES
  ('char-up', 'acct-live'),
  ('char-stale', 'acct-stale');

INSERT INTO public.raids (raid_id, raid_name, date_iso) VALUES
  ('raid-up', 'Upgrade Raid', '2026-01-01'),
  ('raid-stale', 'Stale Raid', '2026-01-02');
INSERT INTO public.raid_events (raid_id, event_id, event_order, event_name, dkp_value, event_time) VALUES
  ('raid-up', 'evt-up', 1, 'Named', '4', '9:00 pm'),
  ('raid-stale', 'evt-stale', 1, 'Named', '1', '9:00 pm');
INSERT INTO public.raid_event_attendance (raid_id, event_id, char_id, character_name, account_id) VALUES
  ('raid-up', 'evt-up', 'char-up', 'Up Char', 'acct-live'),
  ('raid-stale', 'evt-stale', 'char-stale', 'Stale Char', 'acct-stale');
INSERT INTO public.raid_loot (raid_id, event_id, item_name, char_id, character_name, cost) VALUES
  ('raid-up', 'evt-up', 'Move Item', 'char-up', 'Up Char', '2'),
  ('raid-up', 'evt-up', 'Keep Item', 'char-up', 'Up Char', '3');

ALTER TABLE public.raid_loot ADD COLUMN IF NOT EXISTS assigned_char_id TEXT;
ALTER TABLE public.raid_loot ADD COLUMN IF NOT EXISTS assigned_character_name TEXT;
ALTER TABLE public.raid_loot ADD COLUMN IF NOT EXISTS assigned_via_magelo SMALLINT;
UPDATE public.raid_loot
SET assigned_char_id = 'char-move', assigned_character_name = 'Move Name', assigned_via_magelo = 1
WHERE item_name = 'Move Item';
UPDATE public.raid_loot
SET assigned_char_id = 'char-column', assigned_character_name = 'Column Name', assigned_via_magelo = 0
WHERE item_name = 'Keep Item';
INSERT INTO public.loot_assignment (loot_id, assigned_char_id, assigned_character_name, assigned_via_magelo)
SELECT id, 'char-keep', 'Keep Name', 1
FROM public.raid_loot WHERE item_name = 'Keep Item';

UPDATE public.account_dkp_summary SET earned = 999 WHERE account_id = 'acct-stale';
`

const snapshotSql = `
SELECT json_build_object(
  'accounts', (SELECT count(*) FROM public.accounts),
  'characters', (SELECT count(*) FROM public.characters),
  'links', (SELECT count(*) FROM public.character_account),
  'raids', (SELECT count(*) FROM public.raids),
  'events', (SELECT count(*) FROM public.raid_events),
  'loot', (SELECT count(*) FROM public.raid_loot),
  'attendance', (SELECT count(*) FROM public.raid_event_attendance),
  'live_earned', (SELECT earned FROM public.account_dkp_summary WHERE account_id = 'acct-live'),
  'live_spent', (SELECT spent FROM public.account_dkp_summary WHERE account_id = 'acct-live'),
  'stale_earned', (SELECT earned FROM public.account_dkp_summary WHERE account_id = 'acct-stale'),
  'link', (SELECT account_id FROM public.character_account WHERE char_id = 'char-up'),
  'loot_items', (
    SELECT jsonb_agg(jsonb_build_object('item', item_name, 'cost', cost) ORDER BY item_name)
    FROM public.raid_loot
  ),
  'kept_name', (SELECT display_name FROM public.profiles WHERE id = '${kept}'),
  'kept_role', (SELECT role FROM public.profiles WHERE id = '${kept}'),
  'plain_name', (SELECT display_name FROM public.profiles WHERE id = '${plain}'),
  'discord_name', (SELECT display_name FROM public.profiles WHERE id = '${discord}'),
  'move_assign', (
    SELECT la.assigned_char_id FROM public.loot_assignment la
    JOIN public.raid_loot rl ON rl.id = la.loot_id WHERE rl.item_name = 'Move Item'
  ),
  'keep_assign', (
    SELECT la.assigned_char_id FROM public.loot_assignment la
    JOIN public.raid_loot rl ON rl.id = la.loot_id WHERE rl.item_name = 'Keep Item'
  ),
  'assign_cols', (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'raid_loot' AND column_name = 'assigned_char_id'
  ),
  'restore_rows', (SELECT count(*) FROM public.restore_in_progress),
  'event_time', (SELECT event_time FROM public.raid_events WHERE raid_id = 'raid-up' AND event_id = 'evt-up')
)::text
`

function parseSnapshot(stdout) {
  const line = stdout.split(/\r?\n/).map((row) => row.trim()).find((row) => row.startsWith('{'))
  if (!line) throw new Error(`No snapshot JSON in psql output:\n${stdout}`)
  return JSON.parse(line)
}

async function main() {
  const docker = await run('docker', ['info'])
  if (docker.code !== 0) {
    throw new Error('Docker is unavailable. The upstream schema upgrade was not run.')
  }

  const shown = await run('git', ['show', `${upstream}:docs/supabase-schema-full.sql`], null)
  if (shown.code !== 0 || !shown.stdout.includes('CREATE TABLE')) {
    throw new Error(shown.stderr || 'Could not read the upstream schema file')
  }

  await run('docker', ['rm', '-f', container])
  const started = await run('docker', [
    'run', '-d', '--name', container,
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
    '-e', 'POSTGRES_PASSWORD=postgres',
    'postgres:16',
  ])
  if (started.code !== 0) throw new Error(started.stderr || 'could not start Postgres')
  await waitForPostgres()

  await psql(readFileSync(join(here, 'auth-stub.sql'), 'utf8'))
  await psql(shown.stdout, true)
  await psql(seedSql)
  const before = parseSnapshot(await psql(snapshotSql))

  if (before.assign_cols !== 1) {
    throw new Error(`Expected assignment columns on raid_loot before upgrade, got ${before.assign_cols}`)
  }
  if (before.discord_name !== null) {
    throw new Error(`Blank Discord name was already set: ${before.discord_name}`)
  }
  if (before.kept_name !== 'Kept Player' || before.kept_role !== 'officer') {
    throw new Error(`Kept profile was not seeded: ${before.kept_name} ${before.kept_role}`)
  }
  if (before.keep_assign !== 'char-keep') {
    throw new Error(`Existing assignment was not seeded: ${before.keep_assign}`)
  }
  if (before.move_assign !== null) {
    throw new Error(`Move Item already had an assignment row: ${before.move_assign}`)
  }

  const canonical = readFileSync(join(repoRoot, 'docs', 'supabase-schema-full.sql'), 'utf8')
  await psql(canonical, true)
  const after = parseSnapshot(await psql(snapshotSql))

  const sameKeys = [
    'accounts', 'characters', 'links', 'raids', 'events', 'loot', 'attendance',
    'live_earned', 'live_spent', 'stale_earned', 'link', 'loot_items',
    'kept_name', 'kept_role', 'plain_name', 'restore_rows', 'event_time',
  ]
  for (const key of sameKeys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      throw new Error(`Upgrade changed ${key}.\nBefore: ${JSON.stringify(before[key])}\nAfter: ${JSON.stringify(after[key])}`)
    }
  }
  if (after.discord_name !== 'Blank Discord') {
    throw new Error(`Blank Discord display name was not filled: ${after.discord_name}`)
  }
  if (after.move_assign !== 'char-move') {
    throw new Error(`Assignment column was not copied: ${after.move_assign}`)
  }
  if (after.keep_assign !== 'char-keep') {
    throw new Error(`Existing assignment was overwritten: ${after.keep_assign}`)
  }
  if (after.assign_cols !== 0) {
    throw new Error('raid_loot.assigned_char_id was not dropped')
  }
  if (String(after.stale_earned) !== '999') {
    throw new Error(`Upgrade recalculated a stale balance: ${after.stale_earned}`)
  }

  await psql(canonical, true)
  const again = parseSnapshot(await psql(snapshotSql))
  if (JSON.stringify(after) !== JSON.stringify(again)) {
    throw new Error(`Second apply changed populated rows.\nFirst: ${JSON.stringify(after)}\nSecond: ${JSON.stringify(again)}`)
  }

  const grants = await psql(`
SELECT p.proname,
       has_function_privilege('anon', p.oid, 'execute') AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') AS auth_exec
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('truncate_dkp_for_restore', 'update_raid_event_times', 'siteadmin_delete_user', 'refresh_dkp_summary')
ORDER BY 1
`)
  if (!/siteadmin_delete_user\s+\|\s+f\s+\|\s+t/.test(grants.replace(/\s+/g, ' '))) {
    throw new Error(`siteadmin_delete_user grants were not authenticated-only:\n${grants}`)
  }
  if (!/truncate_dkp_for_restore\s+\|\s+f\s+\|\s+f/.test(grants.replace(/\s+/g, ' '))) {
    throw new Error(`truncate_dkp_for_restore is still executable by a browser role:\n${grants}`)
  }
  if (!/update_raid_event_times\s+\|\s+f\s+\|\s+f/.test(grants.replace(/\s+/g, ' '))) {
    throw new Error(`update_raid_event_times is still executable by a browser role:\n${grants}`)
  }

  console.log('Upstream schema upgrade preserved populated rows and applied cleanly a second time')
  console.log(`Before: ${JSON.stringify(before)}`)
  console.log(`After: ${JSON.stringify(after)}`)
}

try {
  await main()
} catch (err) {
  console.error(err?.message || err)
  process.exitCode = 1
} finally {
  await run('docker', ['rm', '-f', container])
}
