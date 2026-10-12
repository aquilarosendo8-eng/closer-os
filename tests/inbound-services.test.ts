import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkedInboundMapping, inboundIntegrationService } from '../src/lib/inbound-integrations'

const mock = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ requireSupabase: () => ({ rpc: mock.rpc }), applicationUrl: () => 'https://crm.example.com/' }))
const ws = '10000000-0000-4000-8000-000000000001'
const integrationId = '20000000-0000-4000-8000-000000000002'
const owner = '30000000-0000-4000-8000-000000000003'
const stage = '40000000-0000-4000-8000-000000000004'
const requestId = '50000000-0000-4000-8000-000000000005'
const token = 'a'.repeat(64)
const input = { name: ' Formulário Site ', source: ' Landing Page ', stageId: stage, ownerId: owner, fieldMapping: { name: ' full_name ', email: 'email_address' } }
const row = { id: integrationId, workspace_id: ws, name: 'Formulário Site', source: 'Landing Page', active: true, archived_at: null, stage_id: stage, stage_name: 'Lead novo', owner_id: owner, owner_name: 'João', field_mapping: { name: 'full_name', email: 'email_address' }, created_by: owner, created_at: '2026-10-12T12:00:00Z', updated_at: '2026-10-12T12:00:00Z', last_received_at: null, created_count: 0, duplicate_count: 0, error_count: 0 }
beforeEach(() => { mock.rpc.mockReset(); vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => vi.unstubAllGlobals())

describe('workspace integration administration adapter', () => {
  it('creates using only the selected workspace and validated configuration', async () => {
    mock.rpc.mockResolvedValue({ data: { integration: row, token }, error: null })
    const result = await inboundIntegrationService.create(ws, { ...input, workspaceId: 'untrusted', role: 'platform_admin' } as typeof input)
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('create_inbound_integration', { p_workspace_id: ws, p_name: 'Formulário Site', p_source: 'Landing Page', p_stage_id: stage, p_owner_id: owner, p_field_mapping: { name: 'full_name', email: 'email_address' } })
    expect(result.webhookUrl).toBe(`https://crm.example.com/api/inbound-leads?token=${token}`)
    expect(result.token).toBe(token)
  })
  it('keeps credentials out of list DTOs even if the provider includes extra fields', async () => {
    mock.rpc.mockResolvedValue({ data: [{ ...row, token_hash: 'private-hash', token }], error: null })
    const result = await inboundIntegrationService.list(ws)
    expect(result[0]).toMatchObject({ id: integrationId, workspaceId: ws, fieldMapping: row.field_mapping })
    expect(JSON.stringify(result)).not.toContain(token)
    expect(JSON.stringify(result)).not.toContain('private-hash')
  })
  it('rejects an unexpected tenant response rather than displaying another company configuration', async () => {
    mock.rpc.mockResolvedValue({ data: [{ ...row, workspace_id: owner }], error: null })
    await expect(inboundIntegrationService.list(ws)).rejects.toThrow('confirmar')
  })
  it('rotates only the explicitly selected integration and returns a one-time credential', async () => {
    mock.rpc.mockResolvedValue({ data: { integration: row, token }, error: null })
    await expect(inboundIntegrationService.rotate(ws, integrationId)).resolves.toMatchObject({ token })
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('rotate_inbound_integration_token', { p_workspace_id: ws, p_integration_id: integrationId })
  })
  it('propagates server role refusals without an alternative privileged write path', async () => {
    const error = { code: '42501', message: 'Administrador ativo necessário' }
    mock.rpc.mockResolvedValue({ data: null, error })
    await expect(inboundIntegrationService.setActive(ws, integrationId, false)).rejects.toEqual(error)
    expect(fetch).not.toHaveBeenCalled()
    expect(mock.rpc).toHaveBeenCalledTimes(1)
  })
  it('offers only active NORMAL stages while leaving terminal and inactive stages out', async () => {
    mock.rpc.mockResolvedValue({ data: ['NORMAL', 'WON', 'LOST'].map(type => ({ id: stage, pipeline_id: integrationId, name: type, type, active: true, position: 0, color: '#234567' })).concat([{ id: stage, pipeline_id: integrationId, name: 'Inactive', type: 'NORMAL', active: false, position: 1, color: '#234567' }]), error: null })
    expect(await inboundIntegrationService.listStages(ws)).toHaveLength(1)
  })
  it('reads operational logs through a bounded scoped cursor without raw provider fields', async () => {
    mock.rpc.mockResolvedValue({ data: { items: [{ id: '9', workspace_id: ws, integration_id: integrationId, request_id: requestId, status: 'created', lead_id: 'lead-legacy', duplicate_lead_id: null, error_code: null, created_at: row.created_at, authorization: token, payload: { email: 'private@example.com' } }], next_cursor: null }, error: null })
    const page = await inboundIntegrationService.listLogs(ws, integrationId)
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('list_inbound_integration_logs', { p_workspace_id: ws, p_integration_id: integrationId, p_before_id: null, p_limit: 30 })
    expect(page.items[0].leadId).toBe('lead-legacy')
    expect(JSON.stringify(page)).not.toContain(token)
    expect(JSON.stringify(page)).not.toContain('private@example.com')
  })
  it.each([{}, { email: 'email' }, { name: '__proto__' }, { name: 'constructor' }, { name: 'prototype' }, { name: 'name\n' }, { name: 'x'.repeat(121) }, { name: 'name', workspaceId: 'workspace' }])('rejects invalid mapping %j before writes', async mapping => {
    expect(() => checkedInboundMapping(mapping)).toThrow()
    await expect(inboundIntegrationService.create(ws, { ...input, fieldMapping: mapping })).rejects.toThrow()
    expect(mock.rpc).not.toHaveBeenCalled()
  })
})

describe('real webhook test client', () => {
  it('sends a POST to the production handler, without session credentials or referrer', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ status: 'duplicate', leadId: 'legacy:lead-1', requestId }) } as Response)
    await expect(inboundIntegrationService.testWebhook(`https://crm.example.com/api/inbound-leads?token=${token}`, { full_name: 'João' })).resolves.toEqual({ status: 'duplicate', leadId: 'legacy:lead-1', requestId })
    expect(fetch).toHaveBeenCalledWith(`https://crm.example.com/api/inbound-leads?token=${token}`, expect.objectContaining({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', body: '{"full_name":"João"}' }))
    expect(mock.rpc).not.toHaveBeenCalled()
  })
  it.each([`https://other.example.com/api/inbound-leads?token=${token}`, `https://crm.example.com/api/invitations?token=${token}`, `https://crm.example.com/api/inbound-leads?token=${token}&token=${token}`, `https://crm.example.com/api/inbound-leads?token=${token}#secret`])('never sends credentials to an unexpected URL', async url => {
    await expect(inboundIntegrationService.testWebhook(url, {})).rejects.toThrow('URL')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('reports an actual rejection instead of claiming a test lead was created', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, json: async () => ({ error: { message: 'Nome obrigatório' } }) } as Response)
    await expect(inboundIntegrationService.testWebhook(`https://crm.example.com/api/inbound-leads?token=${token}`, {})).rejects.toThrow('Nome obrigatório')
  })
})
