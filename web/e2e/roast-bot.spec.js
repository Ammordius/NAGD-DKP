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

  test('switching to Ammomats makes the next upgrade reply name Ammomats', async ({ page }) => {
    const rankings = {
      characters: [
        {
          name: 'Iaminae',
          class: 'Enchanter',
          inventory: [{ slot_id: 2, item_id: 100, item_name: 'Old Circlet' }],
        },
        {
          name: 'Ammomats',
          class: 'Magician',
          inventory: [{ slot_id: 17, item_id: 200, item_name: 'Old Robe' }],
        },
      ],
      class_weights: {
        Enchanter: { CHA: 1, INT: 1, AC: 0.2 },
        Magician: { INT: 1, HP: 0.5, AC: 0.2 },
      },
      focus_candidates: {},
    }
    await page.route('**/class_rankings.json', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(rankings),
      })
    })
    await page.route('**/item_stats.json', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          100: {
            name: 'Old Circlet',
            slot: 'HEAD',
            classes: 'ENC',
            ac: 5,
            mods: [{ label: 'CHA', value: 5 }],
            resists: [],
          },
          200: {
            name: 'Old Robe',
            slot: 'CHEST',
            classes: 'MAG',
            ac: 10,
            mods: [{ label: 'INT', value: 5 }],
            resists: [],
          },
          501: {
            name: 'Beguiler Circlet',
            slot: 'HEAD',
            classes: 'ENC',
            ac: 25,
            mods: [{ label: 'CHA', value: 20 }],
            resists: [],
          },
          601: {
            name: 'Elementalist Robe',
            slot: 'CHEST',
            classes: 'MAG',
            ac: 40,
            mods: [{ label: 'INT', value: 25 }],
            resists: [],
          },
        }),
      })
    })

    await page.goto('/roast-bot')
    await expect(page.getByTestId('roast-bot-character')).toBeVisible()
    await page.getByTestId('roast-bot-character').selectOption({ label: 'Iaminae (Enchanter)' })
    await page.getByTestId('roast-bot-input').fill('What should I buy for upgrades?')
    await page.getByTestId('roast-bot-send').click()
    await expect(page.getByTestId('roast-bot-reply').last()).toContainText(/Iaminae/i)

    await page.getByTestId('roast-bot-character').selectOption({ label: 'Ammomats (Magician)' })
    await page.getByTestId('roast-bot-input').fill('What upgrades should I buy?')
    await page.getByTestId('roast-bot-send').click()
    const reply = page.getByTestId('roast-bot-reply').last()
    await expect(reply).toContainText(/Ammomats/i)
    await expect(reply).not.toContainText(/Iaminae/i)
  })

  test('keyboard: Enter sends message', async ({ page }) => {
    await page.goto('/roast-bot')
    const input = page.getByTestId('roast-bot-input')
    await input.fill('Why am I broke?')
    await input.press('Enter')
    await expect(page.getByTestId('roast-bot-user-msg').last()).toContainText('Why am I broke?')
    await expect(page.getByTestId('roast-bot-reply').last()).toContainText(/42/)
    await expect(page.getByTestId('roast-bot-reply').last()).toContainText(/800|758|Beguiler Circlet|220/i)
  })

  test('clarification resumes gear assessment for Iaminae', async ({ page }) => {
    await page.goto('/roast-bot')
    await page.getByTestId('roast-bot-input').fill('Is this a well geared enchanter?')
    await page.getByTestId('roast-bot-send').click()
    await expect(page.getByTestId('roast-bot-reply').last()).toContainText(/which enchanter/i)
    await expect(page.getByTestId('roast-bot-reply').last()).toContainText(/Iaminae/i)

    await page.getByTestId('roast-bot-input').fill('Iaminae')
    await page.getByTestId('roast-bot-send').click()
    await expect(page.getByTestId('roast-bot-reply').last()).toContainText(/Iaminae/i)
    await expect(page.getByTestId('roast-bot-reply').last()).toContainText(/Magelo|gear|geared|unavailable|invent/i)
  })

  test('How does DKP work explains earn/spend/balance', async ({ page }) => {
    await page.goto('/roast-bot')
    await page.getByTestId('roast-bot-input').fill('How does DKP work?')
    await page.getByTestId('roast-bot-send').click()
    const reply = page.getByTestId('roast-bot-reply').last()
    await expect(reply).toContainText(/earn/i)
    await expect(reply).toContainText(/spend/i)
    await expect(reply).toContainText(/balance/i)
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
