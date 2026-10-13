import { defineConfig, devices } from '@playwright/test'
import { existsSync } from 'node:fs'

export default defineConfig({
  testDir: './tests', testMatch: '**/smart-import.spec.ts', outputDir: './.playwright/smart-import-results',
  fullyParallel: true, workers: 2, timeout: 90_000, expect: { timeout: 10_000 }, reporter: 'list',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:5184', locale: 'pt-BR', timezoneId: 'America/Bahia',
    reducedMotion: 'reduce', trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: { executablePath: existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined, args: ['--no-sandbox'] } },
  webServer: { command: 'npm run dev -- --port 5184 --strictPort', url: 'http://127.0.0.1:5184', reuseExistingServer: false,
    timeout: 30_000, env: { VITE_SUPABASE_URL: 'https://test.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_testing', VITE_SUPABASE_ANON_KEY: '' } },
})
