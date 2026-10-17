import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_GROUP_STATE,
  ITEMS_PER_PAGE,
  SCROLL_ANCHOR_STORAGE_KEY,
  canonicalMobGroupKey,
  chooseScrollAnchor,
  clearScrollAnchor,
  findScrollAnchorElement,
  isMobOpen,
  itemsShownLimit,
  mergeGroupRevision,
  migrateGroupKeys,
  mobGroupAliases,
  normalizeGroupState,
  normalizeScrollAnchor,
  readScrollAnchor,
  revealMoreItems,
  scrollRestoreDecision,
  toggleMobGroup,
  writeScrollAnchor,
} from './mobLootViewState.js'

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

function row(mobKey, itemKey = null) {
  return {
    getAttribute(name) {
      if (name === 'data-mob-key') return mobKey
      if (name === 'data-item-key') return itemKey
      return null
    },
  }
}

const readyToRestore = {
  dataReady: true,
  statsReady: true,
  zonesReady: true,
  armorReady: true,
  anchor: { mobKey: 'quarm|', itemKey: '12' },
  anchorInList: true,
  anchorInDom: true,
}

describe('mob group memory', () => {
  it('keeps several mobs open or closed independently, including show more', () => {
    let state = EMPTY_GROUP_STATE
    state = toggleMobGroup(state, 'quarm|', false)
    state = toggleMobGroup(state, 'vallon|', false)
    state = toggleMobGroup(state, 'quarm|', true)
    state = revealMoreItems(state, 'vallon|')
    state = revealMoreItems(state, 'vallon|')

    assert.equal(state.expanded['quarm|'], false)
    assert.equal(state.expanded['vallon|'], true)
    assert.equal(state.itemsShown['vallon|'], ITEMS_PER_PAGE * 3)
    assert.equal(itemsShownLimit(state, 'quarm|'), ITEMS_PER_PAGE)
    assert.equal(isMobOpen(state, 'quarm|', { filtersActive: false, matchCount: 40 }), false)
    assert.equal(isMobOpen(state, 'vallon|', { filtersActive: false, matchCount: 40 }), true)
  })

  it('does not let auto-open override an explicit collapse', () => {
    const closed = toggleMobGroup(EMPTY_GROUP_STATE, 'saryrn|', true)
    assert.equal(closed.expanded['saryrn|'], false)
    assert.equal(isMobOpen(closed, 'saryrn|', { filtersActive: true, matchCount: 1 }), false)
    assert.equal(isMobOpen(closed, 'saryrn|', { filtersActive: true, matchCount: 2 }), false)
  })

  it('auto-opens a short filtered list only when the user has not chosen', () => {
    assert.equal(isMobOpen(EMPTY_GROUP_STATE, 'innoruuk|', { filtersActive: true, matchCount: 2 }), true)
    assert.equal(isMobOpen(EMPTY_GROUP_STATE, 'innoruuk|', { filtersActive: true, matchCount: 1 }), true)
    assert.equal(isMobOpen(EMPTY_GROUP_STATE, 'innoruuk|', { filtersActive: true, matchCount: 3 }), false)
    assert.equal(isMobOpen(EMPTY_GROUP_STATE, 'innoruuk|', { filtersActive: true, matchCount: 0 }), false)
    assert.equal(isMobOpen(EMPTY_GROUP_STATE, 'innoruuk|', { filtersActive: false, matchCount: 1 }), false)
    const opened = toggleMobGroup(EMPTY_GROUP_STATE, 'innoruuk|', false)
    assert.equal(isMobOpen(opened, 'innoruuk|', { filtersActive: false, matchCount: 1 }), true)
  })

  it('keeps filters, explicit flags, and show more on the same saved object', () => {
    const state = revealMoreItems(
      toggleMobGroup(toggleMobGroup(EMPTY_GROUP_STATE, 'quarm|', false), 'vz|Plane of Time|merged', true),
      'quarm|',
    )
    assert.equal(state.expanded['quarm|'], true)
    assert.equal(state.expanded['vz|Plane of Time|merged'], false)
    assert.equal(state.itemsShown['quarm|'], 40)
    assert.equal(isMobOpen(state, 'vz|Plane of Time|merged', { filtersActive: true, matchCount: 1 }), false)
    assert.equal(isMobOpen(state, 'other|', { filtersActive: true, matchCount: 2 }), true)
  })

  it('drops corrupt values and keeps stale but well-typed keys', () => {
    const normalized = normalizeGroupState({
      expanded: { 'good|': true, 'closed|': false, bad: 'yes', '': true, later: 1 },
      itemsShown: { 'good|': 40, low: 19, big: 501, frac: 20.5, stale: 60, text: '40' },
      extra: true,
    })
    assert.deepEqual(normalized.expanded, { 'good|': true, 'closed|': false })
    assert.deepEqual(normalized.itemsShown, { 'good|': 40, stale: 60 })
    assert.equal(isMobOpen(normalized, 'closed|', { filtersActive: true, matchCount: 1 }), false)
    assert.equal(itemsShownLimit(normalized, 'stale'), 60)

    for (const raw of [null, undefined, [], 'nope', 3, { expanded: [], itemsShown: 'x' }]) {
      assert.deepEqual(normalizeGroupState(raw), { expanded: {}, itemsShown: {}, rev: 0 })
    }
  })

  it('keeps a merged group id stable when the display zone arrives later', () => {
    const before = mobGroupAliases({
      sourceKeys: ['Split_Anar|Old'],
      mobs: ['Split_Anar'],
      zones: ['Old Zone'],
      displayZone: 'Old Zone',
      forceMerged: false,
    })
    const after = mobGroupAliases({
      sourceKeys: ['Split_Anar|Old', 'Split_Anar|'],
      mobs: ['Split_Anar'],
      zones: ['Old Zone', ''],
      displayZone: 'Plane of Time',
      forceMerged: true,
    })
    assert.equal(before.canonical, 'Split_Anar|Old')
    assert.equal(after.canonical, canonicalMobGroupKey({
      sourceKeys: ['Split_Anar|Old', 'Split_Anar|'],
      mobs: ['Split_Anar'],
      zones: ['Old Zone', ''],
      forceMerged: true,
    }))
    assert.notEqual(after.canonical, 'Split_Anar|Plane of Time|merged')
    assert.equal(isMobOpen(
      { expanded: { 'Split_Anar|Old': true }, itemsShown: {} },
      after.canonical,
      { aliases: after.aliases },
    ), true)
    assert.equal(isMobOpen(
      { expanded: { 'Split_Anar|Plane of Time|merged': false }, itemsShown: {} },
      after.canonical,
      { aliases: after.aliases, filtersActive: true, matchCount: 1 },
    ), false)
    const migrated = migrateGroupKeys(
      { expanded: { 'Split_Anar|Old': true }, itemsShown: { 'Split_Anar|Old': 40 }, rev: 1 },
      [{ canonical: after.canonical, aliases: after.aliases }],
    )
    assert.equal(migrated.expanded[after.canonical], true)
    assert.equal(migrated.expanded['Split_Anar|Old'], undefined)
    assert.equal(migrated.itemsShown[after.canonical], 40)
    assert.equal(migrateGroupKeys(migrated, [{ canonical: after.canonical, aliases: after.aliases }]), migrated)
  })

  it('merges one tab\'s edit onto a newer snapshot from another tab', () => {
    const stored = { expanded: { a: true, b: true }, itemsShown: { a: 40 }, rev: 3 }
    const previous = { expanded: { a: true }, itemsShown: {}, rev: 1 }
    const next = toggleMobGroup(previous, 'a', true)
    const merged = mergeGroupRevision(stored, previous, next)
    assert.equal(merged.expanded.a, false)
    assert.equal(merged.expanded.b, true)
    assert.equal(merged.itemsShown.a, 40)
    assert.equal(merged.rev, 4)
  })
})

describe('scroll anchor', () => {
  it('chooses the mob or item at the top of the viewport, not a pixel offset', () => {
    const anchor = chooseScrollAnchor([
      { mobKey: 'earlier|', itemKey: null, top: -200 },
      { mobKey: 'quarm|', itemKey: null, top: -80 },
      { mobKey: 'quarm|', itemKey: '99', top: -2 },
      { mobKey: 'later|', itemKey: null, top: 40 },
    ], 0)
    assert.deepEqual(anchor, { mobKey: 'quarm|', itemKey: '99' })
    assert.equal('top' in anchor, false)
    assert.equal(chooseScrollAnchor([{ mobKey: 'later|', itemKey: null, top: 40 }], 0), null)
    assert.equal(chooseScrollAnchor([], 0), null)
    assert.equal(chooseScrollAnchor(null), null)
  })

  it('falls back safely for a missing or corrupt anchor', () => {
    const storage = memoryStorage()
    assert.equal(readScrollAnchor(storage), null)
    assert.equal(normalizeScrollAnchor(null), null)
    storage.setItem(SCROLL_ANCHOR_STORAGE_KEY, '{')
    assert.equal(readScrollAnchor(storage), null)
    storage.setItem(SCROLL_ANCHOR_STORAGE_KEY, JSON.stringify({ itemKey: 'only-item' }))
    assert.equal(readScrollAnchor(storage), null)
    storage.setItem(SCROLL_ANCHOR_STORAGE_KEY, JSON.stringify({ mobKey: 'quarm|', itemKey: 12 }))
    assert.deepEqual(readScrollAnchor(storage), { mobKey: 'quarm|', itemKey: null })
    writeScrollAnchor(storage, { mobKey: 'saryrn|', itemKey: '5' })
    assert.deepEqual(readScrollAnchor(storage), { mobKey: 'saryrn|', itemKey: '5' })
    writeScrollAnchor(storage, { mobKey: '' })
    assert.deepEqual(readScrollAnchor(storage), { mobKey: 'saryrn|', itemKey: '5' })
    clearScrollAnchor(storage)
    assert.equal(readScrollAnchor(storage), null)
    assert.doesNotThrow(() => writeScrollAnchor(null, { mobKey: 'x' }))
    assert.doesNotThrow(() => readScrollAnchor(undefined))
  })

  it('finds the item row and otherwise the mob header', () => {
    const mob = row('quarm|', null)
    const item = row('quarm|', '12')
    const other = row('saryrn|', '3')
    const root = { querySelectorAll() { return [mob, item, other] } }
    assert.equal(findScrollAnchorElement(root, { mobKey: 'quarm|', itemKey: '12' }), item)
    assert.equal(findScrollAnchorElement(root, { mobKey: 'quarm|', itemKey: 'missing' }), mob)
    assert.equal(findScrollAnchorElement(root, { mobKey: 'gone|' }), null)
    assert.equal(findScrollAnchorElement(null, { mobKey: 'quarm|' }), null)
  })

  it('waits for data, stats, zones, armor, and the anchor node before restoring', () => {
    assert.equal(scrollRestoreDecision({ ...readyToRestore, dataReady: false }), 'wait')
    assert.equal(scrollRestoreDecision({ ...readyToRestore, statsReady: false }), 'wait')
    assert.equal(scrollRestoreDecision({ ...readyToRestore, zonesReady: false }), 'wait')
    assert.equal(scrollRestoreDecision({ ...readyToRestore, armorReady: false }), 'wait')
    assert.equal(scrollRestoreDecision({ ...readyToRestore, anchorInDom: false }), 'wait')
    assert.equal(scrollRestoreDecision(readyToRestore), 'restore')
    assert.equal(scrollRestoreDecision({ ...readyToRestore, userInteracted: true }), 'cancel')
    assert.equal(scrollRestoreDecision({ ...readyToRestore, filtersChangedByUser: true }), 'cancel')
    assert.equal(scrollRestoreDecision({ ...readyToRestore, anchor: null }), 'skip')
    assert.equal(scrollRestoreDecision({ ...readyToRestore, anchorInList: false }), 'skip')
    assert.equal(scrollRestoreDecision(null), 'wait')
  })
})

describe('Raid Items page wiring', () => {
  it('persists group state and does not spread auto-open over saved collapses', () => {
    const source = readFileSync(new URL('../pages/MobLoot.jsx', import.meta.url), 'utf8')
    const scroll = readFileSync(new URL('./routeScrollView.jsx', import.meta.url), 'utf8')
    assert.match(source, /usePersistedState\(\s*'\/mobs:groups'/)
    assert.match(source, /storage:\s*'local'/)
    assert.match(source, /userScope:\s*true/)
    assert.match(source, /mergeGroupRevision/)
    assert.match(source, /normalizeGroupState/)
    assert.match(source, /isMobOpen\(/)
    assert.match(source, /data-mob-key=\{e\.key\}/)
    assert.match(source, /data-scroll-anchor=\{e\.key\}/)
    assert.match(source, /data-item-key=/)
    assert.match(source, /useScrollContentReady\(/)
    assert.match(source, /useForgetScrollOnChange\(/)
    assert.match(scroll, /scrollRestoration = 'manual'/)
    assert.doesNotMatch(source, /\.\.\.toExpand/)
    assert.doesNotMatch(source, /itemsShownPerKey/)
  })
})
