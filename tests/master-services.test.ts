import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { administrationService } from '../src/lib/access'
import { platformInboundIntegrationService } from '../src/lib/inbound-integrations'

const mock = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ requireSupabase: () => ({ rpc: mock.rpc }), applicationUrl: () => 'https://crm.example.com/' }))
const ws = '10000000-0000-4000-8000-000000000001', integrationId = '20000000-0000-4000-8000-000000000002'
const owner = '30000000-0000-4000-8000-000000000003', stage = '40000000-0000-4000-8000-000000000004'
const requestId = '50000000-0000-4000-8000-000000000005', token = 'a'.repeat(64)
const input = { name: 'Formulário', source: 'Site', stageId: stage, ownerId: owner, fieldMapping: { name: 'nome' } }
const row = { id: integrationId, workspace_id: ws, name: input.name, source: input.source, active: true, archived_at: null, stage_id: stage, stage_name: 'Novo', owner_id: owner, owner_name: 'Responsável', field_mapping: input.fieldMapping, created_by: owner, created_at: '2026-10-12T12:00:00Z', updated_at: '2026-10-12T12:00:00Z', last_received_at: null, created_count: 0, duplicate_count: 0, error_count: 0 }
beforeEach(() => { mock.rpc.mockReset(); vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => vi.unstubAllGlobals())

describe('explicit Master administrative adapters', () => {
  it('updates institutional contact without an auth email or profile write', async () => {
    mock.rpc.mockResolvedValue({ data: null, error: null })
    await administrationService.updateWorkspaceInformation(ws, { name: ' Empresa ', businessContactEmail: ' CONTATO@Example.com ' })
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('platform_update_workspace_information', { p_workspace_id: ws, p_name: 'Empresa', p_business_contact_email: 'contato@example.com' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('validates institutional input before invoking a protected RPC', async () => {
    await expect(administrationService.updateWorkspaceInformation(ws, { name: 'Empresa', businessContactEmail: 'invalid' })).rejects.toThrow('comercial')
    await expect(administrationService.updateWorkspaceInformation(ws, { name: 'Minha\nEmpresa', businessContactEmail: '' })).rejects.toThrow('válido')
    expect(mock.rpc).not.toHaveBeenCalled()
  })
  it.each([{ irreversibleConfirmed: false }, { authorizationConfirmed: false }, { reason: 'curto' }])('blocks incomplete deletion confirmation %j', async override => {
    await expect(administrationService.deletePlatformWorkspace(ws, { confirmation: 'Empresa', irreversibleConfirmed: true, authorizationConfirmed: true, reason: 'Encerramento autorizado da conta', ...override })).rejects.toThrow('Confirme')
    expect(mock.rpc).not.toHaveBeenCalled()
  })
  it('sends the exact typed name and explicit authorization to protected deletion', async () => {
    mock.rpc.mockResolvedValue({ data: null, error: null })
    await administrationService.deletePlatformWorkspace(ws, { confirmation: ' Empresa ', irreversibleConfirmed: true, authorizationConfirmed: true, reason: ' Encerramento autorizado da conta ' })
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('platform_delete_workspace', { p_workspace_id: ws, p_confirmation: ' Empresa ', p_irreversible_confirmed: true, p_authorization_confirmed: true, p_reason: 'Encerramento autorizado da conta' })
  })
  it('reads only the dedicated projected administrative audit', async () => {
    mock.rpc.mockResolvedValue({ data: [{ id: 'event', action: 'invitation.created', created_at: row.created_at, actor_id: owner, details: { lead_id: 'private-lead', payload: 'private' } }], error: null })
    const rows = await administrationService.listAdministrativeAudit(ws)
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('platform_list_administrative_audit', { p_workspace_id: ws })
    expect(JSON.stringify(rows)).not.toContain('private')
  })
  it('gets minimal stage and owner metadata without operational RPCs or profile emails', async () => {
    mock.rpc.mockResolvedValue({ data: { stages: [{ id: stage, name: 'Novo', lead_count: 99 }], owners: [{ user_id: owner, display_name: 'Responsável', email: 'private@example.com' }] }, error: null })
    const options = await platformInboundIntegrationService.listAdministrativeOptions!(ws)
    expect(options).toEqual({ stages: [{ id: stage, name: 'Novo' }], owners: [{ userId: owner, displayName: 'Responsável' }] })
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('platform_inbound_options', { p_workspace_id: ws })
  })
  it('rejects unexpected options rather than silently enabling invalid configurations', async () => {
    mock.rpc.mockResolvedValue({ data: { stages: [{ id: 'invalid', name: 'Novo' }], owners: [] }, error: null })
    await expect(platformInboundIntegrationService.listAdministrativeOptions!(ws)).rejects.toThrow('confirmar')
  })
  it('uses only explicit Master RPCs for every integration configuration operation', async () => {
    mock.rpc.mockImplementation(async (name: string) => ({ data: name.includes('create_') || name.includes('rotate_') ? { integration: row, token } : name.includes('list_') ? [row] : row, error: null }))
    await platformInboundIntegrationService.list(ws)
    await platformInboundIntegrationService.create(ws, input)
    await platformInboundIntegrationService.update(ws, integrationId, input)
    await platformInboundIntegrationService.setActive(ws, integrationId, false)
    await platformInboundIntegrationService.rotate(ws, integrationId)
    await platformInboundIntegrationService.archive(ws, integrationId)
    expect(mock.rpc.mock.calls.map(call => call[0])).toEqual(['platform_list_inbound_integrations', 'platform_create_inbound_integration', 'platform_update_inbound_integration', 'platform_set_inbound_integration_active', 'platform_rotate_inbound_integration_token', 'platform_archive_inbound_integration'])
    expect(fetch).not.toHaveBeenCalled()
  })
  it('excludes secrets from list DTOs and returns a credential only when created or rotated', async () => {
    mock.rpc.mockResolvedValue({ data: [{ ...row, token, token_hash: 'private-hash' }], error: null })
    const list = await platformInboundIntegrationService.list(ws)
    expect(JSON.stringify(list)).not.toContain(token)
    expect(JSON.stringify(list)).not.toContain('private-hash')
    mock.rpc.mockResolvedValue({ data: { integration: row, token }, error: null })
    expect((await platformInboundIntegrationService.rotate(ws, integrationId)).token).toBe(token)
  })
  it('defensively strips lead references, contacts, payloads and credentials from diagnostics', async () => {
    mock.rpc.mockResolvedValue({ data: { items: [{ id: '7', workspace_id: ws, integration_id: integrationId, request_id: requestId, status: 'created', lead_id: 'private-lead', duplicate_lead_id: 'private-duplicate', payload: { email: 'private@example.com' }, token, error_code: null, created_at: row.created_at }], next_cursor: null }, error: null })
    const page = await platformInboundIntegrationService.listLogs(ws, integrationId)
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('platform_list_inbound_integration_logs', { p_workspace_id: ws, p_integration_id: integrationId, p_before_id: null, p_limit: 30 })
    expect(JSON.stringify(page)).not.toContain('private')
    expect(JSON.stringify(page)).not.toContain(token)
  })
  it('has no operational stage-list or live lead test fallback', async () => {
    await expect(platformInboundIntegrationService.listStages(ws)).rejects.toThrow('administrativas')
    await expect(platformInboundIntegrationService.testWebhook(`https://crm.example.com/api/inbound-leads?token=${token}`, { name: 'Lead' })).rejects.toThrow('operação')
    expect(mock.rpc).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
  it('propagates backend denial with no privileged fallback', async () => {
    const error = { code: '42501', message: 'Acesso Master não autorizado' }
    mock.rpc.mockResolvedValue({ data: null, error })
    await expect(platformInboundIntegrationService.create(ws, input)).rejects.toEqual(error)
    expect(mock.rpc).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })
})
