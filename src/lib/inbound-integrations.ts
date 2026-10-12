import type { Stage } from '../types'
import { applicationUrl, requireSupabase } from './supabase'
import { INBOUND_FIELDS, type InboundAdministrativeOptions, type InboundCredentialResult, type InboundFieldMapping, type InboundIntegration, type InboundIntegrationInput, type InboundIntegrationLog, type InboundIntegrationService, type InboundLogPage } from './inbound-types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN = /^[a-f0-9]{64}$/
const forbiddenProperties = new Set(['__proto__', 'constructor', 'prototype'])
type Row = Record<string, unknown>
const invalidResponse = () => new Error('Não foi possível confirmar os dados da integração. Atualize a lista antes de tentar novamente.')
const object = (value: unknown): value is Row => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const assertId = (value: string) => { if (!UUID.test(value)) throw new Error('Selecione uma integração e uma empresa válidas.') }
const nullableText = (value: unknown) => typeof value === 'string' ? value : null
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))

export function checkedInboundMapping(input: unknown): InboundFieldMapping {
  if (!object(input) || Object.keys(input).some(field => !INBOUND_FIELDS.includes(field as typeof INBOUND_FIELDS[number]))) throw new Error('Mapeie somente os campos permitidos para a integração.')
  const mapping: InboundFieldMapping = {}
  for (const field of INBOUND_FIELDS) {
    if (!Object.hasOwn(input, field)) continue
    const value = input[field]
    if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 120 || /[\u0000-\u001f\u007f-\u009f]/u.test(value) || forbiddenProperties.has(value.trim())) throw new Error('Informe nomes válidos das propriedades recebidas, com até 120 caracteres.')
    mapping[field] = value.trim()
  }
  if (!mapping.name) throw new Error('O mapeamento de Nome é obrigatório.')
  return mapping
}

function checkedInput(input: InboundIntegrationInput): Record<string, unknown> {
  const name = input.name.trim(), source = input.source.trim()
  if (name.length < 2 || name.length > 120 || !source || source.length > 120 || /[\u0000-\u001f\u007f-\u009f]/u.test(name + source)) throw new Error('Informe nome e origem válidos para a integração.')
  assertId(input.stageId); assertId(input.ownerId)
  return { p_name: name, p_source: source, p_stage_id: input.stageId, p_owner_id: input.ownerId, p_field_mapping: checkedInboundMapping(input.fieldMapping) }
}

function integration(value: unknown, workspaceId: string): InboundIntegration {
  if (!object(value) || typeof value.id !== 'string' || !UUID.test(value.id) || value.workspace_id !== workspaceId || typeof value.name !== 'string' || typeof value.source !== 'string' || typeof value.active !== 'boolean'
    || !timestamp(value.created_at) || !timestamp(value.updated_at) || [value.created_count, value.duplicate_count, value.error_count].some(count => !Number.isSafeInteger(Number(count)) || Number(count) < 0)) throw invalidResponse()
  for (const key of ['stage_id', 'owner_id', 'created_by']) if (value[key] !== null && (typeof value[key] !== 'string' || !UUID.test(value[key]))) throw invalidResponse()
  for (const key of ['archived_at', 'last_received_at']) if (value[key] !== null && !timestamp(value[key])) throw invalidResponse()
  // Explicit DTO selection excludes token hashes and unexpected server fields.
  return { id: value.id, workspaceId, name: value.name, active: value.active, archivedAt: nullableText(value.archived_at), source: value.source,
    stageId: nullableText(value.stage_id), stageName: nullableText(value.stage_name), ownerId: nullableText(value.owner_id), ownerName: nullableText(value.owner_name),
    fieldMapping: checkedInboundMapping(value.field_mapping), createdBy: nullableText(value.created_by), createdAt: value.created_at, updatedAt: value.updated_at,
    lastReceivedAt: nullableText(value.last_received_at), createdCount: Number(value.created_count), duplicateCount: Number(value.duplicate_count), errorCount: Number(value.error_count) }
}

function credential(value: unknown, workspaceId: string): InboundCredentialResult {
  if (!object(value) || typeof value.token !== 'string' || !TOKEN.test(value.token)) throw invalidResponse()
  const webhook = new URL('/api/inbound-leads', applicationUrl())
  webhook.searchParams.set('token', value.token)
  return { integration: integration(value.integration, workspaceId), token: value.token, webhookUrl: webhook.toString() }
}

async function rpc(name: string, params: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await requireSupabase().rpc(name, params)
  if (error) throw error
  return data
}

async function administrativeOptions(workspaceId: string): Promise<InboundAdministrativeOptions> {
  assertId(workspaceId)
  const result = await rpc('platform_inbound_options', { p_workspace_id: workspaceId })
  if (!object(result) || !Array.isArray(result.stages) || !Array.isArray(result.owners)) throw invalidResponse()
  const stages = result.stages.map(value => {
    if (!object(value) || typeof value.id !== 'string' || !UUID.test(value.id) || typeof value.name !== 'string') throw invalidResponse()
    return { id: value.id, name: value.name }
  })
  const owners = result.owners.map(value => {
    if (!object(value) || typeof value.user_id !== 'string' || !UUID.test(value.user_id) || typeof value.display_name !== 'string') throw invalidResponse()
    return { userId: value.user_id, displayName: value.display_name }
  })
  return { stages, owners }
}

function integrationService(platform: boolean): InboundIntegrationService {
 const call = (name: string, params: Record<string, unknown>) => rpc(platform ? `platform_${name}` : name, params)
 return {
  async list(workspaceId) {
    assertId(workspaceId)
    const rows = await call('list_inbound_integrations', { p_workspace_id: workspaceId })
    if (!Array.isArray(rows)) throw invalidResponse()
    return rows.map(row => integration(row, workspaceId))
  },
  async listStages(workspaceId) {
    if (platform) throw new Error('Use as opções administrativas de etapas e responsáveis.')
    assertId(workspaceId)
    const rows = await rpc('list_pipeline_stages', { p_workspace_id: workspaceId })
    if (!Array.isArray(rows)) throw invalidResponse()
    return rows.filter(row => object(row) && row.active === true && row.type === 'NORMAL').map(row => {
      if (!UUID.test(row.id) || !UUID.test(row.pipeline_id) || typeof row.name !== 'string' || !Number.isInteger(row.position) || typeof row.color !== 'string') throw invalidResponse()
      return { id: row.id, pipelineId: row.pipeline_id, name: row.name, position: row.position, color: row.color, type: 'NORMAL', active: true } as Stage
    })
  },
  async listLogs(workspaceId, integrationId, beforeId) {
    assertId(workspaceId); assertId(integrationId)
    if (beforeId !== undefined && !/^[1-9][0-9]*$/.test(beforeId)) throw new Error('Atualize os recebimentos antes de continuar.')
    const page = await call('list_inbound_integration_logs', { p_workspace_id: workspaceId, p_integration_id: integrationId, p_before_id: beforeId || null, p_limit: 30 })
    if (!object(page) || !Array.isArray(page.items) || (page.next_cursor !== null && !/^[1-9][0-9]*$/.test(String(page.next_cursor)))) throw invalidResponse()
    const items: InboundIntegrationLog[] = page.items.map(value => {
      if (!object(value) || !/^[1-9][0-9]*$/.test(String(value.id)) || value.workspace_id !== workspaceId || value.integration_id !== integrationId || typeof value.request_id !== 'string' || !UUID.test(value.request_id)
        || !['created', 'duplicate', 'rejected', 'error'].includes(String(value.status)) || !timestamp(value.created_at)) throw invalidResponse()
      return { id: String(value.id), workspaceId, integrationId, requestId: value.request_id, status: value.status as InboundIntegrationLog['status'],
        leadId: platform ? null : nullableText(value.lead_id), duplicateLeadId: platform ? null : nullableText(value.duplicate_lead_id), errorCode: nullableText(value.error_code), createdAt: value.created_at }
    })
    return { items, nextCursor: page.next_cursor === null ? null : String(page.next_cursor) } as InboundLogPage
  },
  async create(workspaceId, input) {
    assertId(workspaceId)
    return credential(await call('create_inbound_integration', { p_workspace_id: workspaceId, ...checkedInput(input) }), workspaceId)
  },
  async update(workspaceId, integrationId, input) {
    assertId(workspaceId); assertId(integrationId)
    return integration(await call('update_inbound_integration', { p_workspace_id: workspaceId, p_integration_id: integrationId, ...checkedInput(input) }), workspaceId)
  },
  async setActive(workspaceId, integrationId, active) {
    assertId(workspaceId); assertId(integrationId)
    if (typeof active !== 'boolean') throw new Error('Selecione uma situação válida para a integração.')
    return integration(await call('set_inbound_integration_active', { p_workspace_id: workspaceId, p_integration_id: integrationId, p_active: active }), workspaceId)
  },
  async rotate(workspaceId, integrationId) {
    assertId(workspaceId); assertId(integrationId)
    return credential(await call('rotate_inbound_integration_token', { p_workspace_id: workspaceId, p_integration_id: integrationId }), workspaceId)
  },
  async archive(workspaceId, integrationId) {
    assertId(workspaceId); assertId(integrationId)
    return integration(await call('archive_inbound_integration', { p_workspace_id: workspaceId, p_integration_id: integrationId }), workspaceId)
  },
  async testWebhook(value, payload) {
    if (platform) throw new Error('O teste que cria oportunidades está disponível somente à operação autorizada da empresa.')
    let destination: URL
    try { destination = new URL(value) } catch { throw new Error('Use a URL exibida ao criar ou redefinir a credencial.') }
    if (destination.origin !== new URL(applicationUrl()).origin || destination.pathname !== '/api/inbound-leads' || destination.username || destination.password || destination.hash
      || !TOKEN.test(destination.searchParams.get('token') || '') || [...destination.searchParams.keys()].some(key => key !== 'token') || destination.searchParams.getAll('token').length !== 1) throw new Error('Use a URL exibida ao criar ou redefinir a credencial.')
    if (!object(payload)) throw new Error('Envie um objeto JSON com os campos mapeados.')
    let body: string
    try { body = JSON.stringify(payload) } catch { throw new Error('Revise o JSON do teste.') }
    if (new TextEncoder().encode(body).byteLength > 65536) throw new Error('O JSON do teste deve ter no máximo 64 KB.')
    const response = await fetch(destination.toString(), { method: 'POST', headers: { 'content-type': 'application/json' }, body, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: AbortSignal.timeout(30000) })
    const result = await response.json().catch(() => null)
    if (!response.ok) throw new Error(object(result) && object(result.error) && typeof result.error.message === 'string' ? result.error.message : 'Não foi possível receber o lead de teste. Confira os recebimentos antes de reenviar.')
    if (!object(result) || !['created', 'duplicate'].includes(String(result.status)) || typeof result.leadId !== 'string' || !result.leadId || typeof result.requestId !== 'string' || !UUID.test(result.requestId)) throw new Error('Não recebemos a confirmação do teste. Confira os recebimentos antes de reenviar.')
    return { status: result.status as 'created' | 'duplicate', leadId: result.leadId, requestId: result.requestId }
  },
  ...(platform ? { listAdministrativeOptions: administrativeOptions } : {}),
 }
}

export const inboundIntegrationService = integrationService(false)
/** Explicit administrative RPCs: no membership, lead lookups, or webhook ingestion. */
export const platformInboundIntegrationService = integrationService(true)
