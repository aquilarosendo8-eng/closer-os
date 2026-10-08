import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createProfileState, effectiveProfileName, mountProfile, openOwnProfile, openProfileAdministration,
  profileEmail, profileUserIds, profileWorkspaceA, profileWorkspaceB, type ProfileRole, type ProfileState } from './fixtures/profile'

const ownWrites = (state: ProfileState) => state.requests.filter(request => request.path.endsWith('/update_my_display_name'))
const memberWrites = (state: ProfileState) => state.requests.filter(request => request.path.endsWith('/update_member_display_name'))
const companyWrites = (state: ProfileState) => state.requests.filter(request => request.path.endsWith('/rename_workspace'))
function clean(state: ProfileState) {
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([])
  expect(state.requests.filter(request => request.path.startsWith('/auth/') && request.method !== 'GET' && request.method !== 'OPTIONS')).toEqual([])
  expect(state.requests.filter(request => /memberships|profiles|workspaces/.test(request.path) && ['PATCH', 'PUT', 'DELETE'].includes(request.method))).toEqual([])
  expect(state.requests.filter(request => /update_member$|update_subscription|create_invitation|invite_member|revoke_invitation|accept_invitation|\/api\/invitation|recover|signup/.test(request.path))).toEqual([])
}
async function returnToCRM(page: Page) {
  await page.locator('.cloud-context-bar').getByRole('button', { name: 'Voltar ao CRM', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Visão geral.', exact: true })).toBeVisible()
}
async function screenshot(page: Page, info: TestInfo, suffix: string) {
  await mkdir(resolve('.playwright/profile-shots'), { recursive: true })
  const path = resolve('.playwright/profile-shots', `${info.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${suffix}.png`)
  await page.screenshot({ path, fullPage: false, animations: 'disabled' }); await info.attach(suffix, { path, contentType: 'image/png' })
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => innerWidth) + 1)
}

for (const role of ['admin', 'manager', 'closer', 'viewer'] as const) {
  test(`${role} can rename only their own profile; sidebar and avatars refresh and survive reload`, async ({ page }) => {
    const state = await mountProfile(page, role), originalEmail = profileEmail(role)
    await openOwnProfile(page)
    await expect(page.getByLabel('E-mail', { exact: true })).toHaveValue(originalEmail)
    await expect(page.getByLabel('E-mail', { exact: true })).toHaveAttribute('readonly', '')
    await page.getByLabel('Nome de exibição', { exact: true }).fill('  Beatriz Santos  ')
    await page.getByRole('button', { name: 'Salvar nome', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Nome atualizado com sucesso.')
    await expect(page.getByLabel('Nome de exibição', { exact: true })).toHaveValue('Beatriz Santos')
    await expect(page.getByLabel('Nome de exibição', { exact: true })).toHaveAttribute('readonly', '')
    expect(ownWrites(state)).toHaveLength(1)
    expect(ownWrites(state)[0].body).toEqual({ p_display_name: 'Beatriz Santos', p_workspace_id: profileWorkspaceA })
    expect(ownWrites(state)[0].body).not.toHaveProperty('p_user_id')
    expect(memberWrites(state)).toHaveLength(0); expect(companyWrites(state)).toHaveLength(0)
    await returnToCRM(page)
    await expect(page.locator('.sidebar-profile strong')).toHaveText('Beatriz Santos')
    await expect(page.locator('.sidebar-profile .profile-avatar')).toHaveText('BS')
    await expect(page.getByRole('button', { name: 'Seu perfil', exact: true })).toHaveText('BS')
    await page.reload(); await expect(page.getByRole('heading', { name: 'Visão geral.', exact: true })).toBeVisible()
    await expect(page.locator('.sidebar-profile strong')).toHaveText('Beatriz Santos')
    await expect(page.getByRole('button', { name: 'Seu perfil', exact: true })).toHaveText('BS')
    expect(state.names[profileUserIds[role]]).toBe('Beatriz Santos'); clean(state)
  })
}

test('platform admin without company membership can change their own name with a null workspace', async ({ page }) => {
  const state = await mountProfile(page, 'platform')
  await openOwnProfile(page)
  await page.getByLabel('Nome de exibição', { exact: true }).fill('Patrícia Plataforma')
  await page.getByRole('button', { name: 'Salvar nome', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Nome atualizado com sucesso.')
  expect(ownWrites(state)[0].body).toEqual({ p_display_name: 'Patrícia Plataforma', p_workspace_id: null })
  await page.reload(); await expect(page.getByRole('heading', { name: 'Clientes da plataforma', exact: true })).toBeVisible()
  await page.locator('.cloud-context-bar').getByRole('button', { name: 'Minha conta', exact: true }).click()
  await expect(page.getByLabel('Nome de exibição', { exact: true })).toHaveValue('Patrícia Plataforma')
  await expect(page.getByLabel('E-mail', { exact: true })).toHaveValue(profileEmail('platform'))
  expect(memberWrites(state)).toHaveLength(0); expect(companyWrites(state)).toHaveLength(0); clean(state)
})

test('editing the global profile clears only the current company alias and preserves other company names', async ({ page }) => {
  const state = createProfileState(), userId = profileUserIds.closer
  state.overrides[profileWorkspaceA][userId] = 'Apelido na Aurora'
  state.overrides[profileWorkspaceB][userId] = 'Apelido na outra empresa'
  await mountProfile(page, 'closer', { state, twoWorkspaces: true })
  await expect(page.locator('.sidebar-profile strong')).toHaveText('Apelido na Aurora')
  await openOwnProfile(page)
  await expect(page.getByLabel('Nome de exibição', { exact: true })).toHaveValue('Caio Closer')
  await page.getByLabel('Nome de exibição', { exact: true }).fill('Caio Ribeiro')
  await page.getByRole('button', { name: 'Salvar nome', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Nome atualizado com sucesso.')
  expect(state.overrides[profileWorkspaceA][userId]).toBeNull()
  expect(state.overrides[profileWorkspaceB][userId]).toBe('Apelido na outra empresa')
  await returnToCRM(page); await expect(page.locator('.sidebar-profile strong')).toHaveText('Caio Ribeiro')
  await page.getByLabel('Selecionar empresa').selectOption(profileWorkspaceB)
  await expect(page.getByText('Salvo na nuvem', { exact: true })).toBeVisible()
  await expect(page.locator('.sidebar-profile strong')).toHaveText('Apelido na outra empresa')
  await expect(page.getByRole('button', { name: 'Seu perfil', exact: true })).toHaveText('AE')
  clean(state)
})

test('empty or whitespace names cannot be saved and cancel restores the current profile', async ({ page }) => {
  const state = await mountProfile(page, 'viewer')
  await openOwnProfile(page)
  await page.getByLabel('Nome de exibição', { exact: true }).fill('')
  await page.getByRole('button', { name: 'Salvar nome', exact: true }).click()
  expect(ownWrites(state)).toHaveLength(0)
  await page.getByLabel('Nome de exibição', { exact: true }).fill('   ')
  await page.getByRole('button', { name: 'Salvar nome', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible(); expect(ownWrites(state)).toHaveLength(0)
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click()
  await expect(page.getByLabel('Nome de exibição', { exact: true })).toHaveValue('Vera Consulta')
  await expect(page.getByLabel('Nome de exibição', { exact: true })).toHaveAttribute('readonly', ''); clean(state)
})

test('an own-profile RPC failure keeps the name draft and email unchanged for retry', async ({ page }) => {
  const state = await mountProfile(page, 'manager'); state.failOwnName = true
  await openOwnProfile(page); await page.getByLabel('Nome de exibição', { exact: true }).fill('Marcos Ferreira')
  await page.getByRole('button', { name: 'Salvar nome', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByLabel('Nome de exibição', { exact: true })).toHaveValue('Marcos Ferreira')
  await expect(page.getByLabel('E-mail', { exact: true })).toHaveValue(profileEmail('manager'))
  expect(state.names[profileUserIds.manager]).toBe('Marcos Gestor')
  state.failOwnName = false; await page.getByRole('button', { name: 'Salvar nome', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Nome atualizado com sucesso.')
  expect(state.names[profileUserIds.manager]).toBe('Marcos Ferreira'); clean(state)
})

test('admin edits a member name only in the selected company and refreshed CRM ownership options use it', async ({ page }) => {
  const state = createProfileState(), closerId = profileUserIds.closer
  state.overrides[profileWorkspaceB][closerId] = 'Caio na outra empresa'
  await mountProfile(page, 'admin', { state, twoWorkspaces: true }); await openProfileAdministration(page)
  await page.getByRole('button', { name: 'Editar nome de Caio Closer', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Editar nome do membro', exact: true })
  await expect(dialog.getByLabel('Nome na empresa', { exact: true })).toHaveValue('Caio Closer')
  await dialog.getByLabel('Nome na empresa', { exact: true }).fill('Carlos Ferreira')
  await dialog.getByRole('button', { name: 'Salvar nome', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Editar nome de Carlos Ferreira', exact: true })).toBeVisible()
  expect(memberWrites(state)[0].body).toEqual({ p_workspace_id: profileWorkspaceA, p_user_id: closerId, p_display_name: 'Carlos Ferreira' })
  expect(state.names[closerId]).toBe('Caio Closer')
  expect(effectiveProfileName(state, profileWorkspaceB, closerId)).toBe('Caio na outra empresa')
  await returnToCRM(page); await page.getByRole('button', { name: 'Novo lead', exact: true }).click()
  const lead = page.getByRole('dialog', { name: 'Uma nova oportunidade', exact: true })
  await expect(lead.getByLabel('Responsável').locator(`option[value="${closerId}"]`)).toHaveText('Carlos Ferreira')
  await lead.getByRole('button', { name: 'Cancelar', exact: true }).click()
  await page.reload(); await expect(page.getByRole('heading', { name: 'Visão geral.', exact: true })).toBeVisible()
  await openProfileAdministration(page)
  await expect(page.getByRole('button', { name: 'Editar nome de Carlos Ferreira', exact: true })).toBeVisible()
  expect(ownWrites(state)).toHaveLength(0); expect(companyWrites(state)).toHaveLength(0); clean(state)
})

test('admin renames the company while keeping the other company, commercial settings and personal profile intact', async ({ page }) => {
  const state = await mountProfile(page, 'admin', { twoWorkspaces: true }), beforeNames = { ...state.names }
  await openProfileAdministration(page); await page.getByRole('tab', { name: 'Empresa', exact: true }).click()
  await page.getByRole('button', { name: 'Editar nome da empresa', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Editar nome da empresa', exact: true })
  await dialog.getByLabel('Nome da empresa', { exact: true }).fill('Lumina Consultoria')
  await dialog.getByRole('button', { name: 'Salvar nome', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(companyWrites(state)[0].body).toEqual({ p_workspace_id: profileWorkspaceA, p_name: 'Lumina Consultoria' })
  expect(state.workspaceNames[profileWorkspaceB]).toBe('Outra Empresa'); expect(state.names).toEqual(beforeNames)
  await returnToCRM(page)
  await expect(page.locator('.workspace-selector strong')).toHaveText('Lumina Consultoria')
  await expect(page.getByLabel('Selecionar empresa').locator('option:checked')).toHaveText('Lumina Consultoria')
  await page.reload(); await expect(page.getByRole('heading', { name: 'Visão geral.', exact: true })).toBeVisible()
  await expect(page.locator('.workspace-selector strong')).toHaveText('Lumina Consultoria')
  expect(state.requests.filter(request => request.path === '/rest/v1/workspace_settings' && request.method !== 'GET')).toEqual([])
  expect(ownWrites(state)).toHaveLength(0); expect(memberWrites(state)).toHaveLength(0); clean(state)
})

for (const role of ['manager', 'closer', 'viewer'] as const) test(`${role} has no controls for renaming another member or the company`, async ({ page }) => {
  const state = await mountProfile(page, role)
  await expect(page.locator('.cloud-context-bar').getByRole('button', { name: 'Administrar', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Editar nome de / })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Editar nome da empresa', exact: true })).toHaveCount(0)
  await openOwnProfile(page)
  await expect(page.getByLabel('Nome de exibição', { exact: true })).toBeVisible()
  expect(memberWrites(state)).toHaveLength(0); expect(companyWrites(state)).toHaveLength(0); clean(state)
})

test('platform administration alone cannot rename a member or a company without company-admin membership', async ({ page }) => {
  const state = await mountProfile(page, 'platform')
  await page.getByRole('row').filter({ hasText: 'Aurora Comercial' }).getByRole('button', { name: /Administrar/ }).click()
  await expect(page.getByRole('tab', { name: 'Equipe', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Editar nome de / })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Empresa', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Editar nome da empresa', exact: true })).toHaveCount(0)
  expect(memberWrites(state)).toHaveLength(0); expect(companyWrites(state)).toHaveLength(0); clean(state)
})

for (const action of ['member', 'company'] as const) test(`failed admin ${action} rename preserves the modal draft for retry`, async ({ page }) => {
  const state = await mountProfile(page, 'admin')
  await openProfileAdministration(page)
  if (action === 'company') { await page.getByRole('tab', { name: 'Empresa', exact: true }).click(); state.failWorkspaceName = true }
  else state.failMemberName = true
  await page.getByRole('button', { name: action === 'member' ? 'Editar nome de Caio Closer' : 'Editar nome da empresa', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: action === 'member' ? 'Editar nome do membro' : 'Editar nome da empresa', exact: true })
  const input = dialog.getByLabel(action === 'member' ? 'Nome na empresa' : 'Nome da empresa', { exact: true })
  await input.fill('Novo nome preservado')
  await dialog.getByRole('button', { name: 'Salvar nome', exact: true }).click()
  await expect(dialog.getByRole('alert')).toBeVisible(); await expect(input).toHaveValue('Novo nome preservado')
  expect(state.workspaceNames[profileWorkspaceA]).toBe('Aurora Comercial')
  expect(effectiveProfileName(state, profileWorkspaceA, profileUserIds.closer)).toBe('Caio Closer')
  state.failMemberName = false; state.failWorkspaceName = false
  await dialog.getByRole('button', { name: 'Salvar nome', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(action === 'member' ? effectiveProfileName(state, profileWorkspaceA, profileUserIds.closer) : state.workspaceNames[profileWorkspaceA]).toBe('Novo nome preservado'); clean(state)
})

for (const theme of ['light', 'dark'] as const) for (const width of [1366, 390]) test(`${theme} ${width}px own-profile and company-name forms stay usable without page overflow`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
  const state = await mountProfile(page, 'admin', { theme })
  await openOwnProfile(page)
  await expect(page.locator('.crm-visual')).toHaveAttribute('data-theme', theme)
  await page.getByLabel('Nome de exibição', { exact: true }).fill('Beatriz Santos')
  await noOverflow(page); await screenshot(page, info, 'own-profile')
  await page.getByRole('button', { name: 'Salvar nome', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Nome atualizado com sucesso.')
  await returnToCRM(page); await openProfileAdministration(page)
  await page.getByRole('tab', { name: 'Empresa', exact: true }).click()
  await page.getByRole('button', { name: 'Editar nome da empresa', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Editar nome da empresa', exact: true })
  await dialog.getByLabel('Nome da empresa', { exact: true }).fill('Aurora Renovada')
  await noOverflow(page); await screenshot(page, info, 'company-name')
  await dialog.getByRole('button', { name: 'Salvar nome', exact: true }).click()
  await expect(dialog).not.toBeVisible(); clean(state)
})
