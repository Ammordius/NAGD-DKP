import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  accountDetailSessionKey,
  accountDetailSwrKey,
  missingTicControlMatrix,
  needsMissingRaidUniverse,
} from '../lib/accountDetailMissingScope.js'

const dir = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(dir, 'AccountDetail.jsx'), 'utf8')
const activitySource = readFileSync(join(dir, '../components/AccountRaidActivity.jsx'), 'utf8')
const profileSource = readFileSync(join(dir, 'Profile.jsx'), 'utf8')

describe('AccountDetail missing-tic behavior', () => {
  it('wires scope helpers for either control and scoped caches', () => {
    assert.match(activitySource, /needsMissingRaidUniverse\(showMissingDetails, onlyMissingRaids\)/)
    assert.match(source, /accountDetailSwrKey\(accountId, includeMissing\)/)
    assert.match(source, /getAccountDetailFromSession\(accountId, includeMissing\)/)
    assert.match(source, /setAccountDetailInSession\(accountId, data, includeMissing\)/)
    assert.match(source, /<AccountRaidActivity rows=\{activityByRaid\} controls=\{activityControls\} \/>/)
    assert.match(activitySource, /Show all attendance tics, highlight any missed/)
    assert.match(activitySource, /Only show attended raids with some missed tics/)
    assert.match(activitySource, /show which/)
    assert.match(activitySource, /missingTicLabel/)
    assert.match(activitySource, /showWhichTics/)
    assert.match(activitySource, /<< First Page/)
    assert.match(activitySource, /< Previous Page/)
    assert.match(activitySource, /Next Page >/)
    assert.match(activitySource, /Last Page >>/)
    assert.match(activitySource, /className="activity-pager"/)
    assert.match(activitySource, /className="activity-page-summary-page"/)
    assert.match(source, /fetchChunkedIn\(supabase, 'raid_event_attendance'/)
    assert.match(source, /fetchChunkedIn\(supabase, 'raid_events'/)
    assert.match(source, /ticFractionsByRaid\(/)
    assert.match(activitySource, /visibleMissingTicRows\(activityWithMissing/)
    assert.match(profileSource, /<AccountRaidActivity rows=\{activityDetail\?\.activityByRaid \|\| \[\]\} controls=\{activityControls\} \/>/)
    assert.match(profileSource, /fetchAccountDetail\(profile\.account_id, activityControls\.includeMissing\)/)
  })

  it('evaluates all four control combinations for fetch scope', () => {
    const matrix = missingTicControlMatrix('acct-a')
    assert.equal(matrix.length, 4)
    for (const row of matrix) {
      assert.equal(
        row.includeMissing,
        needsMissingRaidUniverse(row.showMissingDetails, row.onlyMissingRaids),
      )
      assert.equal(row.swrKey, accountDetailSwrKey('acct-a', row.includeMissing))
      assert.equal(row.sessionKey, accountDetailSessionKey('acct-a', row.includeMissing))
    }
  })

  it('keeps session caches isolated when switching controls and accounts', () => {
    const store = new Map()
    store.set(accountDetailSessionKey('acct-a', false), { account: 'a', missing: false })
    store.set(accountDetailSessionKey('acct-a', true), { account: 'a', missing: true })
    store.set(accountDetailSessionKey('acct-b', true), { account: 'b', missing: true })

    assert.equal(store.get(accountDetailSessionKey('acct-a', true)).missing, true)
    assert.equal(store.get(accountDetailSessionKey('acct-a', false)).missing, false)
    assert.notEqual(
      store.get(accountDetailSessionKey('acct-a', true)),
      store.get(accountDetailSessionKey('acct-b', true)),
    )
    // Enabling missing must not read the non-missing blob
    assert.notEqual(
      accountDetailSessionKey('acct-a', false),
      accountDetailSessionKey('acct-a', true),
    )
  })
})
