import { defineConfig } from '@playwright/test'
import featureConfig from './playwright.features.config'

export default defineConfig({
  ...featureConfig,
  testMatch: '**/no-show.spec.ts',
  outputDir: './.playwright/no-show-results',
  use: { ...featureConfig.use, baseURL: 'http://127.0.0.1:5193' },
  webServer: {
    ...featureConfig.webServer,
    command: 'npm run dev -- --port 5193 --strictPort',
    url: 'http://127.0.0.1:5193',
  },
})
