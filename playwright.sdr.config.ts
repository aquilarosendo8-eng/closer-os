import { defineConfig } from '@playwright/test'
import features from './playwright.features.config'

export default defineConfig({
  ...features,
  testMatch: '**/sdr.spec.ts',
  outputDir: './.playwright/sdr-results',
  use: { ...features.use, baseURL: 'http://127.0.0.1:5192' },
  webServer: { ...features.webServer, command: 'npm run dev -- --port 5192 --strictPort', url: 'http://127.0.0.1:5192' },
})
