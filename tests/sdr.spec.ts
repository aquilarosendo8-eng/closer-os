import { expect, test, type Page, type Route } from '@playwright/test'
import { createFeatureState, memberIds, mountFeatures, navigateFeatures, workspaceA, workspaceB, type FeatureState } from './fixtures/features'
import { mountInbound, openInbound } from './fixtures/inbound'

// These browser adapters exercise Auth/session/UI/HTTP contracts. Real role
// authorization, invitation membership and RLS are checked in the SQL suite.
const inviteToken = 'e'.repeat(64)
const sdrLabel = 'SDR — Pré-vendas'
type RequestRow = FeatureState['requests'][number]
type Member = { user_id: string; email: string; display_name: string; role: string; is_active: boolean }
type Invitation = { id: string; workspace_id: string; email: string; name: string; role: string; expires_at: string; accepted_at: string | null; revoked_at: string | null }
const json = (route: Route, data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(data) })
const record = (route: Route, state: FeatureState): RequestRow => {
  const request = route.request(), url = new URL(request.url())
  let body: Record<string, unknown> | null = null
  try { body = request.postDataJSON() } catch { /* Read-only request. */ }
  const row = { path: url.pathname, method: request.method(), query: url.search, body }
  state.requests.push(row); return row
}
const members = (): Member[] => [
  { user_id: memberIds.admin, email: 'admin@example.invalid', display_name: 'Ana Administradora', role: 'admin', is_active: true },
  { user_id: memberIds.manager, email: 'manager@example.invalid', display_name: 'Marcos Gestor', role: 'manager', is_active: true },
  { user_id: memberIds.closer, email: 'closer@example.invalid', display_name: 'Sara Pré-vendas', role: 'sdr', is_active: true },
  { user_id: memberIds.viewer, email: 'viewer@example.invalid', display_name: 'Vera Consulta', role: 'viewer', is_active: true },
]
const check = (state: FeatureState) => { expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]) }

async function mountSdr(page: Page, options: { theme?: 'light' | 'dark'; invitation?: boolean } = {}) {
  await page.clock.setFixedTime(new Date('2026-10-15T15:00:00Z'))
  const fixture = createFeatureState()
  fixture.leads[1].owner_id = memberIds.manager
  await mountFeatures(page, 'closer', { state: fixture, theme: options.theme })
  if (options.theme) await page.evaluate(theme => localStorage.setItem('closer-os-theme-v1', theme), options.theme)
  const state = { ...fixture, accepted: !options.invitation }
  await page.route('https://test.supabase.co/**', async route => {
    const path = new URL(route.request().url()).pathname
    const overridden = ['/rest/v1/memberships', '/rest/v1/rpc/list_invitation_preview', '/rest/v1/rpc/accept_invitation', '/rest/v1/rpc/record_policy_acceptance', '/auth/v1/logout']
    if (path === '/rest/v1/leads' && route.request().method() === 'GET') {
      const request = record(route, state), ws = new URLSearchParams(request.query).get('workspace_id')?.replace(/^eq\./, '')
      await json(route, state.accepted && ws === workspaceA ? state.leads.filter(row => row.workspace_id === workspaceA && row.owner_id === memberIds.closer) : []); return
    }
    if (!overridden.includes(path)) { await route.fallback(); return }
    const { body } = record(route, state)
    if (path === '/rest/v1/memberships') { await json(route, state.accepted ? [{ workspace_id: workspaceA, user_id: memberIds.closer, role: 'sdr', is_active: true }] : []); return }
    if (path.endsWith('/list_invitation_preview')) { await json(route, { name: 'Sara Pré-vendas', email: 'closer@example.invalid', workspace_name: 'Aurora Comercial', expires_at: '2030-01-01T00:00:00Z' }); return }
    if (path.endsWith('/accept_invitation')) {
      if (body?.p_token !== inviteToken) { await json(route, { message: 'Convite inválido.' }, 403); return }
      state.accepted = true; await json(route, workspaceA); return
    }
    await json(route, null)
  })
  if (options.invitation) {
    const session = await page.evaluate(() => JSON.parse(localStorage.getItem('sb-test-auth-token')!))
    const fragment = new URLSearchParams({ access_token: session.access_token, refresh_token: session.refresh_token, token_type: 'bearer', expires_in: '3600', expires_at: String(session.expires_at), type: 'invite' })
    await page.goto(`/?invite=${inviteToken}&flow=activate#${fragment}`)
  } else {
    await page.reload()
    await expect(page.locator('.sidebar-profile')).toContainText(sdrLabel)
  }
  return state
}

async function mountAdmin(page: Page) {
  const state = await mountFeatures(page, 'admin')
  const team = members(), invitations: Invitation[] = []
  await page.route('https://test.supabase.co/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!['/rest/v1/rpc/list_members', '/rest/v1/rpc/list_invitations', '/rest/v1/rpc/list_audit', '/rest/v1/rpc/update_member'].includes(path)) { await route.fallback(); return }
    const { body } = record(route, state)
    if (path.endsWith('/list_members')) { await json(route, structuredClone(team)); return }
    if (path.endsWith('/list_invitations')) { await json(route, structuredClone(invitations)); return }
    if (path.endsWith('/update_member')) {
      const member = team.find(row => row.user_id === body?.p_user_id)!
      Object.assign(member, { role: body?.p_role, is_active: body?.p_is_active }); await json(route, null); return
    }
    await json(route, [])
  })
  await page.route('**/api/invitation*', async route => {
    const request = record(route, state), body = request.body!
    expect(route.request().headers().authorization).toMatch(/^Bearer /)
    expect(body).not.toHaveProperty('serviceRoleKey')
    for (const previous of invitations) if (previous.email === body.email) previous.revoked_at = '2026-10-15T15:00:00Z'
    const invitation: Invitation = { id: `sdr-invitation-${invitations.length}`, workspace_id: String(body.workspaceId), name: String(body.name), email: String(body.email), role: String(body.role), expires_at: '2030-01-01T00:00:00Z', accepted_at: null, revoked_at: null }
    invitations.push(invitation)
    const manual = request.path.endsWith('invitation-link')
    await json(route, { invitation, url: `${new URL(route.request().url()).origin}/?invite=${inviteToken}`, ...(manual ? { manualLink: true } : { emailSent: true }) })
  })
  await page.locator('.cloud-context-bar').getByRole('button', { name: 'Administrar', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Pessoas e permissões', exact: true })).toBeVisible()
  return { state, team, invitations }
}

test('company Admin invites SDR through the authenticated server API and resends the same role', async ({ page }) => {
  const { state } = await mountAdmin(page)
  await page.getByRole('button', { name: 'Convidar pessoa', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Convide alguém para a equipe', exact: true })
  await dialog.getByLabel('Nome da pessoa', { exact: true }).fill('Nova SDR')
  await dialog.getByLabel('E-mail da pessoa', { exact: true }).fill('NOVA.SDR@EXAMPLE.INVALID')
  await dialog.getByLabel('Papel na empresa').selectOption('sdr')
  await expect(dialog.getByLabel('Papel na empresa').locator('option:checked')).toHaveText(sdrLabel)
  await dialog.getByRole('button', { name: 'Enviar convite', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Convite enviado por e-mail.')
  const row = page.locator('.ad-invitation-table').getByRole('row').filter({ hasText: 'nova.sdr@example.invalid' })
  await expect(row).toContainText(sdrLabel); await expect(row).toContainText('Pendente')
  expect(state.requests.find(request => request.path === '/api/invitations')?.body).toEqual({ workspaceId: workspaceA, email: 'nova.sdr@example.invalid', role: 'sdr', name: 'Nova SDR' })
  await row.getByRole('button', { name: 'Reenviar convite para nova.sdr@example.invalid', exact: true }).click()
  await expect.poll(() => state.requests.filter(request => request.path === '/api/invitations').length).toBe(2)
  expect(state.requests.filter(request => request.path === '/api/invitations').at(-1)?.body?.role).toBe('sdr')
  expect(state.requests.filter(request => request.path.endsWith('/invite_member'))).toHaveLength(0); check(state)
})

test('company Admin changes Closer to SDR and back without changing membership or activity status', async ({ page }) => {
  const { state, team } = await mountAdmin(page)
  team.find(row => row.user_id === memberIds.closer)!.role = 'closer'
  await page.getByLabel('Buscar membros').fill('Sara')
  await page.getByRole('button', { name: 'Atualizar', exact: true }).click()
  const select = page.getByLabel('Papel de closer@example.invalid', { exact: true })
  await expect(select).toHaveValue('closer')
  for (const role of ['sdr', 'closer']) {
    await select.selectOption(role)
    await page.getByRole('button', { name: 'Salvar papel de closer@example.invalid', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Permissão atualizada.')
    await expect(select).toHaveValue(role)
    expect(state.requests.filter(request => request.path.endsWith('/update_member')).at(-1)?.body).toEqual({ p_workspace_id: workspaceA, p_user_id: memberIds.closer, p_role: role, p_is_active: true })
  }
  expect(team.find(row => row.user_id === memberIds.closer)).toMatchObject({ user_id: memberIds.closer, role: 'closer', is_active: true }); check(state)
})

test('invited SDR activates, accepts terms and enters the exact company with the SDR session after reload', async ({ page }) => {
  const state = await mountSdr(page, { invitation: true }), start = state.requests.length
  await expect(page.getByRole('heading', { name: 'Seu próximo nível começa aqui.', exact: true })).toBeVisible()
  await expect(page.locator('.auth-workspace-invite')).toContainText('Aurora Comercial')
  await page.getByLabel('Nova senha', { exact: true }).fill('senha exclusiva para teste SDR')
  await page.getByLabel('Confirmar senha', { exact: true }).fill('senha exclusiva para teste SDR')
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Ativar e entrar na empresa', exact: true }).click()
  await expect(page.locator('.sidebar-profile')).toContainText(sdrLabel)
  await expect(page).toHaveURL(url => url.searchParams.get('workspace') === workspaceA && !url.searchParams.has('invite'))
  expect(state.requests.slice(start).filter(request => request.path.endsWith('/accept_invitation'))).toHaveLength(1)
  expect(state.requests.slice(start).filter(request => request.path === '/rest/v1/leads').every(request => request.query.includes(workspaceA))).toBe(true)
  await page.reload(); await expect(page.locator('.sidebar-profile')).toContainText(sdrLabel)
  await expect(page.locator('.workspace-selector')).toContainText('Aurora Comercial')
  await expect(page.getByRole('button', { name: 'Administrar', exact: true })).toHaveCount(0); check(state)
})

test('SDR sees owned leads, keeps restricted controls and cannot open another company through its URL', async ({ page }) => {
  const state = await mountSdr(page)
  await navigateFeatures(page, 'Pipeline')
  await expect(page.getByRole('heading', { name: 'Ana Ribeiro', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Bruno Castro', exact: true })).toHaveCount(0)
  await expect(page.getByText('SEGREDO SEGUNDA EMPRESA', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Administrar', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Administração', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Configurar pipeline/ })).toHaveCount(0)
  await page.locator('.lead-card-main').filter({ has: page.getByRole('heading', { name: 'Ana Ribeiro', exact: true }) }).click()
  const detail = page.getByRole('dialog', { name: 'Oportunidade de Ana Ribeiro', exact: true })
  await detail.getByRole('button', { name: 'Editar oportunidade', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Ana Ribeiro', exact: true })
  await expect(editor.getByLabel('Responsável', { exact: true })).toHaveCount(0)
  await expect(editor.getByRole('button', { name: 'Excluir lead', exact: true })).toHaveCount(0)
  await editor.getByRole('button', { name: 'Cancelar', exact: true }).click()
  await page.getByRole('button', { name: 'Configurações', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Seu workspace', exact: true })
  await expect(settings.getByLabel('Meta de faturamento (R$)')).toBeDisabled()
  await expect(settings.getByRole('button', { name: 'Importar backup JSON', exact: true })).toHaveCount(0)
  // Closer and SDR retain their original own-data JSON path, not the CSV/XLSX wizard.
  await settings.getByRole('button', { name: 'Importar leads', exact: true }).click()
  await expect(settings.locator('input[type="file"]')).toHaveAttribute('accept', 'application/json,.json')
  await expect(page.getByRole('dialog', { name: /Importar leads para/ })).toHaveCount(0)
  await page.goto(`/?workspace=${workspaceB}`)
  await expect(page.locator('.sidebar-profile')).toContainText(sdrLabel)
  await expect(page.locator('.workspace-selector')).toContainText('Aurora Comercial')
  expect(state.requests.filter(request => request.path === '/rest/v1/leads').every(request => request.query.includes(workspaceA))).toBe(true)
  expect(state.requests.filter(request => request.path.endsWith('/review_call') || request.path.endsWith('/save_pipeline_stages') || request.path.endsWith('/update_member'))).toHaveLength(0); check(state)
})

test('SDR qualifies its own lead in Calls without gaining leadership review controls', async ({ page }) => {
  const state = await mountSdr(page)
  await navigateFeatures(page, 'Calls')
  await page.getByRole('button', { name: 'Revisar call de Ana Ribeiro', exact: true }).click()
  const dialog = page.locator('.cp-review-modal')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Ana Ribeiro', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Marcar como revisada', exact: true })).toHaveCount(0)
  await dialog.getByRole('textbox', { name: 'Dor principal', exact: true }).fill('Qualificação SDR: precisa organizar o processo comercial.')
  await dialog.getByLabel(/^Urgência/).selectOption('Alta')
  await dialog.getByLabel(/^Capacidade financeira/).selectOption('Média')
  await dialog.getByLabel('Próximo passo', { exact: true }).fill('Validar orçamento com o decisor.')
  await dialog.getByRole('button', { name: 'Salvar revisão', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(state.leads[0]).toMatchObject({ owner_id: memberIds.closer, data: { pain: 'Qualificação SDR: precisa organizar o processo comercial.', urgency: 'Alta', financialCapacity: 'Média', nextStep: 'Validar orçamento com o decisor.' } })
  expect(state.requests.filter(request => request.path === '/rest/v1/leads' && request.method === 'PATCH')).toHaveLength(1)
  await page.reload(); await expect(page.locator('.sidebar-profile')).toContainText(sdrLabel); await navigateFeatures(page, 'Calls')
  await page.getByRole('button', { name: 'Revisar call de Ana Ribeiro', exact: true }).click()
  await expect(dialog.getByRole('textbox', { name: 'Dor principal', exact: true })).toHaveValue('Qualificação SDR: precisa organizar o processo comercial.'); check(state)
})

for (const theme of ['light', 'dark'] as const) for (const width of [1366, 390]) {
  test(`SDR schedules owned opportunity with the existing modal in ${theme} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const state = await mountSdr(page, { theme })
    await navigateFeatures(page, 'Pipeline')
    await page.getByLabel('Etapa de Ana Ribeiro').selectOption({ label: 'Call agendada' })
    const dialog = page.getByRole('dialog', { name: 'Agendar call', exact: true })
    await dialog.getByLabel('Data da reunião').fill('2026-10-16')
    await dialog.getByLabel('Horário da reunião').fill('09:30')
    await dialog.getByRole('button', { name: 'Confirmar agendamento', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    expect(state.leads[0]).toMatchObject({ owner_id: memberIds.closer, data: { callDate: '2026-10-16T12:30:00.000Z', attendance: 'Pendente' } })
    await page.reload(); await expect(page.locator('.sidebar-profile')).toContainText(sdrLabel); await navigateFeatures(page, 'Pipeline')
    await expect(page.getByLabel('Etapa de Ana Ribeiro').locator('option:checked')).toHaveText('Call agendada')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.locator('.crm-visual')).toHaveAttribute('data-theme', theme); check(state)
  })
}

test('company Admin sees SDR as an eligible inbound integration owner and submits its stable member ID', async ({ page }) => {
  const state = await mountInbound(page, 'admin')
  await page.route('https://test.supabase.co/rest/v1/rpc/list_members', route => json(route, members()))
  await openInbound(page)
  await page.getByRole('button', { name: 'Nova integração', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Nova integração', exact: true })
  await expect(dialog.getByLabel('Responsável padrão').locator(`option[value="${memberIds.closer}"]`)).toHaveText('Sara Pré-vendas')
  await expect(dialog.getByLabel('Responsável padrão').locator(`option[value="${memberIds.viewer}"]`)).toHaveCount(0)
  await dialog.getByLabel('Nome da integração', { exact: true }).fill('Formulário SDR')
  await dialog.getByLabel(/^Origem padrão/).fill('Site')
  await dialog.getByLabel('Etapa de entrada', { exact: true }).selectOption({ label: 'Lead novo' })
  await dialog.getByLabel('Responsável padrão', { exact: true }).selectOption(memberIds.closer)
  await dialog.getByRole('button', { name: 'Criar integração', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Integração criada', exact: true })).toBeVisible()
  expect(state.inboundRequests.find(request => request.path.endsWith('/create_inbound_integration'))?.body).toMatchObject({ p_workspace_id: workspaceA, p_owner_id: memberIds.closer })
  check(state)
})

test('SDR signs in with email and password and receives the restricted company membership again', async ({ page }) => {
  const state = await mountSdr(page)
  await page.locator('.cloud-context-bar').getByRole('button', { name: 'Sair', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Bom ter você de volta.', exact: true })).toBeVisible()
  const start = state.requests.length
  await page.getByLabel('E-mail', { exact: true }).fill('closer@example.invalid')
  await page.getByLabel('Senha', { exact: true }).fill('senha de teste para acesso SDR')
  await page.getByRole('button', { name: 'Entrar no meu workspace', exact: true }).click()
  await expect(page.locator('.sidebar-profile')).toContainText(sdrLabel)
  await expect(page.locator('.workspace-selector')).toContainText('Aurora Comercial')
  expect(state.requests.slice(start).find(request => request.path === '/auth/v1/token')?.query).toContain('grant_type=password')
  await expect(page.getByRole('button', { name: 'Administrar', exact: true })).toHaveCount(0); check(state)
})

test('company Admin assigns an existing opportunity to SDR through the existing owner selector', async ({ page }) => {
  const { state } = await mountAdmin(page)
  state.leads[0].owner_id = memberIds.admin
  const original = structuredClone(state.leads[0].data)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Visão geral.', exact: true })).toBeVisible()
  await navigateFeatures(page, 'Pipeline')
  await page.locator('.lead-card-main').filter({ has: page.getByRole('heading', { name: 'Ana Ribeiro', exact: true }) }).click()
  await page.getByRole('dialog', { name: 'Oportunidade de Ana Ribeiro', exact: true }).getByRole('button', { name: 'Editar oportunidade', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Ana Ribeiro', exact: true })
  await expect(editor.getByLabel(/^Responsável/).locator(`option[value="${memberIds.closer}"]`)).toHaveText('Sara Pré-vendas')
  await editor.getByLabel(/^Responsável/).selectOption(memberIds.closer)
  await editor.getByRole('button', { name: 'Salvar alterações', exact: true }).click()
  await expect(editor).toHaveCount(0)
  expect(state.leads[0].owner_id).toBe(memberIds.closer)
  expect(state.leads[0].data).toMatchObject({ id: original.id, pain: original.pain, ticket: original.ticket, source: original.source })
  expect(state.requests.find(request => request.path === '/rest/v1/leads' && request.method === 'PATCH' && request.body?.owner_id)?.body).toEqual({ owner_id: memberIds.closer })
  check(state)
})
