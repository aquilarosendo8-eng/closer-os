import { describe, expect, it, vi } from 'vitest'
import { createInvitationLinkHandler } from '../api/invitation-link.mjs'
import { createInvitationHandler } from '../api/invitations.mjs'

const APP = 'https://crm.example.com/'
const PROJECT = 'https://test.supabase.co'
const WORKSPACE = '10000000-0000-4000-8000-000000000001'
const INVITATION = '20000000-0000-4000-8000-000000000002'
const NEW_USER = '30000000-0000-4000-8000-000000000003'
const TOKEN = 'a'.repeat(64)
const SECRET = 'sb_secret_private_test'
const env = { CLOSER_APP_URL: APP, SUPABASE_URL: PROJECT, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: SECRET }

function providerLink(type: string, redirect: string) {
  const url = new URL('/auth/v1/verify', PROJECT)
  url.search = new URLSearchParams({ type, token: 'provider-verification-hash', redirect_to: redirect }).toString()
  return url.toString()
}
function fixture() {
  const events: string[] = []
  const getUser = vi.fn(async () => ({ data: { user: { id: 'actor', email: 'admin@example.com', email_confirmed_at: '2026-10-07T00:00:00Z' } }, error: null }))
  const rpc = vi.fn(async (name: string, args: any) => {
    events.push(name)
    return { data: name === 'invite_member' ? { id: INVITATION, email: args.p_email, role: args.p_role, name: args.p_name ?? null, token: TOKEN, expires_at: '2030-01-01T00:00:00Z' } : null, error: null }
  })
  const createUser = vi.fn(async (_input: any) => {
    events.push('create-new-auth')
    return { data: { user: { id: NEW_USER, email: 'client@example.com', email_confirmed_at: null } }, error: null }
  })
  const generateLink = vi.fn(async (input: any) => {
    events.push(`generate-${input.type}`)
    return { data: { properties: { action_link: providerLink(input.type, input.options.redirectTo), email_otp: 'do-not-return-otp', access_token: 'do-not-return-session' }, user: { id: NEW_USER, role: 'do-not-return-user' } }, error: null }
  })
  const inviteUserByEmail = vi.fn(async () => ({ data: {}, error: null }))
  const signInWithOtp = vi.fn(async () => ({ data: {}, error: null }))
  const createClient = vi.fn((_url: string, key: string, _options: any) => {
    events.push(key === SECRET ? 'privileged-client' : 'caller-client')
    return key === SECRET ? { auth: { admin: { createUser, generateLink, inviteUserByEmail }, signInWithOtp } } : { auth: { getUser }, rpc }
  })
  return { events, getUser, rpc, createUser, generateLink, inviteUserByEmail, signInWithOtp, createClient,
    handler: createInvitationLinkHandler({ env, createClient }), emailHandler: createInvitationHandler({ env, createClient }) }
}
function request(name: string | null = 'Maria Silva') {
  return { method: 'POST', headers: { origin: 'https://crm.example.com', authorization: 'Bearer test-session', 'content-type': 'application/json' }, body: { workspaceId: WORKSPACE, email: 'client@example.com', role: 'closer', name } }
}
async function invoke(handler: any, req = request()) {
  const res = { statusCode: 200, body: null as any, headers: {} as Record<string, string>,
    setHeader(key: string, value: string) { this.headers[key] = value }, status(code: number) { this.statusCode = code; return this }, json(body: unknown) { this.body = body; return this } }
  await handler(req, res)
  return res
}
const rollback = { p_workspace_id: WORKSPACE, p_invitation_id: INVITATION }

describe('manual access link', () => {
  it('authorizes the caller then generates an activation link without using SMTP or returning SDK credentials', async () => {
    const f = fixture(), res = await invoke(f.handler, request('  Maria Silva  '))
    expect(res.statusCode).toBe(201)
    expect(f.events).toEqual(['caller-client', 'invite_member', 'privileged-client', 'create-new-auth', 'generate-invite'])
    expect(f.rpc).toHaveBeenCalledWith('invite_member', { p_workspace_id: WORKSPACE, p_email: 'client@example.com', p_role: 'closer', p_name: 'Maria Silva' })
    expect(f.createUser).toHaveBeenCalledExactlyOnceWith({ email: 'client@example.com', email_confirm: false, user_metadata: { display_name: 'Maria Silva' } })
    expect(f.generateLink).toHaveBeenCalledExactlyOnceWith({ type: 'invite', email: 'client@example.com', options: { redirectTo: `${APP}?invite=${TOKEN}&flow=activate`, data: { display_name: 'Maria Silva' } } })
    expect(res.body.manualLink).toBe(true)
    expect(res.body.emailSent).toBeUndefined()
    expect(res.body.invitation.name).toBe('Maria Silva')
    expect(res.body.url).toBe(providerLink('invite', `${APP}?invite=${TOKEN}&flow=activate`))
    expect(Object.keys(res.body)).toEqual(['invitation', 'url', 'manualLink'])
    for (const privateValue of [SECRET, 'do-not-return-otp', 'do-not-return-session', 'do-not-return-user']) expect(JSON.stringify(res.body)).not.toContain(privateValue)
    expect(f.inviteUserByEmail).not.toHaveBeenCalled()
    expect(f.signInWithOtp).not.toHaveBeenCalled()
  })

  it.each(['42501', '23514'])('does not create privileged Auth links when the caller RPC rejects access or seats (%s)', async code => {
    const f = fixture(); f.rpc.mockResolvedValueOnce({ data: null, error: { code, message: SECRET } } as any)
    const res = await invoke(f.handler)
    expect(res.statusCode).toBe(code === '42501' ? 403 : 409)
    expect(f.createClient).toHaveBeenCalledTimes(1)
    expect(f.createUser).not.toHaveBeenCalled()
    expect(f.generateLink).not.toHaveBeenCalled()
    expect(JSON.stringify(res.body)).not.toContain(SECRET)
  })

  it.each(['email_exists', 'user_already_exists'])('requires the existing account to sign in without returning a credential (%s)', async code => {
    const f = fixture(); f.createUser.mockResolvedValueOnce({ data: null, error: { code, message: SECRET } } as any)
    const res = await invoke(f.handler)
    expect(res.statusCode).toBe(201)
    expect(f.generateLink).not.toHaveBeenCalled()
    expect(res.body).toMatchObject({ url: `${APP}?invite=${TOKEN}&login=1`, manualLink: true, requiresSignIn: true })
    expect(res.body.emailSent).toBeUndefined()
    expect(res.body.url).not.toContain('/auth/v1/verify')
    expect(res.body.url).not.toContain('provider-verification-hash')
    expect(JSON.stringify(res.body)).not.toContain(SECRET)
    expect(f.rpc).not.toHaveBeenCalledWith('revoke_invitation', expect.anything())
    expect(f.inviteUserByEmail).not.toHaveBeenCalled()
    expect(f.signInWithOtp).not.toHaveBeenCalled()
  })

  it('never creates an Auth identity for an unverified caller', async () => {
    const f = fixture(); f.getUser.mockResolvedValueOnce({ data: { user: null }, error: { message: SECRET } } as any)
    const res = await invoke(f.handler)
    expect(res.statusCode).toBe(401)
    expect(f.rpc).not.toHaveBeenCalled()
    expect(f.createUser).not.toHaveBeenCalled()
    expect(f.generateLink).not.toHaveBeenCalled()
  })

  it('rolls back an unknown account-creation error instead of treating it as an existing account', async () => {
    const f = fixture(); f.createUser.mockResolvedValueOnce({ data: null, error: { code: 'unexpected_failure', message: SECRET } } as any)
    const res = await invoke(f.handler)
    expect(res.statusCode).toBe(502)
    expect(f.generateLink).not.toHaveBeenCalled()
    expect(f.rpc).toHaveBeenCalledWith('revoke_invitation', rollback)
    expect(res.body.url).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain(SECRET)
  })

  it('does not return a credential for a different identity than the newly created account', async () => {
    const f = fixture(); f.generateLink.mockResolvedValueOnce({ data: { user: { id: WORKSPACE }, properties: { action_link: providerLink('invite', `${APP}?invite=${TOKEN}&flow=activate`) } }, error: null } as any)
    const res = await invoke(f.handler)
    expect(res.statusCode).toBe(502)
    expect(f.rpc).toHaveBeenCalledWith('revoke_invitation', rollback)
    expect(res.body.url).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain('provider-verification-hash')
  })

  it.each([
    ['http://test.supabase.co/auth/v1/verify?token=x&type=invite', 502],
    ['https://evil.example/auth/v1/verify?token=x&type=invite', 502],
    [`https://secret@test.supabase.co/auth/v1/verify?token=x&type=invite`, 502],
    [providerLink('magiclink', `${APP}?invite=${TOKEN}&flow=activate`), 502],
    [providerLink('invite', 'http://localhost:3000/'), 503],
  ])('rejects unsafe provider links and revokes only the new invitation', async (link, status) => {
    const f = fixture(); f.generateLink.mockResolvedValueOnce({ data: { user: { id: NEW_USER }, properties: { action_link: link } }, error: null } as any)
    const res = await invoke(f.handler)
    expect(res.statusCode).toBe(status)
    expect(f.rpc).toHaveBeenCalledWith('revoke_invitation', rollback)
    expect(JSON.stringify(res.body)).not.toContain(SECRET)
    expect(res.body.url).toBeUndefined()
  })

  it('rolls back provider failures and reports failed rollback honestly', async () => {
    const f = fixture(); f.generateLink.mockRejectedValueOnce(new Error(SECRET))
    f.rpc.mockImplementation(async (name: string, args: any) => name === 'revoke_invitation' ? { data: null, error: { code: '42501', message: SECRET } } as any : { data: { id: INVITATION, email: args.p_email, role: args.p_role, token: TOKEN, expires_at: '2030-01-01T00:00:00Z' }, error: null })
    const res = await invoke(f.handler)
    expect(res.statusCode).toBe(503)
    expect(res.body.error.code).toBe('INVITATION_ROLLBACK_FAILED')
    expect(res.body.error.message).toContain('Revogue o convite pendente')
    expect(f.rpc).toHaveBeenCalledWith('revoke_invitation', rollback)
    expect(JSON.stringify(res.body)).not.toContain(SECRET)
  })

  it('supports legacy invitations without a name while never adding role metadata', async () => {
    const f = fixture(), res = await invoke(f.handler, request(null))
    expect(res.statusCode).toBe(201)
    expect(f.rpc).toHaveBeenCalledWith('invite_member', { p_workspace_id: WORKSPACE, p_email: 'client@example.com', p_role: 'closer' })
    expect(f.generateLink.mock.calls[0][0].options.data).toBeUndefined()
    expect(f.createUser).toHaveBeenCalledExactlyOnceWith({ email: 'client@example.com', email_confirm: false })
  })
})

describe('named email invitations', () => {
  it('stores the name in the caller RPC and uses it only as display-name metadata in Auth', async () => {
    const f = fixture(), res = await invoke(f.emailHandler)
    expect(res.statusCode).toBe(201)
    expect(res.body.emailSent).toBe(true)
    expect(res.body.invitation.name).toBe('Maria Silva')
    expect(f.inviteUserByEmail).toHaveBeenCalledExactlyOnceWith('client@example.com', { redirectTo: `${APP}?invite=${TOKEN}&flow=activate`, data: { display_name: 'Maria Silva' } })
    expect(f.generateLink).not.toHaveBeenCalled()
  })
  it.each([' ', 'A', 'a'.repeat(121), 'Maria\nSilva'])('rejects invalid names before creating any invitation', async name => {
    const f = fixture(), res = await invoke(f.emailHandler, request(name))
    expect(res.statusCode).toBe(400)
    expect(f.rpc).not.toHaveBeenCalled()
    expect(f.inviteUserByEmail).not.toHaveBeenCalled()
  })
})
