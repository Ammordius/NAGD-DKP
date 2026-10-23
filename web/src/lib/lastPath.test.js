import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { consumeLastPath, persistLastPath } from './lastPath.js'

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
    dump() {
      return data
    },
  }
}

describe('last path', () => {
  it('restores only the signed-in user path', () => {
    const localStore = memoryStorage({
      'dkp-last-path:user-b': '/raids/raid-2',
      'dkp-last-path': '/officer/SiteAdmin',
    })
    const sessionStore = memoryStorage({ 'dkp-last-path': '/accounts/secret' })

    assert.equal(consumeLastPath('user-b', localStore, sessionStore), '/raids/raid-2')
    assert.equal(localStore.getItem('dkp-last-path'), null)
    assert.equal(sessionStore.getItem('dkp-last-path'), null)
    assert.equal(localStore.getItem('dkp-last-path:user-b'), '/raids/raid-2')
  })

  it('does not give the previous browser user path to the next user', () => {
    const localStore = memoryStorage({ 'dkp-last-path': '/officer/SiteAdmin' })
    const sessionStore = memoryStorage({ 'dkp-last-path': '/accounts/secret' })

    assert.equal(consumeLastPath('user-c', localStore, sessionStore), null)
    assert.equal(localStore.getItem('dkp-last-path:user-c'), null)
    assert.equal(localStore.getItem('dkp-last-path'), null)
    assert.equal(sessionStore.getItem('dkp-last-path'), null)
  })

  it('stores the path on the signed-in user key', () => {
    const localStore = memoryStorage()
    persistLastPath('user-a', '/dkp?sort=balance', localStore)
    assert.equal(localStore.getItem('dkp-last-path:user-a'), '/dkp?sort=balance')
    assert.equal(localStore.getItem('dkp-last-path'), null)
  })
})
