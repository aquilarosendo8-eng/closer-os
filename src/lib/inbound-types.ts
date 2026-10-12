import type { Stage } from '../types'

export const INBOUND_FIELDS = ['name', 'email', 'phone', 'company', 'ticket', 'source', 'notes'] as const
export type InboundField = typeof INBOUND_FIELDS[number]
export type InboundFieldMapping = Partial<Record<InboundField, string>>
export const INBOUND_FIELD_LABELS: Record<InboundField, string> = {
  name: 'Nome', email: 'E-mail', phone: 'Telefone / WhatsApp', company: 'Empresa',
  ticket: 'Ticket estimado', source: 'Origem', notes: 'Observações',
}

export interface InboundIntegration {
  id: string
  workspaceId: string
  name: string
  active: boolean
  archivedAt: string | null
  source: string
  stageId: string | null
  stageName: string | null
  ownerId: string | null
  ownerName: string | null
  fieldMapping: InboundFieldMapping
  createdBy: string | null
  createdAt: string
  updatedAt: string
  lastReceivedAt: string | null
  createdCount: number
  duplicateCount: number
  errorCount: number
}

export interface InboundIntegrationInput {
  name: string
  source: string
  stageId: string
  ownerId: string
  fieldMapping: InboundFieldMapping
}

/** A one-time response. Never persist it in storage, a cached DTO, or Auth metadata. */
export interface InboundCredentialResult {
  integration: InboundIntegration
  token: string
  webhookUrl: string
}

export type InboundLogStatus = 'created' | 'duplicate' | 'rejected' | 'error'
export interface InboundIntegrationLog {
  id: string
  workspaceId: string
  integrationId: string
  requestId: string
  status: InboundLogStatus
  leadId: string | null
  duplicateLeadId: string | null
  errorCode: string | null
  createdAt: string
}
export interface InboundLogPage { items: InboundIntegrationLog[]; nextCursor: string | null }
export interface InboundWebhookResult { status: 'created' | 'duplicate'; leadId: string; requestId: string }
export interface InboundAdministrativeOptions { stages: Array<{ id: string; name: string }>; owners: Array<{ userId: string; displayName: string }> }
export interface InboundIntegrationService {
  list(workspaceId: string): Promise<InboundIntegration[]>
  listStages(workspaceId: string): Promise<Stage[]>
  listLogs(workspaceId: string, integrationId: string, beforeId?: string): Promise<InboundLogPage>
  create(workspaceId: string, input: InboundIntegrationInput): Promise<InboundCredentialResult>
  update(workspaceId: string, integrationId: string, input: InboundIntegrationInput): Promise<InboundIntegration>
  setActive(workspaceId: string, integrationId: string, active: boolean): Promise<InboundIntegration>
  rotate(workspaceId: string, integrationId: string): Promise<InboundCredentialResult>
  archive(workspaceId: string, integrationId: string): Promise<InboundIntegration>
  testWebhook(url: string, payload: unknown): Promise<InboundWebhookResult>
  listAdministrativeOptions?(workspaceId: string): Promise<InboundAdministrativeOptions>
}
