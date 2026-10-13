import { defineConfig } from '@playwright/test'
import featureConfig from './playwright.features.config'

export default defineConfig({
  ...featureConfig,
  testMatch: '**/kanban-scroll.spec.ts',
  outputDir: './.playwright/kanban-results',
  use: { ...featureConfig.use, baseURL: 'http://127.0.0.1:5191' },
  webServer: {
    ...featureConfig.webServer,
    command: 'npm run dev -- --port 5191 --strictPort',
    url: 'http://127.0.0.1:5191',
  },
})
