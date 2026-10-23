import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { accountsForInput, charactersForInput } from './activeRoster.js'
import { fetchRaidDetail } from './fetchRaidDetail.js'

const dir = dirname(fileURLToPath(import.meta.url))

describe('officer roster and raid detail review', () => {
  it('hides inactive accounts for new entry while keeping unlinked characters available', () => {
    const accounts = [
      { account_id: 'a1', inactive: false },
      { account_id: 'a2', inactive: true },
    ]
    assert.deepEqual(accountsForInput(accounts).map((a) => a.account_id), ['a1'])
    const characters = [
      { char_id: 'c1', name: 'Active' },
      { char_id: 'c2', name: 'Unlinked' },
      { char_id: 'c3', name: 'OnlyInactive' },
    ]
    const links = [
      { char_id: 'c1', account_id: 'a1' },
      { char_id: 'c3', account_id: 'a2' },
    ]
    const forInput = charactersForInput(characters, links, accounts)
    const ids = forInput.map((c) => c.char_id).sort()
    assert.deepEqual(ids, ['c1', 'c2'])
  })

  it('keeps fetchRaidDetail read-only on view', async () => {
    const calls = []
    const client = {
      from(table) {
        calls.push(table)
        const q = {
          select() { return q },
          eq() { return q },
          order() { return q },
          maybeSingle: async () => ({ data: { raid_id: 'r1', attendees: '0' }, error: null }),
          then: undefined,
        }
        // supabase-js style: await on builder for list queries
        q.then = (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject)
        return q
      },
    }
    await fetchRaidDetail(client, 'r1')
    assert.ok(calls.includes('raids'))
    assert.ok(!calls.some((t) => t === 'update'))
    const raidDetailSrc = readFileSync(join(dir, '../pages/RaidDetail.jsx'), 'utf8')
    assert.doesNotMatch(raidDetailSrc, /\.from\('raids'\)\.update/)
    assert.doesNotMatch(raidDetailSrc, /\.from\('raid_attendance'\)\.delete/)
  })

  it('officer mutation RPCs still rewrite stored attendee counts', () => {
    const schema = readFileSync(join(dir, '../../../docs/supabase-schema-full.sql'), 'utf8')
    assert.match(schema, /SET attendees = \(SELECT count\(\*\)::text FROM raid_attendance WHERE raid_id/)
    assert.match(schema, /add_attendees_to_existing_tic/)
  })
})
