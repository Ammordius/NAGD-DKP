import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:4178',
    viewport: { width: 1280, height: 640 },
  },
  webServer: {
    command: 'npx vite --config vite.e2e.config.js --port 4178 --strictPort',
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
})
