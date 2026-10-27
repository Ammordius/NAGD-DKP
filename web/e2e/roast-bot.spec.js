import { expect, test } from '@playwright/test'

test.describe('DKP Inquisitor roast bot', () => {
  test('opens, sends messages, uses chips, and shows item links', async ({ page }) => {
    await page.goto('/roast-bot')
    await expect(page.getByTestId('roast-bot-panel')).toBeVisible()
    await expect(page.getByTestId('roast-bot-reply').first()).toContainText(/DKP Inquisitor|disappointed/i)

    await page.getByTestId('roast-bot-input').fill('Roast my DKP spending')
    await page.getByTestId('roast-bot-send').click()
    await expect(page.getByTestId('roast-bot-user-msg').last()).toContainText('Roast my DKP spending')
    await expect(page.getByTestId('roast-bot-reply').last()).toBeVisible()

    const chip = page.getByTestId('roast-bot-chips').getByRole('button').first()
    await chip.click()
    await expect(page.getByTestId('roast-bot-user-msg').last()).toBeVisible()

    await page.getByTestId('roast-bot-input').fill('How much is Smooth Onyx Torque?')
    await page.getByTestId('roast-bot-send').click()
    await expect(page.getByTestId('roast-bot-reply').last()).toContainText(/150|180|Smooth Onyx Torque/i)

    const itemLink = page.getByTestId('roast-bot-reply').last().locator('a[href*="/items/"]')
    if (await itemLink.count()) {
      await expect(itemLink.first()).toBeVisible()
    }

    await page.getByTestId('roast-bot-toggle').click()
    await expect(page.getByTestId('roast-bot-panel')).toHaveCount(0)
    await page.getByTestId('roast-bot-toggle').click()
    await expect(page.getByTestId('roast-bot-panel')).toBeVisible()
  })

  test('character select is available for multi-toon accounts', async ({ page }) => {
    await page.goto('/roast-bot')
    await expect(page.getByTestId('roast-bot-character')).toBeVisible()
    await page.getByTestId('roast-bot-character').selectOption({ label: 'Zenderheals (Cleric)' })
  })

  test('keyboard: Enter sends message', async ({ page }) => {
    await page.goto('/roast-bot')
    const input = page.getByTestId('roast-bot-input')
    await input.fill('Why am I broke?')
    await input.press('Enter')
    await expect(page.getByTestId('roast-bot-user-msg').last()).toContainText('Why am I broke?')
  })

  test('missing account still allows sarcastic chat', async ({ page }) => {
    await page.goto('/roast-bot?noAccount=1')
    await expect(page.getByTestId('roast-bot-reply').first()).toContainText(/claimed game account|link one/i)
    await page.getByTestId('roast-bot-input').fill('Roast me')
    await page.getByTestId('roast-bot-send').click()
    await expect(page.getByTestId('roast-bot-reply').last()).toBeVisible()
  })

  test('mobile viewport keeps panel usable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/roast-bot')
    await expect(page.getByTestId('roast-bot-panel')).toBeVisible()
    await expect(page.getByTestId('roast-bot-input')).toBeVisible()
    await expect(page.getByTestId('roast-bot-send')).toBeVisible()
  })
})
