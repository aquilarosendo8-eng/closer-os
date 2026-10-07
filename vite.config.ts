import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  // The Supabase Vercel integration uses these aliases. Never expose its service key.
  const url = env.VITE_SUPABASE_URL || env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || ''
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
  if (env.VERCEL_ENV === 'production' && (!url || !key)) throw new Error('Configure o Supabase antes de publicar o acesso privado em produção.')
  if (key) {
    let publicKey = key.startsWith('sb_publishable_')
    try { publicKey ||= JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role === 'anon' } catch { /* publishable keys are not JWTs */ }
    if (!publicKey || key.startsWith('sb_secret_')) throw new Error('A configuração do frontend exige a chave pública do Supabase. Chaves administrativas não podem entrar no build.')
  }
  return {
  plugins: [react()],
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(url),
    'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(key),
  },
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
  }
})
