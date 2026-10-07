import { expect, test, type Page } from '@playwright/test'

const smtpFailureMessage = 'Configure o SMTP do Supabase para enviar convites a este destinatário. O convite foi cancelado.'

// HTTP fixtures test the SaaS UI and adapters. The SQL suite separately verifies
// authorization in the database, without relying on mocked server permissions.
async function mountAdministration(page: Page, mode: 'company' | 'platform' | 'closer' = 'company', options: { invitationFailure?: boolean } = {}) {
  const ownerId = '00000000-0000-4000-8000-000000000001'
  const otherAdminId = '00000000-0000-4000-8000-000000000002'
  const closerId = '00000000-0000-4000-8000-000000000003'
  const workspaceId = '00000000-0000-4000-8000-000000000011'
  const userId = mode === 'closer' ? closerId : ownerId
  const email = mode === 'closer' ? 'closer@example.com' : 'owner@example.com'
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email, app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: 'Ana Responsável' }, created_at: '2026-10-01T00:00:00Z', email_confirmed_at: '2026-10-01T00:00:00Z', identities: [] }
  const payload = { sub: userId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }
  const token = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture-signature`
  const session = { access_token: token, token_type: 'bearer', refresh_token: 'fixture-refresh-token', expires_in: 3600, expires_at: payload.exp, user }
  const state = {
    workspace: { id: workspaceId, name: 'Empresa Teste', owner_id: ownerId, created_at: '2026-10-01T00:00:00Z' },
    subscription: { workspace_id: workspaceId, plan: 'team', status: 'active', seat_limit: 4, current_period_end: null as string | null, trial_ends_at: null as string | null },
    members: [
      { user_id: ownerId, email: 'owner@example.com', display_name: 'Ana Responsável', role: 'admin', is_active: true },
      { user_id: otherAdminId, email: 'admin@example.com', display_name: 'Bruno Administrador', role: 'admin', is_active: true },
      { user_id: closerId, email: 'closer@example.com', display_name: 'Caio Closer', role: 'closer', is_active: true },
    ],
    invitations: [
      { id: 'revoked-1', workspace_id: workspaceId, email: 'revoked@example.com', role: 'closer', expires_at: '2030-01-01T00:00:00Z', accepted_at: null, revoked_at: '2026-10-01T00:00:00Z' },
      { id: 'expired-1', workspace_id: workspaceId, email: 'expired@example.com', role: 'closer', expires_at: '2000-01-01T00:00:00Z', accepted_at: null, revoked_at: null },
    ],
    privacy: { retentionDays: 365, privacyContactEmail: 'privacy@example.com' },
    calls: [] as { path: string; method: string; query: string; body: Record<string, unknown> | null }[],
    deleted: false,
    invitationFailure: Boolean(options.invitationFailure),
    invitationAuthenticated: false,
    additionalWorkspaces: [] as { id: string; name: string; owner_id: null; created_at: string }[],
    ownerId, otherAdminId, closerId, workspaceId,
  }
  await page.addInitScript(value => localStorage.setItem('sb-test-auth-token', JSON.stringify(value)), session)
  await page.route('https://test.supabase.co/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname
    let body: Record<string, unknown> | null = null
    try { body = request.postDataJSON() } catch { /* GET. */ }
    state.calls.push({ path, method: request.method(), query: url.search, body })
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(value) })
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } }); return }
    if (path === '/auth/v1/token') { await json(session); return }
    if (path === '/auth/v1/user') { await json(user); return }
    if (path === '/rest/v1/rpc/setup_owner') { await json(null); return }
    if (path === '/rest/v1/memberships') { await json(state.deleted || mode === 'platform' ? [] : [{ workspace_id: workspaceId, user_id: userId, role: mode === 'closer' ? 'closer' : 'admin', is_active: true }]); return }
    if (path === '/rest/v1/platform_admins') { await json(mode === 'platform' ? [{ user_id: userId }] : []); return }
    if (path === '/rest/v1/profiles') { await json({ email, display_name: mode === 'closer' ? 'Caio Closer' : 'Ana Responsável' }); return }
    if (path === '/rest/v1/workspaces') {
      await json(url.searchParams.get('select')?.includes('retention_days') ? { retention_days: state.privacy.retentionDays, privacy_contact_email: state.privacy.privacyContactEmail } : state.deleted ? [] : [{ ...state.workspace }]); return
    }
    if (path === '/rest/v1/subscriptions') { await json([{ ...state.subscription }]); return }
    if (path === '/rest/v1/workspace_settings') {
      const settings = { workspace_id: workspaceId, name: 'Ana Responsável', commission_rate: 10, revenue_goal: 200000 }
      await json(url.searchParams.get('workspace_id')?.startsWith('eq.') ? settings : [settings]); return
    }
    if (path === '/rest/v1/leads') { await json([]); return }
    if (path === '/rest/v1/rpc/list_members') { await json(body?.p_workspace_id === workspaceId ? structuredClone(state.members) : []); return }
    if (path === '/rest/v1/rpc/list_invitations') { await json(structuredClone(state.invitations.filter(invite => invite.workspace_id === body?.p_workspace_id))); return }
    if (path === '/rest/v1/rpc/list_audit') { await json([]); return }
    if (path === '/rest/v1/rpc/list_platform_workspaces') { await json([{ ...state.workspace, subscription: { ...state.subscription }, member_count: 3, admin_email: 'owner@example.com' }, ...state.additionalWorkspaces.map(workspace => ({ ...workspace, subscription: { ...state.subscription }, member_count: 0 }))]); return }
    if (path === '/rest/v1/rpc/create_workspace') {
      const id = '00000000-0000-4000-8000-000000000021'
      state.additionalWorkspaces.push({ id, name: String(body?.p_name), owner_id: null, created_at: new Date().toISOString() }); await json(id); return
    }
    if (path === '/rest/v1/rpc/update_workspace_privacy') { state.privacy = { retentionDays: Number(body?.p_retention_days), privacyContactEmail: String(body?.p_privacy_contact_email) }; await json(null); return }
    if (path === '/rest/v1/rpc/export_workspace') { await json({ workspace_id: workspaceId, leads: [{ id: 'lead-1', name: 'Lead da empresa' }], privacy: state.privacy }); return }
    if (path === '/rest/v1/rpc/transfer_workspace_owner') { state.workspace.owner_id = String(body?.p_new_owner_id); await json(null); return }
    if (path === '/rest/v1/rpc/delete_workspace') { state.deleted = true; await json(null); return }
    if (path === '/rest/v1/rpc/admin_update_subscription') {
      Object.assign(state.subscription, { plan: body?.p_plan, status: body?.p_status, seat_limit: body?.p_seat_limit, current_period_end: body?.p_current_period_end, trial_ends_at: body?.p_trial_ends_at }); await json(null); return
    }
    await json({ message: `Unexpected mocked endpoint: ${path}` }, 500)
  })
  await page.route('**/api/invitations', async route => {
    const request = route.request(), body = request.postDataJSON() as Record<string, unknown>
    state.calls.push({ path: '/api/invitations', method: request.method(), query: '', body })
    state.invitationAuthenticated = /^Bearer .+/.test(request.headers().authorization || '')
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
    if (!state.invitationAuthenticated) { await json({ error: 'Faça login para enviar convites.' }, 401); return }
    if (state.invitationFailure) { await json({ error: { code: 'EMAIL_CONFIGURATION_REQUIRED', message: smtpFailureMessage } }, 503); return }
    const invitation = { id: `new-invitation-${state.invitations.length}`, workspace_id: String(body.workspaceId), email: String(body.email), role: String(body.role), expires_at: '2030-01-01T00:00:00Z', accepted_at: null, revoked_at: null }
    state.invitations.push(invitation)
    await json({ invitation, url: `${new URL(request.url()).origin}/?invite=${'b'.repeat(64)}`, emailSent: true })
  })
  await page.goto('/')
  if (mode !== 'platform') {
    await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible()
    if (mode === 'company') await page.locator('.cloud-context-bar').getByRole('button', { name: 'Administrar', exact: true }).click()
  } else await expect(page.getByRole('heading', { name: 'Clientes da plataforma' })).toBeVisible()
  return state
}

test('company admin can save privacy and download company JSON; revoked invitations do not reserve seats', async ({ page }) => {
  const state = await mountAdministration(page)
  await expect(page.getByText('3 membros ativos', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Convidar pessoa', exact: true })).toBeEnabled()
  await expect(page.getByText('revoked@example.com')).toHaveCount(0)
  await expect(page.getByLabel('Papel de owner@example.com')).toBeDisabled()
  await page.getByRole('tab', { name: 'Empresa', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByLabel('Contato de privacidade')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.getByLabel('Contato de privacidade').fill('dados@empresa.com.br')
  await page.getByLabel('Retenção declarada (dias)').fill('180')
  await page.getByRole('button', { name: 'Salvar política de dados' }).click()
  await expect(page.getByRole('status')).toContainText('Configurações de privacidade atualizadas.')
  expect(state.privacy).toEqual({ retentionDays: 180, privacyContactEmail: 'dados@empresa.com.br' })
  await expect(page.getByText(/Não há exclusão automática de leads/)).toBeVisible()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Exportar dados da empresa', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^closer-os-empresa-\d{4}-\d{2}-\d{2}\.json$/)
  const stream = await download.createReadStream()
  if (!stream) throw new Error('A exportação não gerou um arquivo.')
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({ workspace_id: state.workspaceId, leads: [{ name: 'Lead da empresa' }] })
})

test('platform admin without company membership cannot reach company data or privacy controls', async ({ page }) => {
  const state = await mountAdministration(page, 'platform')
  await page.getByRole('row').filter({ hasText: 'Empresa Teste' }).getByRole('button', { name: 'Administrar', exact: false }).click()
  await expect(page.getByText('3 membros ativos', { exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Empresa', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Exportar dados da empresa', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Excluir empresa', exact: true })).toHaveCount(0)
  expect(state.calls.filter(call => /update_workspace_privacy|export_workspace|delete_workspace|retention_days|leads/.test(call.path + call.query))).toEqual([])
})

test('owner transfers responsibility only to another active admin', async ({ page }) => {
  const state = await mountAdministration(page)
  await page.getByRole('tab', { name: 'Empresa', exact: true }).click()
  const select = page.getByLabel('Novo responsável')
  await expect(select.locator('option')).toHaveCount(2)
  await expect(select.locator(`option[value="${state.closerId}"]`)).toHaveCount(0)
  await select.selectOption(state.otherAdminId)
  await page.getByRole('button', { name: 'Transferir responsabilidade', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Transferir a responsabilidade?' })
  await expect(dialog).toContainText('Bruno Administrador')
  await dialog.getByRole('button', { name: 'Confirmar transferência' }).click()
  await expect(page.getByRole('status')).toContainText('Responsabilidade transferida.')
  await expect(page.getByLabel('Novo responsável')).toHaveCount(0)
  expect(state.workspace.owner_id).toBe(state.otherAdminId)
  expect(state.calls.find(call => call.path.endsWith('/transfer_workspace_owner'))?.body).toEqual({ p_workspace_id: state.workspaceId, p_new_owner_id: state.otherAdminId })
})

test('company deletion requires the exact name and refreshes access', async ({ page }) => {
  const state = await mountAdministration(page)
  await page.getByRole('tab', { name: 'Empresa', exact: true }).click()
  await page.getByRole('button', { name: 'Excluir empresa', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Excluir esta empresa?' })
  const confirm = dialog.getByRole('button', { name: 'Excluir empresa e dados', exact: true })
  await expect(confirm).toBeDisabled()
  const input = dialog.getByLabel('Digite o nome exato da empresa para confirmar')
  await input.fill('empresa teste')
  await expect(confirm).toBeDisabled()
  await input.fill('Empresa Teste')
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Sua conta aguarda um convite' })).toBeVisible()
  expect(state.deleted).toBe(true)
  expect(state.calls.find(call => call.path.endsWith('/delete_workspace'))?.body).toEqual({ p_workspace_id: state.workspaceId, p_confirmation: 'Empresa Teste' })
})

test('closer cannot mount the administration or trigger management requests', async ({ page }) => {
  const state = await mountAdministration(page, 'closer')
  await expect(page.locator('.cloud-context-bar').getByRole('button', { name: 'Administrar', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tab')).toHaveCount(0)
  expect(state.calls.filter(call => /list_invitations|list_audit|update_workspace_privacy|export_workspace|delete_workspace|transfer_workspace_owner/.test(call.path))).toEqual([])
})

test('manual subscription activation validates trial dates and sends the access configuration', async ({ page }) => {
  const state = await mountAdministration(page, 'platform')
  await page.getByRole('row').filter({ hasText: 'Empresa Teste' }).getByRole('button', { name: 'Administrar', exact: false }).click()
  await page.getByRole('tab', { name: 'Plano', exact: true }).click()
  await expect(page.getByText(/Esta ação altera o acesso, sem processar pagamentos/)).toBeVisible()
  await page.getByLabel('Status da assinatura').selectOption('trial')
  await page.getByLabel('Vigência até').fill('2020-01-01T12:00')
  await page.getByRole('button', { name: 'Salvar plano e acesso' }).click()
  await expect(page.getByRole('alert')).toContainText('escolha uma vigência futura')
  expect(state.calls.filter(call => call.path.endsWith('/admin_update_subscription'))).toHaveLength(0)
  await page.getByLabel('Vigência até').fill('2030-01-01T12:00')
  await page.getByRole('button', { name: 'Salvar plano e acesso' }).click()
  await expect(page.getByRole('status')).toContainText('Plano e acesso atualizados.')
  expect(state.calls.find(call => call.path.endsWith('/admin_update_subscription'))?.body).toEqual({ p_workspace_id: state.workspaceId, p_plan: 'team', p_status: 'trial', p_seat_limit: 4, p_current_period_end: '2030-01-01T15:00:00.000Z', p_trial_ends_at: '2030-01-01T15:00:00.000Z' })
  await page.getByLabel('Status da assinatura').selectOption('active')
  await page.getByLabel('Vigência até').fill('')
  await page.getByRole('button', { name: 'Salvar plano e acesso' }).click()
  await expect.poll(() => state.calls.filter(call => call.path.endsWith('/admin_update_subscription')).length).toBe(2)
  expect(state.calls.filter(call => call.path.endsWith('/admin_update_subscription')).at(-1)?.body).toEqual({ p_workspace_id: state.workspaceId, p_plan: 'team', p_status: 'active', p_seat_limit: 4, p_current_period_end: null, p_trial_ends_at: null })
})

test('invitation sends authenticated email request and offers a secondary access link', async ({ page }) => {
  const state = await mountAdministration(page)
  await page.getByRole('button', { name: 'Convidar pessoa', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Convide alguém para a equipe' })
  await dialog.getByLabel('E-mail da pessoa').fill('Nova@EXAMPLE.com')
  await dialog.getByLabel('Papel na empresa').selectOption('manager')
  await dialog.getByRole('button', { name: 'Enviar convite', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('Convite enviado por e-mail.')
  await expect(page.getByText('Envio solicitado para nova@example.com.', { exact: false })).toBeVisible()
  await expect(page.getByLabel('Link do convite', { exact: true })).toHaveValue(/\?invite=b{64}$/)
  await expect(page.getByRole('button', { name: 'Copiar link', exact: true })).toHaveClass(/button-secondary/)
  await expect(page.getByRole('row').filter({ hasText: 'nova@example.com' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Convidar pessoa', exact: true })).toBeDisabled()
  expect(state.invitationAuthenticated).toBe(true)
  expect(state.calls.find(call => call.path === '/api/invitations')?.body).toEqual({ workspaceId: state.workspaceId, email: 'nova@example.com', role: 'manager' })
  expect(state.calls.filter(call => call.path.endsWith('/invite_member'))).toHaveLength(0)
})

test('email failure leaves no sent notice or link and refreshes available places', async ({ page }) => {
  const state = await mountAdministration(page, 'company', { invitationFailure: true })
  await page.getByRole('button', { name: 'Convidar pessoa', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Convide alguém para a equipe' })
  await dialog.getByLabel('E-mail da pessoa').fill('novo@example.com')
  await dialog.getByRole('button', { name: 'Enviar convite', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText(smtpFailureMessage)
  await expect(dialog.getByRole('alert')).not.toContainText('[object Object]')
  await expect(page.getByRole('status').filter({ hasText: 'Convite enviado' })).toHaveCount(0)
  await expect(page.getByLabel('Link do convite', { exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Convidar pessoa', exact: true })).toBeEnabled()
  await expect(page.getByText('Nenhum convite pendente.', { exact: false })).toBeVisible()
  expect(state.calls.filter(call => call.path === '/api/invitations')).toHaveLength(1)
  expect(state.calls.filter(call => call.path.endsWith('/list_invitations')).length).toBeGreaterThan(1)
})

test('new company sends the first administrator invitation by email', async ({ page }) => {
  const state = await mountAdministration(page, 'platform')
  await page.getByRole('button', { name: 'Nova empresa', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Uma nova empresa' })
  await dialog.getByLabel('Nome da empresa', { exact: true }).fill('Empresa Comercial')
  await dialog.getByLabel('Nome do administrador', { exact: true }).fill('Nina Admin')
  await dialog.getByLabel('E-mail do administrador', { exact: true }).fill('nina@example.com')
  await dialog.getByRole('button', { name: 'Criar empresa e enviar convite', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('Empresa criada e convite enviado por e-mail ao administrador.')
  await expect(page.getByRole('row').filter({ hasText: 'Empresa Comercial' })).toBeVisible()
  await expect(page.getByText('Envio solicitado para nina@example.com.', { exact: false })).toBeVisible()
  expect(state.calls.filter(call => call.path.endsWith('/create_workspace'))).toHaveLength(1)
  expect(state.calls.find(call => call.path === '/api/invitations')?.body).toEqual({ workspaceId: state.additionalWorkspaces[0].id, email: 'nina@example.com', role: 'admin' })
})

test('partial company creation retries email in the existing company without duplicating it', async ({ page }) => {
  const state = await mountAdministration(page, 'platform', { invitationFailure: true })
  await page.getByRole('button', { name: 'Nova empresa', exact: true }).click()
  const createDialog = page.getByRole('dialog', { name: 'Uma nova empresa' })
  await createDialog.getByLabel('Nome da empresa', { exact: true }).fill('Empresa Comercial')
  await createDialog.getByLabel('E-mail do administrador', { exact: true }).fill('nina@example.com')
  await createDialog.getByRole('button', { name: 'Criar empresa e enviar convite', exact: true }).click()
  await expect(createDialog).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText(/empresa foi criada/i)
  await expect(page.getByRole('alert')).toContainText(smtpFailureMessage)
  await expect(page.getByRole('alert')).not.toContainText('[object Object]')
  await expect(page.getByText('0 membros ativos', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Link do convite', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'convite enviado' })).toHaveCount(0)
  state.invitationFailure = false
  await page.getByRole('button', { name: 'Convidar pessoa', exact: true }).click()
  const inviteDialog = page.getByRole('dialog', { name: 'Convide alguém para a equipe' })
  await expect(inviteDialog.getByLabel('E-mail da pessoa')).toHaveValue('nina@example.com')
  await expect(inviteDialog.getByLabel('Papel na empresa')).toHaveValue('admin')
  await inviteDialog.getByRole('button', { name: 'Enviar convite', exact: true }).click()
  await expect(inviteDialog).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('Convite enviado por e-mail.')
  expect(state.calls.filter(call => call.path.endsWith('/create_workspace'))).toHaveLength(1)
  expect(state.calls.filter(call => call.path === '/api/invitations')).toHaveLength(2)
  expect(state.additionalWorkspaces).toHaveLength(1)
})
