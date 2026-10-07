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
  invitationEmail?: string
  platformAdmin?: boolean
  rejectCallback?: boolean
  holdWorkspaceALeads?: Promise<void>
}
interface FixtureState { requests: { path: string; method: string; query: string; body: unknown }[] }

async function mockSupabase(page: Page, options: FixtureOptions = {}): Promise<FixtureState> {
  const state: FixtureState = { requests: [] }
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
  }, { authenticated: Boolean(options.authenticated), savedSession: session(), key: storageKey })
  await page.route('https://test.supabase.co/**', async route => {
    const request = route.request(), url = new URL(request.url())
    const path = url.pathname
    let body: unknown = null
    try { body = request.postDataJSON() } catch { /* GET and empty bodies. */ }
    state.requests.push({ path, method: request.method(), query: url.search, body })
    const json = async (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(value) })
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } }); return }
    if (path === '/auth/v1/token') {
      if (options.loginFailure) await json({ code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400)
      else await json(session())
      return
    }
    if (path === '/auth/v1/user') {
      if (options.rejectCallback && request.method() === 'GET') await json({ code: 'bad_jwt', msg: 'Invalid callback session' }, 401)
      else await json(user)
      return
    }
    if (path === '/auth/v1/logout' || path === '/auth/v1/recover') { await json({}); return }
    if (path === '/auth/v1/signup') { await json({ user, session: options.confirmSignup ? null : session() }); return }
    if (path === '/rest/v1/rpc/setup_owner') { await json(null); return }
    if (path === '/rest/v1/rpc/record_policy_acceptance') { await json(null); return }
    if (path === '/rest/v1/rpc/list_platform_workspaces') { await json([]); return }
    if (path === '/rest/v1/rpc/list_invitation_preview') { await json({ email: options.invitationEmail || user.email, workspace_name: 'Empresa A', expires_at: '2030-01-01T00:00:00Z' }); return }
    if (path === '/rest/v1/rpc/accept_invitation') { await json(workspaceA); return }
    if (path === '/rest/v1/rpc/list_members') { await json([{ user_id: userId, display_name: 'Closer de teste', email: user.email, role: options.role || 'closer', is_active: true }]); return }
    if (path === '/rest/v1/memberships') {
      const ids = options.noMembership ? [] : options.twoWorkspaces ? [workspaceA, workspaceB] : [workspaceA]
      await json(ids.map(id => ({ workspace_id: id, user_id: userId, role: options.role || 'closer', is_active: true }))); return
    }
    if (path === '/rest/v1/platform_admins') { await json(options.platformAdmin ? [{ user_id: userId }] : []); return }
    if (path === '/rest/v1/profiles') { await json({ display_name: 'Closer de teste', email: user.email }); return }
    if (path === '/rest/v1/workspaces') { await json([{ id: workspaceA, name: 'Empresa A', created_at: '2026-10-01T00:00:00Z' }, ...(options.twoWorkspaces ? [{ id: workspaceB, name: 'Empresa B', created_at: '2026-10-01T00:00:00Z' }] : [])]); return }
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

test('an authenticated account without membership waits for invitation and fetches no leads', async ({ page }) => {
  const state = await mockSupabase(page, { authenticated: true, noMembership: true })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Sua conta aguarda um convite' })).toBeVisible()
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

test('invalid invitation tokens are blocked before any invitation RPC', async ({ page }) => {
  const state = await mockSupabase(page)
  await page.goto('/?invite=invalid-token')
  await expect(page.getByRole('alert')).toContainText('Este convite não é válido.')
  await expect(page.getByRole('button', { name: 'Aceitar convite', exact: true })).toHaveCount(0)
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
  await page.getByRole('button', { name: 'Aceitar convite', exact: true }).click()
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
  await page.getByRole('button', { name: 'Aceitar convite', exact: true }).click()
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
  await page.getByRole('button', { name: 'Aceitar convite', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible()
  const consentIndex = state.requests.findIndex(request => request.path === '/rest/v1/rpc/record_policy_acceptance')
  const membershipIndex = state.requests.findIndex(request => request.path === '/rest/v1/rpc/accept_invitation')
  expect(consentIndex).toBeGreaterThan(-1)
  expect(membershipIndex).toBeGreaterThan(consentIndex)
  expect(state.requests[consentIndex].body).toEqual({ p_terms_version: '2026-10-06', p_privacy_version: '2026-10-06' })
  expect(state.requests[membershipIndex].body).toEqual({ p_token: invitationToken })
  await expect(page).toHaveURL('/')
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
