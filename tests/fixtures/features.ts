import { expect, type Page } from '@playwright/test'
import type { Lead, LeadStatus } from '../../src/types'
import { defaultStageRows, type StageRow } from './pipeline'

export const workspaceA = '00000000-0000-4000-8000-000000000211'
export const workspaceB = '00000000-0000-4000-8000-000000000212'
export const memberIds = {
  admin: '00000000-0000-4000-8000-000000000201',
  manager: '00000000-0000-4000-8000-000000000202',
  closer: '00000000-0000-4000-8000-000000000203',
  viewer: '00000000-0000-4000-8000-000000000204',
}
export type FixtureRole = keyof typeof memberIds
type LeadRow = { id: string; workspace_id: string; owner_id: string; stage_id: string; data: Lead }
type ReviewRow = { lead_id: string; feedback: string; score: number; reviewed_by: string; reviewer_name: string; reviewed_at: string }
type RequestRecord = { path: string; method: string; query: string; body: Record<string, unknown> | null }
export interface FeatureState {
  stages: Record<string, StageRow[]>
  leads: LeadRow[]
  reviews: Record<string, ReviewRow[]>
  requests: RequestRecord[]
  unexpected: string[]
  errors: string[]
  failStageSave: boolean
  failReviewSave: boolean
}

function sampleLead(workspaceId: string, id: string, name: string, status: LeadStatus, changes: Partial<Lead> = {}): LeadRow {
  const now = new Date().toISOString(), stage = defaultStageRows(workspaceId).find(row => row.name === status)!
  return { id, workspace_id: workspaceId, owner_id: memberIds.closer, stage_id: stage.id,
    data: { id, name, company: workspaceId === workspaceA ? 'Aurora Comercial' : 'Segunda Empresa', email: 'lead@example.invalid',
      phone: '', ticket: 20000, source: 'Indicação', createdAt: now, callDate: now, attendance: 'Compareceu',
      objection: 'Caixa', status, closedValue: 0, closedAt: '', lastContactAt: now, notes: 'Contexto da oportunidade',
      pain: 'Crescimento sem previsibilidade', urgency: 'Alta', financialCapacity: 'Alta', decisionMaker: true,
      callScore: 8, closerError: 'Proposta apresentada cedo', callSummary: 'Aprofundar custo da inércia', ...changes } }
}
export function createFeatureState(): FeatureState {
  return {
    stages: { [workspaceA]: defaultStageRows(workspaceA), [workspaceB]: defaultStageRows(workspaceB) },
    leads: [
      sampleLead(workspaceA, '00000000-0000-4000-8000-000000000221', 'Ana Ribeiro', 'Compareceu'),
      sampleLead(workspaceA, '00000000-0000-4000-8000-000000000222', 'Bruno Castro', 'Follow-up'),
      sampleLead(workspaceA, '00000000-0000-4000-8000-000000000223', 'Carla Torres', 'Fechado', { closedValue: 18000, closedAt: new Date().toISOString() }),
      sampleLead(workspaceB, '00000000-0000-4000-8000-000000000224', 'SEGREDO SEGUNDA EMPRESA', 'Follow-up'),
    ],
    reviews: { [workspaceA]: [], [workspaceB]: [] }, requests: [], unexpected: [], errors: [],
    failStageSave: false, failReviewSave: false,
  }
}

// These local adapters validate browser contracts; the independent SQL suite
// supplies the evidence for actual authorization and tenant isolation.
export async function mountFeatures(page: Page, role: FixtureRole = 'admin', options: { state?: FeatureState; twoWorkspaces?: boolean; theme?: 'light' | 'dark' } = {}) {
  const state = options.state || createFeatureState(), userId = memberIds[role]
  const names: Record<FixtureRole, string> = { admin: 'Ana Administradora', manager: 'Marcos Gestor', closer: 'Caio Closer', viewer: 'Vera Consulta' }
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: `${role}@example.invalid`,
    app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: names[role] },
    created_at: '2026-10-01T00:00:00Z', email_confirmed_at: '2026-10-01T00:00:00Z', identities: [] }
  const payload = { sub: userId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }
  const jwt = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.feature-fixture`
  const session = { access_token: jwt, token_type: 'bearer', refresh_token: 'feature-fixture-refresh-token', expires_in: 3600, expires_at: payload.exp, user }
  const allowedIds = options.twoWorkspaces ? [workspaceA, workspaceB] : [workspaceA]
  page.on('pageerror', error => state.errors.push(error.message))
  await page.addInitScript(({ session, theme }) => {
    localStorage.setItem('sb-test-auth-token', JSON.stringify(session))
    if (theme && !sessionStorage.getItem('feature-theme-seeded')) { localStorage.setItem('closer-os-theme-v1', theme); sessionStorage.setItem('feature-theme-seeded', '1') }
  }, { session, theme: options.theme })
  await page.route('https://test.supabase.co/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method()
    let body: Record<string, unknown> | null = null
    try { body = request.postDataJSON() } catch { /* Read-only query. */ }
    state.requests.push({ path, method, query: url.search, body })
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(value) })
    if (method === 'OPTIONS') { await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } }); return }
    if (path === '/auth/v1/user') { await json(user); return }
    if (path === '/auth/v1/token') { await json(session); return }
    if (path === '/rest/v1/rpc/setup_owner') { await json(null); return }
    if (path === '/rest/v1/platform_admins') { await json([]); return }
    if (path === '/rest/v1/profiles') { await json({ display_name: names[role], email: user.email }); return }
    if (path === '/rest/v1/memberships') { await json(allowedIds.map(workspace_id => ({ workspace_id, user_id: userId, role, is_active: true }))); return }
    if (path === '/rest/v1/workspaces') { await json(allowedIds.map(id => ({ id, name: id === workspaceA ? 'Aurora Comercial' : 'Segunda Empresa', owner_id: memberIds.admin, created_at: '2026-10-01T00:00:00Z' }))); return }
    if (path === '/rest/v1/subscriptions') { await json(allowedIds.map(workspace_id => ({ workspace_id, plan: 'team', status: 'active', seat_limit: 10, current_period_end: '2030-01-01T00:00:00Z', billing_method: 'manual' }))); return }
    if (path === '/rest/v1/workspace_settings') {
      const settings = (workspace_id: string) => ({ workspace_id, name: names[role], commission_rate: 10, revenue_goal: 200000 })
      const requestedFilter = url.searchParams.get('workspace_id')
      await json(requestedFilter?.startsWith('eq.') ? settings(requestedFilter.slice(3)) : allowedIds.map(settings)); return
    }
    const requestedWorkspace = String(body?.p_workspace_id || url.searchParams.get('workspace_id')?.replace(/^eq\./, '') || '')
    if (path.startsWith('/rest/v1/') && !allowedIds.includes(requestedWorkspace) && /leads|pipeline_stages|call_reviews|review_call|list_members/.test(path)) {
      state.unexpected.push(`Unscoped or unauthorized request: ${path}`); await json({ message: 'Empresa fora do acesso do fixture' }, 403); return
    }
    if (path === '/rest/v1/rpc/list_members') { await json(Object.entries(memberIds).map(([memberRole, user_id]) => ({ user_id, display_name: names[memberRole as FixtureRole], email: `${memberRole}@example.invalid`, role: memberRole, is_active: true }))); return }
    if (path === '/rest/v1/rpc/list_pipeline_stages') { await json(state.stages[requestedWorkspace].map(stage => ({ ...stage, lead_count: state.leads.filter(lead => lead.workspace_id === requestedWorkspace && lead.stage_id === stage.id).length }))); return }
    if (path === '/rest/v1/rpc/list_call_reviews') { await json(state.reviews[requestedWorkspace]); return }
    if (path === '/rest/v1/rpc/save_pipeline_stages') {
      if (!['admin', 'manager'].includes(role)) { await json({ message: 'Sem permissão para configurar' }, 403); return }
      if (state.failStageSave) { await json({ message: 'Não foi possível salvar o pipeline. Tente novamente.' }, 503); return }
      const submitted = body?.p_stages as Partial<StageRow>[]
      state.stages[requestedWorkspace] = submitted.map((stage, position) => ({ ...stage,
        id: stage.id || `30000000-0000-4000-8000-${requestedWorkspace.replace(/-/g, '').slice(-8)}${String(position).padStart(4, '0')}`,
        pipeline_id: state.stages[requestedWorkspace][0].pipeline_id, name: String(stage.name), color: String(stage.color),
        type: stage.type!, active: stage.active === true, position, lead_count: 0 }))
      await json(state.stages[requestedWorkspace]); return
    }
    if (path === '/rest/v1/rpc/review_call') {
      if (!['admin', 'manager'].includes(role)) { await json({ message: 'Somente liderança pode revisar' }, 403); return }
      if (state.failReviewSave) { await json({ message: 'Não foi possível salvar a revisão. Tente novamente.' }, 503); return }
      const review: ReviewRow = { lead_id: String(body?.p_lead_id), feedback: String(body?.p_feedback), score: Number(body?.p_score),
        reviewed_by: userId, reviewer_name: names[role], reviewed_at: new Date().toISOString() }
      state.reviews[requestedWorkspace] = [...state.reviews[requestedWorkspace].filter(row => row.lead_id !== review.lead_id), review]
      await json(review); return
    }
    if (path === '/rest/v1/leads') {
      if (method === 'GET') { await json(state.leads.filter(row => row.workspace_id === requestedWorkspace)); return }
      if (method === 'PATCH') {
        const id = url.searchParams.get('id')?.replace(/^eq\./, ''), row = state.leads.find(row => row.id === id && row.workspace_id === requestedWorkspace)
        if (!row || role === 'viewer' || role === 'closer' && row.owner_id !== userId) { await json({ message: 'Lead indisponível para edição' }, 403); return }
        Object.assign(row, body); await json({ id: row.id }); return
      }
    }
    state.unexpected.push(`${method} ${path}`)
    await json({ message: 'This feature fixture does not implement this operation.' }, 500)
  })
  await page.route('**/api/invitation*', route => { state.unexpected.push('Unexpected invitation delivery'); return route.abort() })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible()
  await expect(page.getByText('Salvo na nuvem', { exact: true })).toBeVisible()
  return state
}

export async function navigateFeatures(page: Page, name: 'Dashboard' | 'Pipeline' | 'Calls' | 'Performance') {
  const menu = page.getByRole('button', { name: 'Abrir menu', exact: true })
  if (await menu.isVisible() && !await page.locator('.sidebar').evaluate(element => element.classList.contains('open'))) await menu.click()
  await page.getByRole('navigation', { name: 'Menu principal' }).getByRole('button', { name: new RegExp(`^${name}\\s*\\d*\\s*(Novo)?$`) }).click()
}
export async function openCall(page: Page, name = 'Ana Ribeiro') {
  await navigateFeatures(page, 'Calls')
  await page.getByLabel('Buscar calls').fill(name)
  await page.getByRole('button', { name: `Revisar call de ${name}`, exact: true }).click()
  const dialog = page.getByRole('dialog', { name, exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}
