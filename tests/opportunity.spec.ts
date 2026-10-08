import { expect, test, type Locator, type Page } from '@playwright/test'
import { activityFixture, callFixture, createOpportunityState, eventFixture, historyKey, holdHistory, holdPendingActivities, memberIds, mountOpportunity, navigateOpportunity, openOpportunity, opportunityLeadIds, opportunityNow, workspaceA, workspaceB, type OpportunityState } from './fixtures/opportunity'

const reads = (state: OpportunityState, name: string) => state.requests.filter(request => request.path.endsWith(`/rpc/${name}`))
const writes = (state: OpportunityState) => state.requests.filter(request => request.path.endsWith('/rpc/save_activity') || request.path.endsWith('/rpc/set_activity_status') || request.path === '/rest/v1/leads' && request.method !== 'GET')
const revenue = (page: Page) => page.locator('.stat-card').filter({ has: page.getByText('Faturamento', { exact: true }) }).locator('.stat-value')
function clean(state: OpportunityState) { expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]) }
async function tab(dialog: Locator, name: string) { await dialog.getByRole('tab', { name: new RegExp(`^${name}(?:\\s*\\d+)?$`) }).click() }
async function newActivity(dialog: Locator, page: Page) {
  await tab(dialog, 'Atividades')
  await dialog.getByRole('button', { name: 'Nova atividade', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Nova atividade', exact: true }); await expect(form).toBeVisible(); return form
}
async function fillActivity(form: Locator, title = 'Validar aprovação do sócio') {
  await form.getByLabel('Título da atividade', { exact: true }).fill(title)
  await form.getByLabel('Tipo de atividade', { exact: true }).selectOption('whatsapp')
  await form.getByLabel('Data da atividade', { exact: true }).fill('2026-10-11')
  await form.getByLabel('Hora da atividade', { exact: true }).fill('14:00')
  await form.getByLabel('Descrição da atividade', { exact: true }).fill('Confirmar decisão com o sócio e combinar a próxima conversa.')
}
async function noOverflow(page: Page, dialog?: Locator) {
  const viewport = page.viewportSize()!
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1)
  if (dialog) {
    const box = await dialog.boundingBox(); expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(-1); expect(box!.y).toBeGreaterThanOrEqual(-1)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1)
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1)
  }
}

test('opening the pipeline card shows the correct 360 data and loads detailed history only for that lead', async ({ page }) => {
  const state = await mountOpportunity(page)
  expect(reads(state, 'list_lead_events')).toHaveLength(0); expect(reads(state, 'list_lead_call_history')).toHaveLength(0)
  const dialog = await openOpportunity(page)
  await expect(dialog.locator('.l360-company')).toHaveText('Aurora Comercial')
  await expect(dialog.getByText('ana.lead@example.invalid', { exact: true })).toBeVisible()
  await expect(dialog.getByText('+55 11 99999-1111', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Crescimento sem previsibilidade', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Contexto da oportunidade', { exact: true })).toBeVisible()
  await expect(dialog.locator('.l360-summary').getByText('Caio Closer', { exact: true })).toBeVisible()
  await expect(dialog.locator('.l360-summary').getByText(/R\$\s*20\.000/)).toBeVisible()
  await expect(dialog.getByText('Mais de 5 dias sem contato.', { exact: true })).toBeVisible()
  await expect(dialog.locator('.l360-summary').getByText('Última nota: 8/10', { exact: true })).toBeVisible()
  await expect(dialog.locator('.l360-next-action').getByText('Follow-up atrasado do sócio', { exact: true })).toBeVisible()
  expect(reads(state, 'list_lead_call_history')).toHaveLength(1)
  expect(reads(state, 'list_lead_call_history')[0].body).toMatchObject({ p_workspace_id: workspaceA, p_lead_id: opportunityLeadIds.ana })
  expect(reads(state, 'list_lead_events')).toHaveLength(0)
  await tab(dialog, 'Calls'); await expect(dialog.locator('.l360-call')).toHaveCount(2)
  await tab(dialog, 'Visão geral'); await tab(dialog, 'Calls')
  expect(reads(state, 'list_lead_call_history')).toHaveLength(1)
  expect(writes(state)).toHaveLength(0); clean(state)
})

test('the pipeline list opens 360 while the explicit edit action preserves the existing lead form', async ({ page }) => {
  const state = await mountOpportunity(page)
  await navigateOpportunity(page, 'Pipeline'); await page.getByLabel('Visualização em lista').click()
  const row = page.getByRole('row').filter({ has: page.getByText('Ana Ribeiro', { exact: true }) })
  await row.locator('.lead-identity').click()
  const detail = page.getByRole('dialog', { name: 'Oportunidade de Ana Ribeiro', exact: true }); await expect(detail).toBeVisible()
  await detail.getByRole('button', { name: 'Fechar oportunidade', exact: true }).click()
  await row.getByRole('button', { name: 'Editar Ana Ribeiro', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Ana Ribeiro', exact: true })
  await expect(form.getByLabel('Nome do lead')).toHaveValue('Ana Ribeiro')
  await form.getByRole('button', { name: 'Fechar formulário', exact: true }).click(); clean(state)
})

test('360 traps keyboard focus, supports arrow navigation between tabs and restores focus to its opportunity', async ({ page }) => {
  const state = await mountOpportunity(page), dialog = await openOpportunity(page)
  await expect(dialog.getByRole('button', { name: 'Fechar oportunidade', exact: true })).toBeFocused()
  const overview = dialog.getByRole('tab', { name: 'Visão geral', exact: true })
  await overview.focus(); await page.keyboard.press('ArrowRight')
  await expect(dialog.getByRole('tab', { name: 'Calls', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.getByRole('tab', { name: 'Calls', exact: true })).toBeFocused()
  await expect(dialog.locator('.l360-call')).toHaveCount(2)
  for (let index = 0; index < 16; index++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible()
  await expect(page.locator('.lead-card').filter({ has: page.getByRole('heading', { name: 'Ana Ribeiro', exact: true }) }).locator('.lead-card-main')).toBeFocused()
  expect(reads(state, 'list_lead_events')).toHaveLength(0); expect(writes(state)).toHaveLength(0); clean(state)
})

test('360 switches to the selected lead without showing calls or tasks from the previous opportunity', async ({ page }) => {
  const state = await mountOpportunity(page), ana = await openOpportunity(page)
  await tab(ana, 'Calls'); await expect(ana.locator('.l360-call')).toHaveCount(2)
  await ana.getByRole('button', { name: 'Fechar oportunidade', exact: true }).click()
  const bruno = await openOpportunity(page, 'Bruno Castro')
  await expect(bruno.locator('.l360-summary').getByText('Marcos Gestor', { exact: true })).toBeVisible()
  await tab(bruno, 'Calls'); await expect(bruno.getByRole('heading', { name: 'A primeira conversa começa aqui', exact: true })).toBeVisible()
  await expect(bruno.getByText('Resumo da primeira conversa preservado.', { exact: true })).toHaveCount(0)
  await tab(bruno, 'Atividades'); await expect(bruno.getByText('Tarefa restrita do outro closer', { exact: true })).toBeVisible()
  await expect(bruno.getByText('WhatsApp para hoje', { exact: true })).toHaveCount(0)
  expect(reads(state, 'list_lead_call_history').at(-1)?.body?.p_lead_id).toBe(opportunityLeadIds.bruno); clean(state)
})

test('viewer reads overview, secure recordings, call feedback and activity history without write controls', async ({ page }) => {
  const state = await mountOpportunity(page, 'viewer'), dialog = await openOpportunity(page)
  await expect(dialog.getByRole('button', { name: 'Editar oportunidade', exact: true })).toHaveCount(0)
  await tab(dialog, 'Calls')
  const previous = dialog.locator('.l360-call').filter({ hasText: 'Resumo da primeira conversa preservado.' })
  await expect(previous.getByText('Feedback da primeira conversa', { exact: true })).toBeVisible()
  await previous.getByRole('button', { name: 'Ver call', exact: true }).click()
  await expect(previous.locator('input,textarea,select')).toHaveCount(0)
  const link = previous.getByRole('link', { name: 'Assistir gravação', exact: true })
  await expect(link).toHaveAttribute('href', 'https://recordings.example.invalid/historical')
  await expect(link).toHaveAttribute('target', '_blank'); await expect(link).toHaveAttribute('rel', /noopener/); await expect(link).toHaveAttribute('rel', /noreferrer/)
  await tab(dialog, 'Atividades')
  await expect(dialog.getByRole('button', { name: 'Nova atividade', exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: /^(Concluir|Cancelar|Editar) atividade / })).toHaveCount(0)
  await expect(dialog.getByText('Conversa já concluída', { exact: true })).toBeVisible()
  expect(writes(state)).toHaveLength(0); clean(state)
})

test('closer sees only owned opportunities and their pending activities, and assigns new tasks only to self', async ({ page }) => {
  const state = await mountOpportunity(page, 'closer')
  await navigateOpportunity(page, 'Atividades')
  await expect(page.getByText('Tarefa restrita do outro closer', { exact: true })).toHaveCount(0)
  await expect(page.getByText('SEGREDO ATIVIDADE EMPRESA B', { exact: true })).toHaveCount(0)
  const dialog = await openOpportunity(page), form = await newActivity(dialog, page)
  await expect(form.getByLabel('Responsável pela atividade', { exact: true })).toHaveValue(memberIds.closer)
  await expect(form.getByLabel('Responsável pela atividade', { exact: true }).locator('option')).toHaveCount(1)
  await fillActivity(form, 'Atividade criada pelo closer')
  await form.getByRole('button', { name: 'Criar atividade', exact: true }).click(); await expect(form).not.toBeVisible()
  const saved = state.activities.find(activity => activity.title === 'Atividade criada pelo closer')!
  expect(saved).toMatchObject({ workspace_id: workspaceA, lead_id: opportunityLeadIds.ana, assigned_to: memberIds.closer, created_by: memberIds.closer })
  expect(state.requests.some(request => request.body?.p_lead_id === opportunityLeadIds.bruno)).toBe(false); clean(state)
})

test('editing an owned opportunity task preserves its existing assignee instead of silently taking ownership', async ({ page }) => {
  const fixture = createOpportunityState()
  Object.assign(fixture.activities[0], { assigned_to: memberIds.manager, assigned_name: 'Marcos Gestor' })
  const state = await mountOpportunity(page, 'closer', { state: fixture }), detail = await openOpportunity(page)
  await tab(detail, 'Atividades')
  await detail.getByRole('button', { name: 'Editar atividade Follow-up atrasado do sócio', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Editar atividade', exact: true })
  await expect(form.getByLabel('Responsável pela atividade', { exact: true })).toHaveValue(memberIds.manager)
  await form.getByLabel('Título da atividade', { exact: true }).fill('Retorno com responsabilidade preservada')
  await form.getByRole('button', { name: 'Salvar atividade', exact: true }).click(); await expect(form).not.toBeVisible()
  expect(state.activities[0]).toMatchObject({ title: 'Retorno com responsabilidade preservada', assigned_to: memberIds.manager, created_by: memberIds.admin })
  expect(reads(state, 'save_activity')[0].body?.p_assigned_to).toBe(memberIds.manager); clean(state)
})

test('activity creation and editing use the selected opportunity, assignee and Brasília time without client authorship', async ({ page }) => {
  const state = await mountOpportunity(page), dialog = await openOpportunity(page), form = await newActivity(dialog, page)
  await expect(form.getByLabel('Oportunidade', { exact: true })).toBeDisabled()
  await expect(form.getByLabel('Oportunidade', { exact: true })).toHaveValue(opportunityLeadIds.ana)
  await expect(form.getByLabel('Responsável pela atividade', { exact: true }).locator(`option[value="${memberIds.viewer}"]`)).toHaveCount(0)
  await fillActivity(form); await form.getByLabel('Responsável pela atividade', { exact: true }).selectOption(memberIds.manager)
  await form.getByRole('button', { name: 'Criar atividade', exact: true }).click(); await expect(form).not.toBeVisible()
  const saved = state.activities.find(activity => activity.title === 'Validar aprovação do sócio')!
  expect(saved).toMatchObject({ workspace_id: workspaceA, lead_id: opportunityLeadIds.ana, assigned_to: memberIds.manager, due_at: '2026-10-11T17:00:00.000Z', created_by: memberIds.admin, status: 'pending' })
  const request = reads(state, 'save_activity')[0]
  expect(request.body).toMatchObject({ p_workspace_id: workspaceA, p_lead_id: opportunityLeadIds.ana, p_assigned_to: memberIds.manager, p_title: saved.title })
  for (const field of ['p_actor_id', 'p_created_by', 'p_created_at', 'p_completed_at', 'p_status', 'metadata']) expect(request.body).not.toHaveProperty(field)
  await dialog.getByRole('button', { name: `Editar atividade ${saved.title}`, exact: true }).click()
  const edit = page.getByRole('dialog', { name: 'Editar atividade', exact: true })
  await expect(edit.getByLabel('Oportunidade', { exact: true })).toBeDisabled()
  await edit.getByLabel('Título da atividade', { exact: true }).fill('Validar aprovação revisada')
  await edit.getByLabel('Data da atividade', { exact: true }).fill('2026-10-12')
  await edit.getByLabel('Responsável pela atividade', { exact: true }).selectOption(memberIds.closer)
  await edit.getByRole('button', { name: 'Salvar atividade', exact: true }).click(); await expect(edit).not.toBeVisible()
  expect(saved).toMatchObject({ title: 'Validar aprovação revisada', assigned_to: memberIds.closer, due_at: '2026-10-12T17:00:00.000Z', created_by: memberIds.admin })
  expect(reads(state, 'save_activity')[1].body?.p_activity_id).toBe(saved.id)
  expect(reads(state, 'list_lead_activities').filter(request => request.body?.p_lead_id === opportunityLeadIds.ana)).toHaveLength(3)
  expect(reads(state, 'list_lead_call_history')).toHaveLength(1)
  await tab(dialog, 'Timeline'); await expect(dialog.getByRole('heading', { name: 'Atividade criada', exact: true }).first()).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Atividade atualizada', exact: true })).toBeVisible(); clean(state)
})

test('completed and cancelled tasks leave the operational queue and remain in the opportunity history', async ({ page }) => {
  const state = await mountOpportunity(page), dialog = await openOpportunity(page)
  await tab(dialog, 'Atividades')
  await dialog.getByRole('button', { name: 'Concluir atividade Follow-up atrasado do sócio', exact: true }).click()
  await expect.poll(() => state.activities.find(activity => activity.id.endsWith('000001'))?.status).toBe('completed')
  expect(state.activities.find(activity => activity.id.endsWith('000001'))?.completed_at).toBe(opportunityNow)
  await dialog.getByRole('button', { name: 'Cancelar atividade WhatsApp para hoje', exact: true }).click()
  await page.getByRole('dialog', { name: 'Cancelar atividade?', exact: true }).getByRole('button', { name: 'Confirmar cancelamento', exact: true }).click()
  await expect.poll(() => state.activities.find(activity => activity.title === 'WhatsApp para hoje')?.status).toBe('cancelled')
  expect(state.activities.find(activity => activity.title === 'WhatsApp para hoje')?.completed_at).toBeNull()
  await expect(dialog.getByRole('button', { name: 'Editar atividade Follow-up atrasado do sócio', exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Editar atividade WhatsApp para hoje', exact: true })).toHaveCount(0)
  await tab(dialog, 'Visão geral'); await expect(dialog.locator('.l360-next-action').getByText('Reunião futura com decisor', { exact: true })).toBeVisible()
  await tab(dialog, 'Timeline'); await expect(dialog.getByRole('heading', { name: 'Atividade concluída', exact: true })).toBeVisible(); await expect(dialog.getByRole('heading', { name: 'Atividade cancelada', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Fechar oportunidade', exact: true }).click(); await navigateOpportunity(page, 'Atividades')
  await expect(page.getByText('Follow-up atrasado do sócio', { exact: true })).toHaveCount(0); await expect(page.getByText('WhatsApp para hoje', { exact: true })).toHaveCount(0)
  expect(reads(state, 'set_activity_status').map(request => request.body?.p_status)).toEqual(['completed', 'cancelled']); clean(state)
  expect(reads(state, 'list_lead_activities').filter(request => request.body?.p_lead_id === opportunityLeadIds.ana)).toHaveLength(3)
  expect(reads(state, 'list_lead_call_history')).toHaveLength(1)
})

test('operational activities separate overdue, today and future without changing executive revenue', async ({ page }) => {
  const state = await mountOpportunity(page)
  await expect(revenue(page)).toHaveText(/R\$\s*18\.000/)
  await navigateOpportunity(page, 'Atividades')
  await expect(page.getByText('Follow-up atrasado do sócio', { exact: true })).toBeVisible()
  await expect(page.getByText('WhatsApp para hoje', { exact: true })).toBeVisible()
  await expect(page.getByText('Reunião futura com decisor', { exact: true })).toBeVisible()
  await expect(page.getByText('Conversa já concluída', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Atividade cancelada anterior', { exact: true })).toHaveCount(0)
  await expect(page.getByText(/Follow-up atrasado há 1 dia|Follow-up atrasado há 2 dias/)).toBeVisible()
  await page.getByLabel('Buscar atividades', { exact: true }).fill('Follow-up atrasado do sócio')
  await expect(page.getByText('Follow-up atrasado do sócio', { exact: true })).toBeVisible(); await expect(page.getByText('WhatsApp para hoje', { exact: true })).toHaveCount(0)
  await navigateOpportunity(page, 'Dashboard'); await expect(revenue(page)).toHaveText(/R\$\s*18\.000/)
  expect(reads(state, 'list_lead_events')).toHaveLength(0); expect(reads(state, 'list_lead_call_history')).toHaveLength(0); clean(state)
})

test('the operational queue filters pending buckets and today calls open the corresponding opportunity', async ({ page }) => {
  const state = await mountOpportunity(page)
  await navigateOpportunity(page, 'Atividades')
  const metrics = page.getByLabel('Resumo das atividades', { exact: true })
  await expect(metrics.getByRole('button', { name: /^Atrasadas/ }).locator('strong')).toHaveText('1')
  await expect(metrics.getByRole('button', { name: /^Para hoje/ }).locator('strong')).toHaveText('2')
  await expect(metrics.getByRole('button', { name: /^Próximas/ }).locator('strong')).toHaveText('1')
  await page.getByLabel('Filtrar atividades pendentes', { exact: true }).getByRole('button', { name: 'Hoje', exact: true }).click()
  await expect(page.getByText('WhatsApp para hoje', { exact: true })).toBeVisible()
  await expect(page.getByText('Tarefa restrita do outro closer', { exact: true })).toBeVisible()
  await expect(page.getByText('Follow-up atrasado do sócio', { exact: true })).toHaveCount(0)
  await page.getByLabel('Filtrar atividades pendentes', { exact: true }).getByRole('button', { name: 'Próximas', exact: true }).click()
  await expect(page.getByText('Reunião futura com decisor', { exact: true })).toBeVisible()
  await expect(page.getByText('WhatsApp para hoje', { exact: true })).toHaveCount(0)
  await metrics.getByRole('button', { name: /^Calls de hoje/ }).click()
  const agenda = page.getByLabel('Calls de hoje', { exact: true })
  await expect(agenda.getByRole('button', { name: 'Abrir oportunidade Bruno Castro', exact: true })).toBeVisible()
  await agenda.getByRole('button', { name: 'Abrir oportunidade Bruno Castro', exact: true }).click()
  const detail = page.getByRole('dialog', { name: 'Oportunidade de Bruno Castro', exact: true })
  await expect(detail.locator('.l360-company')).toHaveText('Aurora Comercial')
  await expect(detail.locator('.l360-summary').getByText('Marcos Gestor', { exact: true })).toBeVisible()
  expect(reads(state, 'list_lead_call_history').at(-1)?.body?.p_lead_id).toBe(opportunityLeadIds.bruno)
  expect(writes(state)).toHaveLength(0); clean(state)
})

test('timeline presents commercial events and authoritative author/date without technical logs or write requests', async ({ page }) => {
  const state = await mountOpportunity(page), dialog = await openOpportunity(page)
  await tab(dialog, 'Timeline')
  for (const title of ['Oportunidade criada', 'Responsável alterado', 'Etapa atualizada', 'Call registrada', 'Atividade criada', 'Venda fechada', 'Oportunidade perdida', 'Oportunidade reaberta', 'Revisão da liderança', 'Ticket atualizado']) {
    await expect(dialog.getByRole('heading', { name: title, exact: true })).toBeVisible()
  }
  await expect(dialog.getByText('Qualificado → Compareceu', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Timing · Retomar no próximo trimestre.', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Nota da liderança: 0/10', { exact: true })).toBeVisible()
  await expect(dialog.locator('.l360-event-byline').first()).toHaveText('Ana Administradora')
  await expect(dialog.locator('.l360-event time').first()).toHaveAttribute('datetime', state.events.find(event => event.id === '909')!.created_at)
  await expect(dialog.getByText('SEGREDO TIMELINE EMPRESA B', { exact: true })).toHaveCount(0)
  await expect(dialog.getByText('lead.created', { exact: true })).toHaveCount(0)
  const request = reads(state, 'list_lead_events')[0]
  expect(request.body).toMatchObject({ p_workspace_id: workspaceA, p_lead_id: opportunityLeadIds.ana })
  expect(state.requests.some(request => request.path === '/rest/v1/lead_events' && request.method !== 'GET')).toBe(false)
  await tab(dialog, 'Visão geral'); await tab(dialog, 'Timeline'); expect(reads(state, 'list_lead_events')).toHaveLength(1); clean(state)
})

test('existing opportunity edits and WON, LOST and reopen transitions appear in its scoped commercial timeline', async ({ page }) => {
  const fixture = createOpportunityState()
  fixture.events = fixture.events.filter(event => event.event_type === 'lead.created')
  const state = await mountOpportunity(page, 'admin', { state: fixture })
  const detail = await openOpportunity(page)
  await detail.getByRole('button', { name: 'Editar oportunidade', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Ana Ribeiro', exact: true })
  await form.getByLabel('Ticket previsto (R$)').fill('24500')
  await form.getByLabel('Responsável').selectOption(memberIds.manager)
  await form.getByRole('button', { name: 'Salvar alterações', exact: true }).click()
  await expect(form).not.toBeVisible()
  await page.getByLabel('Etapa de Ana Ribeiro').selectOption({ label: 'Fechado' })
  const won = page.getByRole('dialog', { name: 'Confirmar fechamento', exact: true })
  await won.getByLabel('Valor fechado (R$)').fill('12500.75')
  await won.getByRole('button', { name: 'Confirmar fechamento', exact: true }).click()
  await expect(won).not.toBeVisible()
  await page.getByLabel('Etapa de Ana Ribeiro').selectOption({ label: 'Perdido' })
  const lost = page.getByRole('dialog', { name: 'Por que esta oportunidade foi perdida?', exact: true })
  await lost.getByLabel('Motivo da perda').selectOption('Timing')
  await lost.getByLabel('Comentário adicional').fill('Retomar na revisão trimestral.')
  await lost.getByRole('button', { name: 'Registrar perda', exact: true }).click()
  await expect(lost).not.toBeVisible()
  await page.getByLabel('Etapa de Ana Ribeiro').selectOption({ label: 'Follow-up' })
  await expect(page.getByLabel('Etapa de Ana Ribeiro').locator('option:checked')).toHaveText('Follow-up')
  const reopened = await openOpportunity(page)
  await expect(reopened.locator('.l360-summary').getByText('Marcos Gestor', { exact: true })).toBeVisible()
  await tab(reopened, 'Timeline')
  for (const title of ['Responsável alterado', 'Ticket atualizado', 'Venda fechada', 'Oportunidade perdida', 'Oportunidade reaberta']) await expect(reopened.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await expect(reopened.getByText('Timing · Retomar na revisão trimestral.', { exact: true })).toBeVisible()
  await expect(reopened.getByText(/R\$\s*12\.500,75/, { exact: true })).toBeVisible()
  expect(state.leads.find(lead => lead.id === opportunityLeadIds.ana)).toMatchObject({ owner_id: memberIds.manager, data: { ticket: 24500, closedValue: 0 } })
  expect(state.events.filter(event => event.lead_id === opportunityLeadIds.ana && event.event_type === 'lead.stage_changed')).toHaveLength(3)
  expect(state.requests.some(request => request.path === '/rest/v1/lead_events' && request.method !== 'GET')).toBe(false); clean(state)
})

test('call history keeps each review and seller score with its own date and expands snapshots without mutating the latest call', async ({ page }) => {
  const state = await mountOpportunity(page, 'manager'), before = structuredClone(state.leads), dialog = await openOpportunity(page)
  await tab(dialog, 'Calls')
  const current = dialog.locator('.l360-call').filter({ hasText: 'Diagnóstico da operação atual.' }), previous = dialog.locator('.l360-call').filter({ hasText: 'Resumo da primeira conversa preservado.' })
  await expect(current.getByText('Feedback atual da liderança', { exact: true })).toBeVisible()
  await expect(current.locator('.l360-call-review .l360-score')).toHaveText('0/10')
  await expect(previous.getByText('Feedback da primeira conversa', { exact: true })).toBeVisible()
  await expect(previous.locator('.l360-call-review .l360-score')).toHaveText('7/10')
  await expect(previous.getByText('Feedback atual da liderança', { exact: true })).toHaveCount(0)
  await previous.getByRole('button', { name: 'Ver call', exact: true }).click(); await expect(previous.getByText('Validar decisão do sócio.', { exact: true })).toBeVisible()
  await expect(dialog.locator('form,input,textarea,select')).toHaveCount(0)
  expect(state.leads).toEqual(before); expect(writes(state)).toHaveLength(0); clean(state)
})

test('a new current call never inherits the leadership feedback of the previous call date', async ({ page }) => {
  const fixture = createOpportunityState(), key = historyKey(workspaceA, opportunityLeadIds.ana)
  const previous = fixture.calls[key][0]
  const nextDate = '2026-10-10T13:00:00.000Z'
  fixture.calls[key] = [callFixture(nextDate, { call_summary: 'Nova conversa ainda sem revisão.', call_score: null, leadership_review: null }), previous]
  Object.assign(fixture.leads.find(lead => lead.id === opportunityLeadIds.ana)!.data, { callDate: nextDate, callSummary: 'Nova conversa ainda sem revisão.', callScore: null })
  // The legacy current-review endpoint still has one row per lead; date-aware
  // presentation must use the historical DTO instead of attaching that row blindly.
  const state = await mountOpportunity(page, 'closer', { state: fixture }), dialog = await openOpportunity(page)
  await expect(dialog.locator('.l360-summary').getByText('Última call ainda sem nota', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Feedback atual da liderança', { exact: true })).toHaveCount(0)
  await tab(dialog, 'Calls')
  const current = dialog.locator('.l360-call').filter({ hasText: 'Nova conversa ainda sem revisão.' })
  await expect(current.getByText('Feedback atual da liderança', { exact: true })).toHaveCount(0)
  await expect(dialog.locator('.l360-call').filter({ hasText: 'Diagnóstico da operação atual.' }).getByText('Feedback atual da liderança', { exact: true })).toBeVisible()
  expect(writes(state)).toHaveLength(0); clean(state)
})

test('legacy call snapshot is labelled an opportunity record rather than reconstructed old meetings', async ({ page }) => {
  const fixture = createOpportunityState(); fixture.calls[historyKey(workspaceA, opportunityLeadIds.ana)] = [callFixture(undefined, { legacy: true })]
  const state = await mountOpportunity(page, 'admin', { state: fixture }), dialog = await openOpportunity(page)
  await tab(dialog, 'Calls'); await expect(dialog.locator('.l360-call')).toHaveCount(1)
  await expect(dialog.getByText('Registro da oportunidade', { exact: true })).toBeVisible()
  expect(reads(state, 'list_lead_call_history')).toHaveLength(1); clean(state)
})

test('call and timeline pagination append scoped results without duplicates or eager loading other leads', async ({ page }) => {
  const fixture = createOpportunityState()
  fixture.calls[historyKey(workspaceA, opportunityLeadIds.ana)] = Array.from({ length: 21 }, (_, index) => callFixture(new Date(Date.UTC(2026, 9, 8 - index, 13)).toISOString(), { call_summary: `Conversa ${index + 1}` }))
  fixture.events = Array.from({ length: 31 }, (_, index) => eventFixture(100 + index, 'activity.created', { title: `Histórico ${index + 1}` }))
  const state = await mountOpportunity(page, 'admin', { state: fixture }), dialog = await openOpportunity(page)
  await tab(dialog, 'Calls'); await expect(dialog.locator('.l360-call')).toHaveCount(20)
  await dialog.getByRole('button', { name: 'Carregar mais calls', exact: true }).click(); await expect(dialog.locator('.l360-call')).toHaveCount(21)
  await expect(dialog.getByRole('button', { name: 'Carregar mais calls', exact: true })).toHaveCount(0)
  expect(reads(state, 'list_lead_call_history')[1].body?.p_offset).toBe(20)
  await tab(dialog, 'Timeline'); await expect(dialog.locator('.l360-event')).toHaveCount(30)
  await dialog.getByRole('button', { name: 'Carregar mais eventos', exact: true }).click(); await expect(dialog.locator('.l360-event')).toHaveCount(31)
  expect(reads(state, 'list_lead_events')[1].body?.p_before_id).toBe('101')
  expect([...reads(state, 'list_lead_events'), ...reads(state, 'list_lead_call_history')].every(request => request.body?.p_lead_id === opportunityLeadIds.ana && request.body?.p_workspace_id === workspaceA)).toBe(true); clean(state)
})

test('failed activity save keeps the draft and retry produces exactly one created task', async ({ page }) => {
  const fixture = createOpportunityState(); fixture.failActivitySave = true
  const state = await mountOpportunity(page, 'admin', { state: fixture }), dialog = await openOpportunity(page), form = await newActivity(dialog, page)
  await fillActivity(form, 'Rascunho preservado')
  await form.getByRole('button', { name: 'Criar atividade', exact: true }).click()
  await expect(form.getByRole('alert')).toContainText('Não foi possível salvar')
  await expect(form.getByLabel('Título da atividade', { exact: true })).toHaveValue('Rascunho preservado')
  expect(state.activities.some(activity => activity.title === 'Rascunho preservado')).toBe(false)
  state.failActivitySave = false; await form.getByRole('button', { name: 'Criar atividade', exact: true }).click(); await expect(form).not.toBeVisible()
  expect(state.activities.filter(activity => activity.title === 'Rascunho preservado')).toHaveLength(1); clean(state)
})

test('failed task completion leaves the task pending and permits a successful retry', async ({ page }) => {
  const fixture = createOpportunityState(); fixture.failActivityStatus = true
  const state = await mountOpportunity(page, 'admin', { state: fixture }), dialog = await openOpportunity(page)
  await tab(dialog, 'Atividades'); await dialog.getByRole('button', { name: 'Concluir atividade Follow-up atrasado do sócio', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText(/Não foi possível/)
  expect(state.activities[0].status).toBe('pending')
  state.failActivityStatus = false; await dialog.getByRole('button', { name: 'Concluir atividade Follow-up atrasado do sócio', exact: true }).click()
  await expect.poll(() => state.activities[0].status).toBe('completed'); clean(state)
})

test('history errors are visible and retry independently without an endless loading state', async ({ page }) => {
  const fixture = createOpportunityState(); fixture.failCalls = true; fixture.failEvents = true
  const state = await mountOpportunity(page, 'admin', { state: fixture }), dialog = await openOpportunity(page)
  await tab(dialog, 'Calls'); await expect(dialog.getByRole('alert')).toContainText(/histórico de calls|calls/)
  state.failCalls = false; await dialog.getByRole('button', { name: 'Tentar novamente', exact: true }).click(); await expect(dialog.locator('.l360-call')).toHaveCount(2)
  await tab(dialog, 'Timeline'); await expect(dialog.getByRole('alert')).toContainText(/timeline|histórico/)
  state.failEvents = false; await dialog.getByRole('button', { name: 'Tentar novamente', exact: true }).click(); await expect(dialog.locator('.l360-event')).toHaveCount(10)
  await expect(dialog.getByRole('alert')).toHaveCount(0); clean(state)
})

test('scoped activity history can fail and retry while overview and call history stay available', async ({ page }) => {
  const state = await mountOpportunity(page); state.failActivities = true
  const dialog = await openOpportunity(page)
  await tab(dialog, 'Atividades'); await expect(dialog.getByRole('alert')).toContainText(/atividades/)
  state.failActivities = false
  await dialog.getByRole('button', { name: 'Tentar novamente', exact: true }).click()
  await expect(dialog.getByText('Conversa já concluída', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await tab(dialog, 'Calls'); await expect(dialog.locator('.l360-call')).toHaveCount(2)
  expect(writes(state)).toHaveLength(0); clean(state)
})

test('a periodic permission denial clears cached operational tasks instead of showing revoked data', async ({ page }) => {
  const state = await mountOpportunity(page)
  await navigateOpportunity(page, 'Atividades')
  await expect(page.getByText('WhatsApp para hoje', { exact: true })).toBeVisible()
  const before = reads(state, 'list_lead_activities').length
  state.activityReadError = { code: '42501', message: 'Atividades não autorizadas.', status: 403 }
  await page.clock.runFor(31_000)
  await expect.poll(() => reads(state, 'list_lead_activities').length).toBeGreaterThan(before)
  await expect(page.locator('.at-central').getByRole('alert')).toContainText(/não autorizadas|permissão|acesso/)
  for (const title of ['Follow-up atrasado do sócio', 'WhatsApp para hoje', 'Reunião futura com decisor']) await expect(page.getByText(title, { exact: true })).toHaveCount(0)
  expect(writes(state)).toHaveLength(0); clean(state)
})

test('a slow pending-activities request survives the thirty-second refresh without duplicated polls or starvation', async ({ page }) => {
  const fixture = createOpportunityState(), release = holdPendingActivities(fixture)
  try {
    const state = await mountOpportunity(page, 'admin', { state: fixture })
    await navigateOpportunity(page, 'Atividades')
    await expect(page.locator('.at-loading')).toBeVisible()
    const initialRequests = reads(state, 'list_lead_activities').filter(request => !request.body?.p_lead_id).length
    expect(initialRequests).toBeGreaterThan(0)
    await page.clock.runFor(61_000)
    expect(reads(state, 'list_lead_activities').filter(request => !request.body?.p_lead_id)).toHaveLength(initialRequests)
    const settled = page.waitForResponse(response => response.url().endsWith('/rpc/list_lead_activities') && !response.request().postDataJSON()?.p_lead_id)
    release(); await settled
    await expect(page.getByText('WhatsApp para hoje', { exact: true })).toBeVisible()
    await expect(page.locator('.at-loading')).toHaveCount(0)
    expect(writes(state)).toHaveLength(0); clean(state)
  } finally { release() }
})

test('external task updates refresh only the opened opportunity while unchanged and other-lead polls keep detailed histories cached', async ({ page }) => {
  const state = await mountOpportunity(page), dialog = await openOpportunity(page)
  await expect(dialog.locator('.l360-next-action').getByText('Follow-up atrasado do sócio', { exact: true })).toBeVisible()
  const lastInteraction = dialog.locator('.l360-stat').filter({ hasText: 'Última interação' }).locator('dd')
  await expect(lastInteraction).toHaveText('Hoje, 12:00')
  const scopedReads = () => reads(state, 'list_lead_activities').filter(request => request.body?.p_lead_id === opportunityLeadIds.ana)
  await tab(dialog, 'Timeline'); await expect(dialog.locator('.l360-event')).toHaveCount(10)
  const activityReadCount = scopedReads().length, callReadCount = reads(state, 'list_lead_call_history').length
  const poll = async () => {
    const response = page.waitForResponse(result => result.url().endsWith('/rpc/list_lead_activities') && !result.request().postDataJSON()?.p_lead_id)
    await page.clock.runFor(31_000); await response
    await page.clock.runFor(100)
  }
  await poll()
  expect(scopedReads()).toHaveLength(activityReadCount); expect(reads(state, 'list_lead_events')).toHaveLength(1)
  Object.assign(state.activities.find(activity => activity.lead_id === opportunityLeadIds.bruno)!, { title: 'Contato de outro lead atualizado externamente', updated_at: '2026-10-08T15:00:30.000Z' })
  await poll()
  expect(scopedReads()).toHaveLength(activityReadCount); expect(reads(state, 'list_lead_events')).toHaveLength(1)
  Object.assign(state.activities[0], { status: 'completed', completed_at: '2026-10-08T15:01:30.000Z', updated_at: '2026-10-08T15:01:30.000Z' })
  state.activities.push(activityFixture(88, 'Próximo contato externo urgente', '2026-10-08T16:00:00.000Z', { updated_at: '2026-10-08T15:01:30.000Z' }))
  state.events.push(eventFixture(state.nextEvent++, 'activity.completed', { title: 'Follow-up atrasado do sócio' }, { actor_id: memberIds.manager, actor_name: 'Marcos Gestor' }), eventFixture(state.nextEvent++, 'activity.created', { title: 'Próximo contato externo urgente', due_at: '2026-10-08T16:00:00.000Z' }, { actor_id: memberIds.manager, actor_name: 'Marcos Gestor' }))
  await poll()
  await expect.poll(() => scopedReads().length).toBe(activityReadCount + 1)
  await expect(dialog.locator('.l360-event')).toHaveCount(12)
  await expect(dialog.getByRole('heading', { name: 'Atividade concluída', exact: true })).toBeVisible()
  await tab(dialog, 'Visão geral'); await expect(dialog.locator('.l360-next-action').getByText('Próximo contato externo urgente', { exact: true })).toBeVisible()
  await expect(lastInteraction).toHaveText('Hoje, 12:01')
  await tab(dialog, 'Atividades')
  const completed = dialog.getByLabel('Atividades concluídas', { exact: true }).getByRole('article', { name: 'Follow-up atrasado do sócio', exact: true })
  await expect(completed).toBeVisible(); await expect(completed.getByRole('button', { name: /^Concluir|^Editar|^Cancelar/ })).toHaveCount(0)
  expect(reads(state, 'list_lead_call_history')).toHaveLength(callReadCount)
  expect(reads(state, 'list_lead_activities').filter(request => request.body?.p_lead_id).every(request => request.body?.p_lead_id === opportunityLeadIds.ana)).toBe(true)
  expect(writes(state)).toHaveLength(0); clean(state)
})

test('session sign-out unmounts nested activity and opportunity dialogs and restores login-page scrolling', async ({ page }) => {
  const state = await mountOpportunity(page), detail = await openOpportunity(page), form = await newActivity(detail, page)
  await expect(form).toBeVisible()
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden')
  // Exercise the real Supabase auth adapter and its subscription, as an expired
  // session or another tab may end access while both dialogs are open.
  await page.evaluate(async () => {
    const modulePath = '/src/lib/supabase.ts'
    const auth = await import(modulePath)
    const result = await auth.requireSupabase().auth.signOut({ scope: 'local' })
    if (result.error) throw result.error
  })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Entrar no meu workspace', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden')
  expect(writes(state)).toHaveLength(0); clean(state)
})

test('late history from the previous workspace cannot populate a newly opened opportunity', async ({ page }) => {
  const fixture = createOpportunityState(), release = holdHistory(fixture, opportunityLeadIds.ana)
  try {
    const state = await mountOpportunity(page, 'admin', { state: fixture, twoWorkspaces: true }), ana = await openOpportunity(page)
    await tab(ana, 'Timeline'); await expect.poll(() => reads(state, 'list_lead_events').length).toBe(1)
    await ana.getByRole('button', { name: 'Fechar oportunidade', exact: true }).click()
    await page.getByLabel('Selecionar empresa', { exact: true }).selectOption(workspaceB)
    const other = await openOpportunity(page, 'SEGREDO SEGUNDA EMPRESA')
    await tab(other, 'Calls'); await expect(other.getByText('SEGREDO CALL EMPRESA B', { exact: true })).toBeVisible()
    await tab(other, 'Timeline'); await expect(other.locator('.l360-event')).toHaveCount(1)
    const previousWorkspaceSettled = page.waitForResponse(response => response.url().endsWith('/rpc/list_lead_events') && response.request().postDataJSON()?.p_workspace_id === workspaceA)
    release(); await previousWorkspaceSettled
    await expect(other.getByText('Qualificado → Compareceu', { exact: true })).toHaveCount(0)
    await expect(other.getByText('Timing · Retomar no próximo trimestre.', { exact: true })).toHaveCount(0)
    await expect(other.locator('.l360-event')).toHaveCount(1)
    expect(reads(state, 'list_lead_call_history').at(-1)?.body?.p_workspace_id).toBe(workspaceB); clean(state)
  } finally { release() }
})

for (const theme of ['light', 'dark'] as const) test(`${theme} 360 and nested activity form fit notebook, mobile and short landscape; Escape closes only the active modal`, async ({ page }) => {
  const state = await mountOpportunity(page, 'admin', { theme }), dialog = await openOpportunity(page)
  await expect(page.locator('.crm-visual')).toHaveAttribute('data-theme', theme)
  for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }, { width: 667, height: 375 }]) {
    await page.setViewportSize(viewport); await noOverflow(page, dialog)
    const form = await newActivity(dialog, page); await noOverflow(page, form)
    await form.getByLabel('Título da atividade', { exact: true }).fill('Rascunho para escapar')
    await page.keyboard.press('Escape'); await expect(form).not.toBeVisible(); await expect(dialog).toBeVisible()
    await tab(dialog, 'Calls'); await expect(dialog.locator('.l360-call')).toHaveCount(2); await noOverflow(page, dialog)
  }
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); expect(writes(state)).toHaveLength(0); clean(state)
})
