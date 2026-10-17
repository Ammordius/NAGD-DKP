import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  chooseRouteScrollAnchor,
  clearScrollRecord,
  decideRouteScroll,
  findRouteScrollElement,
  hashBlocksScrollRestore,
  readScrollRecord,
  routesShareScroll,
  scrollRouteKey,
  writeScrollRecord,
} from './routeScroll.js'

function memoryStorage() {
  const data = {}
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
  }
}

function row(anchorId, itemId = null) {
  return {
    getAttribute(name) {
      if (name === 'data-scroll-anchor') return anchorId
      if (name === 'data-scroll-item') return itemId
      return null
    },
  }
}

describe('route scroll', () => {
  it('keeps a separate anchor per route so back and forward do not carry scroll across pages', () => {
    assert.equal(scrollRouteKey('/mobs', ''), '/mobs')
    assert.equal(scrollRouteKey('/accounts/abc', '?tab=loot'), '/accounts/abc?tab=loot')
    assert.equal(scrollRouteKey('/accounts/abc', '?tab=activity'), '/accounts/abc?tab=activity')
    assert.equal(scrollRouteKey('/dkp', '?x=1'), '/dkp')
    assert.equal(routesShareScroll({ pathname: '/mobs', search: '' }, { pathname: '/dkp', search: '' }), false)
    assert.equal(routesShareScroll(
      { pathname: '/accounts/abc', search: '?tab=loot' },
      { pathname: '/accounts/abc', search: '?tab=history' },
    ), false)

    const storage = memoryStorage()
    writeScrollRecord(storage, '/mobs', { anchorId: 'quarm|', itemId: '12', top: 400 })
    writeScrollRecord(storage, '/dkp', { anchorId: 'acct', itemId: null, top: 80 })
    assert.deepEqual(readScrollRecord(storage, '/mobs'), { anchorId: 'quarm|', itemId: '12', top: 400 })
    assert.equal(readScrollRecord(storage, '/loot')?.anchorId ?? null, null)
    clearScrollRecord(storage, '/mobs')
    assert.equal(readScrollRecord(storage, '/mobs'), null)
    assert.equal(readScrollRecord(storage, '/dkp').anchorId, 'acct')
  })

  it('chooses a row anchor and falls back when the saved record is corrupt', () => {
    const anchor = chooseRouteScrollAnchor([
      { anchorId: 'earlier', itemId: null, top: -200 },
      { mobKey: 'quarm|', itemKey: '99', top: -2 },
      { anchorId: 'later', itemId: null, top: 40 },
    ], 0)
    assert.deepEqual(anchor, { anchorId: 'quarm|', itemId: '99' })
    assert.equal(chooseRouteScrollAnchor([{ anchorId: 'later', top: 40 }], 0), null)

    const storage = memoryStorage()
    storage.setItem('pageState:scroll:/mobs', '{')
    assert.equal(readScrollRecord(storage, '/mobs'), null)
    storage.setItem('pageState:scroll:/mobs', JSON.stringify({ top: 'nope' }))
    assert.equal(readScrollRecord(storage, '/mobs'), null)
  })

  it('waits for layout, then restores, and cancels when the user interacts or a hash is present', () => {
    const waiting = {
      contentReady: false,
      anchor: { anchorId: 'quarm|', itemId: '12' },
      anchorInDom: false,
    }
    assert.equal(decideRouteScroll(waiting), 'wait')
    assert.equal(decideRouteScroll({ ...waiting, contentReady: true, anchorInDom: true }), 'restore')
    assert.equal(decideRouteScroll({ ...waiting, contentReady: true, anchorInDom: true, userInteracted: true }), 'cancel')
    assert.equal(decideRouteScroll({ ...waiting, contentReady: true, hashPresent: true, anchorInDom: true }), 'cancel')
    assert.equal(hashBlocksScrollRestore('#add-raid'), true)
    assert.equal(hashBlocksScrollRestore(''), false)
  })

  it('scrolls to the top when the anchor is gone and uses pixel mode for a virtual list', () => {
    assert.equal(decideRouteScroll({
      contentReady: true,
      anchor: { anchorId: 'gone', itemId: null },
      anchorInList: false,
      anchorInDom: false,
      missingAnchor: 'top',
      emptyAnchor: 'top',
    }), 'top')
    assert.equal(decideRouteScroll({
      contentReady: true,
      anchor: null,
      emptyAnchor: 'top',
    }), 'top')
    assert.equal(decideRouteScroll({
      contentReady: true,
      preferPixel: true,
      pixel: 640,
      anchor: { anchorId: 'row-1', itemId: null },
      anchorInDom: false,
    }), 'pixel')
  })

  it('finds the item row and otherwise the section header', () => {
    const header = row('quarm|', null)
    const item = row('quarm|', '12')
    const root = { querySelectorAll() { return [header, item] } }
    assert.equal(findRouteScrollElement(root, { anchorId: 'quarm|', itemId: '12' }), item)
    assert.equal(findRouteScrollElement(root, { anchorId: 'quarm|', itemId: null }), header)
    assert.equal(findRouteScrollElement(root, { anchorId: 'missing' }), null)
  })
})
