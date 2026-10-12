import { expect, test, type Locator, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { createInboundState, mountInbound, openInbound, seedIntegration, memberIds, workspaceA, workspaceB, type InboundState } from './fixtures/inbound'
import { openOpportunity } from './fixtures/opportunity'

const externalMapping = { name: 'full_name', email: 'email_address', phone: 'whatsapp', company: 'company_name', ticket: 'interest', notes: 'context' }
const payload = { full_name: 'João Silva', email_address: ' JOAO@EXAMPLE.INVALID ', whatsapp: '+55 (77) 99999-9999', company_name: 'XPTO', interest: 15000, context: 'Formulário enviado pelo site', unexpected: 'Este campo não deve aparecer nas observações', workspaceId: workspaceB, ownerId: memberIds.viewer }
const integrationRequests = (state: InboundState, rpc: string) => state.inboundRequests.filter(request => request.path.endsWith(`/${rpc}`))
function clean(state: InboundState) {
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([])
  expect(state.inboundRequests.filter(request => /inbound/.test(request.path)).every(request => request.authenticated)).toBe(true)
  expect(state.requests.filter(request => ['PATCH', 'DELETE'].includes(request.method))).toHaveLength(0)
}
async function openCreate(page: Page) {
  await page.getByRole('button', { name: 'Nova integração', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Nova integração', exact: true })
  await expect(dialog).toBeVisible(); return dialog
}
async function fillConfiguration(dialog: Locator, name = 'Formulário Site') {
  await dialog.getByLabel('Nome da integração', { exact: true }).fill(name)
  await dialog.getByLabel(/^Origem padrão/).fill('Landing Page')
  await dialog.getByLabel('Etapa de entrada', { exact: true }).selectOption({ label: 'Lead novo' })
  await dialog.getByLabel('Responsável padrão', { exact: true }).selectOption(memberIds.closer)
  const labels = { name: 'Nome', email: 'E-mail', phone: 'Telefone / WhatsApp', company: 'Empresa', ticket: 'Ticket estimado', source: 'Origem', notes: 'Observações' }
  for (const [field, label] of Object.entries(labels)) await dialog.getByLabel(`Propriedade externa para ${label}`, { exact: true }).fill(externalMapping[field as keyof typeof externalMapping] || '')
}
async function createIntegration(page: Page, name = 'Formulário Site') {
  const form = await openCreate(page)
  await fillConfiguration(form, name)
  await form.getByRole('button', { name: 'Criar integração', exact: true }).click()
  const credential = page.getByRole('dialog', { name: 'Integração criada', exact: true })
  await expect(credential).toBeVisible()
  return { credential, url: await credential.getByLabel('URL do Webhook', { exact: true }).inputValue(), token: await credential.getByLabel('Token', { exact: true }).inputValue() }
}
async function closeCredential(credential: Locator) {
  await credential.getByRole('button', { name: 'Fechar', exact: true }).click()
  await expect(credential).not.toBeVisible()
}
async function sendTest(page: Page, credential: Locator, value: unknown = payload) {
  await credential.getByRole('button', { name: 'Testar integração', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Testar integração', exact: true })
  await expect(dialog).toContainText(/lead real/i)
  await dialog.getByLabel('Payload de teste', { exact: true }).fill(JSON.stringify(value))
  await dialog.getByRole('button', { name: 'Enviar teste real', exact: true }).click()
  return dialog
}
async function returnToCRM(page: Page) {
  await page.locator('.cloud-context-bar').getByRole('button', { name: 'Voltar ao CRM', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Visão geral.', exact: true })).toBeVisible()
}
async function localWebhookPost(page: Page, url: string, value: unknown) {
  // Browser fetch reaches the actual API handler via the fixture's local route adapter.
  return page.evaluate(async ({ url, value }) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
    return { status: response.status, body: await response.json() }
  }, { url, value })
}

test('admin creates flat field mapping with an active normal stage and editable owner; credentials are shown once', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const fixture = createInboundState()
  fixture.stages[workspaceA][1].active = false
  const state = await mountInbound(page, 'admin', { state: fixture })
  await openInbound(page)
  const form = await openCreate(page)
  await expect(form.getByLabel('Etapa de entrada').locator('option').filter({ hasText: 'Fechado' })).toHaveCount(0)
  await expect(form.getByLabel('Etapa de entrada').locator('option').filter({ hasText: 'Perdido' })).toHaveCount(0)
  await expect(form.getByLabel('Etapa de entrada').locator('option').filter({ hasText: 'Qualificado' })).toHaveCount(0)
  await expect(form.getByLabel('Responsável padrão').locator(`option[value="${memberIds.viewer}"]`)).toHaveCount(0)
  await fillConfiguration(form)
  await form.getByRole('button', { name: 'Criar integração', exact: true }).click()
  const credential = page.getByRole('dialog', { name: 'Integração criada', exact: true })
  await expect(credential).toBeVisible()
  const url = await credential.getByLabel('URL do Webhook', { exact: true }).inputValue(), token = await credential.getByLabel('Token', { exact: true }).inputValue()
  expect(token).toMatch(/^[a-f0-9]{64}$/)
  expect(new URL(url).pathname).toBe('/api/inbound-leads')
  expect(new URL(url).searchParams.get('token')).toBe(token)
  expect(new URL(url).searchParams.has('workspaceId')).toBe(false)
  await expect(credential).toContainText(/não será exibida novamente/i)
  await credential.getByRole('button', { name: 'Copiar URL', exact: true }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url)
  await credential.getByRole('button', { name: 'Copiar token', exact: true }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token)
  expect(state.tokenHashes[state.integrations[0].id]).toBe(createHash('sha256').update(token).digest('hex'))
  expect(state.integrations[0]).not.toHaveProperty('token')
  expect(state.integrations[0]).not.toHaveProperty('token_hash')
  expect(integrationRequests(state, 'create_inbound_integration')[0].body).toMatchObject({ p_workspace_id: workspaceA, p_name: 'Formulário Site', p_source: 'Landing Page', p_owner_id: memberIds.closer, p_field_mapping: externalMapping })
  await closeCredential(credential)
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(token)
  await page.getByRole('button', { name: 'Editar Formulário Site', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Editar integração', exact: true }).getByLabel('Nome da integração')).toHaveValue('Formulário Site')
  await expect(page.getByLabel('Token', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('URL do Webhook', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.reload(); await expect(page.getByRole('heading', { name: 'Visão geral.', exact: true })).toBeVisible()
  await openInbound(page)
  await expect(page.getByText(token, { exact: false })).toHaveCount(0)
  await expect(page.getByLabel('Token', { exact: true })).toHaveCount(0)
  clean(state)
})

test('the real test POST maps a normal lead, handles a duplicate and feeds Pipeline, Lead 360, timeline and safe logs', async ({ page }) => {
  const state = await mountInbound(page)
  await openInbound(page)
  const created = await createIntegration(page)
  const testing = await sendTest(page, created.credential)
  await expect(testing.getByRole('status')).toContainText('Lead criado no HIGH CLOSER.')
  expect(state.receivedRequests).toHaveLength(1)
  expect(state.receivedRequests[0].tokenHash).toBe(createHash('sha256').update(created.token).digest('hex'))
  const received = state.leads.find(row => row.data.name === 'João Silva')!
  expect(received).toMatchObject({ workspace_id: workspaceA, owner_id: memberIds.closer, stage_id: state.stages[workspaceA][0].id,
    data: { name: 'João Silva', email: 'joao@example.invalid', company: 'XPTO', ticket: 15000, source: 'Landing Page', status: 'Lead novo', notes: 'Formulário enviado pelo site' } })
  expect(received.data.notes).not.toContain('unexpected')
  await testing.getByRole('button', { name: 'Enviar teste real', exact: true }).click()
  await expect(testing.getByRole('status')).toContainText('Envio recebido como duplicado. Nenhum novo lead criado.')
  expect(state.leads.filter(row => row.workspace_id === workspaceA)).toHaveLength(1)
  expect(state.integrations[0]).toMatchObject({ created_count: 1, duplicate_count: 1, error_count: 0 })
  await expect(testing.getByRole('button', { name: 'Enviar teste real', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  await closeCredential(page.getByRole('dialog').filter({ has: page.getByLabel('Token', { exact: true }) }))
  await returnToCRM(page)
  const opportunity = await openOpportunity(page, 'João Silva')
  await expect(opportunity).toContainText('Landing Page')
  await expect(opportunity).toContainText('Caio Closer')
  await opportunity.getByRole('tab', { name: 'Timeline', exact: true }).click()
  await expect(opportunity.getByText(/Lead recebido automaticamente via Formulário Site/)).toBeVisible()
  await expect(opportunity).not.toContainText(created.token)
  await opportunity.getByRole('button', { name: 'Fechar oportunidade', exact: true }).click()
  await openInbound(page)
  await page.getByRole('button', { name: 'Logs de Formulário Site', exact: true }).click()
  const logs = page.getByRole('dialog', { name: 'Logs de Formulário Site', exact: true })
  await expect(logs.getByText('Lead criado', { exact: true })).toBeVisible()
  await expect(logs.getByText('Duplicado', { exact: true })).toBeVisible()
  await expect(logs).not.toContainText(created.token)
  await expect(logs).not.toContainText('joao@example.invalid')
  await expect(logs).not.toContainText('Formulário enviado pelo site')
  expect(state.logs.every(row => !('payload' in row) && !('token' in row) && !('authorization' in row))).toBe(true)
  clean(state)
})

test('rotation invalidates the previous URL and disabling or archiving immediately stops local ingress', async ({ page }) => {
  const state = await mountInbound(page)
  await openInbound(page)
  const old = await createIntegration(page)
  await closeCredential(old.credential)
  await page.getByRole('button', { name: 'Redefinir credencial de Formulário Site', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: 'Redefinir credencial', exact: true })
  await confirmation.getByRole('button', { name: 'Redefinir credencial', exact: true }).click()
  const credential = page.getByRole('dialog').filter({ has: page.getByLabel('Token', { exact: true }) })
  await expect(credential).toBeVisible()
  const nextUrl = await credential.getByLabel('URL do Webhook', { exact: true }).inputValue()
  expect(nextUrl).not.toBe(old.url)
  expect((await localWebhookPost(page, old.url, payload)).status).toBe(401)
  expect((await localWebhookPost(page, nextUrl, payload)).status).toBe(201)
  await closeCredential(credential)
  await page.getByRole('button', { name: 'Desativar Formulário Site', exact: true }).click()
  await page.getByRole('dialog', { name: 'Desativar integração', exact: true }).getByRole('button', { name: 'Desativar', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Ativar Formulário Site', exact: true })).toBeVisible()
  expect((await localWebhookPost(page, nextUrl, { ...payload, email_address: 'another@example.invalid', whatsapp: '44123456789' })).status).toBe(401)
  await page.getByRole('button', { name: 'Ativar Formulário Site', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Desativar Formulário Site', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Arquivar Formulário Site', exact: true }).click()
  await page.getByRole('dialog', { name: 'Arquivar integração', exact: true }).getByRole('button', { name: 'Arquivar', exact: true }).click()
  expect((await localWebhookPost(page, nextUrl, payload)).status).toBe(401)
  expect(state.integrations[0].archived_at).not.toBeNull()
  expect(state.logs).toHaveLength(1)
  expect(state.leads.filter(row => row.workspace_id === workspaceA)).toHaveLength(1)
  clean(state)
})

test('creation and configuration failures preserve drafts and never show a credential or false success', async ({ page }) => {
  const state = await mountInbound(page)
  state.failCreate = true
  await openInbound(page)
  const form = await openCreate(page)
  await fillConfiguration(form)
  await form.getByRole('button', { name: 'Criar integração', exact: true }).click()
  await expect(form.getByRole('alert')).toContainText('Não foi possível criar a integração')
  await expect(form.getByLabel('Nome da integração')).toHaveValue('Formulário Site')
  await expect(page.getByLabel('Token', { exact: true })).toHaveCount(0)
  expect(state.integrations).toHaveLength(0)
  state.failCreate = false
  await form.getByRole('button', { name: 'Criar integração', exact: true }).click()
  await closeCredential(page.getByRole('dialog', { name: 'Integração criada', exact: true }))
  await page.getByRole('button', { name: 'Editar Formulário Site', exact: true }).click()
  const editing = page.getByRole('dialog', { name: 'Editar integração', exact: true })
  state.failUpdate = true
  await editing.getByLabel('Nome da integração').fill('Nome preservado no formulário')
  await editing.getByRole('button', { name: 'Salvar configuração', exact: true }).click()
  await expect(editing.getByRole('alert')).toContainText('Não foi possível salvar a configuração')
  await expect(editing.getByLabel('Nome da integração')).toHaveValue('Nome preservado no formulário')
  expect(state.integrations[0].name).toBe('Formulário Site')
  clean(state)
})

test('missing mapped name creates a rejected safe log, not a lead or a successful test', async ({ page }) => {
  const state = await mountInbound(page)
  await openInbound(page)
  const created = await createIntegration(page)
  const testing = await sendTest(page, created.credential, { email_address: 'private@example.invalid', unexpected: 'RAW SECRET PAYLOAD' })
  await expect(testing.getByRole('alert')).toContainText('Informe o nome no campo configurado')
  await expect(testing.getByRole('status')).toHaveCount(0)
  expect(state.leads.filter(row => row.workspace_id === workspaceA)).toHaveLength(0)
  expect(state.logs[0]).toMatchObject({ status: 'rejected', error_code: 'NAME_REQUIRED' })
  expect(JSON.stringify(state.logs)).not.toContain('RAW SECRET PAYLOAD')
  expect(JSON.stringify(state.logs)).not.toContain('private@example.invalid')
  clean(state)
})

test('received HTML-like values are rendered as lead data without executing scripts', async ({ page }) => {
  const state = createInboundState(), seeded = seedIntegration(state)
  await mountInbound(page, 'admin', { state })
  const name = '<img src=x onerror="window.inboundXssExecuted=true">'
  const notes = '<svg onload="window.inboundXssExecuted=true">'
  const destination = new URL('/api/inbound-leads', page.url()); destination.searchParams.set('token', seeded.token)
  expect((await localWebhookPost(page, destination.toString(), { name, notes, email: 'xss@example.invalid' })).status).toBe(201)
  await page.reload(); await expect(page.getByRole('heading', { name: 'Visão geral.', exact: true })).toBeVisible()
  const detail = await openOpportunity(page, name)
  await expect(detail.getByRole('heading', { name: `Oportunidade de ${name}`, exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { inboundXssExecuted?: boolean }).inboundXssExecuted)).toBeUndefined()
  await expect(detail.locator('img[onerror], svg[onload]')).toHaveCount(0)
  expect(state.leads.find(row => row.data.name === name)?.data.notes).toBe(notes)
  clean(state)
})

test('integration logs paginate by server cursor and retain only operational metadata', async ({ page }) => {
  const state = createInboundState(), seeded = seedIntegration(state)
  for (let index = 1; index <= 34; index++) state.logs.push({ id: String(index), workspace_id: workspaceA, integration_id: seeded.integration.id,
    request_id: `90000000-0000-4000-8000-${String(index).padStart(12, '0')}`, status: 'rejected', error_code: 'NAME_REQUIRED',
    lead_id: null, duplicate_lead_id: null, created_at: seeded.integration.created_at })
  seeded.integration.error_count = 34
  await mountInbound(page, 'admin', { state })
  await openInbound(page)
  await page.getByRole('button', { name: 'Logs de Formulário Site', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Logs de Formulário Site', exact: true })
  await expect(dialog.locator('tbody tr')).toHaveCount(30)
  await dialog.getByRole('button', { name: 'Carregar mais recebimentos', exact: true }).click()
  await expect(dialog.locator('tbody tr')).toHaveCount(34)
  await expect(dialog.getByRole('button', { name: 'Carregar mais recebimentos', exact: true })).toHaveCount(0)
  expect(integrationRequests(state, 'list_inbound_integration_logs').map(request => request.body?.p_before_id)).toEqual([null, '5'])
  await expect(dialog).not.toContainText(seeded.token)
  clean(state)
})

test('stage option failure preserves existing integrations, logs and disabling; retry reloads only stage choices', async ({ page }) => {
  const fixture = createInboundState(), seeded = seedIntegration(fixture)
  fixture.logs.push({ id: '1', workspace_id: workspaceA, integration_id: seeded.integration.id,
    request_id: '90000000-0000-4000-8000-000000000001', status: 'rejected', error_code: 'NAME_REQUIRED',
    lead_id: null, duplicate_lead_id: null, created_at: seeded.integration.created_at })
  seeded.integration.error_count = 1
  const state = await mountInbound(page, 'admin', { state: fixture })
  // The CRM's initial load succeeded; only the later configuration options fail.
  state.failStageOptions = true
  await openInbound(page)
  await expect(page.getByText('Formulário Site', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('Não foi possível carregar as etapas do pipeline')
  await expect(page.getByRole('button', { name: 'Nova integração', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Editar Formulário Site', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Redefinir credencial de Formulário Site', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Arquivar Formulário Site', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Logs de Formulário Site', exact: true }).click()
  const logs = page.getByRole('dialog', { name: 'Logs de Formulário Site', exact: true })
  await expect(logs.getByText('Rejeitado', { exact: true })).toBeVisible()
  await logs.getByRole('button', { name: 'Fechar', exact: true }).click()
  const listCountBeforeDisable = integrationRequests(state, 'list_inbound_integrations').length
  await page.getByRole('button', { name: 'Desativar Formulário Site', exact: true }).click()
  await page.getByRole('dialog', { name: 'Desativar integração', exact: true }).getByRole('button', { name: 'Desativar', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Ativar Formulário Site', exact: true })).toBeVisible()
  await expect.poll(() => integrationRequests(state, 'list_inbound_integrations').length).toBeGreaterThan(listCountBeforeDisable)
  const listCountBeforeRetry = integrationRequests(state, 'list_inbound_integrations').length
  const leadsBeforeRetry = state.requests.filter(request => request.path === '/rest/v1/leads').length
  const stagesBeforeRetry = state.stageOptionCalls
  state.failStageOptions = false
  await page.getByRole('button', { name: 'Tentar carregar etapas', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Nova integração', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Editar Formulário Site', exact: true })).toBeEnabled()
  expect(state.stageOptionCalls).toBe(stagesBeforeRetry + 1)
  expect(integrationRequests(state, 'list_inbound_integrations')).toHaveLength(listCountBeforeRetry)
  expect(state.requests.filter(request => request.path === '/rest/v1/leads')).toHaveLength(leadsBeforeRetry)
  expect(seeded.integration.active).toBe(false)
  await expect(page.getByLabel('Token', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('URL do Webhook', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Editar Formulário Site', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Editar integração', exact: true })
  await expect(editor.getByLabel('Etapa de entrada', { exact: true })).toHaveValue(seeded.integration.stage_id!)
  await editor.getByRole('button', { name: 'Cancelar', exact: true }).click()
  clean(state)
})

for (const role of ['manager', 'closer', 'viewer'] as const) test(`${role} cannot browse or administer workspace integrations`, async ({ page }) => {
  const state = await mountInbound(page, role)
  await expect(page.locator('.cloud-context-bar').getByRole('button', { name: 'Administrar', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Integrações', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Nova integração', exact: true })).toHaveCount(0)
  expect(state.inboundRequests.filter(request => /inbound/.test(request.path))).toHaveLength(0)
  clean(state)
})

test('platform administration alone never requests client integration metadata or logs', async ({ page }) => {
  const state = await mountInbound(page, 'platform')
  await page.getByRole('row').filter({ hasText: 'Aurora Comercial' }).getByRole('button', { name: /Administrar/ }).click()
  await expect(page.getByRole('tab', { name: 'Equipe', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Integrações', exact: true })).toHaveCount(0)
  expect(state.inboundRequests.filter(request => /inbound/.test(request.path))).toHaveLength(0)
  expect(state.receivedRequests).toHaveLength(0)
  clean(state)
})

test('switching companies discards an older integration response and exposes only the selected company', async ({ page }) => {
  const state = createInboundState()
  seedIntegration(state, workspaceA, 'SEGREDO INTEGRAÇÃO EMPRESA A')
  seedIntegration(state, workspaceB, 'INTEGRAÇÃO EMPRESA B')
  let release!: () => void
  state.delayedLists.set(workspaceA, new Promise<void>(resolve => { release = resolve }))
  await mountInbound(page, 'admin', { state, twoWorkspaces: true })
  try {
    await page.locator('.cloud-context-bar').getByRole('button', { name: 'Administrar', exact: true }).click()
    await page.getByRole('tab', { name: 'Integrações', exact: true }).click()
    await expect.poll(() => integrationRequests(state, 'list_inbound_integrations').some(request => request.body?.p_workspace_id === workspaceA)).toBe(true)
    await page.getByLabel('Selecionar empresa').selectOption(workspaceB)
    await expect(page.getByRole('heading', { name: 'Visão geral.', exact: true })).toBeVisible()
    await openInbound(page)
    await expect(page.getByText('INTEGRAÇÃO EMPRESA B', { exact: true })).toBeVisible()
    release()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))))
    await expect(page.getByText('SEGREDO INTEGRAÇÃO EMPRESA A', { exact: true })).toHaveCount(0)
    await expect(page.getByText('INTEGRAÇÃO EMPRESA B', { exact: true })).toBeVisible()
    clean(state)
  } finally { release() }
})

for (const theme of ['light', 'dark'] as const) for (const width of [1366, 390]) test(`${theme} ${width}px integration configuration and credential panels keep the operational theme and page width`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
  const state = await mountInbound(page, 'admin', { theme })
  await openInbound(page)
  await expect(page.locator('.crm-visual')).toHaveAttribute('data-theme', theme)
  const created = await createIntegration(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
  await created.credential.screenshot({ path: `.playwright/inbound-${theme}-${width}.png`, animations: 'disabled' })
  await closeCredential(created.credential)
  await page.getByRole('button', { name: 'Editar Formulário Site', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Editar integração', exact: true }).getByLabel('Nome da integração')).toHaveValue('Formulário Site')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
  clean(state)
})
