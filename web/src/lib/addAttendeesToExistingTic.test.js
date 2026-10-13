import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const sql = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../docs/supabase-schema-full.sql'),
  'utf8',
)

function functionBody(source) {
  const start = source.indexOf('CREATE OR REPLACE FUNCTION public.add_attendees_to_existing_tic')
  const end = source.indexOf('REVOKE ALL ON FUNCTION public.add_attendees_to_existing_tic')
  assert.ok(start >= 0 && end > start)
  return source.slice(start, end)
}

describe('add_attendees_to_existing_tic migration', () => {
  const body = functionBody(sql)

  it('rejects anyone who is not an officer before it writes', () => {
    const officerAt = body.indexOf('IF NOT public.is_officer()')
    const insertAt = body.search(/INSERT\s+INTO\s+raid_event_attendance/i)
    assert.ok(officerAt >= 0)
    assert.ok(insertAt > officerAt)
    assert.match(body, /RAISE EXCEPTION 'Only officers can add attendees to tics'/)
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.add_attendees_to_existing_tic\(TEXT, TEXT, JSONB\) FROM PUBLIC/)
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.add_attendees_to_existing_tic\(TEXT, TEXT, JSONB\) TO authenticated/)
  })

  it('does not disable triggers or rebuild the ledger', () => {
    assert.equal(/DISABLE TRIGGER/i.test(body), false)
    assert.equal(/refresh_dkp_summary/i.test(body), false)
    assert.equal(/begin_restore_load/i.test(body), false)
    assert.equal(/\bdkp_value\b/i.test(body), false)
    assert.equal(/\bevent_time\b/i.test(body), false)
    assert.equal(/DELETE\s+FROM/i.test(body), false)
    assert.equal(/raid_loot/i.test(body), false)
  })

  it('inserts only missing attendees and reports added versus already present', () => {
    assert.match(body, /'added'/)
    assert.match(body, /'already_present'/)
    assert.match(body, /'skipped_same_account'/)
    assert.match(body, /'invalid'/)
    assert.match(body, /SET attendee_count/)
    assert.match(body, /WHERE NOT EXISTS/)
    assert.equal(/UPDATE\s+raid_events[\s\S]*dkp_value/i.test(body), false)
  })
})
