import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildResolveAccountMaps,
  filterAttendanceForAccount,
  resolveDkpAccountId,
} from './resolveDkpAccountId.js'

describe('resolveDkpAccountId', () => {
  const maps = buildResolveAccountMaps(
    [
      { char_id: 'c1', account_id: 'acct-a' },
      { char_id: 'c2', account_id: 'acct-b' },
      { char_id: 'shared', account_id: 'acct-a' },
      { char_id: 'shared', account_id: 'acct-b' },
    ],
    [
      { char_id: 'c1', name: 'Alice' },
      { char_id: 'c2', name: 'Bob' },
      { char_id: 'orphan', name: 'Orphan' },
    ],
  )

  it('prefers an explicit account id over character linkage', () => {
    assert.equal(
      resolveDkpAccountId('acct-other', 'c1', 'Alice', maps),
      'acct-other',
    )
  })

  it('uses a unique char_id link when explicit account is empty', () => {
    assert.equal(resolveDkpAccountId(null, 'c1', 'Alice', maps), 'acct-a')
    assert.equal(resolveDkpAccountId('', 'c2', 'Bob', maps), 'acct-b')
  })

  it('does not credit by name when char_id already has a link', () => {
    assert.equal(resolveDkpAccountId(null, 'c1', 'Bob', maps), 'acct-a')
  })

  it('uses a unique name only when the char_id has no link', () => {
    assert.equal(resolveDkpAccountId(null, 'unlinked', 'Alice', maps), 'acct-a')
    assert.equal(resolveDkpAccountId(null, null, 'Bob', maps), 'acct-b')
  })

  it('returns null when char_id or name maps to multiple accounts', () => {
    assert.equal(resolveDkpAccountId(null, 'shared', null, maps), null)
  })

  it('filters attendance so an explicit other account is not credited here', () => {
    const rows = [
      { id: 1, raid_id: 'r1', event_id: 'e1', account_id: 'acct-other', char_id: 'c1', character_name: 'Alice' },
      { id: 2, raid_id: 'r1', event_id: 'e2', account_id: null, char_id: 'c1', character_name: 'Alice' },
      { id: 3, raid_id: 'r1', event_id: 'e3', account_id: 'acct-a', char_id: 'x', character_name: 'X' },
    ]
    const kept = filterAttendanceForAccount(rows, 'acct-a', maps)
    assert.deepEqual(kept.map((r) => r.id), [2, 3])
  })
})
