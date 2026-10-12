import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { expect, type Page } from '@playwright/test'
import type { Lead } from '../../src/types'
import { createOpportunityState, mountOpportunity, opportunityNow, memberIds, workspaceA, workspaceB, type OpportunityState } from './opportunity'
import { mountProfile } from './profile'
import type { FixtureRole } from './features'

export { memberIds, workspaceA, workspaceB }
export type InboundRole = FixtureRole | 'platform'
type Mapping = Record<string, string>
export interface IntegrationRow {
  id: string; workspace_id: string; name: string; active: boolean; archived_at: string | null; source: string
  stage_id: string | null; stage_name: string | null; owner_id: string | null; owner_name: string | null
  field_mapping: Mapping; created_by: string | null; created_at: string; updated_at: string; last_received_at: string | null
  created_count: number; duplicate_count: number; error_count: number
}
export interface IntegrationLog {
  id: string; workspace_id: string; integration_id: string; request_id: string; status: 'created' | 'duplicate' | 'rejected' | 'error'
  lead_id: string | null; duplicate_lead_id: string | null; error_code: string | null; created_at: string
}
export interface InboundState extends OpportunityState {
  integrations: IntegrationRow[]; logs: IntegrationLog[]; tokenHashes: Record<string, string>
  inboundRequests: { path: string; method: string; body: Record<string, unknown> | null; authenticated: boolean }[]
  receivedRequests: { tokenHash: string; payload: Record<string, unknown>; requestId: string; transportError: string | null }[]
  failCreate: boolean; failRotate: boolean; failUpdate: boolean; nextLog: number
  failStageOptions: boolean; stageOptionCalls: number
  delayedLists: Map<string, Promise<void>>
}
const names: Record<FixtureRole, string> = { admin: 'Ana Administradora', manager: 'Marcos Gestor', closer: 'Caio Closer', viewer: 'Vera Consulta' }
const hash = (token: string) => createHash('sha256').update(token).digest('hex')
export function createInboundState(): InboundState {
  const base = createOpportunityState()
  return { ...base, leads: base.leads.filter(row => row.workspace_id === workspaceB), activities: [], events: [], calls: {},
    integrations: [], logs: [], tokenHashes: {}, inboundRequests: [], receivedRequests: [],
    failCreate: false, failRotate: false, failUpdate: false, nextLog: 1,
    failStageOptions: false, stageOptionCalls: 0, delayedLists: new Map() }
}
export function seedIntegration(state: InboundState, workspaceId = workspaceA, name = 'Formulário Site') {
  const stage = state.stages[workspaceId].find(row => row.active && row.type === 'NORMAL')!
  const row: IntegrationRow = { id: randomUUID(), workspace_id: workspaceId, name, active: true, archived_at: null,
    source: 'Landing Page', stage_id: stage.id, stage_name: stage.name, owner_id: memberIds.closer, owner_name: names.closer,
    field_mapping: { name: 'name', email: 'email', phone: 'phone', company: 'company', ticket: 'ticket', source: 'source', notes: 'notes' },
    created_by: memberIds.admin, created_at: opportunityNow, updated_at: opportunityNow, last_received_at: null,
    created_count: 0, duplicate_count: 0, error_count: 0 }
  state.integrations.push(row)
  const token = randomBytes(32).toString('hex')
  state.tokenHashes[row.id] = hash(token)
  return { integration: row, token }
}

// Browser tests exercise production components and the actual public API parser.
// Auth/REST replies and the atomic database RPC below are modeled test adapters.
// They do not constitute evidence for real PostgreSQL authorization or deduplication.
export async function mountInbound(page: Page, role: InboundRole = 'admin', options: { state?: InboundState; twoWorkspaces?: boolean; theme?: 'light' | 'dark' } = {}) {
  const state = options.state || createInboundState()
  if (role === 'platform') await mountProfile(page, 'platform', { theme: options.theme })
  else await mountOpportunity(page, role, { state, twoWorkspaces: options.twoWorkspaces, theme: options.theme })
  const allowed = options.twoWorkspaces ? [workspaceA, workspaceB] : [workspaceA]
  await page.route('https://test.supabase.co/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname
    let body: Record<string, unknown> | null = null
    try { body = request.postDataJSON() } catch { /* GET. */ }
    const management = /\/(list|create|update|set|rotate|archive)_inbound_/.test(path)
    const stageOptions = path === '/rest/v1/rpc/list_pipeline_stages'
    const incidental = path === '/rest/v1/rpc/list_invitations' || path === '/rest/v1/rpc/list_audit'
      || path === '/rest/v1/workspaces' && url.searchParams.get('select')?.includes('retention_days')
    if (!management && !incidental && !stageOptions) { await route.fallback(); return }
    state.inboundRequests.push({ path, method: request.method(), body, authenticated: Boolean(request.headers().authorization?.startsWith('Bearer ')) })
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(value) })
    if (stageOptions) {
      state.stageOptionCalls += 1
      if (state.failStageOptions) { await json({ code: '42501', message: 'As opções do pipeline estão temporariamente indisponíveis.' }, 403); return }
      await json(state.stages[String(body?.p_workspace_id)]); return
    }
    if (!management) { await json(path === '/rest/v1/workspaces' ? { retention_days: 365, privacy_contact_email: 'privacy@example.invalid' } : []); return }
    const ws = String(body?.p_workspace_id || '')
    if (role !== 'admin' || !allowed.includes(ws)) { state.unexpected.push(`Unauthorized integration request from ${role}`); await json({ message: 'Somente o administrador ativo desta empresa pode administrar integrações.' }, 403); return }
    if (path.endsWith('/list_inbound_integrations')) {
      const rows = structuredClone(state.integrations.filter(row => row.workspace_id === ws))
      const delayed = state.delayedLists.get(ws); if (delayed) await delayed
      await json(rows); return
    }
    const id = String(body?.p_integration_id || ''), current = state.integrations.find(row => row.id === id && row.workspace_id === ws)
    if (path.endsWith('/list_inbound_integration_logs')) {
      const before = Number(body?.p_before_id || Infinity), limit = Number(body?.p_limit || 30)
      const rows = state.logs.filter(row => row.workspace_id === ws && row.integration_id === id && Number(row.id) < before).sort((a,b) => Number(b.id) - Number(a.id))
      const items = rows.slice(0, limit)
      await json({ items, next_cursor: rows.length > limit ? items.at(-1)!.id : null }); return
    }
    const configuration = () => {
      const stage = state.stages[ws].find(stage => stage.id === body?.p_stage_id && stage.active && stage.type === 'NORMAL')
      const ownerId = String(body?.p_owner_id)
      if (!stage || ![memberIds.admin, memberIds.manager, memberIds.closer].includes(ownerId)) throw new Error('Destino ou responsável inválido')
      return { name: String(body?.p_name).trim(), source: String(body?.p_source).trim(), stage_id: stage.id, stage_name: stage.name,
        owner_id: ownerId, owner_name: names[(Object.keys(memberIds) as FixtureRole[]).find(memberRole => memberIds[memberRole] === ownerId)!],
        field_mapping: structuredClone(body?.p_field_mapping as Mapping), updated_at: opportunityNow }
    }
    if (path.endsWith('/create_inbound_integration')) {
      if (state.failCreate) { await json({ message: 'Não foi possível criar a integração. Tente novamente.' }, 503); return }
      const seeded = seedIntegration(state, ws)
      Object.assign(seeded.integration, configuration())
      await json({ integration: seeded.integration, token: seeded.token }); return
    }
    if (!current) { await json({ message: 'Integração não encontrada.' }, 404); return }
    if (path.endsWith('/update_inbound_integration')) {
      if (state.failUpdate) { await json({ message: 'Não foi possível salvar a configuração. Tente novamente.' }, 503); return }
      Object.assign(current, configuration()); await json(current); return
    }
    if (path.endsWith('/rotate_inbound_integration_token')) {
      if (state.failRotate) { await json({ message: 'Não foi possível redefinir a credencial. Tente novamente.' }, 503); return }
      const token = randomBytes(32).toString('hex')
      state.tokenHashes[id] = hash(token); current.updated_at = opportunityNow
      await json({ integration: current, token }); return
    }
    if (path.endsWith('/set_inbound_integration_active')) { current.active = body?.p_active === true; current.updated_at = opportunityNow; await json(current); return }
    if (path.endsWith('/archive_inbound_integration')) { current.active = false; current.archived_at = opportunityNow; current.updated_at = opportunityNow; await json(current); return }
    state.unexpected.push(path); await json({ message: 'Unsupported integration fixture operation.' }, 500)
  })

  await page.route('**/api/inbound-leads**', async route => {
    const request = route.request(), url = new URL(request.url())
    // The real production HTTP handler validates content type, size and token.
    // This mock SDK implements only its privileged atomic RPC; no network leaves the fixture.
    const { createInboundLeadsHandler } = await import('../../api/inbound-leads.mjs')
    const handler = createInboundLeadsHandler({ env: { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_inbound_browser_fixture' },
      createClient: () => ({ rpc: async (rpc: string, args: Record<string, unknown>) => {
        if (rpc !== 'receive_inbound_lead') throw new Error('Unexpected public webhook RPC')
        const payload = args.p_payload as Record<string, unknown>, tokenHash = String(args.p_token_hash), requestId = String(args.p_request_id)
        const transportError = typeof args.p_transport_error === 'string' ? args.p_transport_error : null
        state.receivedRequests.push({ tokenHash, payload, requestId, transportError })
        const integration = state.integrations.find(row => state.tokenHashes[row.id] === tokenHash)
        const result = (status: string, httpStatus: number, errorCode?: string, leadId?: string) => ({ data: { status, request_id: requestId, http_status: httpStatus, ...(errorCode ? { error_code: errorCode } : {}), ...(leadId ? { lead_id: leadId } : {}) }, error: null })
        if (!integration || !integration.active || integration.archived_at) return result('rejected', 401, 'INVALID_CREDENTIALS')
        integration.last_received_at = opportunityNow
        const addLog = (status: IntegrationLog['status'], errorCode: string | null = null, leadId: string | null = null) => {
          state.logs.push({ id: String(state.nextLog++), workspace_id: integration.workspace_id, integration_id: integration.id, request_id: requestId, status,
            lead_id: status === 'created' ? leadId : null, duplicate_lead_id: status === 'duplicate' ? leadId : null, error_code: errorCode, created_at: opportunityNow })
          if (status === 'created') integration.created_count += 1
          else if (status === 'duplicate') integration.duplicate_count += 1
          else integration.error_count += 1
        }
        const mapped = (key: string) => payload[integration.field_mapping[key]]
        const name = typeof mapped('name') === 'string' ? String(mapped('name')).trim() : ''
        if (transportError || !name) { const code = transportError || 'NAME_REQUIRED'; addLog('rejected', code); return result('rejected', 422, code) }
        const email = typeof mapped('email') === 'string' ? String(mapped('email')).trim().toLowerCase() : ''
        const phone = typeof mapped('phone') === 'string' ? String(mapped('phone')).replace(/\D/g,'') : ''
        const duplicate = state.leads.find(row => row.workspace_id === integration.workspace_id && (email && row.data.email.toLowerCase() === email || phone && row.data.phone.replace(/\D/g,'') === phone))
        if (duplicate) { addLog('duplicate', null, duplicate.id); return result('duplicate', 200, undefined, duplicate.id) }
        const id = randomUUID(), stage = state.stages[integration.workspace_id].find(row => row.id === integration.stage_id)!
        const data: Lead = { id, name, email, phone, company: String(mapped('company') || ''), ticket: Number(mapped('ticket') || 0), source: String(mapped('source') || integration.source),
          createdAt: opportunityNow, callDate: '', attendance: 'Pendente', objection: '', status: 'Lead novo', closedValue: 0, closedAt: '', lastContactAt: opportunityNow,
          notes: String(mapped('notes') || ''), pain: '', urgency: 'Média', financialCapacity: 'Não avaliada', decisionMaker: false, callScore: null, closerError: '', callSummary: '' }
        state.leads.push({ id, workspace_id: integration.workspace_id, owner_id: integration.owner_id!, stage_id: stage.id, data })
        state.events.push({ id: String(2000 + state.nextLog), workspace_id: integration.workspace_id, lead_id: id, actor_id: null, actor_name: 'Sistema', event_type: 'lead.inbound_received',
          metadata: { integration_id: integration.id, integration_name: integration.name, source: data.source }, created_at: opportunityNow })
        addLog('created', null, id)
        return result('created', 201, undefined, id)
      } }) })
    let status = 200, responseBody = '', headers: Record<string, string> = {}
    const response = { setHeader: (key: string, value: unknown) => { headers[key] = String(value) },
      status: (value: number) => { status = value; return response }, json: (value: unknown) => { responseBody = JSON.stringify(value); return response },
      end: (value?: string) => { responseBody = value || ''; return response } }
    await handler({ method: request.method(), url: request.url(), query: Object.fromEntries(url.searchParams), headers: request.headers(), body: request.postData() || '' }, response)
    await route.fulfill({ status, headers, body: responseBody })
  })
  await page.route('**/api/invitation*', route => { state.unexpected.push('Unexpected email delivery'); return route.abort() })
  return state
}
export async function openInbound(page: Page) {
  await page.locator('.cloud-context-bar').getByRole('button', { name: 'Administrar', exact: true }).click()
  await page.getByRole('tab', { name: 'Integrações', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Formulários e Webhooks', exact: true })).toBeVisible()
}
