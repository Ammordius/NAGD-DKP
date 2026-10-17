import { expect, test } from '@playwright/test'

const TORQUE = 'Smooth Onyx Torque'

function mobRow(page, name) {
  return page.locator('tbody tr').filter({
    has: page.locator('td', { hasText: new RegExp(`^${name}$`) }),
  }).first()
}

async function setExpanded(page, name, open) {
  const button = mobRow(page, name).getByRole('button')
  await expect(button).toBeVisible()
  const expanded = (await button.getAttribute('aria-expanded')) === 'true'
  if (expanded !== open) await button.click()
  await expect(button).toHaveAttribute('aria-expanded', open ? 'true' : 'false')
}

async function scrollTorqueToTop(page) {
  const torque = page.getByRole('link', { name: TORQUE })
  await page.evaluate(() => window.dispatchEvent(new WheelEvent('wheel', { deltaY: 1 })))
  await torque.evaluate((node) => node.scrollIntoView({ block: 'start' }))
  const box = await torque.boundingBox()
  expect(box?.y).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeLessThan(120)
  return box
}
async function readScroll(page, userId = 'user-a') {
  return page.evaluate((id) => {
    const raw = localStorage.getItem(`pageState:user:${id}:scroll:/mobs`)
    return raw ? JSON.parse(raw) : null
  }, userId)
}

async function readGroups(page, userId = 'user-a') {
  return page.evaluate((id) => {
    const raw = localStorage.getItem(`pageState:user:${id}:/mobs:groups`)
    return raw ? JSON.parse(raw) : null
  }, userId)
}

async function expectTorqueNear(page, beforeY) {
  const restored = page.getByRole('link', { name: TORQUE })
  await expect(restored).toBeVisible()
  await expect.poll(async () => {
    const box = await restored.boundingBox()
    return box ? Math.abs(box.y - beforeY) : 9999
  }).toBeLessThan(80)
}
async function openRaidItems(page, search = '') {
  await page.goto(`/mobs${search}`)
  await expect(page.getByRole('heading', { name: 'Raid Items' })).toBeVisible()
  await expect(mobRow(page, 'Anar_of_Water')).toBeVisible()
}

test('keeps the expanded mob and item after leaving for DKP', async ({ page }) => {
  await openRaidItems(page)
  await setExpanded(page, 'Aaa_Mob_00', true)
  await setExpanded(page, 'Anar_of_Water', true)
  const before = await scrollTorqueToTop(page)

  await page.getByRole('link', { name: 'DKP', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'DKP' })).toBeVisible()

  const saved = await readScroll(page)
  expect(saved?.value?.anchorId || '').toContain('Anar_of_Water')
  expect(saved?.value?.itemId).toBe('28655')
  expect(saved?.value?.anchorId).not.toBe('dkp-account')
  const groups = await readGroups(page)
  expect(groups?.value?.expanded?.['Anar_of_Water|Plane of Time']).toBe(true)
  expect(groups?.value?.expanded?.['Aaa_Mob_00|Plane of Time']).toBe(true)

  await page.getByRole('link', { name: 'Raid Items' }).click()
  await expect(mobRow(page, 'Anar_of_Water').getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  await expect(mobRow(page, 'Aaa_Mob_00').getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  await expectTorqueNear(page, before.y)
})

test('restores the item after item-detail navigation and browser Back', async ({ page }) => {
  await openRaidItems(page)
  await setExpanded(page, 'Anar_of_Water', true)
  const before = await scrollTorqueToTop(page)
  await page.getByRole('link', { name: TORQUE }).click()
  await expect(page.getByRole('heading', { name: 'Item' })).toBeVisible()
  await page.goBack()
  await expect(mobRow(page, 'Anar_of_Water').getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  await expectTorqueNear(page, before.y)
})

test('restores expansion and the item after reload', async ({ page }) => {
  await openRaidItems(page)
  await setExpanded(page, 'Anar_of_Water', true)
  const before = await scrollTorqueToTop(page)
  await page.waitForTimeout(200)
  await page.reload()
  await expect(mobRow(page, 'Anar_of_Water').getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  await expectTorqueNear(page, before.y)
})

test('flushes a pending scroll snapshot when the tab is hidden', async ({ page }) => {
  await openRaidItems(page)
  await setExpanded(page, 'Anar_of_Water', true)
  await scrollTorqueToTop(page)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const saved = await readScroll(page)
  expect(saved?.value?.itemId).toBe('28655')
  expect(saved?.value?.anchorId || '').toContain('Anar_of_Water')
})

test('a second tab sees the same expansion and anchor', async ({ page, context }) => {
  await openRaidItems(page)
  await setExpanded(page, 'Anar_of_Water', true)
  await setExpanded(page, 'Aaa_Mob_02', true)
  await scrollTorqueToTop(page)
  await page.getByRole('link', { name: 'DKP', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'DKP' })).toBeVisible()

  const page2 = await context.newPage()
  await openRaidItems(page2)
  await expect(mobRow(page2, 'Anar_of_Water').getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  await expect(mobRow(page2, 'Aaa_Mob_02').getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(async () => (await page2.getByRole('link', { name: TORQUE }).boundingBox())?.y ?? 9999).toBeLessThan(120)
})

test('keeps filters, an explicit collapse, and show more', async ({ page }) => {
  await openRaidItems(page)
  await page.getByLabel('Search by item, mob, or zone').fill('Aaa_Mob_00')
  await page.getByRole('link', { name: 'DKP', exact: true }).click()
  await page.getByRole('link', { name: 'Raid Items' }).click()
  await expect(page.getByLabel('Search by item, mob, or zone')).toHaveValue('Aaa_Mob_00')
  await page.getByLabel('Search by item, mob, or zone').fill('')

  await page.getByLabel('Filter by equipment slot').selectOption('NECK')
  await expect(page.getByText(/mobs \(grouped by zone\)/)).toContainText('3 mobs')
  await setExpanded(page, 'Anar_of_Water', true)
  await setExpanded(page, 'Aaa_Mob_01', false)
  await expect(mobRow(page, 'Aaa_Mob_00').getByRole('button')).toHaveAttribute('aria-expanded', 'true')

  await page.getByLabel('Filter by equipment slot').selectOption('')
  await setExpanded(page, 'Anar_of_Water', true)
  await page.getByRole('button', { name: /Show \d+ more/ }).click()
  const shown = page.locator('tr[data-scroll-item="28655"]')
  await expect(shown).toBeVisible()
  const extra = page.locator('tr[data-scroll-item="3111"]')
  await expect(extra).toBeVisible()

  await page.getByLabel('Filter by equipment slot').selectOption('NECK')
  await page.getByRole('link', { name: 'DKP', exact: true }).click()
  await page.getByRole('link', { name: 'Raid Items' }).click()
  await expect(page.getByLabel('Filter by equipment slot')).toHaveValue('NECK')
  await expect(mobRow(page, 'Anar_of_Water').getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  await expect(mobRow(page, 'Aaa_Mob_01').getByRole('button')).toHaveAttribute('aria-expanded', 'false')
  await expect(mobRow(page, 'Aaa_Mob_00').getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  await page.getByLabel('Filter by equipment slot').selectOption('')
  await expect(page.locator('tr[data-scroll-item="3111"]')).toBeVisible()
})

test('delayed zone inference does not retarget a saved mob', async ({ page }) => {
  await openRaidItems(page, '?zoneDelay=1200')
  const splitRows = page.locator('tbody tr').filter({
    has: page.locator('td', { hasText: /^Split_Anar$/ }),
  })
  await expect(splitRows).toHaveCount(2)
  const timed = splitRows.filter({ hasText: 'Plane of Time' }).getByRole('button')
  await timed.click()
  await expect(timed).toHaveAttribute('aria-expanded', 'true')
  await expect(splitRows).toHaveCount(1, { timeout: 8000 })
  const anchor = await splitRows.first().getAttribute('data-scroll-anchor')
  expect(anchor).toContain('Split_Anar')
  expect(anchor).toContain('merged')
  expect(anchor).not.toBe('Split_Anar|Plane of Time|merged')
  await expect(splitRows.first().getByRole('button')).toHaveAttribute('aria-expanded', 'true')
})

test('signed-in users do not share Raid Items view state', async ({ page }) => {
  await openRaidItems(page)
  await setExpanded(page, 'Anar_of_Water', true)
  await scrollTorqueToTop(page)
  await page.getByRole('link', { name: 'DKP', exact: true }).click()
  await page.getByRole('link', { name: 'Raid Items' }).click()
  await expect(mobRow(page, 'Anar_of_Water').getByRole('button')).toHaveAttribute('aria-expanded', 'true')

  await page.getByRole('button', { name: 'User B' }).click()
  await expect(page.getByTestId('current-user')).toHaveText('user-b')
  await expect(mobRow(page, 'Anar_of_Water').getByRole('button')).toHaveAttribute('aria-expanded', 'false')
  expect(await readGroups(page, 'user-b')).toBeNull()

  await page.getByRole('button', { name: 'User A' }).click()
  await expect(mobRow(page, 'Anar_of_Water').getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  const saved = await readScroll(page, 'user-a')
  expect(saved?.value?.itemId).toBe('28655')
  expect(await readScroll(page, 'user-b')).toBeNull()
})
