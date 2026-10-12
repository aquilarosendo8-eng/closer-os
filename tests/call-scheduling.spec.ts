import { expect, test, type Locator, type Page } from '@playwright/test'
import { createFeatureState, mountFeatures, navigateFeatures, workspaceA, workspaceB } from './fixtures/features'

const moment = new Date('2026-10-12T15:00:00Z')
const writes = (state: ReturnType<typeof createFeatureState>) => state.requests.filter(request => request.path === '/rest/v1/leads' && request.method === 'PATCH')
const callDialog = (page: Page) => page.getByRole('dialog', { name: 'Agendar call', exact: true })
async function fillSchedule(dialog: Locator, date = '2026-10-13', time = '09:30') {
  await dialog.getByLabel('Data da reunião').fill(date)
  await dialog.getByLabel('Horário da reunião').fill(time)
}
function check(state: ReturnType<typeof createFeatureState>) { expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]) }
async function setup(page: Page, role: 'admin' | 'manager' | 'closer' | 'viewer' = 'closer', theme: 'light' | 'dark' = 'light') {
  await page.clock.install({ time: moment })
  const state = createFeatureState()
  state.leads[0].data.callDate = '2026-10-10T14:20:00Z'
  state.leads[1].data.callDate = '2026-10-14T13:00:00Z'
  state.leads[1].data.attendance = 'Pendente'
  await mountFeatures(page, role, { state, theme })
  await navigateFeatures(page, 'Pipeline')
  return state
}

test('stage selector schedules one atomic update, persists after reload and enters Calls chronologically', async ({ page }) => {
  const state = await setup(page), initial = structuredClone(state.leads), stage = state.stages[workspaceA].find(stage => stage.name === 'Call agendada')!
  await page.getByLabel('Etapa de Ana Ribeiro').selectOption(stage.id)
  const dialog = callDialog(page)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Data da reunião')).toHaveValue('2026-10-10')
  await expect(dialog.getByLabel('Horário da reunião')).toHaveValue('11:20')
  expect(writes(state)).toHaveLength(0)
  await fillSchedule(dialog)
  await dialog.getByRole('button', { name: 'Confirmar agendamento', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(writes(state)).toHaveLength(1)
  expect(writes(state)[0].body).toMatchObject({ stage_id: stage.id, data: { stageId: stage.id, callDate: '2026-10-13T12:30:00.000Z', attendance: 'Pendente' } })
  expect(state.leads[0].data).toMatchObject({ id: initial[0].id, callSummary: initial[0].data.callSummary, callScore: initial[0].data.callScore, closerError: initial[0].data.closerError })
  expect(state.leads).toHaveLength(initial.length)
  expect(state.leads.filter(row => row.workspace_id === workspaceB)).toEqual(initial.filter(row => row.workspace_id === workspaceB))
  await navigateFeatures(page, 'Calls')
  await page.getByRole('tab', { name: 'Próximas', exact: true }).click()
  await expect(page.locator('.cp-calls-table tbody tr').first()).toContainText('Ana Ribeiro')
  await expect(page.locator('.cp-calls-table tbody tr').first()).toContainText('09:30')
  await expect(page.locator('.stat-card').filter({ has: page.getByText('Próximas calls', { exact: true }) }).locator('.stat-value')).toHaveText('2')
  await page.reload()
  await expect(page.getByText('Salvo na nuvem', { exact: true })).toBeVisible()
  await navigateFeatures(page, 'Calls'); await page.getByRole('tab', { name: 'Próximas', exact: true }).click()
  await expect(page.locator('.cp-calls-table tbody tr').first()).toContainText('Ana Ribeiro')
  expect(writes(state)).toHaveLength(1); check(state)
})

test('native drag-and-drop opens schedule before writing and cancellation changes nothing', async ({ page }) => {
  const state = await setup(page), original = structuredClone(state.leads)
  const card = page.locator('.lead-card').filter({ has: page.getByRole('heading', { name: 'Ana Ribeiro', exact: true }) })
  const target = page.locator('.kanban-column').filter({ has: page.getByRole('heading', { name: 'Call agendada', exact: true }) })
  await card.dragTo(target.locator('.kanban-column-header'))
  const dialog = callDialog(page); await expect(dialog).toBeVisible()
  await fillSchedule(dialog); await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(state.leads).toEqual(original); expect(writes(state)).toHaveLength(0)
  await expect(page.getByLabel('Etapa de Ana Ribeiro').locator('option:checked')).toHaveText('Compareceu')
  await card.dragTo(target.locator('.kanban-column-header'))
  await fillSchedule(dialog); await dialog.getByRole('button', { name: 'Confirmar agendamento', exact: true }).click()
  await expect(dialog).not.toBeVisible(); expect(writes(state)).toHaveLength(1)
  expect(state.leads[0].data).toMatchObject({ callDate: '2026-10-13T12:30:00.000Z', attendance: 'Pendente' })
  check(state)
})

test('both fields are required and a time earlier today cannot confirm', async ({ page }) => {
  const state = await setup(page), original = structuredClone(state.leads[0])
  await page.getByLabel('Etapa de Ana Ribeiro').selectOption({ label: 'Call agendada' })
  const dialog = callDialog(page), date = dialog.getByLabel('Data da reunião'), time = dialog.getByLabel('Horário da reunião')
  await date.fill(''); await time.fill('')
  await dialog.getByRole('button', { name: 'Confirmar agendamento', exact: true }).click()
  expect(await date.evaluate((element: HTMLInputElement) => element.validity.valueMissing)).toBe(true)
  await date.fill('2026-10-13')
  await dialog.getByRole('button', { name: 'Confirmar agendamento', exact: true }).click()
  expect(await time.evaluate((element: HTMLInputElement) => element.validity.valueMissing)).toBe(true)
  await fillSchedule(dialog, '2026-10-12', '11:59')
  await dialog.getByRole('button', { name: 'Confirmar agendamento', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('futuros')
  await expect(dialog).toBeVisible()
  expect(state.leads[0]).toEqual(original); expect(writes(state)).toHaveLength(0); check(state)
})

test('a save error retains the open modal and draft and never partly changes stage or date', async ({ page }) => {
  const state = await setup(page), original = structuredClone(state.leads[0]); let failed = false
  await page.route('https://test.supabase.co/rest/v1/leads**', async route => {
    if (route.request().method() === 'PATCH' && !failed) {
      failed = true; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Falha temporária ao salvar o agendamento.' }) }); return
    }
    await route.fallback()
  })
  await page.getByLabel('Etapa de Ana Ribeiro').selectOption({ label: 'Call agendada' })
  const dialog = callDialog(page); await fillSchedule(dialog)
  await dialog.getByRole('button', { name: 'Confirmar agendamento', exact: true }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await expect(dialog.getByLabel('Data da reunião')).toHaveValue('2026-10-13')
  await expect(dialog.getByLabel('Horário da reunião')).toHaveValue('09:30')
  expect(state.leads[0]).toEqual(original); expect(writes(state)).toHaveLength(0)
  await dialog.getByRole('button', { name: 'Confirmar agendamento', exact: true }).click()
  await expect(dialog).not.toBeVisible(); expect(writes(state)).toHaveLength(1); check(state)
})

test('pending confirmation cannot submit duplicates or dismiss before the atomic write finishes', async ({ page }) => {
  const state = await setup(page); let unblock: (() => void) | undefined, entered = false
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  await page.route('https://test.supabase.co/rest/v1/leads**', async route => {
    if (route.request().method() === 'PATCH') { entered = true; await blocked }
    await route.fallback()
  })
  await page.getByLabel('Etapa de Ana Ribeiro').selectOption({ label: 'Call agendada' })
  const dialog = callDialog(page); await fillSchedule(dialog)
  await dialog.getByRole('button', { name: 'Confirmar agendamento', exact: true }).click()
  await expect.poll(() => entered).toBe(true)
  await expect(dialog.getByRole('button', { name: 'Confirmar agendamento', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Cancelar', exact: true })).toBeDisabled()
  await dialog.locator('form').evaluate(form => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  await page.keyboard.press('Escape'); await expect(dialog).toBeVisible()
  unblock!(); await expect(dialog).not.toBeVisible()
  expect(writes(state)).toHaveLength(1); check(state)
})

test('Lead360 editor shares schedule flow; cancel preserves the parent draft and confirm persists once', async ({ page }) => {
  const state = await setup(page, 'manager')
  await page.locator('.lead-card').filter({ has: page.getByRole('heading', { name: 'Ana Ribeiro', exact: true }) }).getByRole('button', { name: /Ana Ribeiro/ }).click()
  await page.getByRole('dialog', { name: 'Oportunidade de Ana Ribeiro', exact: true }).getByRole('button', { name: 'Editar oportunidade', exact: true }).click()
  const parent = page.getByRole('dialog', { name: 'Ana Ribeiro', exact: true })
  await parent.getByLabel('Observações').fill('Rascunho preservado para esta reunião.')
  await parent.getByLabel('Status').selectOption({ label: 'Call agendada' })
  const dialog = callDialog(page); await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible(); await expect(parent).toBeVisible()
  await expect(parent.getByLabel('Status').locator('option:checked')).toHaveText('Compareceu')
  await expect(parent.getByLabel('Observações')).toHaveValue('Rascunho preservado para esta reunião.')
  expect(writes(state)).toHaveLength(0)
  await parent.getByLabel('Status').selectOption({ label: 'Call agendada' })
  await fillSchedule(dialog, '2026-10-15', '14:20')
  await dialog.getByRole('button', { name: 'Confirmar agendamento', exact: true }).click()
  await expect(dialog).not.toBeVisible(); await expect(parent).not.toBeVisible()
  expect(writes(state)).toHaveLength(1)
  expect(state.leads[0].data).toMatchObject({ callDate: '2026-10-15T17:20:00.000Z', attendance: 'Pendente', notes: 'Rascunho preservado para esta reunião.' })
  check(state)
})

test('Calls upcoming count expires by full time without reloading and never adds a record', async ({ page }) => {
  const state = await setup(page)
  await page.getByLabel('Etapa de Ana Ribeiro').selectOption({ label: 'Call agendada' })
  const dialog = callDialog(page); await fillSchedule(dialog, '2026-10-12', '12:01')
  await dialog.getByRole('button', { name: 'Confirmar agendamento', exact: true }).click(); await expect(dialog).not.toBeVisible()
  await navigateFeatures(page, 'Calls'); await page.getByRole('tab', { name: 'Próximas', exact: true }).click()
  await expect(page.locator('.cp-calls-table tbody tr')).toHaveCount(2)
  await page.clock.runFor(90000)
  await expect(page.locator('.cp-calls-table tbody tr')).toHaveCount(1)
  await expect(page.locator('.cp-calls-table')).not.toContainText('Ana Ribeiro')
  expect(state.leads).toHaveLength(4); expect(writes(state)).toHaveLength(1); check(state)
})

test('viewer cannot open scheduling and other normal stages retain immediate updates', async ({ page }) => {
  const state = await setup(page, 'viewer')
  await expect(page.getByLabel('Etapa de Ana Ribeiro')).toBeDisabled()
  expect(await page.locator('.lead-card').first().getAttribute('draggable')).toBe('false')
  await expect(callDialog(page)).toHaveCount(0); expect(writes(state)).toHaveLength(0); check(state)
})

test('similar names and terminal stages never accidentally invoke scheduling', async ({ page }) => {
  const state = createFeatureState()
  state.stages[workspaceA][1].name = 'Agendado - retorno'
  state.stages[workspaceA][5].name = 'Agendado'
  await mountFeatures(page, 'manager', { state })
  await navigateFeatures(page, 'Pipeline')
  await page.getByLabel('Etapa de Ana Ribeiro').selectOption(state.stages[workspaceA][1].id)
  await expect(page.getByLabel('Etapa de Ana Ribeiro').locator('option:checked')).toHaveText('Agendado - retorno')
  await expect(callDialog(page)).toHaveCount(0); expect(writes(state)).toHaveLength(1)
  await page.getByLabel('Etapa de Ana Ribeiro').selectOption(state.stages[workspaceA][5].id)
  await expect(page.getByRole('dialog', { name: 'Confirmar fechamento', exact: true })).toBeVisible()
  await expect(callDialog(page)).toHaveCount(0)
  check(state)
})

test('an administrator changing the scheduling stage while the modal is open prevents a stale confirmation', async ({ page }) => {
  const state = await setup(page)
  await page.getByLabel('Etapa de Ana Ribeiro').selectOption({ label: 'Call agendada' })
  const dialog = callDialog(page); await fillSchedule(dialog)
  state.stages[workspaceA][2].name = 'Diagnóstico'
  await page.clock.runFor(31000)
  await expect(page.getByRole('heading', { name: 'Diagnóstico', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Confirmar agendamento', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('etapa foi alterada')
  await expect(dialog).toBeVisible(); expect(writes(state)).toHaveLength(0)
  check(state)
})

test('adding a lead directly in the scheduled column asks for its appointment before the first save', async ({ page }) => {
  await page.clock.install({ time: moment })
  await page.goto('/?demo=1'); await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible()
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('closer-os-demo-leads-v1')!))
  await page.getByRole('navigation', { name: 'Menu principal' }).getByRole('button', { name: /^Pipeline\s*\d*$/ }).click()
  await page.getByRole('button', { name: 'Adicionar lead em Call agendada', exact: true }).click()
  const parent = page.getByRole('dialog', { name: 'Uma nova oportunidade', exact: true })
  await parent.getByLabel('Nome do lead').fill('Nova reunião de teste')
  await parent.getByRole('button', { name: 'Cadastrar lead', exact: true }).click()
  const dialog = callDialog(page); await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Data da reunião')).toHaveValue('')
  await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click()
  await expect(parent).toBeVisible()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('closer-os-demo-leads-v1')!))).toEqual(before)
  await parent.getByRole('button', { name: 'Cadastrar lead', exact: true }).click()
  await fillSchedule(dialog); await dialog.getByRole('button', { name: 'Confirmar agendamento', exact: true }).click()
  await expect(dialog).not.toBeVisible(); await expect(parent).not.toBeVisible()
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('closer-os-demo-leads-v1')!))
  expect(after).toHaveLength(before.length + 1)
  expect(after.filter((lead: { name: string }) => lead.name === 'Nova reunião de teste')).toEqual([expect.objectContaining({ callDate: '2026-10-13T12:30:00.000Z', attendance: 'Pendente', stageName: 'Call agendada' })])
})

for (const theme of ['light', 'dark'] as const) {
  test(`configured Agendado stage works in ${theme} theme on mobile`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.clock.install({ time: moment })
    const state = createFeatureState(); state.stages[workspaceA][2].name = 'Agendado'
    await mountFeatures(page, 'closer', { state, theme }); await navigateFeatures(page, 'Pipeline')
    await page.getByLabel('Etapa de Ana Ribeiro').selectOption({ label: 'Agendado' })
    const dialog = callDialog(page); await expect(dialog).toBeVisible(); await fillSchedule(dialog)
    const bounds = await dialog.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391)
    await dialog.getByRole('button', { name: 'Confirmar agendamento', exact: true }).click()
    await expect(dialog).not.toBeVisible(); expect(writes(state)).toHaveLength(1)
    expect(state.leads[0].data).toMatchObject({ callDate: '2026-10-13T12:30:00.000Z', attendance: 'Pendente' })
    check(state)
  })
}
