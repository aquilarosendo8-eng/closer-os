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

export interface SignUpAccountInput {
  email: string
  password: string
  displayName: string
  companyName: string
  acceptTerms: boolean
}

/** Account creation does not create memberships or grant any platform role. */
export async function signUpAccount(input: SignUpAccountInput): Promise<{ pendingConfirmation: boolean }> {
  const email = input.email.trim().toLowerCase(), displayName = input.displayName.trim(), companyName = input.companyName.trim()
  if (!input.acceptTerms) throw new Error('Leia e aceite os termos de uso e a política de privacidade para continuar.')
  if (displayName.length < 2 || displayName.length > 120 || !companyName || companyName.length > 120) throw new Error('Informe seu nome e o nome da empresa.')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('Informe um e-mail válido.')
  if (input.password.length < 12 || input.password.length > 128) throw new Error('Use uma senha exclusiva com 12 a 128 caracteres.')
  const redirect = new URL(applicationUrl()); redirect.searchParams.set('signup', '1')
  const { data, error } = await requireSupabase().auth.signUp({
    email, password: input.password,
    options: { emailRedirectTo: redirect.toString(), data: { display_name: displayName, self_signup_company: companyName, self_signup_terms: true } },
  })
  if (error) throw new Error(readableError(error))
  if (data.user?.identities?.length === 0) throw new Error('Se você já possui conta, entre com sua senha ou use a recuperação de acesso.')
  return { pendingConfirmation: !data.session }
}

export function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String(error.message) : 'Não foi possível concluir. Tente novamente.'
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
  if (code === 'email_address_not_authorized' || /email.*not.*authoriz|only.*send.*email.*team/i.test(message)) return 'O envio de confirmações ainda não está configurado para este destinatário. Contate o administrador.'
  if (code === 'over_email_send_rate_limit' || /over_email_send_rate_limit/i.test(message)) return 'O envio de e-mails está temporariamente limitado. Aguarde alguns minutos e tente novamente.'
  if (['email_exists', 'user_already_exists'].includes(code)) return 'Este e-mail já possui uma conta. Entre com sua senha ou recupere o acesso.'
  if (/invalid login credentials|invalid_credentials/i.test(message)) return 'E-mail ou senha incorretos.'
  if (/email not confirmed/i.test(message)) return 'Confirme seu e-mail antes de entrar.'
  if (/row-level security|permission denied|not authorized|not_authorized|forbidden/i.test(message)) return 'Seu acesso não permite esta operação. Atualize a página ou consulte o administrador.'
  if (/failed to fetch|networkerror|network request/i.test(message)) return 'Não foi possível conectar. Verifique sua conexão e tente novamente.'
  if (/rate limit|too many requests/i.test(message)) return 'Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.'
  return message
}
