import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  clearUserPageState,
  decodeStoredValue,
  encodeStoredValue,
  migrateSessionKeyToUserLocal,
  pageStateFullKey,
  readPageState,
  writePageState,
} from './pageState.js'

function memoryStorage(initial = {}) {
  const data = { ...initial }
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null
    },
    setItem(key, value) {
      data[key] = String(value)
    },
    removeItem(key) {
      delete data[key]
    },
    keys() {
      return Object.keys(data)
    },
    dump() {
      return data
    },
  }
}

const here = new URL('./', import.meta.url)

describe('page state storage', () => {
  it('keeps guild view keys unscoped and raw so existing session values still load', () => {
    const storage = memoryStorage({
      'pageState:/mobs:query': JSON.stringify('vulak'),
    })
    assert.equal(readPageState(storage, '/mobs:query', ''), 'vulak')
    writePageState(storage, '/mobs:groups', { expanded: { 'quarm|': false } })
    assert.equal(pageStateFullKey('/mobs:groups'), 'pageState:/mobs:groups')
    assert.equal(storage.getItem('pageState:/mobs:query'), JSON.stringify('vulak'))
  })

  it('falls back when saved JSON is corrupt', () => {
    const storage = memoryStorage({ 'pageState:/dkp:sortKey': '{' })
    assert.equal(readPageState(storage, '/dkp:sortKey', 'balance'), 'balance')
  })

  it('rejects an outdated or expired local envelope', () => {
    const storage = memoryStorage()
    writePageState(storage, '/items/example:elementalClass', 'MAG', {
      version: 1,
      ttlMs: 1000,
      now: 1_000,
    })
    assert.equal(
      readPageState(storage, '/items/example:elementalClass', '', undefined, { version: 1, now: 1_500 }),
      'MAG',
    )
    assert.equal(
      readPageState(storage, '/items/example:elementalClass', '', undefined, { version: 2, now: 1_500 }),
      '',
    )
    assert.equal(
      readPageState(storage, '/items/example:elementalClass', '', undefined, { version: 1, now: 3_000 }),
      '',
    )
    assert.equal(decodeStoredValue(encodeStoredValue('ok', { version: 1, now: 5 }), { version: 1, now: 5 }).value, 'ok')
    assert.equal(decodeStoredValue({ v: 1 }, { version: 1 }).ok, false)
  })

  it('scopes personalized drafts to the user and drops them on sign-out without touching guild view state', () => {
    const storage = memoryStorage()
    writePageState(storage, '/mobs:query', 'vulak')
    writePageState(storage, '/officer/who-parser:paste', 'secret paste', { userId: 'user-a' })
    writePageState(storage, '/tools/discord-schedule:paste', 'other', { userId: 'user-b' })
    assert.equal(readPageState(storage, '/officer/who-parser:paste', '', undefined, { userId: 'user-a' }), 'secret paste')
    assert.equal(readPageState(storage, '/officer/who-parser:paste', '', undefined, { userId: 'user-b' }), '')
    const removed = clearUserPageState(storage, 'user-a')
    assert.deepEqual(removed, ['pageState:user:user-a:/officer/who-parser:paste'])
    assert.equal(storage.getItem('pageState:/mobs:query'), JSON.stringify('vulak'))
    assert.equal(storage.getItem('pageState:user:user-b:/tools/discord-schedule:paste'), JSON.stringify('other'))
    assert.equal(readPageState(storage, '/officer/who-parser:paste', '', undefined, { userId: 'user-a' }), '')
  })

  it('moves an old unscoped draft onto the signed-in user once', () => {
    const storage = memoryStorage({
      'pageState:/officer/who-parser:paste': JSON.stringify('legacy'),
    })
    assert.equal(
      readPageState(storage, '/officer/who-parser:paste', '', undefined, { userId: 'user-a', migrateUnscoped: true }),
      'legacy',
    )
    assert.equal(storage.getItem('pageState:/officer/who-parser:paste'), null)
    assert.equal(storage.getItem('pageState:user:user-a:/officer/who-parser:paste'), JSON.stringify('legacy'))
  })

  it('moves an unscoped session view into the signed-in user\'s local slot once', () => {
    const session = memoryStorage({
      'pageState:/mobs:groups': JSON.stringify({ expanded: { 'Anar_of_Water|Plane of Time': true }, itemsShown: {} }),
    })
    const local = memoryStorage()
    assert.equal(migrateSessionKeyToUserLocal(session, local, '/mobs:groups', 'user-a', { version: 1 }), true)
    assert.equal(session.getItem('pageState:/mobs:groups'), null)
    assert.equal(migrateSessionKeyToUserLocal(session, local, '/mobs:groups', 'user-b', { version: 1 }), false)
    const saved = readPageState(local, '/mobs:groups', null, undefined, { userId: 'user-a', version: 1 })
    assert.equal(saved.expanded['Anar_of_Water|Plane of Time'], true)
    assert.equal(readPageState(local, '/mobs:groups', null, undefined, { userId: 'user-b', version: 1 }), null)
  })
})

describe('view-state contract', () => {
  const required = [
    ['../pages/MobLoot.jsx', '/mobs:groups'],
    ['../pages/MobLoot.jsx', '/mobs:query'],
    ['../pages/DKP.jsx', '/dkp:sortKey'],
    ['../pages/LootSearch.jsx', '/loot:pagesLoaded'],
    ['../pages/LootRecipients.jsx', '/loot-recipients:expanded'],
    ['../pages/DkpChangelog.jsx', '/officer/dkp-changelog:pages'],
    ['../pages/Officer.jsx', 'raidPickerQuery'],
    ['../pages/ItemPage.jsx', 'elementalClass'],
    ['../components/AccountBiddingPortfolioCard.jsx', 'bidFrom'],
    ['../components/DiscordScheduleTool.jsx', 'userScope: true'],
    ['../pages/OfficerWhoParser.jsx', 'userScope: true'],
    ['../App.jsx', 'clearUserPageState'],
  ]

  for (const [file, needle] of required) {
    it(`${file} keeps ${needle}`, () => {
      const source = readFileSync(new URL(file, here), 'utf8')
      assert.match(source, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    })
  }

  it('does not persist login secrets', () => {
    const source = readFileSync(new URL('../pages/Login.jsx', here), 'utf8')
    assert.doesNotMatch(source, /usePersistedState/)
    assert.match(source, /useState\(''\)/)
  })
})
