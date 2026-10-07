import { describe, expect, it, vi } from 'vitest'
import { createInvitationHandler } from '../api/invitations.mjs'

const APP_ORIGIN = 'https://crm.example.com'
const WORKSPACE_ID = 'a16274f6-0000-4000-8000-000000000001'
const INVITATION_ID = 'b16274f6-0000-4000-8000-000000000002'
const TOKEN = '1234567890abcdef'.repeat(4)
const PRIVATE_KEY = 'sb_secret_private_UNIT'
const env = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_unit',
  SUPABASE_SECRET_KEY: PRIVATE_KEY,
  CLOSER_APP_URL: `${APP_ORIGIN}/`,
}
const invitation = {
  id: INVITATION_ID,
  email: 'new.client@example.com',
  role: 'closer',
  token: TOKEN,
  expires_at: '2026-11-07T12:00:00Z',
}

function fixture() {
  const events: string[] = []
  const getUser = vi.fn(async (_jwt: string) => {
    events.push('validate-session')
    return {
      data: { user: { id: 'c16274f6-0000-4000-8000-000000000003', email: 'admin@example.com', email_confirmed_at: '2026-10-01T12:00:00Z' } },
      error: null,
    }
  })
  const rpc = vi.fn(async (name: string, _args: unknown) => {
    events.push(name)
    return name === 'invite_member' ? { data: { ...invitation }, error: null } : { data: null, error: null }
  })
  const inviteUserByEmail = vi.fn(async (_email: string, _options: unknown) => {
    events.push('send-invite')
    return { data: { user: { id: 'new-user-id' } }, error: null }
  })
  const signInWithOtp = vi.fn(async (_options: unknown) => {
    events.push('send-existing-user-link')
    return { data: { user: null, session: null }, error: null }
  })
  const publicClient = { auth: { getUser }, rpc }
  const serviceClient = { auth: { admin: { inviteUserByEmail }, signInWithOtp } }
  const createClient = vi.fn((_url: string, key: string, _options: unknown) => {
    events.push(key === PRIVATE_KEY ? 'create-service' : 'create-public')
    return key === PRIVATE_KEY ? serviceClient : publicClient
  })
  const handler = createInvitationHandler({ env: { ...env }, createClient })
  return { events, getUser, rpc, inviteUserByEmail, signInWithOtp, createClient, handler }
}

function request(changes: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    headers: { origin: APP_ORIGIN, authorization: 'Bearer test-session', 'content-type': 'application/json' },
    body: { workspaceId: WORKSPACE_ID, email: invitation.email, role: invitation.role },
    ...changes,
  }
}

async function invoke(handler: ReturnType<typeof createInvitationHandler>, req = request()) {
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as any,
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; return this },
    status(status: number) { this.statusCode = status; return this },
    json(body: unknown) { this.body = body; return this },
    end() { return this },
  }
  await handler(req, response)
  return response
}

function expectNoMailer(f: ReturnType<typeof fixture>) {
  expect(f.createClient.mock.calls.some(([, key]) => key === PRIVATE_KEY)).toBe(false)
  expect(f.inviteUserByEmail).not.toHaveBeenCalled()
  expect(f.signInWithOtp).not.toHaveBeenCalled()
}

function expectSafeError(response: Awaited<ReturnType<typeof invoke>>) {
  expect(response.body).toEqual({ error: { code: expect.any(String), message: expect.any(String) } })
  expect(JSON.stringify(response.body)).not.toContain(PRIVATE_KEY)
  expect(JSON.stringify(response.body)).not.toContain(TOKEN)
}

describe('server invitation authorization', () => {
  it.each([
    ['missing authorization', { origin: APP_ORIGIN, 'content-type': 'application/json' }],
    ['non-bearer authorization', { origin: APP_ORIGIN, 'content-type': 'application/json', authorization: 'Basic user-password' }],
  ])('rejects %s before making a Supabase client', async (_name, headers) => {
    const f = fixture()
    const response = await invoke(f.handler, request({ headers }))
    expect(response.statusCode).toBe(401)
    expect(f.createClient).not.toHaveBeenCalled()
    expectNoMailer(f)
    expectSafeError(response)
  })

  it('validates the bearer session with Supabase before calling the invitation RPC', async () => {
    const f = fixture()
    f.getUser.mockResolvedValueOnce({ data: { user: null } as any, error: { message: PRIVATE_KEY } as any })
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(401)
    expect(f.getUser).toHaveBeenCalledWith('test-session')
    expect(f.rpc).not.toHaveBeenCalled()
    expectNoMailer(f)
    expectSafeError(response)
  })

  it.each([
    ['unconfirmed email', { id: 'user', email: 'admin@example.com', email_confirmed_at: null }],
    ['missing account email', { id: 'user', email: null, email_confirmed_at: '2026-10-01T12:00:00Z' }],
  ])('blocks %s before creating an invitation or using the service key', async (_name, user) => {
    const f = fixture()
    f.getUser.mockResolvedValueOnce({ data: { user } as any, error: null })
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(403)
    expect(f.rpc).not.toHaveBeenCalled()
    expectNoMailer(f)
    expectSafeError(response)
  })

  it('lets the caller-scoped RPC reject a foreign workspace before any mailer exists', async () => {
    const f = fixture()
    f.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: `Forbidden ${PRIVATE_KEY}` } } as any)
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(403)
    expect(f.rpc).toHaveBeenCalledTimes(1)
    expect(f.rpc).toHaveBeenCalledWith('invite_member', {
      p_workspace_id: WORKSPACE_ID, p_email: invitation.email, p_role: 'closer',
    })
    const options = f.createClient.mock.calls[0][2] as any
    expect(options.global.headers.Authorization).toBe('Bearer test-session')
    expectNoMailer(f)
    expectSafeError(response)
  })

  it.each(['23514', '23505'])('does not send mail when database limits or conflicts reject the invitation (%s)', async code => {
    const f = fixture()
    f.rpc.mockResolvedValueOnce({ data: null, error: { code, message: PRIVATE_KEY } } as any)
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(409)
    expectNoMailer(f)
    expectSafeError(response)
  })

  it('does not create a service client when the database returns no valid invitation', async () => {
    const f = fixture()
    f.rpc.mockResolvedValueOnce({ data: null, error: null })
    const response = await invoke(f.handler)
    expect(response.statusCode).toBeGreaterThanOrEqual(500)
    expectNoMailer(f)
    expectSafeError(response)
  })
})

describe('invitation mail delivery', () => {
  it('creates and authorizes a database invitation before sending a new-user invite', async () => {
    const f = fixture()
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(201)
    expect(response.body).toEqual({ invitation, url: `${APP_ORIGIN}/?invite=${TOKEN}`, emailSent: true })
    expect(f.events).toEqual(['create-public', 'validate-session', 'invite_member', 'create-service', 'send-invite'])
    expect(f.inviteUserByEmail).toHaveBeenCalledTimes(1)
    const serviceOptions = f.createClient.mock.calls.find(([, key]) => key === PRIVATE_KEY)?.[2] as any
    expect(serviceOptions?.auth?.flowType).not.toBe('pkce')
    const [email, options] = f.inviteUserByEmail.mock.calls[0] as any
    expect(email).toBe(invitation.email)
    const redirect = new URL(options.redirectTo)
    expect(redirect.origin).toBe(APP_ORIGIN)
    expect(redirect.pathname).toBe('/')
    expect(redirect.searchParams.get('invite')).toBe(TOKEN)
    expect(redirect.searchParams.get('flow')).toBe('activate')
    expect(f.signInWithOtp).not.toHaveBeenCalled()
    expect(JSON.stringify(response.body)).not.toContain(PRIVATE_KEY)
  })

  it.each(['admin', 'manager', 'closer', 'viewer'])('preserves the requested %s role in the caller-scoped database operation', async role => {
    const f = fixture()
    f.rpc.mockResolvedValueOnce({ data: { ...invitation, role }, error: null })
    const response = await invoke(f.handler, request({ body: { workspaceId: WORKSPACE_ID, email: invitation.email, role } }))
    expect(response.statusCode).toBe(201)
    expect(f.rpc).toHaveBeenCalledWith('invite_member', { p_workspace_id: WORKSPACE_ID, p_email: invitation.email, p_role: role })
    expect(response.body.invitation.role).toBe(role)
  })

  it('builds links from the configured application URL instead of the forwarded host', async () => {
    const f = fixture()
    const response = await invoke(f.handler, request({
      headers: { ...request().headers, host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' },
    }))
    expect(response.statusCode).toBe(201)
    const [, options] = f.inviteUserByEmail.mock.calls[0] as any
    expect(new URL(options.redirectTo).origin).toBe(APP_ORIGIN)
    expect(new URL(response.body.url).origin).toBe(APP_ORIGIN)
    expect(JSON.stringify(response.body)).not.toContain('evil.example')
  })

  it.each(['redirectTo', 'origin'])('rejects an attempted %s body override before sending mail', async field => {
    const f = fixture()
    const response = await invoke(f.handler, request({ body: { ...request().body, [field]: 'https://evil.example/steal' } }))
    expect(response.statusCode).toBe(400)
    expect(f.rpc).not.toHaveBeenCalled()
    expectNoMailer(f)
    expectSafeError(response)
  })

  it.each(['email_exists', 'user_already_exists'])('sends an existing-user sign-in link when Auth reports %s', async code => {
    const f = fixture()
    f.inviteUserByEmail.mockResolvedValueOnce({ data: null, error: { code, status: 422, message: 'Account already exists' } } as any)
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(201)
    expect(response.body.emailSent).toBe(true)
    expect(f.signInWithOtp).toHaveBeenCalledExactlyOnceWith({
      email: invitation.email,
      options: { shouldCreateUser: false, emailRedirectTo: `${APP_ORIGIN}/?invite=${TOKEN}` },
    })
    const options = f.signInWithOtp.mock.calls[0][0] as any
    expect(new URL(options.options.emailRedirectTo).searchParams.has('flow')).toBe(false)
    expect(f.rpc.mock.calls.filter(([name]) => name === 'revoke_invitation')).toHaveLength(0)
  })

  it('revokes exactly the newly created invitation when sending fails', async () => {
    const f = fixture()
    f.inviteUserByEmail.mockResolvedValueOnce({ data: null, error: { code: 'unexpected_failure', message: `Provider leaked ${PRIVATE_KEY}` } } as any)
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(502)
    expect(f.rpc.mock.calls.filter(([name]) => name === 'revoke_invitation')).toEqual([
      ['revoke_invitation', { p_workspace_id: WORKSPACE_ID, p_invitation_id: INVITATION_ID }],
    ])
    expect(f.signInWithOtp).not.toHaveBeenCalled()
    expectSafeError(response)
  })

  it('revokes the pending invitation when the existing-user fallback fails', async () => {
    const f = fixture()
    f.inviteUserByEmail.mockResolvedValueOnce({ data: null, error: { code: 'email_exists', message: 'Account already exists' } } as any)
    f.signInWithOtp.mockResolvedValueOnce({ data: null, error: { code: 'unexpected_failure', message: PRIVATE_KEY } } as any)
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(502)
    expect(f.rpc.mock.calls.filter(([name]) => name === 'revoke_invitation')).toEqual([
      ['revoke_invitation', { p_workspace_id: WORKSPACE_ID, p_invitation_id: INVITATION_ID }],
    ])
    expectSafeError(response)
  })

  it('also rolls back a thrown transport failure without exposing its details', async () => {
    const f = fixture()
    f.inviteUserByEmail.mockRejectedValueOnce(new Error(`Connection failed: ${PRIVATE_KEY}`))
    const response = await invoke(f.handler)
    expect([502, 503]).toContain(response.statusCode)
    expect(f.rpc.mock.calls.filter(([name]) => name === 'revoke_invitation')).toEqual([
      ['revoke_invitation', { p_workspace_id: WORKSPACE_ID, p_invitation_id: INVITATION_ID }],
    ])
    expectSafeError(response)
  })

  it('reports a temporary delivery limitation and releases the reserved invitation', async () => {
    const f = fixture()
    f.inviteUserByEmail.mockResolvedValueOnce({ data: null, error: { code: 'over_email_send_rate_limit', status: 429, message: PRIVATE_KEY } } as any)
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(503)
    expect(f.rpc).toHaveBeenCalledWith('revoke_invitation', { p_workspace_id: WORKSPACE_ID, p_invitation_id: INVITATION_ID })
    expectSafeError(response)
  })

  it('reports that manual revocation is required if rollback also fails', async () => {
    const f = fixture()
    f.inviteUserByEmail.mockResolvedValueOnce({ data: null, error: { code: 'unexpected_failure', message: PRIVATE_KEY } } as any)
    f.rpc.mockResolvedValueOnce({ data: invitation, error: null })
    f.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: PRIVATE_KEY } } as any)
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(503)
    expect(response.body.error.message).toMatch(/revog|manual/i)
    expect(f.rpc.mock.calls.filter(([name]) => name === 'revoke_invitation')).toHaveLength(1)
    expectSafeError(response)
  })

  it('does not revoke a newer invite when the exact failed invite was concurrently consumed', async () => {
    const f = fixture()
    f.inviteUserByEmail.mockResolvedValueOnce({ data: null, error: { code: 'unexpected_failure', message: PRIVATE_KEY } } as any)
    f.rpc.mockResolvedValueOnce({ data: invitation, error: null })
    f.rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0002', message: 'Invitation is no longer pending' } } as any)
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(502)
    expect(f.rpc.mock.calls.filter(([name]) => name === 'revoke_invitation')).toEqual([
      ['revoke_invitation', { p_workspace_id: WORKSPACE_ID, p_invitation_id: INVITATION_ID }],
    ])
    expectSafeError(response)
  })

  it.each([
    { email: 'another-person@example.com' },
    { role: 'admin' },
    { token: 'invalid-token' },
    { expires_at: 'invalid-date' },
  ])('rolls back a mismatched or unusable database invitation %# without sending mail', async change => {
    const f = fixture()
    f.rpc.mockResolvedValueOnce({ data: { ...invitation, ...change }, error: null })
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(502)
    expectNoMailer(f)
    expect(f.rpc.mock.calls.filter(([name]) => name === 'revoke_invitation')).toEqual([
      ['revoke_invitation', { p_workspace_id: WORKSPACE_ID, p_invitation_id: INVITATION_ID }],
    ])
    expectSafeError(response)
  })
})

describe('invitation endpoint input and configuration', () => {
  it.each(['GET', 'PUT', 'DELETE'])('rejects %s without invoking Supabase', async method => {
    const f = fixture()
    const response = await invoke(f.handler, request({ method }))
    expect(response.statusCode).toBe(405)
    expect(f.createClient).not.toHaveBeenCalled()
    expectNoMailer(f)
  })

  it('blocks an untrusted origin before account validation', async () => {
    const f = fixture()
    const response = await invoke(f.handler, request({ headers: { ...request().headers, origin: 'https://evil.example' } }))
    expect(response.statusCode).toBe(403)
    expect(f.createClient).not.toHaveBeenCalled()
    expectNoMailer(f)
    expectSafeError(response)
  })

  it.each([
    null,
    [],
    '{broken-json',
    { workspaceId: 'not-a-uuid', email: invitation.email, role: 'closer' },
    { workspaceId: WORKSPACE_ID, email: 'not-an-email', role: 'closer' },
    { workspaceId: WORKSPACE_ID, email: invitation.email, role: 'platform_admin' },
    { workspaceId: WORKSPACE_ID, email: invitation.email },
    { workspaceId: WORKSPACE_ID, email: invitation.email, role: { toString: 'admin' } },
  ])('rejects malformed input %# before a database or mailer operation', async body => {
    const f = fixture()
    const response = await invoke(f.handler, request({ body }))
    expect(response.statusCode).toBe(400)
    expect(f.rpc).not.toHaveBeenCalled()
    expectNoMailer(f)
    expectSafeError(response)
  })

  it.each([undefined, 'text/plain'])('rejects a non-JSON content type (%s)', async contentType => {
    const f = fixture()
    const headers: Record<string, string> = { origin: APP_ORIGIN, authorization: 'Bearer test-session' }
    if (contentType) headers['content-type'] = contentType
    const response = await invoke(f.handler, request({ headers }))
    expect(response.statusCode).toBe(415)
    expect(f.createClient).not.toHaveBeenCalled()
    expectNoMailer(f)
    expectSafeError(response)
  })

  it('accepts a valid JSON-encoded request body', async () => {
    const f = fixture()
    const response = await invoke(f.handler, request({ body: JSON.stringify(request().body) }))
    expect(response.statusCode).toBe(201)
  })

  it('rejects an oversized request before parsing it or using service credentials', async () => {
    const f = fixture()
    const response = await invoke(f.handler, request({ body: JSON.stringify({ ...request().body, padding: 'x'.repeat(100_000) }) }))
    expect(response.statusCode).toBe(413)
    expect(f.createClient).not.toHaveBeenCalled()
    expectNoMailer(f)
    expectSafeError(response)
  })

  it.each(['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'CLOSER_APP_URL'])('fails closed when %s is missing', async name => {
    const f = fixture()
    const missing = { ...env, [name]: '' }
    const handler = createInvitationHandler({ env: missing, createClient: f.createClient })
    const response = await invoke(handler)
    expect(response.statusCode).toBe(503)
    expect(f.createClient).not.toHaveBeenCalled()
    expectNoMailer(f)
    expectSafeError(response)
  })
})
