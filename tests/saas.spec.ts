import { expect, test, type Page } from '@playwright/test'
import type { Lead } from '../src/types'

// These HTTP fixtures exercise session/UI contracts only. The SQL suite verifies real RLS.
const userId = '00000000-0000-4000-8000-000000000001'
const workspaceA = '00000000-0000-4000-8000-000000000011'
const workspaceB = '00000000-0000-4000-8000-000000000012'
const invitationToken = 'a'.repeat(64)
const storageKey = 'sb-test-auth-token'
const user = {
  id: userId, aud: 'authenticated', role: 'authenticated', email: 'closer@example.com',
  app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: 'Closer de teste' },
  identities: [{ identity_id: userId, id: userId, user_id: userId, provider: 'email', identity_data: { email: 'closer@example.com' } }],
  created_at: '2026-10-06T12:00:00Z', email_confirmed_at: '2026-10-06T12:00:00Z',
}
function session() {
  const payload = { sub: userId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }
  const token = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.test-signature`
  return { access_token: token, token_type: 'bearer', refresh_token: 'test-refresh-token', expires_in: 3600, expires_at: payload.exp, user }
}
function lead(name: string, id: string): Lead {
  const now = new Date().toISOString()
  return { id, name, company: 'Empresa privada', email: 'lead@example.com', phone: '', ticket: 7500, source: 'Indicação', createdAt: now, callDate: now, attendance: 'Compareceu', objection: 'Momento', status: 'Fechado', closedValue: 7500, closedAt: now, lastContactAt: now, notes: 'Registro privado da empresa', pain: 'Processos', urgency: 'Alta', financialCapacity: 'Alta', decisionMaker: true, callScore: 8, closerError: '', callSummary: '' }
}
interface FixtureOptions {
  authenticated?: boolean
  role?: 'admin' | 'manager' | 'closer' | 'viewer'
  noMembership?: boolean
  twoWorkspaces?: boolean
  subscriptionStatus?: string
  loginFailure?: boolean
  confirmSignup?: boolean
  signupFailure?: boolean
  unconfirmedEmail?: boolean
  ownWorkspaceFailure?: boolean
  expiredInvitation?: boolean
  previewFailure?: boolean
  registrationMetadata?: boolean
  invitationEmail?: string
  platformAdmin?: boolean
  rejectCallback?: boolean
  holdWorkspaceALeads?: Promise<void>
}
interface FixtureState { requests: { path: string; method: string; query: string; body: unknown }[] }

async function mockSupabase(page: Page, options: FixtureOptions = {}): Promise<FixtureState> {
  const state: FixtureState = { requests: [] }
  let provisioned = false
  let accepted = false
  let ownName = 'Empresa A'
  const fixtureUser = { ...user, email_confirmed_at: options.unconfirmedEmail ? undefined : user.email_confirmed_at, user_metadata: options.registrationMetadata ? { display_name: 'Nome do cadastro', self_signup_company: 'Empresa do cadastro', self_signup_terms: true } : user.user_metadata }
  const fixtureSession = () => ({ ...session(), user: fixtureUser })
  await page.addInitScript(({ authenticated, savedSession, key }) => {
    if (authenticated) localStorage.setItem(key, JSON.stringify(savedSession))
    // A recognizable legacy sentinel must never be loaded by the private app.
    localStorage.setItem('closer-os-leads-v1', JSON.stringify([{ name: 'SEGREDO DO NAVEGADOR ANTIGO' }]))
    localStorage.setItem('closer-os-settings-v1', JSON.stringify({ name: 'PERFIL LOCAL ANTIGO' }))
    const read = Storage.prototype.getItem
    ;(window as unknown as { legacyReads: string[] }).legacyReads = []
    Storage.prototype.getItem = function (name: string) {
      if (name === 'closer-os-leads-v1' || name === 'closer-os-settings-v1') (window as unknown as { legacyReads: string[] }).legacyReads.push(name)
      return read.call(this, name)
    }
  }, { authenticated: Boolean(options.authenticated), savedSession: fixtureSession(), key: storageKey })
  await page.route('https://test.supabase.co/**', async route => {
    const request = route.request(), url = new URL(request.url())
    const path = url.pathname
    let body: unknown = null
    try { body = request.postDataJSON() } catch { /* GET and empty bodies. */ }
    state.requests.push({ path, method: request.method(), query: url.search, body })
    const json = async (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'x-supabase-api-version': '2024-01-01', 'access-control-expose-headers': 'x-supabase-api-version' }, body: JSON.stringify(value) })
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } }); return }
    if (path === '/auth/v1/token') {
      if (options.loginFailure) await json({ code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400)
      else await json(fixtureSession())
      return
    }
    if (path === '/auth/v1/user') {
      if (options.rejectCallback && request.method() === 'GET') await json({ code: 'bad_jwt', msg: 'Invalid callback session' }, 401)
      else await json(fixtureUser)
      return
    }
    if (path === '/auth/v1/logout' || path === '/auth/v1/recover') { await json({}); return }
    if (path === '/auth/v1/signup') {
      if (options.signupFailure) await json({ code: 'over_email_send_rate_limit', msg: 'Email rate limit exceeded' }, 429)
      else await json({ user: fixtureUser, session: options.confirmSignup ? null : fixtureSession() })
      return
    }
    if (path === '/rest/v1/rpc/setup_owner') { await json(null); return }
    if (path === '/rest/v1/rpc/record_policy_acceptance') { await json(null); return }
    if (path === '/rest/v1/rpc/list_platform_workspaces') { await json([]); return }
    if (path === '/rest/v1/rpc/list_invitation_preview' && options.previewFailure) { await json({ message: 'Network request failed' }, 503); return }
    if (path === '/rest/v1/rpc/list_invitation_preview') { await json(options.expiredInvitation ? null : { name: 'Nome no convite', email: options.invitationEmail || user.email, workspace_name: 'Empresa A', expires_at: '2030-01-01T00:00:00Z' }); return }
    if (path === '/rest/v1/rpc/accept_invitation') { accepted = true; await json(workspaceA); return }
    if (path === '/rest/v1/rpc/create_own_workspace') {
      if (options.ownWorkspaceFailure && !state.requests.some(request => request.path === path && request !== state.requests.at(-1))) await json({ message: 'Não foi possível criar a empresa. Tente novamente.' }, 500)
      else { provisioned = true; ownName = (body as { p_name: string }).p_name; await json(workspaceA) }
      return
    }
    if (path === '/rest/v1/rpc/list_members') { await json([{ user_id: userId, display_name: 'Closer de teste', email: user.email, role: options.role || 'closer', is_active: true }]); return }
    if (path === '/rest/v1/memberships') {
      const ids = options.noMembership && !provisioned && !accepted ? [] : options.twoWorkspaces ? [workspaceA, workspaceB] : [workspaceA]
      await json(ids.map(id => ({ workspace_id: id, user_id: userId, role: provisioned ? 'admin' : options.role || 'closer', is_active: true }))); return
    }
    if (path === '/rest/v1/platform_admins') { await json(options.platformAdmin ? [{ user_id: userId }] : []); return }
    if (path === '/rest/v1/profiles') { await json({ display_name: 'Closer de teste', email: user.email }); return }
    if (path === '/rest/v1/workspaces') { await json([{ id: workspaceA, name: ownName, created_at: '2026-10-01T00:00:00Z' }, ...(options.twoWorkspaces ? [{ id: workspaceB, name: 'Empresa B', created_at: '2026-10-01T00:00:00Z' }] : [])]); return }
    if (path === '/rest/v1/subscriptions') { await json([workspaceA, workspaceB].map(id => ({ workspace_id: id, status: options.subscriptionStatus || 'active', plan: 'team', seat_limit: 5, current_period_end: '2030-01-01T00:00:00Z' }))); return }
    if (path === '/rest/v1/workspace_settings') {
      const settings = (id: string) => ({ workspace_id: id, name: 'Closer de teste', commission_rate: 10, revenue_goal: 200000 })
      const id = url.searchParams.get('workspace_id')
      await json(id?.startsWith('eq.') ? settings(id.slice(3)) : [settings(workspaceA), settings(workspaceB)]); return
    }
    if (path === '/rest/v1/leads') {
      const id = url.searchParams.get('workspace_id')?.replace(/^eq\./, '')
      if (id === workspaceA && options.holdWorkspaceALeads) await options.holdWorkspaceALeads
      const record = id === workspaceB ? lead('LEAD PRIVADO EMPRESA B', 'lead-b') : lead('LEAD PRIVADO EMPRESA A', 'lead-a')
      await json([{ id: record.id, owner_id: userId, data: record }]); return
    }
    await json({ message: `Unexpected mocked endpoint: ${path}` }, 500)
  })
  return state
}

async function login(page: Page) {
  await page.getByLabel('E-mail', { exact: true }).fill(user.email)
  await page.getByLabel('Senha', { exact: true }).fill('senha longa de teste')
  await page.getByRole('button', { name: 'Entrar no meu workspace', exact: true }).click()
}

test('private login never loads legacy browser data and authenticated CRM uses cloud data', async ({ page }) => {
  const state = await mockSupabase(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Bom ter você de volta.' })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { legacyReads: string[] }).legacyReads)).toEqual([])
  expect(state.requests.filter(request => request.path === '/rest/v1/leads')).toHaveLength(0)
  await expect(page.getByText('SEGREDO DO NAVEGADOR ANTIGO')).toHaveCount(0)
  await login(page)
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible()
  await expect(page.locator('.stat-card').filter({ has: page.getByText('Faturamento', { exact: true }) }).locator('.stat-value')).toHaveText(/R\$\s*7\.500/)
  await page.getByRole('button', { name: /^Pipeline\s*\d*$/ }).click()
  await expect(page.getByRole('heading', { name: 'LEAD PRIVADO EMPRESA A', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { legacyReads: string[] }).legacyReads)).toEqual([])
  await expect(page.getByText('Mariana Costa', { exact: true })).toHaveCount(0)
  expect(state.requests.find(request => request.path === '/rest/v1/leads')?.query).toContain(workspaceA)
})

test('an authenticated account without membership can start its own workspace without fetching leads', async ({ page }) => {
  const state = await mockSupabase(page, { authenticated: true, noMembership: true })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Vamos criar sua empresa.' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toHaveCount(0)
  expect(state.requests.filter(request => request.path === '/rest/v1/leads')).toHaveLength(0)
  expect(await page.evaluate(() => (window as unknown as { legacyReads: string[] }).legacyReads)).toEqual([])
})

test('wrong credentials retain private login and mobile legal documents remain accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const state = await mockSupabase(page, { loginFailure: true })
  await page.goto('/')
  await login(page)
  await expect(page.getByRole('alert')).toHaveText('E-mail ou senha incorretos.')
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toHaveCount(0)
  expect(state.requests.filter(request => request.path === '/rest/v1/leads')).toHaveLength(0)
  await page.getByRole('button', { name: 'Privacidade', exact: true }).click()
  const legalDialog = page.getByRole('dialog', { name: 'Política de privacidade' })
  await expect(legalDialog).toBeVisible()
  await expect(legalDialog.getByRole('link', { name: 'support@example.com' })).toHaveAttribute('href', 'mailto:support@example.com')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(legalDialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Privacidade', exact: true })).toBeFocused()
})

test('viewer can inspect records but cannot edit, move, delete or export', async ({ page }) => {
  const state = await mockSupabase(page, { authenticated: true, role: 'viewer' })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Novo lead', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Exportar relatório' })).toHaveCount(0)
  await page.getByRole('button', { name: /^Pipeline\s*\d*$/ }).click()
  await expect(page.getByLabel('Etapa de LEAD PRIVADO EMPRESA A')).toBeDisabled()
  await expect(page.getByRole('button', { name: /Adicionar lead em/ })).toHaveCount(0)
  await page.locator('.lead-card-main').click()
  const dialog = page.getByRole('dialog', { name: 'LEAD PRIVADO EMPRESA A' })
  await expect(dialog.getByLabel('Nome do lead')).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Salvar alterações' })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Excluir lead' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Fechar', exact: true }).click()
  await page.getByRole('button', { name: 'Configurações', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Seu workspace' }).getByLabel('Meta de faturamento (R$)')).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Exportar backup' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Importar leads', exact: true })).toHaveCount(0)
  expect(state.requests.filter(request => ['PATCH', 'DELETE'].includes(request.method))).toHaveLength(0)
})

test('signing out clears the private UI and session without deleting legacy data', async ({ page }) => {
  await mockSupabase(page)
  await page.goto('/')
  await login(page)
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible()
  await page.locator('.cloud-context-bar').getByRole('button', { name: 'Sair', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Bom ter você de volta.' })).toBeVisible()
  await expect(page.getByText('LEAD PRIVADO EMPRESA A', { exact: true })).toHaveCount(0)
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull()
  expect(await page.evaluate(() => localStorage.getItem('closer-os-leads-v1'))).toContain('SEGREDO DO NAVEGADOR ANTIGO')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Bom ter você de volta.' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toHaveCount(0)
})

test('a recovery URL alone never grants a password-change session', async ({ page }) => {
  const state = await mockSupabase(page)
  await page.goto('/?flow=recovery')
  await expect(page.getByRole('heading', { name: 'Bom ter você de volta.' })).toBeVisible()
  await expect(page.getByLabel('Nova senha', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Esqueci minha senha' }).click()
  await page.getByLabel('E-mail', { exact: true }).fill('unknown@example.com')
  await page.getByRole('button', { name: 'Enviar link de recuperação' }).click()
  await expect(page.getByRole('status')).toContainText('Se esse e-mail estiver cadastrado')
  expect(state.requests.filter(request => request.path === '/auth/v1/user' && request.method === 'PUT')).toHaveLength(0)
  expect(state.requests.find(request => request.path === '/auth/v1/recover')?.query).toContain('flow%3Drecovery')
})

test('an implicit activation callback verifies Auth before setting the owner password and survives reload', async ({ page }) => {
  const state = await mockSupabase(page, { noMembership: true, platformAdmin: true })
  const saved = session()
  const fragment = new URLSearchParams({ access_token: saved.access_token, refresh_token: saved.refresh_token,
    token_type: saved.token_type, expires_in: String(saved.expires_in), expires_at: String(saved.expires_at), type: 'invite' })
  await page.goto(`/?flow=activate#${fragment}`)
  await expect(page.getByRole('heading', { name: 'Uma nova senha. Um novo começo.' })).toBeVisible()
  expect(state.requests.some(request => request.path === '/auth/v1/user' && request.method === 'GET')).toBe(true)
  await expect(page).toHaveURL(url => url.search === '?flow=activate' && url.hash === '')
  await page.getByLabel('Nova senha', { exact: true }).fill('uma senha exclusiva de teste')
  await page.getByLabel('Confirmar senha', { exact: true }).fill('uma senha exclusiva de teste')
  await page.getByRole('button', { name: 'Salvar nova senha', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Clientes da plataforma', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Nova empresa', exact: true })).toBeVisible()
  expect(state.requests.some(request => request.path === '/auth/v1/user' && request.method === 'PUT')).toBe(true)
  await expect(page).toHaveURL('/')
  expect(await page.evaluate(key => Boolean(localStorage.getItem(key)), storageKey)).toBe(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Clientes da plataforma', exact: true })).toBeVisible()
  await expect(page.getByLabel('Nova senha', { exact: true })).toHaveCount(0)
  expect(state.requests.filter(request => request.path === '/rest/v1/leads')).toHaveLength(0)
})

test('a rejected implicit callback cannot create an authenticated password-change session', async ({ page }) => {
  const state = await mockSupabase(page, { rejectCallback: true })
  const saved = session()
  const fragment = new URLSearchParams({ access_token: saved.access_token, refresh_token: saved.refresh_token,
    token_type: saved.token_type, expires_in: String(saved.expires_in), type: 'invite' })
  await page.goto(`/?flow=activate#${fragment}`)
  await expect(page.getByRole('heading', { name: 'Bom ter você de volta.' })).toBeVisible()
  await expect(page.getByLabel('Nova senha', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Clientes da plataforma', exact: true })).toHaveCount(0)
  expect(state.requests.some(request => request.path === '/auth/v1/user' && request.method === 'GET')).toBe(true)
  expect(state.requests.filter(request => request.path === '/rest/v1/leads' || request.path === '/rest/v1/rpc/setup_owner')).toHaveLength(0)
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull()
})

test('activation uses one explicit-consent form and keeps the invitation secure across reload', async ({ page }) => {
  const state = await mockSupabase(page, { noMembership: true })
  const saved = session()
  const fragment = new URLSearchParams({ access_token: saved.access_token, refresh_token: saved.refresh_token,
    token_type: saved.token_type, expires_in: String(saved.expires_in), expires_at: String(saved.expires_at), type: 'invite' })
  await page.goto(`/?invite=${invitationToken}&flow=activate#${fragment}`)
  await expect(page.getByRole('heading', { name: 'Seu próximo nível começa aqui.' })).toBeVisible()
  await expect(page.getByLabel('Seu nome', { exact: true })).toHaveValue('Nome no convite')
  await expect(page.locator('.auth-workspace-invite')).toContainText('Empresa A')
  await expect(page.getByLabel('E-mail', { exact: true })).toHaveValue(user.email)
  await expect(page).toHaveURL(url => url.searchParams.get('invite') === invitationToken && !url.hash)
  await page.reload()
  await expect(page.getByLabel('Nova senha', { exact: true })).toBeVisible()
  await page.getByLabel('Nova senha', { exact: true }).fill('senha exclusiva para convite')
  await page.getByLabel('Confirmar senha', { exact: true }).fill('senha exclusiva para convite')
  await page.getByRole('button', { name: 'Ativar e entrar na empresa', exact: true }).click()
  expect(state.requests.filter(request => request.path === '/auth/v1/user' && request.method === 'PUT')).toHaveLength(0)
  expect(state.requests.filter(request => request.path === '/rest/v1/rpc/accept_invitation')).toHaveLength(0)
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Ativar e entrar na empresa', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible()
  await expect(page).toHaveURL(url => url.searchParams.get('workspace') === workspaceA && !url.searchParams.has('invite'))
  expect(state.requests.filter(request => request.path === '/auth/v1/user' && request.method === 'PUT').some(request => Boolean((request.body as { password?: string })?.password))).toBe(true)
  expect(state.requests.some(request => request.path === '/auth/v1/logout' && request.query.includes('scope=others'))).toBe(true)
  expect(state.requests.filter(request => request.path === '/rest/v1/rpc/create_own_workspace' || request.path === '/auth/v1/signup')).toHaveLength(0)
})

test('an existing account verifies an email magic link and accepts an invitation without replacing its password', async ({ page }) => {
  const state = await mockSupabase(page, { noMembership: true })
  const saved = session()
  const fragment = new URLSearchParams({ access_token: saved.access_token, refresh_token: saved.refresh_token,
    token_type: saved.token_type, expires_in: String(saved.expires_in), expires_at: String(saved.expires_at), type: 'magiclink' })
  await page.goto(`/?invite=${invitationToken}#${fragment}`)
  await expect(page.getByRole('button', { name: 'Aceitar e entrar', exact: true })).toBeVisible()
  await expect(page.getByLabel('Nova senha', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Senha', { exact: true })).toHaveCount(0)
  expect(state.requests.some(request => request.path === '/auth/v1/user' && request.method === 'GET')).toBe(true)
  await page.getByLabel('Seu nome', { exact: true }).fill('Pessoa convidada')
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Aceitar e entrar', exact: true }).click()
  await expect.poll(() => state.requests.filter(request => request.path === '/rest/v1/rpc/accept_invitation').length).toBe(1)
  expect(state.requests.filter(request => request.path === '/auth/v1/user' && request.method === 'PUT').some(request => Boolean((request.body as { password?: string })?.password))).toBe(false)
})

test('the company selected by a completed invitation survives reload without granting access to an unrelated ID', async ({ page }) => {
  const state = await mockSupabase(page, { authenticated: true, twoWorkspaces: true })
  await page.goto(`/?workspace=${workspaceB}`)
  await expect(page.getByLabel('Selecionar empresa')).toHaveValue(workspaceB)
  await expect(page.locator('.stat-card').filter({ has: page.getByText('Faturamento', { exact: true }) }).locator('.stat-value')).toHaveText(/R\$\s*7\.500/)
  expect(state.requests.filter(request => request.path === '/rest/v1/leads').every(request => request.query.includes(workspaceB))).toBe(true)
  await page.reload()
  await expect(page.getByLabel('Selecionar empresa')).toHaveValue(workspaceB)
  await page.getByLabel('Selecionar empresa').selectOption(workspaceA)
  await expect(page).toHaveURL(url => url.searchParams.get('workspace') === workspaceA)
  await page.reload()
  await expect(page.getByLabel('Selecionar empresa')).toHaveValue(workspaceA)
  const count = state.requests.length
  await page.goto('/?workspace=00000000-0000-4000-8000-000000000099')
  await expect(page.getByLabel('Selecionar empresa')).toHaveValue(workspaceA)
  expect(state.requests.slice(count).filter(request => request.path === '/rest/v1/leads').every(request => request.query.includes(workspaceA))).toBe(true)
})

test('invalid invitation tokens are blocked before any invitation RPC', async ({ page }) => {
  const state = await mockSupabase(page)
  await page.goto('/?invite=invalid-token')
  await expect(page.getByRole('alert')).toContainText('Este convite não é válido.')
  await expect(page.getByRole('button', { name: 'Aceitar e entrar', exact: true })).toHaveCount(0)
  expect(state.requests.filter(request => request.path.includes('invitation'))).toHaveLength(0)
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toHaveCount(0)
})

test('invitation signup waits for email confirmation before accepting membership', async ({ page }) => {
  const state = await mockSupabase(page, { loginFailure: true, confirmSignup: true })
  await page.goto(`/?invite=${invitationToken}`)
  await expect(page.getByRole('heading', { name: 'Seu próximo nível começa aqui.' })).toBeVisible()
  await page.getByLabel('Seu nome', { exact: true }).fill('Cliente convidado')
  await page.getByLabel('Nova senha', { exact: true }).fill('uma senha longa exclusiva')
  await page.getByLabel('Confirmar senha', { exact: true }).fill('uma senha longa exclusiva')
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Ativar e entrar na empresa', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Enviamos a confirmação para seu e-mail' })).toBeVisible()
  await expect(page.getByText('Convite aceito. Seu acesso foi preparado.', { exact: true })).toHaveCount(0)
  expect(state.requests.filter(request => request.path === '/rest/v1/rpc/accept_invitation')).toHaveLength(0)
  expect(state.requests.filter(request => request.path === '/auth/v1/signup')).toHaveLength(1)
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toHaveCount(0)
})

test('an invitation cannot grant membership to a different signed-in email', async ({ page }) => {
  const state = await mockSupabase(page, { authenticated: true, invitationEmail: 'invited@example.com' })
  await page.goto(`/?invite=${invitationToken}`)
  await expect(page.getByRole('heading', { name: 'Seu próximo nível começa aqui.' })).toBeVisible()
  await expect(page.getByLabel('E-mail', { exact: true })).toHaveValue('invited@example.com')
  await expect(page.getByLabel('Nova senha', { exact: true })).toHaveCount(0)
  await page.getByLabel('Seu nome', { exact: true }).fill('Outra pessoa')
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Aceitar e entrar', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Este convite pertence a outro e-mail.')
  expect(state.requests.filter(request => request.path === '/rest/v1/rpc/accept_invitation')).toHaveLength(0)
  expect(state.requests.filter(request => request.path === '/auth/v1/signup')).toHaveLength(0)
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toHaveCount(0)
})

test('a confirmed invited account records policy acceptance before joining its company', async ({ page }) => {
  const state = await mockSupabase(page, { authenticated: true })
  await page.goto(`/?invite=${invitationToken}`)
  await expect(page.getByRole('heading', { name: 'Seu próximo nível começa aqui.' })).toBeVisible()
  await page.getByLabel('Seu nome', { exact: true }).fill('Cliente convidado')
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Aceitar e entrar', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible()
  const consentIndex = state.requests.findIndex(request => request.path === '/rest/v1/rpc/record_policy_acceptance')
  const membershipIndex = state.requests.findIndex(request => request.path === '/rest/v1/rpc/accept_invitation')
  expect(consentIndex).toBeGreaterThan(-1)
  expect(membershipIndex).toBeGreaterThan(consentIndex)
  expect(state.requests[consentIndex].body).toEqual({ p_terms_version: '2026-10-06', p_privacy_version: '2026-10-06' })
  expect(state.requests[membershipIndex].body).toEqual({ p_token: invitationToken })
  await expect(page).toHaveURL(url => url.searchParams.get('workspace') === workspaceA && !url.searchParams.has('invite'))
})

test('a suspended company never fetches CRM leads', async ({ page }) => {
  const state = await mockSupabase(page, { authenticated: true, subscriptionStatus: 'suspended' })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'O acesso desta empresa está pausado' })).toBeVisible()
  expect(state.requests.filter(request => request.path === '/rest/v1/leads')).toHaveLength(0)
  await expect(page.getByText('LEAD PRIVADO EMPRESA A', { exact: true })).toHaveCount(0)
})

test('a late response from the previous company cannot populate the selected company', async ({ page }) => {
  let releaseOldResponse!: () => void
  const delayed = new Promise<void>(resolve => { releaseOldResponse = resolve })
  const state = await mockSupabase(page, { authenticated: true, twoWorkspaces: true, holdWorkspaceALeads: delayed })
  try {
    await page.goto('/')
    await expect(page.getByLabel('Selecionar empresa')).toBeVisible()
    await expect.poll(() => state.requests.some(request => request.path === '/rest/v1/leads' && request.query.includes(workspaceA))).toBe(true)
    await page.getByLabel('Selecionar empresa').selectOption(workspaceB)
    await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible()
    await page.getByRole('button', { name: /^Pipeline\s*\d*$/ }).click()
    await expect(page.getByRole('heading', { name: 'LEAD PRIVADO EMPRESA B', exact: true })).toBeVisible()
    const oldResponse = page.waitForResponse(response => response.url().includes('/rest/v1/leads') && response.url().includes(workspaceA))
    releaseOldResponse()
    await oldResponse
    await expect(page.getByRole('heading', { name: 'LEAD PRIVADO EMPRESA B', exact: true })).toBeVisible()
    await expect(page.getByText('LEAD PRIVADO EMPRESA A', { exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { legacyReads: string[] }).legacyReads)).toEqual([])
  } finally { releaseOldResponse() }
})

async function fillRegistration(page: Page) {
  await page.getByLabel('Seu nome', { exact: true }).fill('Novo cliente')
  await page.getByLabel('Nome da empresa', { exact: true }).fill('Minha empresa privada')
  await page.getByLabel('E-mail', { exact: true }).fill(user.email)
  await page.getByLabel('Nova senha', { exact: true }).fill('senha de cadastro exclusiva')
  await page.getByLabel('Confirmar senha', { exact: true }).fill('senha de cadastro exclusiva')
}

test('public signup uses the shared link and explicit terms, then waits for email without provisioning', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const state = await mockSupabase(page, { noMembership: true, confirmSignup: true })
  await page.goto('/')
  await page.getByRole('button', { name: 'Criar conta', exact: true }).click()
  await expect(page).toHaveURL('/?signup=1')
  await fillRegistration(page)
  await page.getByRole('button', { name: 'Criar minha conta', exact: true }).click()
  expect(state.requests.filter(request => request.path === '/auth/v1/signup')).toHaveLength(0)
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Criar minha conta', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Confira seu e-mail para confirmar o cadastro')
  const request = state.requests.find(request => request.path === '/auth/v1/signup')!
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(request.query).toContain('signup%3D1')
  expect((request.body as { data: unknown }).data).toEqual({ display_name: 'Novo cliente', self_signup_company: 'Minha empresa privada', self_signup_terms: true })
  expect(state.requests.filter(request => request.path === '/rest/v1/rpc/create_own_workspace' || request.path === '/rest/v1/leads')).toHaveLength(0)
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull()
})

test('signup rate limits keep the form and never claim email was sent or grant access', async ({ page }) => {
  const state = await mockSupabase(page, { signupFailure: true, noMembership: true })
  await page.goto('/?signup=1')
  await fillRegistration(page)
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Criar minha conta', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('O envio de e-mails está temporariamente limitado')
  await expect(page.getByRole('status')).toHaveCount(0)
  await expect(page.getByLabel('Nome da empresa', { exact: true })).toHaveValue('Minha empresa privada')
  expect(state.requests.filter(request => request.path === '/rest/v1/rpc/create_own_workspace' || request.path === '/rest/v1/leads')).toHaveLength(0)
})

test('confirmed signup pre-fills onboarding but requires fresh consent and retries safely before entering its own company', async ({ page }) => {
  const state = await mockSupabase(page, { authenticated: true, noMembership: true, registrationMetadata: true, ownWorkspaceFailure: true })
  await page.goto('/?signup=1')
  await expect(page.getByRole('heading', { name: 'Vamos criar sua empresa.' })).toBeVisible()
  await expect(page.getByLabel('Seu nome', { exact: true })).toHaveValue('Nome do cadastro')
  await expect(page.getByLabel('Nome da empresa', { exact: true })).toHaveValue('Empresa do cadastro')
  await expect(page.getByRole('checkbox')).not.toBeChecked()
  expect(state.requests.filter(request => request.path === '/rest/v1/rpc/create_own_workspace')).toHaveLength(0)
  await page.getByRole('button', { name: 'Criar meu workspace', exact: true }).click()
  expect(state.requests.filter(request => request.path === '/rest/v1/rpc/create_own_workspace')).toHaveLength(0)
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Criar meu workspace', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Não foi possível criar a empresa')
  await expect(page.getByLabel('Nome da empresa', { exact: true })).toHaveValue('Empresa do cadastro')
  await page.getByRole('button', { name: 'Criar meu workspace', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible()
  await expect(page).toHaveURL(url => url.searchParams.get('workspace') === workspaceA && !url.searchParams.has('signup'))
  await expect(page.locator('.cloud-context-bar')).toContainText('Empresa do cadastro')
  const creates = state.requests.filter(request => request.path === '/rest/v1/rpc/create_own_workspace')
  expect(creates).toHaveLength(2)
  expect(creates.every(request => JSON.stringify(request.body) === JSON.stringify({ p_name: 'Empresa do cadastro', p_display_name: 'Nome do cadastro', p_accept_terms: true }))).toBe(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible()
  expect(state.requests.filter(request => request.path === '/rest/v1/rpc/create_own_workspace')).toHaveLength(2)
  expect(state.requests.some(request => request.path === '/rest/v1/platform_admins' && request.method !== 'GET')).toBe(false)
})

test('unconfirmed sessions cannot provision a workspace or load private CRM data', async ({ page }) => {
  const state = await mockSupabase(page, { authenticated: true, noMembership: true, unconfirmedEmail: true, registrationMetadata: true })
  await page.goto('/?signup=1')
  await expect(page.getByRole('heading', { name: 'Confirme seu e-mail.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Criar meu workspace' })).toHaveCount(0)
  expect(state.requests.filter(request => request.path === '/rest/v1/rpc/create_own_workspace' || request.path === '/rest/v1/leads')).toHaveLength(0)
})

test('existing workspace accounts open their CRM from the signup link without resetting trial or creating another company', async ({ page }) => {
  const state = await mockSupabase(page, { authenticated: true, registrationMetadata: true })
  await page.goto('/?signup=1')
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible()
  expect(state.requests.filter(request => request.path === '/rest/v1/rpc/create_own_workspace' || request.path === '/auth/v1/signup')).toHaveLength(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible()
  expect(state.requests.filter(request => request.path === '/rest/v1/rpc/create_own_workspace')).toHaveLength(0)
})

test('invitation takes priority over public signup and never creates a separate workspace', async ({ page }) => {
  const state = await mockSupabase(page, { authenticated: true, noMembership: true, registrationMetadata: true })
  await page.goto(`/?signup=1&invite=${invitationToken}`)
  await expect(page.getByRole('heading', { name: 'Seu próximo nível começa aqui.' })).toBeVisible()
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Aceitar e entrar', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible()
  expect(state.requests.filter(request => request.path === '/rest/v1/rpc/create_own_workspace' || request.path === '/auth/v1/signup')).toHaveLength(0)
})

test('expired invitations request a replacement from the administrator and never show onboarding', async ({ page }) => {
  const state = await mockSupabase(page, { authenticated: true, noMembership: true, expiredInvitation: true })
  await page.goto(`/?invite=${invitationToken}`)
  await expect(page.getByRole('heading', { name: 'Convite expirado' })).toBeVisible()
  await expect(page.getByText('O administrador pode reenviar um convite ou gerar um novo link seguro.', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Criar meu workspace' })).toHaveCount(0)
  expect(state.requests.filter(request => request.path === '/rest/v1/rpc/create_own_workspace' || request.path === '/rest/v1/rpc/accept_invitation' || request.path === '/rest/v1/leads')).toHaveLength(0)
})

test('a temporary invitation verification failure can retry without declaring the link expired', async ({ page }) => {
  const options: FixtureOptions = { previewFailure: true }
  const state = await mockSupabase(page, options)
  await page.goto(`/?invite=${invitationToken}`)
  await expect(page.getByRole('heading', { name: 'Vamos verificar seu acesso.' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Convite expirado' })).toHaveCount(0)
  const previousRequests = state.requests.filter(request => request.path === '/rest/v1/rpc/list_invitation_preview').length
  options.previewFailure = false
  await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Seu próximo nível começa aqui.' })).toBeVisible()
  expect(state.requests.filter(request => request.path === '/rest/v1/rpc/list_invitation_preview')).toHaveLength(previousRequests + 1)
  expect(state.requests.filter(request => request.path === '/rest/v1/rpc/accept_invitation' || request.path === '/rest/v1/leads')).toHaveLength(0)
})


test('existing-account manual invitations require the current password and preserve legacy passwords', async ({ page }) => {
  const state = await mockSupabase(page, { noMembership: true })
  await page.goto(`/?invite=${invitationToken}&login=1`)
  await expect(page.getByLabel('Senha atual', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Nova senha', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Confirmar senha', { exact: true })).toHaveCount(0)
  await page.getByLabel('Senha atual', { exact: true }).fill('oldpass8')
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Entrar e aceitar convite', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible()
  expect((state.requests.find(request => request.path === '/auth/v1/token')?.body as { password: string }).password).toBe('oldpass8')
  expect(state.requests.filter(request => request.path === '/auth/v1/signup' || request.path === '/rest/v1/rpc/create_own_workspace')).toHaveLength(0)
  expect(state.requests.filter(request => request.path === '/auth/v1/user' && request.method === 'PUT').some(request => Boolean((request.body as { password?: string }).password))).toBe(false)
  await expect(page).toHaveURL(url => url.searchParams.get('workspace') === workspaceA && !url.searchParams.has('login'))
})

test('wrong current passwords on manual existing-account invitations never trigger signup or membership', async ({ page }) => {
  const state = await mockSupabase(page, { noMembership: true, loginFailure: true })
  await page.goto(`/?invite=${invitationToken}&login=1`)
  await page.getByLabel('Senha atual', { exact: true }).fill('wrongpw8')
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Entrar e aceitar convite', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('E-mail ou senha incorretos.')
  expect(state.requests.filter(request => request.path === '/auth/v1/signup' || request.path === '/rest/v1/rpc/accept_invitation' || request.path === '/rest/v1/rpc/create_own_workspace' || request.path === '/rest/v1/leads')).toHaveLength(0)
  await expect(page.getByLabel('Senha atual', { exact: true })).toBeVisible()
})


test('existing invitation password recovery retains the link and returns to one activation form', async ({ page }) => {
  const state = await mockSupabase(page, { noMembership: true })
  await page.goto(`/?invite=${invitationToken}&login=1`)
  await page.getByRole('button', { name: 'Esqueci minha senha', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Vamos recuperar sua senha.' })).toBeVisible()
  await expect(page.getByLabel('E-mail', { exact: true })).toHaveValue(user.email)
  await page.getByRole('button', { name: 'Voltar para entrar', exact: true }).click()
  await expect(page.getByLabel('Senha atual', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(url => url.searchParams.get('invite') === invitationToken && url.searchParams.get('login') === '1')
  await page.getByRole('button', { name: 'Esqueci minha senha', exact: true }).click()
  await page.getByRole('button', { name: 'Enviar link de recuperação', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Se esse e-mail estiver cadastrado')
  const request = state.requests.find(value => value.path === '/auth/v1/recover')!
  const redirect = new URL(new URLSearchParams(request.query).get('redirect_to')!)
  expect(redirect.searchParams.get('invite')).toBe(invitationToken)
  expect(redirect.searchParams.get('flow')).toBe('recovery')
  expect(redirect.searchParams.get('login')).toBe('1')
  const saved = session()
  redirect.hash = new URLSearchParams({ access_token: saved.access_token, refresh_token: saved.refresh_token,
    token_type: saved.token_type, expires_in: String(saved.expires_in), type: 'recovery' }).toString()
  await page.goto(redirect.toString())
  await expect(page.getByLabel('Nova senha', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Senha atual', { exact: true })).toHaveCount(0)
  await page.getByLabel('Nova senha', { exact: true }).fill('senha recuperada exclusiva')
  await page.getByLabel('Confirmar senha', { exact: true }).fill('senha recuperada exclusiva')
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Ativar e entrar na empresa', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible()
  expect(state.requests.filter(value => value.path === '/auth/v1/signup' || value.path === '/rest/v1/rpc/create_own_workspace')).toHaveLength(0)
  expect(state.requests.filter(value => value.path === '/rest/v1/leads').every(value => value.query.includes(workspaceA))).toBe(true)
})

test('valid password recovery remains available for an expired CRM invitation without granting membership', async ({ page }) => {
  const state = await mockSupabase(page, { noMembership: true, expiredInvitation: true })
  const saved = session()
  const fragment = new URLSearchParams({ access_token: saved.access_token, refresh_token: saved.refresh_token,
    token_type: saved.token_type, expires_in: String(saved.expires_in), type: 'recovery' })
  await page.goto(`/?invite=${invitationToken}&login=1&flow=recovery#${fragment}`)
  await expect(page.getByRole('heading', { name: 'Uma nova senha. Um novo começo.' })).toBeVisible()
  await page.getByLabel('Nova senha', { exact: true }).fill('senha recuperada sem empresa')
  await page.getByLabel('Confirmar senha', { exact: true }).fill('senha recuperada sem empresa')
  await page.getByRole('button', { name: 'Salvar nova senha', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Convite expirado' })).toBeVisible()
  await expect(page).toHaveURL(url => url.searchParams.get('invite') === invitationToken && !url.hash)
  expect(state.requests.filter(value => value.path === '/auth/v1/user' && value.method === 'PUT').some(value => Boolean((value.body as { password?: string }).password))).toBe(true)
  expect(state.requests.filter(value => value.path === '/rest/v1/rpc/accept_invitation' || value.path === '/rest/v1/rpc/create_own_workspace' || value.path === '/rest/v1/leads')).toHaveLength(0)
})


test('expired provider callbacks explain renewal in Portuguese and never offer anonymous invitation signup', async ({ page }) => {
  const state = await mockSupabase(page)
  const fragment = new URLSearchParams({ error: 'access_denied', error_code: 'otp_expired', error_description: 'Email link is invalid or has expired' })
  await page.goto(`/?invite=${invitationToken}&flow=activate#${fragment}`)
  await expect(page.getByRole('heading', { name: 'Link de ativação expirado' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('Peça ao administrador')
  await expect(page.getByLabel('Nova senha', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Ativar e entrar na empresa' })).toHaveCount(0)
  expect(state.requests.filter(value => value.path === '/auth/v1/signup' || value.path === '/rest/v1/rpc/accept_invitation' || value.path === '/rest/v1/leads')).toHaveLength(0)
  await page.goto(`/?flow=recovery#${fragment}`)
  await expect(page.getByRole('heading', { name: 'Vamos recuperar sua senha.' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('Este link de recuperação expirou. Solicite um novo')
  await page.getByLabel('E-mail', { exact: true }).fill(user.email)
  await page.getByRole('button', { name: 'Enviar link de recuperação', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Se esse e-mail estiver cadastrado')
  expect(state.requests.filter(value => value.path === '/auth/v1/recover')).toHaveLength(1)
  expect(state.requests.filter(value => value.path === '/auth/v1/user' && value.method === 'PUT')).toHaveLength(0)
})
