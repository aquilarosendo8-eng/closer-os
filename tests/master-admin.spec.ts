import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { assertMasterClean, createMasterState, masterRequests, masterWorkspaceA, masterWorkspaceB, mountMaster, openMasterCompany, seedMasterIntegration, type MasterState } from './fixtures/master-admin'
import { profileUserIds } from './fixtures/profile'

const operational = /(?:\/rest\/v1\/(?:leads|lead_calls|call_reviews|activities|lead_events|recordings|evaluations|workspace_settings|pipelines|pipeline_stages)$|\/rpc\/(?:list_(?:call_reviews|pipeline_stages|lead_activities|lead_events|lead_call_history)|export_workspace|move_lead|save_lead))/
const visualDirectory = process.env.MASTER_SCREENSHOT_DIRECTORY || '.playwright/master-visual'
mkdirSync(visualDirectory, { recursive: true })
function assertNoCommercialAccess(state: MasterState) {
  expect([...state.requests, ...state.profile.requests].filter(request => operational.test(request.path))).toEqual([])
  expect(state.profile.requests.filter(request => request.path === '/rest/v1/memberships' && request.method !== 'GET')).toEqual([])
  assertMasterClean(state)
}
async function integrations(page: Page) {
  await page.getByRole('tab', { name: 'Integrações', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Formulários e Webhooks', exact: true })).toBeVisible()
}
async function danger(page: Page) { await page.getByRole('tab', { name: 'Zona de perigo', exact: true }).click() }
async function deletion(page: Page) {
  await danger(page)
  await page.getByRole('button', { name: 'Excluir empresa', exact: true }).click()
  const modal = page.getByRole('dialog').filter({ has: page.getByLabel('Digite o nome exato da empresa para confirmar') })
  await expect(modal).toBeVisible()
  return modal
}
async function authorizeDeletion(modal: Locator, name = 'Aurora Comercial') {
  await modal.getByLabel('Digite o nome exato da empresa para confirmar').fill(name)
  await modal.getByLabel(/Motivo/).fill('Encerramento autorizado da conta de teste')
  await modal.getByRole('checkbox', { name: /irreversível|permanente/i }).check()
  await modal.getByRole('checkbox', { name: /autorização/i }).check()
}
async function createIntegration(page: Page, name = 'Formulário Comercial') {
  await page.getByRole('button', { name: 'Nova integração', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Nova integração', exact: true })
  await editor.getByLabel('Nome da integração', { exact: true }).fill(name)
  await editor.getByLabel(/^Origem padrão/).fill('Site institucional')
  await editor.getByLabel('Responsável padrão', { exact: true }).selectOption(profileUserIds.closer)
  await editor.getByLabel('Propriedade externa para Nome', { exact: true }).fill('nome_completo')
  await editor.getByRole('button', { name: 'Criar integração', exact: true }).click()
  const credential = page.getByRole('dialog', { name: 'Integração criada', exact: true })
  await expect(credential).toBeVisible()
  return credential
}

test('Master without memberships selects either client and only sees administrative sections', async ({ page }) => {
  const state = await mountMaster(page)
  for (const name of ['Aurora Comercial', 'Outra Empresa']) {
    await openMasterCompany(page, name)
    await expect(page.getByRole('tab', { name: 'Informações', exact: true })).toHaveAttribute('aria-selected', 'true')
    for (const label of ['Equipe', 'Plano', 'Integrações', 'Auditoria', 'Zona de perigo']) await expect(page.getByRole('tab', { name: label, exact: true })).toBeVisible()
    for (const label of ['Pipeline', 'Leads', 'Calls', 'Performance']) await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Exportar dados da empresa', exact: true })).toHaveCount(0)
    await expect(page.getByLabel('Contato de privacidade', { exact: true })).toHaveCount(0)
    await expect(page.getByLabel(/^Nome da empresa/)).toHaveValue(name)
    await page.getByRole('button', { name: 'Todos os clientes', exact: true }).click()
  }
  assertNoCommercialAccess(state)
})

test('Master edits institutional name and commercial contact separately from login and privacy email', async ({ page }) => {
  const state = await mountMaster(page)
  await openMasterCompany(page)
  await expect(page.getByText(masterWorkspaceA, { exact: true })).toBeVisible()
  await expect(page.getByLabel(/^E-mail de contato comercial/)).toHaveValue('comercial@aurora.example.invalid')
  await page.getByLabel(/^Nome da empresa/).fill('Aurora Enterprise')
  await page.getByLabel(/^E-mail de contato comercial/).fill('DIRETORIA@AURORA.EXAMPLE.INVALID')
  await page.getByRole('button', { name: 'Salvar informações', exact: true }).click()
  await expect(page.getByRole('status')).toContainText(/informações.*atualizadas/i)
  expect(masterRequests(state, 'platform_update_workspace_information')).toHaveLength(1)
  expect(masterRequests(state, 'platform_update_workspace_information')[0].body).toEqual({ p_workspace_id: masterWorkspaceA, p_name: 'Aurora Enterprise', p_business_contact_email: 'diretoria@aurora.example.invalid' })
  expect(state.profile.requests.filter(request => request.path === '/auth/v1/user' && request.method !== 'GET')).toEqual([])
  await page.getByRole('tab', { name: 'Equipe', exact: true }).click()
  await expect(page.getByText('admin@example.invalid', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Todos os clientes', exact: true }).click()
  await openMasterCompany(page, 'Aurora Enterprise')
  await expect(page.getByLabel(/^E-mail de contato comercial/)).toHaveValue('diretoria@aurora.example.invalid')
  assertNoCommercialAccess(state)
})

test('information errors keep the draft and invalid contact does not send an update', async ({ page }) => {
  const state = await mountMaster(page)
  await openMasterCompany(page)
  await page.getByLabel(/^E-mail de contato comercial/).fill('endereco-invalido')
  await page.getByRole('button', { name: 'Salvar informações', exact: true }).click()
  expect(masterRequests(state, 'platform_update_workspace_information')).toHaveLength(0)
  await page.getByLabel(/^E-mail de contato comercial/).fill('novo@example.invalid')
  await page.getByLabel(/^Nome da empresa/).fill('Nome ainda não salvo')
  state.failInformation = true
  await page.getByRole('button', { name: 'Salvar informações', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Não foi possível salvar as informações')
  await expect(page.getByLabel(/^Nome da empresa/)).toHaveValue('Nome ainda não salvo')
  expect(state.workspaces[masterWorkspaceA].name).toBe('Aurora Comercial')
  state.failInformation = false
  await page.getByRole('button', { name: 'Salvar informações', exact: true }).click()
  await expect(page.getByRole('status')).toContainText(/informações.*atualizadas/i)
  assertNoCommercialAccess(state)
})

test('Master manages a member role and access only in the selected company and keeps owner protections', async ({ page }) => {
  const state = await mountMaster(page); await openMasterCompany(page)
  await page.getByRole('tab', { name: 'Equipe', exact: true }).click()
  await expect(page.getByLabel('Papel de admin@example.invalid')).toBeDisabled()
  const member = page.getByRole('row').filter({ hasText: 'closer@example.invalid' })
  await member.getByLabel('Papel de closer@example.invalid').selectOption('manager')
  await member.getByRole('button', { name: 'Salvar papel de closer@example.invalid', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Permissão atualizada.')
  await expect(member.getByLabel('Papel de closer@example.invalid')).toHaveValue('manager')
  await member.getByRole('button', { name: 'Desativar', exact: true }).click()
  await page.getByRole('dialog', { name: 'Desativar este acesso?', exact: true }).getByRole('button', { name: 'Desativar acesso', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Acesso desativado.')
  await expect(member).toContainText('Desativado')
  expect(masterRequests(state, 'update_member').map(request => request.body)).toEqual([
    { p_workspace_id: masterWorkspaceA, p_user_id: profileUserIds.closer, p_role: 'manager', p_is_active: true },
    { p_workspace_id: masterWorkspaceA, p_user_id: profileUserIds.closer, p_role: 'manager', p_is_active: false },
  ])
  expect(state.memberships[masterWorkspaceB].find(row => row.user_id === profileUserIds.closer)).toMatchObject({ role: 'closer', is_active: true })
  expect(state.profile.names[profileUserIds.closer]).toBe('Caio Closer')
  assertNoCommercialAccess(state)
})

test('Master manages plan limits and suspension without becoming a company member', async ({ page }) => {
  const state = await mountMaster(page)
  await openMasterCompany(page)
  await page.getByRole('tab', { name: 'Plano', exact: true }).click()
  await page.getByLabel('Limite de lugares').fill('12')
  await page.getByRole('button', { name: 'Salvar plano e acesso', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Plano e acesso atualizados.')
  expect(state.subscriptions[masterWorkspaceA].seat_limit).toBe(12)
  await danger(page)
  await page.getByRole('button', { name: 'Suspender empresa', exact: true }).click()
  const confirmation = page.getByRole('dialog')
  await expect(confirmation).toContainText('Aurora Comercial')
  await confirmation.getByRole('button', { name: /Confirmar suspensão|Suspender acesso/i }).click()
  await expect.poll(() => state.subscriptions[masterWorkspaceA].status).toBe('suspended')
  expect(masterRequests(state, 'admin_update_subscription').at(-1)?.body).toMatchObject({ p_workspace_id: masterWorkspaceA, p_status: 'suspended' })
  assertNoCommercialAccess(state)
})

test('Master integration editor uses minimal stage/owner metadata and shows a new token only once', async ({ page }) => {
  const state = await mountMaster(page)
  await openMasterCompany(page)
  await integrations(page)
  const credential = await createIntegration(page)
  const token = await credential.getByLabel('Token', { exact: true }).inputValue()
  expect(token).toMatch(/^[a-f0-9]{64}$/)
  expect(state.issuedTokens).toEqual([token])
  await expect(credential.getByRole('button', { name: /Testar|teste real/i })).toHaveCount(0)
  await expect(credential.getByRole('heading', { name: 'Exemplo de payload', exact: true })).toBeVisible()
  await expect(page.getByLabel('Payload de teste', { exact: true })).toHaveCount(0)
  expect(masterRequests(state, 'platform_inbound_options').length).toBeGreaterThan(0)
  expect(masterRequests(state, 'platform_create_inbound_integration')[0].body).toMatchObject({ p_workspace_id: masterWorkspaceA, p_name: 'Formulário Comercial', p_owner_id: profileUserIds.closer, p_field_mapping: { name: 'nome_completo' } })
  await credential.getByRole('button', { name: /Concluir|Fechar$/, exact: false }).last().click()
  await page.getByRole('button', { name: 'Editar Formulário Comercial', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Editar integração', exact: true })
  await expect(editor.getByLabel('Token', { exact: true })).toHaveCount(0)
  await editor.getByLabel('Nome da integração').fill('Entrada Site Comercial')
  await editor.getByLabel('Propriedade externa para Nome', { exact: true }).fill('full_name')
  await editor.getByRole('button', { name: 'Salvar configuração', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Configuração da integração atualizada.')
  await expect(page.getByText('Entrada Site Comercial', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(token)
  assertNoCommercialAccess(state)
})

test('technical diagnostics omit lead identifiers and payloads, and use dedicated platform RPC', async ({ page }) => {
  const state = createMasterState(), integration = seedMasterIntegration(state)
  await mountMaster(page, { state })
  await openMasterCompany(page)
  await integrations(page)
  await page.getByRole('button', { name: 'Logs de Respondi → Make', exact: true }).click()
  const logs = page.getByRole('dialog', { name: 'Logs de Respondi → Make', exact: true })
  await expect(logs).toContainText('NAME_REQUIRED')
  await expect(logs).toContainText('Rejeitado')
  await expect(logs).not.toContainText('lead_id')
  await expect(logs.getByRole('columnheader', { name: /Lead|Oportunidade/i })).toHaveCount(0)
  await expect(logs.getByRole('button', { name: /Abrir lead|Ver lead|Abrir oportunidade/i })).toHaveCount(0)
  expect(masterRequests(state, 'platform_list_inbound_integration_logs')[0].body).toMatchObject({ p_workspace_id: masterWorkspaceA, p_integration_id: integration.id })
  expect(state.logs.every(row => !('lead_id' in row) && !('duplicate_lead_id' in row) && !('payload' in row))).toBe(true)
  assertNoCommercialAccess(state)
})

test('rotation, activation, deactivation and archival use explicit Master integration operations', async ({ page }) => {
  const state = createMasterState(); seedMasterIntegration(state)
  await mountMaster(page, { state }); await openMasterCompany(page); await integrations(page)
  await page.getByRole('button', { name: 'Redefinir credencial de Respondi → Make', exact: true }).click()
  await page.getByRole('dialog', { name: 'Redefinir credencial', exact: true }).getByRole('button', { name: 'Redefinir credencial', exact: true }).click()
  const credential = page.getByRole('dialog').filter({ has: page.getByLabel('Token', { exact: true }) })
  await expect(credential).toBeVisible()
  const token = await credential.getByLabel('Token', { exact: true }).inputValue()
  await credential.getByRole('button', { name: /Concluir|Fechar$/, exact: false }).last().click()
  await page.getByRole('button', { name: 'Desativar Respondi → Make', exact: true }).click()
  await page.getByRole('dialog', { name: 'Desativar integração', exact: true }).getByRole('button', { name: 'Desativar', exact: true }).click()
  await page.getByRole('button', { name: 'Ativar Respondi → Make', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Desativar Respondi → Make', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Arquivar Respondi → Make', exact: true }).click()
  await page.getByRole('dialog', { name: 'Arquivar integração', exact: true }).getByRole('button', { name: 'Arquivar', exact: true }).click()
  expect(masterRequests(state, 'platform_rotate_inbound_integration_token')).toHaveLength(1)
  expect(masterRequests(state, 'platform_set_inbound_integration_active').map(request => request.body?.p_active)).toEqual([false, true])
  expect(masterRequests(state, 'platform_archive_inbound_integration')).toHaveLength(1)
  expect(state.integrations[0].archived_at).not.toBeNull()
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(token)
  assertNoCommercialAccess(state)
})

test('failed administrative options preserve technical diagnostics and credential management', async ({ page }) => {
  const state = createMasterState(); seedMasterIntegration(state); state.failOptions = true
  await mountMaster(page, { state }); await openMasterCompany(page); await integrations(page)
  await expect(page.getByRole('button', { name: 'Nova integração', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Editar Respondi → Make', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Redefinir credencial de Respondi → Make', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Logs de Respondi → Make', exact: true }).click()
  const logs = page.getByRole('dialog', { name: 'Logs de Respondi → Make', exact: true })
  await expect(logs).toContainText('NAME_REQUIRED')
  await logs.getByRole('button', { name: 'Fechar', exact: true }).click()
  const requestsBefore = masterRequests(state, 'platform_inbound_options').length
  state.failOptions = false
  await page.getByRole('button', { name: 'Tentar carregar etapas', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Nova integração', exact: true })).toBeEnabled()
  expect(masterRequests(state, 'platform_inbound_options')).toHaveLength(requestsBefore + 1)
  assertNoCommercialAccess(state)
})

test('switching the selected client discards an older integration option response', async ({ page }) => {
  const state = createMasterState()
  seedMasterIntegration(state, masterWorkspaceA, 'Integração da Aurora')
  seedMasterIntegration(state, masterWorkspaceB, 'Integração da Outra Empresa')
  let release!: () => void
  state.delayedOptions.set(masterWorkspaceA, new Promise<void>(resolve => { release = resolve }))
  try {
    await mountMaster(page, { state }); await openMasterCompany(page); await integrations(page)
    await expect.poll(() => masterRequests(state, 'platform_inbound_options').some(request => request.body?.p_workspace_id === masterWorkspaceA)).toBe(true)
    await page.getByRole('button', { name: 'Todos os clientes', exact: true }).click()
    await openMasterCompany(page, 'Outra Empresa'); await integrations(page)
    await expect(page.getByText('Integração da Outra Empresa', { exact: true })).toBeVisible()
    release()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))))
    await expect(page.getByText('Integração da Aurora', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Editar Integração da Outra Empresa', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Editar integração', exact: true })
    await expect(editor.getByLabel('Etapa de entrada', { exact: true })).toHaveValue(String(state.integrations[1].stage_id))
    await editor.getByRole('button', { name: 'Cancelar', exact: true }).click()
    assertNoCommercialAccess(state)
  } finally { release() }
})

test('Master deletion requires exact name, reason, irreversible confirmation and authorization', async ({ page }) => {
  const state = await mountMaster(page); await openMasterCompany(page)
  const modal = await deletion(page), confirm = modal.getByRole('button', { name: 'Excluir empresa e dados', exact: true })
  await expect(modal).toContainText('Aurora Comercial')
  await expect(modal).toContainText(/permanente|irreversível/i)
  await expect(confirm).toBeDisabled()
  await authorizeDeletion(modal, 'aurora comercial')
  await expect(confirm).toBeDisabled()
  expect(masterRequests(state, 'platform_delete_workspace')).toHaveLength(0)
  await modal.getByLabel('Digite o nome exato da empresa para confirmar').fill('Aurora Comercial')
  await modal.getByRole('checkbox', { name: /autorização/i }).uncheck()
  await expect(confirm).toBeDisabled()
  await modal.getByRole('checkbox', { name: /autorização/i }).check()
  await modal.getByLabel(/Motivo/).fill('')
  await expect(confirm).toBeDisabled()
  await modal.getByLabel(/Motivo/).fill('Encerramento autorizado da conta de teste')
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(modal).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Clientes da plataforma', exact: true })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: 'Aurora Comercial' })).toHaveCount(0)
  await expect(page.getByRole('row').filter({ hasText: 'Outra Empresa' })).toBeVisible()
  expect(masterRequests(state, 'platform_delete_workspace')[0].body).toEqual({ p_workspace_id: masterWorkspaceA, p_confirmation: 'Aurora Comercial', p_irreversible_confirmed: true, p_authorization_confirmed: true, p_reason: 'Encerramento autorizado da conta de teste' })
  assertNoCommercialAccess(state)
})

test('cancelled or failed deletion keeps the company and safeguards visible', async ({ page }) => {
  const state = await mountMaster(page); await openMasterCompany(page)
  let modal = await deletion(page)
  await authorizeDeletion(modal)
  await modal.getByRole('button', { name: 'Cancelar', exact: true }).click()
  expect(masterRequests(state, 'platform_delete_workspace')).toHaveLength(0)
  modal = await deletion(page)
  await expect(modal.getByLabel('Digite o nome exato da empresa para confirmar')).toHaveValue('')
  await authorizeDeletion(modal)
  state.failDeletion = true
  await modal.getByRole('button', { name: 'Excluir empresa e dados', exact: true }).click()
  await expect(modal.getByRole('alert')).toContainText('A empresa está em atualização')
  await expect(modal.getByLabel('Digite o nome exato da empresa para confirmar')).toHaveValue('Aurora Comercial')
  expect(state.workspaces[masterWorkspaceA]).toBeDefined()
  await expect(modal.getByRole('button', { name: 'Excluir empresa e dados', exact: true })).toBeEnabled()
  assertNoCommercialAccess(state)
})

test('pending deletion cannot be confirmed a second time or silently switched to another company', async ({ page }) => {
  const state = await mountMaster(page); await openMasterCompany(page)
  let release!: () => void
  state.deletionWait = new Promise<void>(resolve => { release = resolve })
  try {
    const modal = await deletion(page)
    await authorizeDeletion(modal)
    const confirm = modal.getByRole('button', { name: 'Excluir empresa e dados', exact: true })
    await confirm.click()
    await expect(confirm).toBeDisabled()
    await expect(modal.getByRole('button', { name: 'Cancelar', exact: true })).toBeDisabled()
    await expect.poll(() => masterRequests(state, 'platform_delete_workspace').length).toBe(1)
    await page.keyboard.press('Escape')
    await expect(modal).toBeVisible()
    expect(state.workspaces[masterWorkspaceB]).toBeDefined()
    release()
    await expect(modal).toHaveCount(0)
    expect(masterRequests(state, 'platform_delete_workspace')).toHaveLength(1)
    assertNoCommercialAccess(state)
  } finally { release() }
})

for (const role of ['manager', 'closer', 'viewer', 'admin'] as const) test(`${role} does not receive Master clients, institutional or deletion controls`, async ({ page }) => {
  const state = await mountMaster(page, { role })
  if (role === 'admin') await page.locator('.cloud-context-bar').getByRole('button', { name: 'Administrar', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Clientes', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Informações', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Zona de perigo', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Clientes da plataforma', exact: true })).toHaveCount(0)
  await expect(page.getByLabel(/^E-mail de contato comercial/)).toHaveCount(0)
  expect(state.requests.filter(request => /\/platform_|\/list_platform_workspaces/.test(request.path))).toEqual([])
  assertMasterClean(state)
})

for (const theme of ['light', 'dark'] as const) for (const width of [1440, 390]) test(`${theme} ${width}px Master sections, technical logs and danger modal stay legible and inside the viewport`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
  const state = createMasterState(); seedMasterIntegration(state)
  await mountMaster(page, { state, theme }); await openMasterCompany(page)
  await expect(page.locator('.crm-visual')).toHaveAttribute('data-theme', theme)
  for (const name of ['Informações', 'Equipe', 'Plano', 'Integrações', 'Auditoria', 'Zona de perigo']) {
    await page.getByRole('tab', { name, exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
    await page.screenshot({ path: `${visualDirectory}/master-${theme}-${width}-${name.normalize('NFD').replace(/[\u0300-\u036f ]/g, '').toLowerCase()}.png`, animations: 'disabled' })
  }
  const modal = await deletion(page)
  await expect.poll(() => modal.evaluate(node => node.contains(document.activeElement))).toBe(true)
  await authorizeDeletion(modal)
  const bounds = await modal.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1)
  await expect(modal.getByRole('button', { name: 'Excluir empresa e dados', exact: true })).toBeEnabled()
  if (width === 390) {
    for (const name of ['Cancelar', 'Excluir empresa e dados']) {
      const control = await modal.getByRole('button', { name, exact: true }).boundingBox()
      expect(control?.height).toBeGreaterThanOrEqual(44)
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
  await modal.screenshot({ path: `${visualDirectory}/master-${theme}-${width}-delete.png`, animations: 'disabled' })
  await modal.getByRole('button', { name: 'Cancelar', exact: true }).click()
  assertNoCommercialAccess(state)
})
