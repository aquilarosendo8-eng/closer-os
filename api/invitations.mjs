import { createClient as supabaseClient } from '@supabase/supabase-js'

export const config = { maxDuration: 60 }

const BODY_LIMIT = 2048
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN = /^[a-f0-9]{64}$/
const ROLES = new Set(['admin', 'manager', 'closer', 'viewer'])
const EMAIL = /^[^\s@<>"\\]+@[^\s@<>"\\]+\.[^\s@<>"\\]+$/

class RequestError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code }
}
const reject = (status, code, message) => { throw new RequestError(status, code, message) }
const header = (request, name) => typeof request.headers?.[name] === 'string' ? request.headers[name] : ''
const first = (env, ...names) => names.map(name => env[name]).find(Boolean) || ''
function keyRole(key) {
  try { return JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role } catch { return '' }
}

async function requestBody(request) {
  const contentType = header(request, 'content-type').split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json') reject(415, 'JSON_REQUIRED', 'Envie o convite no formato JSON.')
  const declaredSize = Number(header(request, 'content-length'))
  if (declaredSize > BODY_LIMIT) reject(413, 'BODY_TOO_LARGE', 'Os dados do convite excedem o limite permitido.')
  let body = request.body
  if (body === undefined) {
    let size = 0
    const chunks = []
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > BODY_LIMIT) reject(413, 'BODY_TOO_LARGE', 'Os dados do convite excedem o limite permitido.')
      chunks.push(buffer)
    }
    body = Buffer.concat(chunks).toString('utf8')
  }
  if (Buffer.isBuffer(body)) body = body.toString('utf8')
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > BODY_LIMIT) reject(413, 'BODY_TOO_LARGE', 'Os dados do convite excedem o limite permitido.')
    try { body = JSON.parse(body) } catch { reject(400, 'INVALID_INVITATION', 'Informe a empresa, o e-mail e o perfil do convite.') }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) reject(400, 'INVALID_INVITATION', 'Informe a empresa, o e-mail e o perfil do convite.')
  if (Buffer.byteLength(JSON.stringify(body)) > BODY_LIMIT) reject(413, 'BODY_TOO_LARGE', 'Os dados do convite excedem o limite permitido.')
  if (Object.keys(body).some(key => !['workspaceId', 'email', 'role'].includes(key))) reject(400, 'INVALID_INVITATION', 'O convite contém campos não permitidos.')
  const { workspaceId, role } = body
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (typeof workspaceId !== 'string' || !UUID.test(workspaceId) || !EMAIL.test(email) || email.length > 254 || !ROLES.has(role)) {
    reject(400, 'INVALID_INVITATION', 'Informe uma empresa válida, um e-mail válido e um perfil permitido.')
  }
  return { workspaceId, email, role }
}

function rpcFailure(error) {
  if (error?.code === '42501') reject(403, 'INVITATION_FORBIDDEN', 'Seu acesso não permite convidar pessoas para esta empresa.')
  if (error?.code === '23514') reject(409, 'INVITATION_LIMIT', 'Verifique o plano e o limite de acessos antes de enviar outro convite.')
  if (error?.code === '23505') reject(409, 'ALREADY_A_MEMBER', 'Esta pessoa já possui acesso à empresa.')
  if (error?.code === '22023') reject(400, 'INVALID_INVITATION', 'Verifique o e-mail, o perfil e o administrador inicial da empresa.')
  if (error?.code === 'P0002') reject(404, 'WORKSPACE_NOT_FOUND', 'A empresa não foi encontrada.')
  reject(503, 'INVITATION_SERVICE_UNAVAILABLE', 'Não foi possível preparar o convite. Tente novamente em alguns instantes.')
}
function deliveryFailure(error) {
  const code = String(error?.code || '')
  if (code === 'over_email_send_rate_limit' || error?.status === 429) {
    return new RequestError(503, 'EMAIL_RATE_LIMITED', 'O provedor limitou temporariamente o envio de e-mails. Aguarde alguns minutos e tente novamente.')
  }
  if (['email_address_not_authorized', 'email_address_invalid'].includes(code) || /email.*not.*authoriz|only.*send.*email.*team|custom smtp|smtp.*config/i.test(String(error?.message || ''))) {
    return new RequestError(503, 'EMAIL_CONFIGURATION_REQUIRED', 'Configure o SMTP do Supabase para enviar convites a este destinatário. O convite foi cancelado.')
  }
  return new RequestError(502, 'EMAIL_DELIVERY_FAILED', 'Não foi possível enviar o e-mail de acesso. O convite foi cancelado. Verifique o envio de e-mails do Supabase e tente novamente.')
}

/** Dependency injection is used only by tests; production uses the official SDK. */
export function createInvitationHandler({ env = process.env, createClient = supabaseClient } = {}) {
  return async function invitations(request, response) {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Vary', 'Origin')
    let caller, pending, input
    let deadline = Date.now() + 25000
    try {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST')
        reject(405, 'METHOD_NOT_ALLOWED', 'Use POST para enviar um convite.')
      }
      const appUrlValue = first(env, 'CLOSER_APP_URL')
      let appUrl
      try { appUrl = new URL(appUrlValue) } catch { reject(503, 'CONFIGURATION_REQUIRED', 'O envio de convites ainda não está configurado pelo administrador.') }
      if (appUrl.protocol !== 'https:' || appUrl.username || appUrl.password) reject(503, 'CONFIGURATION_REQUIRED', 'O endereço de acesso precisa estar configurado com HTTPS.')
      appUrl.search = ''; appUrl.hash = ''
      if (header(request, 'origin') !== appUrl.origin) reject(403, 'ORIGIN_FORBIDDEN', 'Este convite precisa ser enviado pelo aplicativo autorizado.')
      const authorization = header(request, 'authorization')
      const bearer = authorization.match(/^Bearer ([A-Za-z0-9._~-]{10,8192})$/i)?.[1]
      if (!bearer) reject(401, 'AUTHENTICATION_REQUIRED', 'Entre na sua conta para enviar convites.')
      input = await requestBody(request)
      const supabaseUrl = first(env, 'SUPABASE_URL', 'VITE_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL')
      const publicKey = first(env, 'SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY')
      const serviceKey = first(env, 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY')
      let projectUrl
      try { projectUrl = new URL(supabaseUrl) } catch { reject(503, 'CONFIGURATION_REQUIRED', 'O envio de convites ainda não está configurado pelo administrador.') }
      if (projectUrl.protocol !== 'https:' || !projectUrl.hostname.endsWith('.supabase.co')
        || !(publicKey.startsWith('sb_publishable_') || keyRole(publicKey) === 'anon')
        || !(serviceKey.startsWith('sb_secret_') || keyRole(serviceKey) === 'service_role')) {
        reject(503, 'CONFIGURATION_REQUIRED', 'O envio de convites ainda não está configurado pelo administrador.')
      }
      const boundedFetch = (resource, init) => {
        const timeout = AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - Date.now())))
        const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
        return fetch(resource, { ...init, signal })
      }
      caller = createClient(supabaseUrl, publicKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'implicit' },
        global: { headers: { Authorization: `Bearer ${bearer}` }, fetch: boundedFetch },
      })
      const verified = await caller.auth.getUser(bearer)
      if (verified.error || !verified.data?.user?.id) reject(401, 'AUTHENTICATION_REQUIRED', 'Sua sessão expirou. Entre novamente para enviar convites.')
      if (!verified.data.user.email || !verified.data.user.email_confirmed_at) reject(403, 'EMAIL_CONFIRMATION_REQUIRED', 'Confirme o e-mail da sua conta antes de enviar convites.')

      // Authorization, tenancy, role and reserved seats are checked under the
      // caller's verified JWT before any privileged Auth operation is created.
      const prepared = await caller.rpc('invite_member', { p_workspace_id: input.workspaceId, p_email: input.email, p_role: input.role })
      if (prepared.error) rpcFailure(prepared.error)
      const record = prepared.data
      if (record && UUID.test(record.id || '')) pending = { workspaceId: input.workspaceId, id: record.id }
      if (!pending || !TOKEN.test(record.token || '') || record.email !== input.email || record.role !== input.role || !Number.isFinite(Date.parse(record.expires_at))) {
        reject(502, 'INVITATION_CREATION_FAILED', 'Não foi possível preparar um convite válido. Verifique os convites pendentes e tente novamente.')
      }
      const invitation = { id: record.id, email: record.email, role: record.role, token: record.token, expires_at: record.expires_at }
      const invitationUrl = new URL(appUrl); invitationUrl.searchParams.set('invite', invitation.token)
      const activationUrl = new URL(invitationUrl); activationUrl.searchParams.set('flow', 'activate')
      const mailer = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'implicit' },
        global: { fetch: boundedFetch },
      })
      let delivery = await mailer.auth.admin.inviteUserByEmail(input.email, { redirectTo: activationUrl.toString() })
      if (delivery.error && ['email_exists', 'user_already_exists'].includes(delivery.error.code)) {
        // Existing users receive a login link; no new account/password is created.
        delivery = await mailer.auth.signInWithOtp({ email: input.email, options: { shouldCreateUser: false, emailRedirectTo: invitationUrl.toString() } })
      }
      if (delivery.error) throw deliveryFailure(delivery.error)
      pending = null
      // Success means the provider accepted the mail request, not inbox delivery.
      return response.status(201).json({ invitation, url: invitationUrl.toString(), emailSent: true })
    } catch (cause) {
      let error = cause instanceof RequestError ? cause : new RequestError(503, 'INVITATION_SERVICE_UNAVAILABLE', 'O serviço de convites está indisponível. Tente novamente em alguns instantes.')
      if (pending && caller) {
        deadline = Date.now() + 15000
        try {
          const canceled = await caller.rpc('revoke_invitation', { p_workspace_id: pending.workspaceId, p_invitation_id: pending.id })
          // P0002 means this exact invitation was already consumed/revoked by
          // a concurrent action. Never revoke a newer invitation by email.
          if (canceled.error && canceled.error.code !== 'P0002') throw new Error('Cancellation failed')
        } catch {
          error = new RequestError(503, 'INVITATION_ROLLBACK_FAILED', 'Não foi possível enviar o e-mail nem cancelar este convite. Revogue o convite pendente antes de tentar novamente.')
        }
      }
      return response.status(error.status).json({ error: { code: error.code, message: error.message } })
    }
  }
}

export default createInvitationHandler()
