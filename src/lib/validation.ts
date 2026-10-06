import { STATUSES, type Lead, type Settings } from '../types'

const textFields: (keyof Lead)[] = ['id', 'name', 'company', 'email', 'phone', 'source', 'createdAt', 'callDate', 'objection', 'closedAt', 'lastContactAt', 'notes', 'pain', 'closerError', 'callSummary']
const dateFields: (keyof Lead)[] = ['createdAt', 'callDate', 'closedAt', 'lastContactAt']
export function validLead(input: unknown): input is Lead {
  if (!input || typeof input !== 'object') return false
  const lead = input as Lead
  return textFields.every(key => typeof lead[key] === 'string')
    && !!lead.id && !!lead.name.trim()
    && dateFields.every(key => lead[key] === '' || Number.isFinite(new Date(lead[key] as string).getTime()))
    && STATUSES.includes(lead.status)
    && ['Pendente', 'Compareceu', 'Não compareceu'].includes(lead.attendance)
    && ['Baixa', 'Média', 'Alta'].includes(lead.urgency)
    && ['Não avaliada', 'Baixa', 'Média', 'Alta'].includes(lead.financialCapacity)
    && typeof lead.decisionMaker === 'boolean'
    && typeof lead.ticket === 'number' && Number.isFinite(lead.ticket) && lead.ticket >= 0
    && typeof lead.closedValue === 'number' && Number.isFinite(lead.closedValue) && lead.closedValue >= 0
    && (lead.callScore === null || (typeof lead.callScore === 'number' && Number.isInteger(lead.callScore) && lead.callScore >= 0 && lead.callScore <= 10))
}
export function validSettings(input: unknown): input is Settings {
  if (!input || typeof input !== 'object') return false
  const settings = input as Settings
  return typeof settings.name === 'string' && !!settings.name.trim()
    && typeof settings.revenueGoal === 'number' && Number.isFinite(settings.revenueGoal) && settings.revenueGoal > 0
    && typeof settings.commissionRate === 'number' && Number.isFinite(settings.commissionRate) && settings.commissionRate >= 0 && settings.commissionRate <= 100
}
