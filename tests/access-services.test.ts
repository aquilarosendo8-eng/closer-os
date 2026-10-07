import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ createClient: vi.fn(), signUp: vi.fn(), getSession: vi.fn(), rpc: vi.fn(), fetch: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mock.createClient }))

const WORKSPACE = '10000000-0000-4000-8000-000000000001'
const TOKEN = 'a'.repeat(64)
const input = { email: ' Client@Example.com ', password: 'uma senha exclusiva de teste', displayName: ' Maria Silva ', companyName: ' Empresa Nova ', acceptTerms: true }
const row = { id: '20000000-0000-4000-8000-000000000002', email: 'client@example.com', name: 'Maria Silva', role: 'closer', expires_at: '2030-01-01T00:00:00Z', status: 'pending', accepted_by: null }
let supabase: typeof import('../src/lib/supabase')
let access: typeof import('../src/lib/access')

beforeEach(async () => {
  vi.resetModules()
  for (const item of Object.values(mock)) item.mockReset()
  mock.createClient.mockReturnValue({ auth: { signUp: mock.signUp, getSession: mock.getSession }, rpc: mock.rpc })
  mock.signUp.mockResolvedValue({ data: { user: { identities: [{ id: 'new' }] }, session: null }, error: null })
  mock.getSession.mockResolvedValue({ data: { session: { access_token: 'test-user-token' } }, error: null })
  mock.rpc.mockResolvedValue({ data: WORKSPACE, error: null })
  vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co')
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')
  vi.stubGlobal('window', { location: { href: 'https://crm.example.com/?old=1', search: '?old=1', hash: '' } })
  vi.stubGlobal('fetch', mock.fetch)
  supabase = await import('../src/lib/supabase')
  access = await import('../src/lib/access')
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('public account registration adapter', () => {
  it('uses PKCE and a clean signup redirect with only unprivileged onboarding hints', async () => {
    await expect(supabase.signUpAccount({ ...input, role: 'admin', workspaceId: WORKSPACE } as any)).resolves.toEqual({ pendingConfirmation: true })
    expect(mock.createClient.mock.calls[0][2].auth.flowType).toBe('pkce')
    expect(mock.signUp).toHaveBeenCalledExactlyOnceWith({ email: 'client@example.com', password: input.password,
      options: { emailRedirectTo: 'https://crm.example.com/?signup=1', data: { display_name: 'Maria Silva', self_signup_company: 'Empresa Nova', self_signup_terms: true } } })
    expect(mock.rpc).not.toHaveBeenCalled()
  })
  it('does not create a workspace or infer privileges from an immediate confirmed Auth session', async () => {
    mock.signUp.mockResolvedValueOnce({ data: { user: { identities: [{ id: 'new' }] }, session: { access_token: 'confirmed-session' } }, error: null })
    await expect(supabase.signUpAccount(input)).resolves.toEqual({ pendingConfirmation: false })
    expect(mock.rpc).not.toHaveBeenCalled()
  })
  it.each([{ acceptTerms: false }, { password: 'short' }, { displayName: 'A' }, { companyName: '' }])('does not send invalid registration to Auth (%j)', async invalid => {
    await expect(supabase.signUpAccount({ ...input, ...invalid })).rejects.toThrow()
    expect(mock.signUp).not.toHaveBeenCalled()
  })
  it('does not report successful signup when Auth masks an already registered account', async () => {
    mock.signUp.mockResolvedValueOnce({ data: { user: { identities: [] }, session: null }, error: null })
    await expect(supabase.signUpAccount(input)).rejects.toThrow('Se você já possui conta')
    expect(mock.rpc).not.toHaveBeenCalled()
  })
  it.each([
    ['email_address_not_authorized', 'Contate o administrador'],
    ['over_email_send_rate_limit', 'temporariamente limitado'],
  ])('shows a useful Portuguese message for provider error %s', async (code, expected) => {
    mock.signUp.mockResolvedValueOnce({ data: { user: null, session: null }, error: { code, message: 'Provider internal detail' } })
    await expect(supabase.signUpAccount(input)).rejects.toThrow(expected)
  })
  it('does not enable implicit signup callbacks merely because an access token appears in the fragment', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { location: { href: 'https://crm.example.com/?signup=1#tokens', search: '?signup=1', hash: '#access_token=fake&refresh_token=fake&type=signup' } })
    await import('../src/lib/supabase')
    expect(mock.createClient.mock.calls.at(-1)?.[2].auth.flowType).toBe('pkce')
  })
})

describe('self-owned company adapter', () => {
  it('requires explicit consent and sends ownership-free arguments to the authenticated RPC', async () => {
    await expect(access.createOwnWorkspace({ name: ' Empresa Nova ', displayName: ' Maria Silva ', acceptTerms: true, ownerId: 'someone-else', role: 'platform_admin' } as any)).resolves.toBe(WORKSPACE)
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('create_own_workspace', { p_name: 'Empresa Nova', p_display_name: 'Maria Silva', p_accept_terms: true })
  })
  it('rejects absent consent before any database operation', async () => {
    await expect(access.createOwnWorkspace({ name: 'Empresa Nova', displayName: 'Maria Silva', acceptTerms: false })).rejects.toThrow('aceite os termos')
    expect(mock.rpc).not.toHaveBeenCalled()
  })
  it('propagates database refusal without trying a platform bootstrap or another creation route', async () => {
    const error = { code: '42501', message: 'Conta precisa confirmar o e-mail' }
    mock.rpc.mockResolvedValueOnce({ data: null, error })
    await expect(access.createOwnWorkspace({ name: 'Empresa Nova', displayName: 'Maria Silva', acceptTerms: true })).rejects.toEqual(error)
    expect(mock.rpc).toHaveBeenCalledTimes(1)
  })
  it('requires a valid returned workspace ID before declaring onboarding completed', async () => {
    mock.rpc.mockResolvedValueOnce({ data: null, error: null })
    await expect(access.createOwnWorkspace({ name: 'Empresa Nova', displayName: 'Maria Silva', acceptTerms: true })).rejects.toThrow('confirmar a criação')
  })
})

describe('named invitation client adapter', () => {
  it('uses the protected mail API with the current session and normalized name/email', async () => {
    mock.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ invitation: row, url: `https://crm.example.com/?invite=${TOKEN}`, emailSent: true }) })
    const result = await access.administrationService.createInvitation(WORKSPACE, { email: ' Client@Example.com ', role: 'closer', name: ' Maria Silva ' })
    const [url, options] = mock.fetch.mock.calls[0]
    expect(url).toBe('/api/invitations')
    expect(options.headers.authorization).toBe('Bearer test-user-token')
    expect(JSON.parse(options.body)).toEqual({ workspaceId: WORKSPACE, email: 'client@example.com', role: 'closer', name: 'Maria Silva' })
    expect(result).toMatchObject({ invitation: { name: 'Maria Silva', status: 'pending' }, emailSent: true })
    expect(mock.rpc).not.toHaveBeenCalled()
  })
  it('keeps the manually shared provider link separate from mail delivery', async () => {
    const url = 'https://test.supabase.co/auth/v1/verify?token=verification-hash'
    mock.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ invitation: row, url, manualLink: true }) })
    const result = await access.administrationService.createManualInvitation(WORKSPACE, { email: row.email, role: 'closer', name: row.name })
    expect(mock.fetch.mock.calls[0][0]).toBe('/api/invitation-link')
    expect(result).toMatchObject({ url, manualLink: true })
    expect('emailSent' in result).toBe(false)
  })
  it('preserves the sign-in requirement for an existing account without implying email delivery', async () => {
    const url = `https://crm.example.com/?invite=${TOKEN}&login=1`
    mock.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ invitation: row, url, manualLink: true, requiresSignIn: true }) })
    const result = await access.administrationService.createManualInvitation(WORKSPACE, { email: row.email, role: 'closer', name: row.name })
    expect(result).toMatchObject({ url, manualLink: true, requiresSignIn: true })
    expect('emailSent' in result).toBe(false)
  })
  it('does not infer manual-link success from an email-only response', async () => {
    mock.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ invitation: row, url: 'https://crm.example.com/', emailSent: true }) })
    await expect(access.administrationService.createManualInvitation(WORKSPACE, { email: row.email, role: 'closer' })).rejects.toThrow('confirmação do convite')
  })
  it('cannot invoke either privileged invitation endpoint without a session', async () => {
    mock.getSession.mockResolvedValue({ data: { session: null }, error: null })
    await expect(access.administrationService.createInvitation(WORKSPACE, { email: row.email, role: 'closer' })).rejects.toThrow('Entre novamente')
    await expect(access.administrationService.createManualInvitation(WORKSPACE, { email: row.email, role: 'closer' })).rejects.toThrow('Entre novamente')
    expect(mock.fetch).not.toHaveBeenCalled()
  })
  it('passes the administrator name when creating the company and its first invitation', async () => {
    mock.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ invitation: { ...row, role: 'admin' }, url: 'https://crm.example.com/invite', emailSent: true }) })
    await access.administrationService.createWorkspace({ name: 'Empresa Nova', ownerName: ' Maria Silva ', ownerEmail: row.email })
    expect(mock.rpc).toHaveBeenCalledWith('create_workspace', { p_name: 'Empresa Nova', p_owner_name: 'Maria Silva' })
    expect(JSON.parse(mock.fetch.mock.calls[0][1].body)).toMatchObject({ name: 'Maria Silva', role: 'admin' })
  })
  it('allows legacy empty administrator names when creating a company and regenerating its manual copy', async () => {
    mock.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ invitation: { ...row, name: null, role: 'admin' }, url: 'https://crm.example.com/invite', emailSent: true }) })
    mock.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ invitation: { ...row, name: null, role: 'admin' }, url: 'https://test.supabase.co/auth/v1/verify?token=copy', manualLink: true }) })
    await access.administrationService.createWorkspace({ name: 'Empresa Nova', ownerName: '', ownerEmail: row.email })
    await access.administrationService.createManualInvitation(WORKSPACE, { email: row.email, role: 'admin', name: '  ' })
    expect(mock.rpc).toHaveBeenCalledWith('create_workspace', { p_name: 'Empresa Nova', p_owner_name: null })
    expect(mock.fetch).toHaveBeenCalledTimes(2)
    for (const [, options] of mock.fetch.mock.calls) expect(JSON.parse(options.body).name).toBeUndefined()
  })
  it('preserves accepted status and destination name in the invitation list', async () => {
    mock.rpc.mockResolvedValueOnce({ data: [{ ...row, status: 'activated', accepted_by: 'recipient-id' }], error: null })
    await expect(access.administrationService.listInvitations(WORKSPACE)).resolves.toMatchObject([{ name: 'Maria Silva', status: 'activated', acceptedBy: 'recipient-id' }])
  })
})
