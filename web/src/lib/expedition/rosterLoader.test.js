import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearRosterMemoryCache,
  extractCharactersFromAccountDetail,
  peekSessionAccountCharacters,
  peekSwrAccountCharacters,
  fetchAccountRosterMinimal,
  resolveExpeditionRoster,
} from './rosterLoader.js'
import { accountDetailSessionKey } from '../accountDetailMissingScope.js'
import { fillPartyToThree, normalizeRoster, compositionCommentary } from './characterAdapter.js'

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) },
  }
}

function fakeClient({ ca, chars, caError, chError }) {
  return {
    from(table) {
      return {
        select() {
          return {
            eq() {
              return {
                async limit() {
                  if (table === 'character_account') {
                    if (caError) return { data: null, error: caError }
                    return { data: ca, error: null }
                  }
                  return { data: [], error: null }
                },
              }
            },
            in() {
              return {
                async limit() {
                  if (table === 'characters') {
                    if (chError) return { data: null, error: chError }
                    return { data: chars, error: null }
                  }
                  return { data: [], error: null }
                },
              }
            },
          }
        },
      }
    },
  }
}

describe('characterAdapter', () => {
  it('prevents duplicate selections when normalizing', () => {
    const rows = [
      { char_id: '1', name: 'A', class_name: 'Warrior', level: 60 },
      { char_id: '1', name: 'A', class_name: 'Warrior', level: 60 },
      { char_id: '2', name: 'B', class_name: 'Cleric', level: 60 },
    ]
    assert.equal(normalizeRoster(rows).length, 2)
  })

  it('fills single-character party with fictional volunteers', () => {
    const party = fillPartyToThree([{ char_id: '1', name: 'Solo', class_name: 'Rogue', level: 60 }])
    assert.equal(party.length, 3)
    assert.equal(party[0].name, 'Solo')
    assert.ok(party[1].fictional)
    assert.ok(party[2].fictional)
  })

  it('comments on weird compositions', () => {
    const line = compositionCommentary([
      { char_id: '1', name: 'W1', class_name: 'Wizard' },
      { char_id: '2', name: 'W2', class_name: 'Wizard' },
      { char_id: '3', name: 'W3', class_name: 'Wizard' },
    ])
    assert.match(line, /wizards/i)
  })
})

describe('rosterLoader', () => {
  beforeEach(() => {
    clearRosterMemoryCache()
  })

  it('returns fictional party when no account', async () => {
    const res = await resolveExpeditionRoster({ accountId: null })
    assert.equal(res.fictional, true)
    assert.equal(res.networkQueries, 0)
    assert.equal(res.characters.length, 3)
    assert.ok(res.characters.every((c) => c.fictional))
  })

  it('uses session cache without network', async () => {
    const accountId = 'acct-1'
    const storage = memoryStorage()
    const key = accountDetailSessionKey(accountId, false)
    storage.setItem(key, JSON.stringify({
      characters: [{ char_id: 'c1', name: 'Ada', class_name: 'Cleric', level: 60 }],
    }))
    let network = 0
    const client = {
      from() {
        network += 1
        throw new Error('should not network')
      },
    }
    const res = await resolveExpeditionRoster({ accountId, sessionStorage: storage, client })
    assert.equal(res.source, 'session')
    assert.equal(res.networkQueries, 0)
    assert.equal(network, 0)
    assert.equal(res.characters[0].name, 'Ada')
  })

  it('uses SWR peek without network', async () => {
    const res = await resolveExpeditionRoster({
      accountId: 'acct-2',
      swrData: {
        characters: [{ char_id: 'c2', name: 'Bor', class_name: 'Warrior', level: 55 }],
      },
      client: { from() { throw new Error('no') } },
    })
    assert.equal(res.source, 'swr')
    assert.equal(res.networkQueries, 0)
  })

  it('fetches at most two queries on miss', async () => {
    const client = fakeClient({
      ca: [{ char_id: 'x1' }, { char_id: 'x2' }],
      chars: [
        { char_id: 'x1', name: 'X', class_name: 'Monk', level: 60 },
        { char_id: 'x2', name: 'Y', class_name: 'Bard', level: 60 },
      ],
    })
    const res = await resolveExpeditionRoster({
      accountId: 'acct-3',
      sessionStorage: memoryStorage(),
      client,
    })
    assert.equal(res.source, 'network')
    assert.equal(res.networkQueries, 2)
    assert.equal(res.characters.length, 2)

    // restart uses memory — zero network
    const again = await resolveExpeditionRoster({
      accountId: 'acct-3',
      sessionStorage: memoryStorage(),
      client: { from() { throw new Error('no refetch') } },
    })
    assert.equal(again.source, 'memory')
    assert.equal(again.networkQueries, 0)
  })

  it('falls back fictional on query error', async () => {
    const client = fakeClient({ caError: { message: 'fail' } })
    const res = await resolveExpeditionRoster({
      accountId: 'acct-err',
      sessionStorage: memoryStorage(),
      client,
    })
    assert.equal(res.fictional, true)
    assert.match(res.notice || '', /Could not load|fictional/i)
  })

  it('extractCharacters rejects empty', () => {
    assert.equal(extractCharactersFromAccountDetail({ characters: [] }), null)
    assert.ok(peekSwrAccountCharacters({ data: { characters: [{ char_id: '1', name: 'A', class_name: 'Rogue' }] } }))
  })

  it('peekSession returns null for missing', () => {
    assert.equal(peekSessionAccountCharacters('nope', memoryStorage()), null)
  })

  it('fetchAccountRosterMinimal maps fields only', async () => {
    const client = fakeClient({
      ca: [{ char_id: 'a' }],
      chars: [{ char_id: 'a', name: 'Ann', class_name: 'Druid', level: 59 }],
    })
    const rows = await fetchAccountRosterMinimal(client, 'acct')
    assert.deepEqual(rows[0], {
      char_id: 'a',
      name: 'Ann',
      class_name: 'Druid',
      level: 59,
      fictional: false,
      displayName: 'Ann',
    })
  })
})
