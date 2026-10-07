import { defineConfig, devices } from '@playwright/test'
import { existsSync } from 'node:fs'

const chromiumPath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined)

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/saas.spec.ts', '**/admin.spec.ts'],
  outputDir: './.playwright/saas-results',
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:5174',
    locale: 'pt-BR',
    timezoneId: 'America/Bahia',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: chromiumPath, args: ['--no-sandbox'] },
  },
  webServer: {
    command: 'npm run dev -- --port 5174 --strictPort',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      VITE_SUPABASE_URL: 'https://test.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_testing',
      VITE_SUPABASE_ANON_KEY: '',
      VITE_SUPPORT_EMAIL: 'support@example.com',
    },
  },
})
