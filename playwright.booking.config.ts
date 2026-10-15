import { defineConfig } from '@playwright/test'
import featureConfig from './playwright.features.config'

export default defineConfig({
  ...featureConfig,
  testMatch: '**/booking.spec.ts',
  outputDir: './.playwright/booking-results',
  use: { ...featureConfig.use, baseURL: 'http://127.0.0.1:5194' },
  webServer: {
    ...featureConfig.webServer,
    command: 'npm run dev -- --port 5194 --strictPort',
    url: 'http://127.0.0.1:5194',
  },
})
