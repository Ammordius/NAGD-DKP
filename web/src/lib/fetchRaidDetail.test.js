import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchRaidDetail } from './fetchRaidDetail.js'

function trackingQuery(table, result, writes) {
  const chain = {
    select() { return chain },
    eq() { return chain },
    order() { return chain },
    maybeSingle() { return Promise.resolve(result) },
    update(payload) {
      writes.push({ op: 'update', table, payload })
      return chain
    },
    delete() {
      writes.push({ op: 'delete', table })
      return chain
    },
    then(onFulfilled, onRejected) {
      return Promise.resolve(result).then(onFulfilled, onRejected)
    },
  }
  return chain
}

describe('fetchRaidDetail', () => {
  it('returns the raid rows and does not update or delete when the stored count is stale', async () => {
    const writes = []
    const client = {
      from(table) {
        if (table === 'raids') {
          return trackingQuery(table, { data: { raid_id: 'raid-1', attendees: null }, error: null }, writes)
        }
        if (table === 'raid_attendance') {
          return trackingQuery(table, { data: [{ char_id: 'char-1', character_name: 'Ada' }], error: null }, writes)
        }
        return trackingQuery(table, { data: [], error: null }, writes)
      },
    }

    const detail = await fetchRaidDetail(client, 'raid-1')

    assert.equal(detail.raid.raid_id, 'raid-1')
    assert.equal(detail.attendance.length, 1)
    assert.deepEqual(writes, [])
  })

  it('throws the raid read error without writing', async () => {
    const writes = []
    const client = {
      from(table) {
        if (table === 'raids') {
          return trackingQuery(table, { data: null, error: { message: 'permission denied' } }, writes)
        }
        return trackingQuery(table, { data: [], error: null }, writes)
      },
    }

    await assert.rejects(() => fetchRaidDetail(client, 'raid-1'), /permission denied/)
    assert.deepEqual(writes, [])
  })
})

describe('RaidDetail view', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../pages/RaidDetail.jsx'),
    'utf8',
  )

  it('does not sync attendance while the page is only being viewed', () => {
    assert.equal(source.includes(".from('raids').update"), false)
    assert.equal(source.includes(".from('raid_attendance').delete"), false)
    assert.match(source, /fetchRaidDetail\(supabase, raidId\)/)
  })
})
