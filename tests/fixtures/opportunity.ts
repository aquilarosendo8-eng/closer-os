import { expect, type Page } from '@playwright/test'
import type { Lead } from '../../src/types'
import type { ActivityStatus, ActivityType } from '../../src/lib/opportunity-types'
import { createFeatureState, memberIds, workspaceA, workspaceB, type FeatureState, type FixtureRole } from './features'

export { memberIds, workspaceA, workspaceB }
export const opportunityNow = '2026-10-08T15:00:00.000Z'
export const opportunityLeadIds = { ana: '00000000-0000-4000-8000-000000000221', bruno: '00000000-0000-4000-8000-000000000222', carla: '00000000-0000-4000-8000-000000000223', foreign: '00000000-0000-4000-8000-000000000224' }
const names: Record<FixtureRole, string> = { admin: 'Ana Administradora', manager: 'Marcos Gestor', closer: 'Caio Closer', viewer: 'Vera Consulta' }
export interface ActivityRow {
  id: string; workspace_id: string; lead_id: string; assigned_to: string; assigned_name: string; created_by: string; created_by_name: string
  type: ActivityType; title: string; description: string; due_at: string; status: ActivityStatus; completed_at: string | null; created_at: string; updated_at: string
}
export interface EventRow { id: string; workspace_id: string; lead_id: string; actor_id: string | null; actor_name: string; event_type: string; metadata: Record<string, unknown>; created_at: string }
export interface CallRow {
  id: string; call_date: string | null; attendance: Lead['attendance']; call_score: number | null; call_summary: string; objection: string
  pain: string; urgency: Lead['urgency']; financial_capacity: Lead['financialCapacity']; decision_maker: boolean; closer_error: string
  recording_url: string; next_step: string; recorded_at: string; legacy: boolean
  leadership_review: { feedback: string; score: number; reviewed_by: string | null; reviewer_name: string; reviewed_at: string } | null
}
export interface OpportunityState extends FeatureState {
  activities: ActivityRow[]; events: EventRow[]; calls: Record<string, CallRow[]>
  failActivitySave: boolean; failActivityStatus: boolean; failEvents: boolean; failCalls: boolean; failActivities: boolean
  activityReadError: { code: string; message: string; status: number } | null
  pendingGate: Promise<void> | null
  historyGates: Map<string, Promise<void>>; nextEvent: number; nextActivity: number
}
export const historyKey = (workspaceId: string, leadId: string) => `${workspaceId}:${leadId}`
export function callFixture(date = '2026-10-08T13:00:00.000Z', changes: Partial<CallRow> = {}): CallRow {
  return { id: date, call_date: date, attendance: 'Compareceu', call_score: 8, call_summary: 'Diagnóstico da operação atual.', objection: 'Caixa', pain: 'Estoque parado', urgency: 'Alta',
    financial_capacity: 'Alta', decision_maker: true, closer_error: 'Proposta apresentada cedo', recording_url: 'https://recordings.example.invalid/current',
    next_step: 'Validar decisão do sócio.', recorded_at: opportunityNow, legacy: false, leadership_review: null, ...changes }
}
export function activityFixture(id: number, title: string, dueAt: string, changes: Partial<ActivityRow> = {}): ActivityRow {
  return { id: `40000000-0000-4000-8000-${String(id).padStart(12, '0')}`, workspace_id: workspaceA, lead_id: opportunityLeadIds.ana,
    assigned_to: memberIds.closer, assigned_name: names.closer, created_by: memberIds.admin, created_by_name: names.admin, type: 'follow_up', title,
    description: 'Validar decisão do sócio.', due_at: dueAt, status: 'pending', completed_at: null, created_at: '2026-10-08T12:00:00.000Z', updated_at: opportunityNow, ...changes }
}
export function eventFixture(id: number, eventType: string, metadata: Record<string, unknown> = {}, changes: Partial<EventRow> = {}): EventRow {
  return { id: String(id), workspace_id: workspaceA, lead_id: opportunityLeadIds.ana, actor_id: memberIds.admin, actor_name: names.admin,
    event_type: eventType, metadata, created_at: new Date(new Date(opportunityNow).getTime() - (1000 - id) * 60000).toISOString(), ...changes }
}
export function createOpportunityState(): OpportunityState {
  const state = createFeatureState()
  for (const row of state.leads) {
    row.data.createdAt = '2026-10-01T12:00:00.000Z'; row.data.lastContactAt = '2026-10-01T12:00:00.000Z'
    row.data.callDate = '2026-10-08T13:00:00.000Z'; row.data.email = 'ana.lead@example.invalid'; row.data.phone = '+55 11 99999-1111'
    if (row.data.closedAt) row.data.closedAt = opportunityNow
  }
  state.leads.find(row => row.id === opportunityLeadIds.bruno)!.owner_id = memberIds.manager
  const ana = state.leads.find(row => row.id === opportunityLeadIds.ana)!
  ana.data.recordingUrl = 'https://recordings.example.invalid/current'; ana.data.nextStep = 'Validar decisão do sócio.'
  state.reviews[workspaceA] = [{ lead_id: ana.id, feedback: 'Feedback atual da liderança', score: 0, reviewed_by: memberIds.manager, reviewer_name: names.manager, reviewed_at: opportunityNow }]
  return { ...state,
    activities: [
      activityFixture(1, 'Follow-up atrasado do sócio', '2026-10-06T16:00:00.000Z'),
      activityFixture(2, 'WhatsApp para hoje', '2026-10-08T18:00:00.000Z', { type: 'whatsapp' }),
      activityFixture(3, 'Reunião futura com decisor', '2026-10-09T17:00:00.000Z', { type: 'meeting' }),
      activityFixture(4, 'Conversa já concluída', '2026-10-07T18:00:00.000Z', { status: 'completed', completed_at: '2026-10-07T18:30:00.000Z' }),
      activityFixture(5, 'Atividade cancelada anterior', '2026-10-05T18:00:00.000Z', { status: 'cancelled' }),
      activityFixture(6, 'Tarefa restrita do outro closer', '2026-10-08T20:00:00.000Z', { lead_id: opportunityLeadIds.bruno, assigned_to: memberIds.manager, assigned_name: names.manager }),
      activityFixture(7, 'SEGREDO ATIVIDADE EMPRESA B', '2026-10-08T18:00:00.000Z', { workspace_id: workspaceB, lead_id: opportunityLeadIds.foreign }),
    ],
    events: [
      eventFixture(900, 'lead.created', { name: 'Ana Ribeiro' }), eventFixture(901, 'lead.owner_changed', { from_owner_id: memberIds.admin, to_owner_id: memberIds.closer, to_owner_name: names.closer }),
      eventFixture(902, 'lead.stage_changed', { from_stage_name: 'Qualificado', to_stage_name: 'Compareceu' }),
      eventFixture(903, 'call.recorded', { attendance: 'Compareceu', call_score: 8 }),
      eventFixture(904, 'activity.created', { title: 'Follow-up atrasado do sócio', due_at: '2026-10-06T16:00:00.000Z' }),
      eventFixture(905, 'lead.won', { closed_value: 18000 }), eventFixture(906, 'lead.lost', { loss_reason: 'Timing', loss_comment: 'Retomar no próximo trimestre.' }),
      eventFixture(907, 'lead.reopened'), eventFixture(908, 'call.reviewed', { score: 0 }),
      eventFixture(909, 'lead.ticket_changed', { previous_ticket: 15000, ticket: 20000 }),
      eventFixture(910, 'lead.created', { name: 'SEGREDO TIMELINE EMPRESA B' }, { workspace_id: workspaceB, lead_id: opportunityLeadIds.foreign }),
    ],
    calls: { [historyKey(workspaceA, ana.id)]: [
      callFixture(undefined, { leadership_review: { feedback: 'Feedback atual da liderança', score: 0, reviewed_by: memberIds.manager, reviewer_name: names.manager, reviewed_at: opportunityNow } }),
      callFixture('2026-10-01T13:00:00.000Z', { call_score: 6, call_summary: 'Resumo da primeira conversa preservado.', recording_url: 'https://recordings.example.invalid/historical',
        leadership_review: { feedback: 'Feedback da primeira conversa', score: 7, reviewed_by: memberIds.manager, reviewer_name: names.manager, reviewed_at: '2026-10-01T14:00:00.000Z' } }),
    ], [historyKey(workspaceB, opportunityLeadIds.foreign)]: [callFixture(undefined, { call_summary: 'SEGREDO CALL EMPRESA B' })] },
    failActivitySave: false, failActivityStatus: false, failEvents: false, failCalls: false, failActivities: false,
    activityReadError: null, pendingGate: null,
    historyGates: new Map(), nextEvent: 1000, nextActivity: 100,
  }
}
export function holdHistory(state: OpportunityState, leadId: string): () => void {
  let release!: () => void
  state.historyGates.set(leadId, new Promise<void>(resolve => { release = resolve }))
  return () => { state.historyGates.delete(leadId); release() }
}
export function holdPendingActivities(state: OpportunityState): () => void {
  let release!: () => void
  state.pendingGate = new Promise<void>(resolve => { release = resolve })
  return () => { state.pendingGate = null; release() }
}
const nameFor = (id: string) => names[(Object.keys(memberIds) as FixtureRole[]).find(role => memberIds[role] === id) || 'closer']

// These adapters exercise frontend contracts only. Real RLS, immutable authorship
// and event capture are verified independently by the PostgreSQL suite.
export async function mountOpportunity(page: Page, role: FixtureRole = 'admin', options: { state?: OpportunityState; twoWorkspaces?: boolean; theme?: 'light' | 'dark' } = {}) {
  const state = options.state || createOpportunityState(), userId = memberIds[role]
  const allowedIds = options.twoWorkspaces ? [workspaceA, workspaceB] : [workspaceA]
  const allowedLead = (workspaceId: string, leadId: string) => allowedIds.includes(workspaceId) && state.leads.some(lead => lead.workspace_id === workspaceId && lead.id === leadId && (role !== 'closer' || lead.owner_id === userId))
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: `${role}@example.invalid`, app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: names[role] }, created_at: '2026-10-01T00:00:00Z', email_confirmed_at: '2026-10-01T00:00:00Z', identities: [] }
  const payload = { sub: userId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 86400 }
  const jwt = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.opportunity-fixture`
  const session = { access_token: jwt, token_type: 'bearer', refresh_token: 'opportunity-fixture-refresh-token', expires_in: 86400, expires_at: payload.exp, user }
  await page.clock.install({ time: new Date(opportunityNow) })
  page.on('pageerror', error => state.errors.push(error.message))
  await page.addInitScript(({ session, theme }) => {
    localStorage.setItem('sb-test-auth-token', JSON.stringify(session))
    if (theme && !sessionStorage.getItem('opportunity-theme-seeded')) { localStorage.setItem('closer-os-theme-v1', theme); sessionStorage.setItem('opportunity-theme-seeded', '1') }
  }, { session, theme: options.theme })
  const addEvent = (workspaceId: string, leadId: string, type: string, metadata: Record<string, unknown> = {}) => state.events.push(eventFixture(state.nextEvent++, type, metadata, { workspace_id: workspaceId, lead_id: leadId, actor_id: userId, actor_name: names[role], created_at: opportunityNow }))
  await page.route('https://test.supabase.co/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method()
    let body: Record<string, unknown> | null = null
    try { body = request.postDataJSON() } catch { /* GET. */ }
    state.requests.push({ path, method, query: url.search, body })
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(value) })
    if (method === 'OPTIONS') { await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } }); return }
    if (path === '/auth/v1/user') { await json(user); return }
    if (path === '/auth/v1/token') { await json(session); return }
    if (path === '/auth/v1/logout') { await json({}); return }
    if (path === '/rest/v1/rpc/setup_owner') { await json(null); return }
    if (path === '/rest/v1/platform_admins') { await json([]); return }
    if (path === '/rest/v1/profiles') { await json({ display_name: names[role], email: user.email }); return }
    if (path === '/rest/v1/memberships') { await json(allowedIds.map(workspace_id => ({ workspace_id, user_id: userId, role, is_active: true, display_name: null }))); return }
    if (path === '/rest/v1/workspaces') { await json(allowedIds.map(id => ({ id, name: id === workspaceA ? 'Aurora Comercial' : 'Segunda Empresa', owner_id: memberIds.admin }))); return }
    if (path === '/rest/v1/subscriptions') { await json(allowedIds.map(workspace_id => ({ workspace_id, plan: 'team', status: 'active', seat_limit: 10, current_period_end: '2030-01-01T00:00:00Z', billing_method: 'manual' }))); return }
    const ws = String(body?.p_workspace_id || url.searchParams.get('workspace_id')?.replace(/^eq\./, '') || '')
    if (path === '/rest/v1/workspace_settings') {
      const settings = (workspace_id: string) => ({ workspace_id, name: names[role], commission_rate: 10, revenue_goal: 200000 })
      const filter = url.searchParams.get('workspace_id')
      await json(filter?.startsWith('eq.') ? settings(filter.slice(3)) : allowedIds.map(settings)); return
    }
    if (path.startsWith('/rest/v1/') && !allowedIds.includes(ws)) { state.unexpected.push(`Unscoped or foreign request: ${path}`); await json({ message: 'Empresa indisponível' }, 403); return }
    if (path === '/rest/v1/rpc/list_members') { await json(Object.entries(memberIds).map(([memberRole, user_id]) => ({ user_id, display_name: names[memberRole as FixtureRole], email: `${memberRole}@example.invalid`, role: memberRole, is_active: true }))); return }
    if (path === '/rest/v1/rpc/list_pipeline_stages') { await json(state.stages[ws].map(stage => ({ ...stage, lead_count: state.leads.filter(row => row.workspace_id === ws && row.stage_id === stage.id).length }))); return }
    if (path === '/rest/v1/rpc/list_call_reviews') { await json(state.reviews[ws].filter(review => allowedLead(ws, review.lead_id))); return }
    if (path === '/rest/v1/rpc/list_lead_activities') {
      if (!body?.p_lead_id && state.pendingGate) await state.pendingGate
      if (state.activityReadError) { const { status, ...error } = state.activityReadError; await json(error, status); return }
      if (state.failActivities) { await json({ message: 'Não foi possível carregar atividades.' }, 503); return }
      const leadId = body?.p_lead_id, offset = Number(body?.p_offset || 0), limit = Number(body?.p_limit || 200)
      const rows = state.activities.filter(activity => activity.workspace_id === ws && (leadId ? activity.lead_id === leadId : activity.status === 'pending') && allowedLead(ws, activity.lead_id)).sort((a,b) => a.due_at.localeCompare(b.due_at) || a.id.localeCompare(b.id))
      await json({ items: rows.slice(offset, offset + limit), next_offset: offset + limit < rows.length ? offset + limit : null }); return
    }
    if (path === '/rest/v1/rpc/list_lead_events' || path === '/rest/v1/rpc/list_lead_call_history') {
      const leadId = String(body?.p_lead_id)
      if (!allowedLead(ws, leadId)) { state.unexpected.push('History request for forbidden lead'); await json({ message: 'Oportunidade não autorizada' }, 403); return }
      const gate = state.historyGates.get(leadId); if (gate) await gate
      if (path.endsWith('list_lead_events')) {
        if (state.failEvents) { await json({ message: 'Não foi possível carregar a timeline.' }, 503); return }
        const before = Number(body?.p_before_id || Infinity), limit = Number(body?.p_limit || 30)
        const rows = state.events.filter(event => event.workspace_id === ws && event.lead_id === leadId && Number(event.id) < before && event.event_type !== 'call.snapshot').sort((a,b) => Number(b.id) - Number(a.id))
        const items = rows.slice(0, limit); await json({ items, next_cursor: rows.length > limit ? items.at(-1)!.id : null }); return
      }
      if (state.failCalls) { await json({ message: 'Não foi possível carregar o histórico de calls.' }, 503); return }
      const rows = state.calls[historyKey(ws, leadId)] || [], offset = Number(body?.p_offset || 0), limit = Number(body?.p_limit || 20)
      await json({ items: rows.slice(offset, offset + limit), next_offset: offset + limit < rows.length ? offset + limit : null, call_count: rows.length }); return
    }
    if (path === '/rest/v1/rpc/save_activity') {
      const leadId = String(body?.p_lead_id), activityId = body?.p_activity_id && String(body.p_activity_id)
      if (role === 'viewer' || !allowedLead(ws, leadId)) { state.unexpected.push('Forbidden activity mutation from UI'); await json({ message: 'Sem permissão para editar atividade' }, 403); return }
      if (state.failActivitySave) { await json({ message: 'Não foi possível salvar a atividade. Tente novamente.' }, 503); return }
      const assignedTo = String(body?.p_assigned_to || userId)
      const existing = state.activities.find(activity => activity.id === activityId && activity.workspace_id === ws && activity.lead_id === leadId)
      if (role === 'closer' && assignedTo !== userId && assignedTo !== existing?.assigned_to || assignedTo === memberIds.viewer) { state.unexpected.push('Invalid assignment from UI'); await json({ message: 'Responsável inválido' }, 403); return }
      const saved = existing || activityFixture(state.nextActivity++, String(body?.p_title), String(body?.p_due_at), { workspace_id: ws, lead_id: leadId, created_by: userId, created_by_name: names[role], created_at: opportunityNow })
      Object.assign(saved, { assigned_to: assignedTo, assigned_name: nameFor(assignedTo), type: body?.p_type, title: String(body?.p_title).trim(), description: String(body?.p_description || ''), due_at: body?.p_due_at, updated_at: opportunityNow })
      if (!existing) state.activities.push(saved)
      addEvent(ws, leadId, existing ? 'activity.updated' : 'activity.created', { activity_id: saved.id, title: saved.title, due_at: saved.due_at })
      await json(saved); return
    }
    if (path === '/rest/v1/rpc/set_activity_status') {
      const saved = state.activities.find(activity => activity.workspace_id === ws && activity.id === body?.p_activity_id)
      if (!saved || role === 'viewer' || !allowedLead(ws, saved.lead_id)) { state.unexpected.push('Forbidden activity status mutation from UI'); await json({ message: 'Atividade não autorizada' }, 403); return }
      if (state.failActivityStatus) { await json({ message: 'Não foi possível concluir a atividade. Tente novamente.' }, 503); return }
      saved.status = body!.p_status as ActivityStatus; saved.completed_at = saved.status === 'completed' ? opportunityNow : null; saved.updated_at = opportunityNow
      addEvent(ws, saved.lead_id, `activity.${saved.status}`, { activity_id: saved.id, title: saved.title, due_at: saved.due_at })
      await json(saved); return
    }
    if (path === '/rest/v1/leads') {
      if (method === 'GET') { await json(state.leads.filter(row => row.workspace_id === ws && allowedLead(ws, row.id))); return }
      if (method === 'PATCH') {
        const leadId = url.searchParams.get('id')?.replace(/^eq\./, ''), row = state.leads.find(item => item.workspace_id === ws && item.id === leadId)
        if (!row || role === 'viewer' || !allowedLead(ws, row.id)) { await json({ message: 'Lead não autorizado' }, 403); return }
        const before = structuredClone(row), nextData = body?.data as Lead | undefined
        Object.assign(row, body)
        if (before.owner_id !== row.owner_id) addEvent(ws, row.id, 'lead.owner_changed', { from_owner_id: before.owner_id, to_owner_id: row.owner_id, to_owner_name: nameFor(row.owner_id) })
        if (nextData && before.data.ticket !== row.data.ticket) addEvent(ws, row.id, 'lead.ticket_changed', { previous_ticket: before.data.ticket, ticket: row.data.ticket })
        if (before.stage_id !== row.stage_id) {
          const from = state.stages[ws].find(stage => stage.id === before.stage_id)!, to = state.stages[ws].find(stage => stage.id === row.stage_id)!
          addEvent(ws, row.id, 'lead.stage_changed', { from_stage_name: from.name, to_stage_name: to.name })
          if (to.type === 'WON') addEvent(ws, row.id, 'lead.won', { closed_value: row.data.closedValue })
          else if (to.type === 'LOST') addEvent(ws, row.id, 'lead.lost', { loss_reason: row.data.lossReason, loss_comment: row.data.lossComment })
          else if (from.type !== 'NORMAL') addEvent(ws, row.id, 'lead.reopened')
        }
        await json({ id: row.id }); return
      }
    }
    state.unexpected.push(`${method} ${path}`); await json({ message: 'This opportunity fixture rejects unsupported operations.' }, 500)
  })
  await page.route('**/api/invitation*', route => { state.unexpected.push('Unexpected email delivery'); return route.abort() })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Visão geral.', exact: true })).toBeVisible()
  await expect(page.getByText('Salvo na nuvem', { exact: true })).toBeVisible()
  return state
}
export async function navigateOpportunity(page: Page, name: 'Dashboard' | 'Pipeline' | 'Calls' | 'Performance' | 'Atividades') {
  const menu = page.getByRole('button', { name: 'Abrir menu', exact: true })
  if (await menu.isVisible() && !await page.locator('.sidebar').evaluate(element => element.classList.contains('open'))) await menu.click()
  await page.getByRole('navigation', { name: 'Menu principal' }).getByRole('button', { name: new RegExp(`^${name}\\s*\\d*\\s*(Novo)?$`) }).click()
}
export async function openOpportunity(page: Page, name = 'Ana Ribeiro') {
  await navigateOpportunity(page, 'Pipeline')
  await page.getByLabel('Buscar no pipeline').fill(name)
  const card = page.locator('.lead-card').filter({ has: page.getByRole('heading', { name, exact: true }) })
  await card.locator('.lead-card-main').click()
  const dialog = page.getByRole('dialog', { name: `Oportunidade de ${name}`, exact: true })
  await expect(dialog).toBeVisible(); return dialog
}
