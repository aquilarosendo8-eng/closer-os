import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/')) {
            if (/recharts|d3-|internmap|decimal.js/.test(id)) return 'charts'
            if (/\/(react|react-dom|scheduler)\//.test(id)) return 'react'
          }
        },
      },
    },
  },
})
