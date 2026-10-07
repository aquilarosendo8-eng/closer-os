import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/** Only public client credentials may enter this module or a Vite bundle. */
export function isPublicSupabaseKey(key: string): boolean {
  if (key.startsWith('sb_publishable_')) return true
  if (key.startsWith('sb_secret_')) return false
  try {
    const payload = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return payload.role === 'anon'
  } catch { return false }
}

const url = import.meta.env.VITE_SUPABASE_URL || ''
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || ''
export const cloudConfigured = Boolean(url && key && isPublicSupabaseKey(key))
// Admin-generated invitations have no originating browser/verifier and use an
// implicit callback. Its tokens still go through Auth's server-side getUser
// verification; the fragment itself never grants account or workspace access.
const callback = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.hash.slice(1))
const emailInvitation = typeof window !== 'undefined' && /^[a-f0-9]{64}$/i.test(new URLSearchParams(window.location.search).get('invite') || '')
const implicitEmailCallback = (['invite', 'recovery'].includes(callback.get('type') || '') || callback.get('type') === 'magiclink' && emailInvitation)
  && Boolean(callback.get('access_token') && callback.get('refresh_token'))
export const supabase: SupabaseClient | null = cloudConfigured ? createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: implicitEmailCallback ? 'implicit' : 'pkce' },
}) : null

export function requireSupabase(): SupabaseClient {
  if (!supabase) throw new Error('O login ainda não está configurado. Conecte o banco de dados antes de liberar acessos.')
  return supabase
}

export function applicationUrl(): string {
  const url = new URL(window.location.href)
  url.search = ''; url.hash = ''
  return url.toString()
}

export function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String(error.message) : 'Não foi possível concluir. Tente novamente.'
  if (/invalid login credentials|invalid_credentials/i.test(message)) return 'E-mail ou senha incorretos.'
  if (/email not confirmed/i.test(message)) return 'Confirme seu e-mail antes de entrar.'
  if (/row-level security|permission denied|not authorized|not_authorized|forbidden/i.test(message)) return 'Seu acesso não permite esta operação. Atualize a página ou consulte o administrador.'
  if (/failed to fetch|networkerror|network request/i.test(message)) return 'Não foi possível conectar. Verifique sua conexão e tente novamente.'
  if (/rate limit|too many requests/i.test(message)) return 'Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.'
  return message
}
