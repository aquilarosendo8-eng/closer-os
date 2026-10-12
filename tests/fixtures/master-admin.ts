import { randomBytes, randomUUID } from 'node:crypto'
import { expect, type Page } from '@playwright/test'
import { defaultStageRows } from './pipeline'
import { createProfileState, mountProfile, profileEmail, profileUserIds, profileWorkspaceA, profileWorkspaceB, type ProfileRole } from './profile'

export const masterWorkspaceA = profileWorkspaceA
export const masterWorkspaceB = profileWorkspaceB
const now = '2026-10-12T12:00:00Z'
type Row = Record<string, unknown>
export interface MasterRequest { path: string; method: string; body: Row | null; authenticated: boolean }
export interface MasterState {
  profile: ReturnType<typeof createProfileState>
  workspaces: Record<string, { id: string; name: string; business_contact_email: string; owner_id: string; created_at: string }>
  subscriptions: Record<string, { workspace_id: string; plan: string; status: string; seat_limit: number; current_period_end: string | null; trial_ends_at: string | null }>
  memberships: Record<string, { user_id: string; email: string; display_name: string; role: string; is_active: boolean }[]>
  integrations: Row[]
  logs: Row[]
  audit: Row[]
  requests: MasterRequest[]
  unexpected: string[]
  issuedTokens: string[]
  failInformation: boolean
  failDeletion: boolean
  failIntegration: boolean
  failOptions: boolean
  deletionWait: Promise<void> | null
  delayedOptions: Map<string, Promise<void>>
}

export function createMasterState(): MasterState {
  const profile = createProfileState()
  const workspaces = Object.fromEntries([masterWorkspaceA, masterWorkspaceB].map(id => [id,
    { id, name: profile.workspaceNames[id], business_contact_email: id === masterWorkspaceA ? 'comercial@aurora.example.invalid' : 'comercial@outra.example.invalid',
      owner_id: profileUserIds.admin, created_at: now }]))
  const subscriptions = Object.fromEntries([masterWorkspaceA, masterWorkspaceB].map(workspace_id => [workspace_id,
    { workspace_id, plan: 'team', status: 'active', seat_limit: 10, current_period_end: null, trial_ends_at: null }]))
  const memberships = Object.fromEntries([masterWorkspaceA, masterWorkspaceB].map(workspace_id => [workspace_id,
    Object.entries(profileUserIds).filter(([memberRole]) => memberRole !== 'platform').map(([memberRole, user_id]) => ({ user_id, email: profileEmail(memberRole as ProfileRole), display_name: profile.names[user_id], role: memberRole, is_active: true }))]))
  return { profile, workspaces, subscriptions, memberships, integrations: [], logs: [], requests: [], unexpected: [], issuedTokens: [],
    audit: [{ id: '1', workspace_id: masterWorkspaceA, action: 'subscription.updated', actor_id: profileUserIds.platform, details: { plan: 'team', status: 'active', seat_limit: 10 }, created_at: now }],
    failInformation: false, failDeletion: false, failIntegration: false, failOptions: false, deletionWait: null, delayedOptions: new Map() }
}

export function seedMasterIntegration(state: MasterState, workspaceId = masterWorkspaceA, name = 'Respondi → Make') {
  const stage = defaultStageRows(workspaceId).find(row => row.active && row.type === 'NORMAL')!
  const row: Row = { id: randomUUID(), workspace_id: workspaceId, name, active: true, archived_at: null, source: 'Respondi',
    stage_id: stage.id, stage_name: stage.name, owner_id: profileUserIds.closer, owner_name: state.profile.names[profileUserIds.closer],
    field_mapping: { name: 'nome', email: 'email', phone: 'whatsapp', company: 'empresa', ticket: 'ticket', source: 'origem', notes: 'observacoes' },
    created_by: profileUserIds.admin, created_at: now, updated_at: now, last_received_at: now, created_count: 5, duplicate_count: 2, error_count: 1 }
  state.integrations.push(row)
  state.logs.push({ id: String(state.logs.length + 1), workspace_id: workspaceId, integration_id: row.id, request_id: randomUUID(), status: 'rejected', error_code: 'NAME_REQUIRED', created_at: now })
  return row
}

// This fixture checks rendered components, scope switching, and real SDK request
// contracts. It does not prove PostgreSQL authorization; separate SQL tests do.
// A Master session has no memberships and no successful operational endpoints.
export async function mountMaster(page: Page, options: { state?: MasterState; role?: ProfileRole; theme?: 'light' | 'dark' } = {}) {
  const role = options.role || 'platform', state = options.state || createMasterState()
  await mountProfile(page, role, { state: state.profile, theme: options.theme })
  await page.route('https://test.supabase.co/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname
    let body: Row | null = null
    try { body = request.postDataJSON() } catch { /* Read request. */ }
    if (!path.startsWith('/rest/v1/rpc/')) { await route.fallback(); return }
    const rpc = path.split('/').at(-1)!
    const handled = rpc.startsWith('platform_') || ['list_platform_workspaces', 'list_members', 'list_invitations', 'list_audit', 'admin_update_subscription', 'update_member', 'revoke_invitation'].includes(rpc)
    if (!handled) {
      if (role === 'platform' && /lead|call|pipeline|activity|export_workspace/.test(rpc)) {
        state.unexpected.push(`Operational request from Master: ${rpc}`)
        await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Master sem acesso operacional.' }) }); return
      }
      await route.fallback(); return
    }
    state.requests.push({ path, method: request.method(), body, authenticated: /^Bearer .+/.test(request.headers().authorization || '') })
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(value) })
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } }); return }
    if (role !== 'platform' && (rpc.startsWith('platform_') || rpc === 'list_platform_workspaces')) {
      state.unexpected.push(`Master request from ${role}: ${rpc}`); await json({ message: 'Apenas Master pode executar esta operação.' }, 403); return
    }
    const workspaceId = String(body?.p_workspace_id || '')
    const workspace = state.workspaces[workspaceId]
    if (rpc === 'list_platform_workspaces') {
      await json(Object.values(state.workspaces).map(row => ({ ...row, subscription: state.subscriptions[row.id], member_count: state.memberships[row.id].filter(member => member.is_active).length, admin_email: profileEmail('admin') }))); return
    }
    if (!workspace) { await json({ message: 'Empresa não encontrada.' }, 404); return }
    if (rpc === 'list_members') { await json(state.memberships[workspaceId]); return }
    if (rpc === 'update_member') {
      const member = state.memberships[workspaceId].find(row => row.user_id === body?.p_user_id)
      if (!member || member.user_id === workspace.owner_id) { await json({ message: 'O responsável deve continuar como administrador ativo.' }, 403); return }
      member.role = String(body?.p_role); member.is_active = body?.p_is_active === true
      await json(null); return
    }
    if (rpc === 'list_invitations') { await json([]); return }
    if (rpc === 'platform_list_administrative_audit' || rpc === 'list_audit') { await json(state.audit.filter(row => row.workspace_id === workspaceId)); return }
    if (rpc === 'platform_update_workspace_information') {
      if (state.failInformation) { await json({ message: 'Não foi possível salvar as informações. Tente novamente.' }, 503); return }
      Object.assign(workspace, { name: String(body?.p_name), business_contact_email: String(body?.p_business_contact_email) })
      state.profile.workspaceNames[workspaceId] = workspace.name
      await json(null); return
    }
    if (rpc === 'admin_update_subscription') {
      Object.assign(state.subscriptions[workspaceId], { plan: body?.p_plan, status: body?.p_status, seat_limit: body?.p_seat_limit, current_period_end: body?.p_current_period_end, trial_ends_at: body?.p_trial_ends_at }); await json(null); return
    }
    if (rpc === 'platform_delete_workspace') {
      if (state.deletionWait) await state.deletionWait
      if (state.failDeletion) { await json({ message: 'A empresa está em atualização. Tente novamente.' }, 409); return }
      if (body?.p_confirmation !== workspace.name || body.p_irreversible_confirmed !== true || body.p_authorization_confirmed !== true || String(body.p_reason || '').trim().length < 10 || String(body.p_reason || '').trim().length > 500) {
        await json({ message: 'Confirme a empresa, autorização e ação irreversível; informe o motivo.' }, 400); return
      }
      delete state.workspaces[workspaceId]
      await json(null); return
    }
    if (rpc === 'platform_inbound_options') {
      if (state.failOptions) { await json({ message: 'As opções estão temporariamente indisponíveis.' }, 503); return }
      const value = { stages: defaultStageRows(workspaceId).filter(row => row.active && row.type === 'NORMAL').map(row => ({ id: row.id, name: row.name })),
        owners: ['admin', 'manager', 'closer'].map(memberRole => ({ user_id: profileUserIds[memberRole as ProfileRole], display_name: state.profile.names[profileUserIds[memberRole as ProfileRole]] })) }
      if (state.delayedOptions.has(workspaceId)) await state.delayedOptions.get(workspaceId)
      await json(value); return
    }
    const integrationId = String(body?.p_integration_id || '')
    if (rpc === 'platform_list_inbound_integrations') { await json(state.integrations.filter(row => row.workspace_id === workspaceId)); return }
    if (rpc === 'platform_list_inbound_integration_logs') {
      await json({ items: state.logs.filter(row => row.workspace_id === workspaceId && row.integration_id === integrationId), next_cursor: null }); return
    }
    if (rpc === 'platform_create_inbound_integration') {
      if (state.failIntegration) { await json({ message: 'Não foi possível criar a integração.' }, 503); return }
      const row = seedMasterIntegration(state, workspaceId, String(body?.p_name))
      const stage = defaultStageRows(workspaceId).find(row => row.id === body?.p_stage_id)
      Object.assign(row, { source: body?.p_source, stage_id: body?.p_stage_id, stage_name: stage?.name, owner_id: body?.p_owner_id, owner_name: state.profile.names[String(body?.p_owner_id)], field_mapping: body?.p_field_mapping })
      const token = randomBytes(32).toString('hex'); state.issuedTokens.push(token)
      await json({ integration: row, token }); return
    }
    const integration = state.integrations.find(row => row.id === integrationId && row.workspace_id === workspaceId)
    if (rpc.includes('inbound_') && !integration) { await json({ message: 'Integração não encontrada.' }, 404); return }
    if (rpc === 'platform_update_inbound_integration') {
      if (state.failIntegration) { await json({ message: 'Não foi possível salvar a configuração.' }, 503); return }
      const stage = defaultStageRows(workspaceId).find(row => row.id === body?.p_stage_id)
      Object.assign(integration!, { name: body?.p_name, source: body?.p_source, stage_id: body?.p_stage_id, stage_name: stage?.name, owner_id: body?.p_owner_id, owner_name: state.profile.names[String(body?.p_owner_id)], field_mapping: body?.p_field_mapping })
      await json(integration); return
    }
    if (rpc === 'platform_rotate_inbound_integration_token') {
      const token = randomBytes(32).toString('hex'); state.issuedTokens.push(token)
      await json({ integration, token }); return
    }
    if (rpc === 'platform_set_inbound_integration_active') { integration!.active = body?.p_active === true; await json(integration); return }
    if (rpc === 'platform_archive_inbound_integration') { integration!.active = false; integration!.archived_at = now; await json(integration); return }
    state.unexpected.push(`Unmodeled Master action: ${rpc}`)
    await json({ message: 'Unsupported fixture operation.' }, 500)
  })
  await page.route('**/api/inbound-leads**', async route => { state.unexpected.push('Master attempted a lead webhook POST'); await route.abort() })
  await page.reload()
  await expect(page.getByRole('heading', { name: role === 'platform' ? 'Clientes da plataforma' : 'Visão geral.', exact: true })).toBeVisible()
  return state
}

export async function openMasterCompany(page: Page, name = 'Aurora Comercial') {
  await page.getByRole('row').filter({ hasText: name }).getByRole('button', { name: /Administrar/ }).click()
  await expect(page.getByRole('tab', { name: 'Informações', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Informações', exact: true }).click()
}

export function masterRequests(state: MasterState, rpc: string) { return state.requests.filter(row => row.path.endsWith(`/${rpc}`)) }
export function assertMasterClean(state: MasterState) {
  expect(state.unexpected).toEqual([])
  expect(state.profile.unexpected).toEqual([])
  expect(state.profile.errors).toEqual([])
  for (const request of state.requests.filter(row => row.method === 'POST')) expect(request.authenticated).toBe(true)
}
