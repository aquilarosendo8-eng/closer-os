import { LOSS_REASONS, STATUSES, type Lead, type LeadershipReview, type LeadershipReviewInput, type Settings, type Stage } from '../types'

const textFields: (keyof Lead)[] = ['id', 'name', 'company', 'email', 'phone', 'source', 'createdAt', 'callDate', 'objection', 'closedAt', 'lastContactAt', 'notes', 'pain', 'closerError', 'callSummary']
const dateFields: (keyof Lead)[] = ['createdAt', 'callDate', 'closedAt', 'lastContactAt']
export function validRecordingUrl(input: unknown): input is string {
  if (typeof input !== 'string' || input.length > 4096) return false
  if (input === '') return true
  if (!/^https:\/\//i.test(input) || /[\s\\\u0000-\u001f\u007f-\u009f]/.test(input) || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(input)) return false
  try {
    const url = new URL(input)
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password
  } catch { return false }
}
/** Store the browser's canonical HTTPS URL while keeping invalid input available for correction. */
export function normalizeRecordingUrl(input: string): string {
  if (!validRecordingUrl(input)) throw new Error('Informe um link HTTPS válido, sem usuário ou senha na URL.')
  return input === '' ? '' : new URL(input).href
}
export function validReviewInput(input: unknown): input is LeadershipReviewInput {
  if (!input || typeof input !== 'object') return false
  const review = input as LeadershipReviewInput
  return typeof review.feedback === 'string' && !!review.feedback.trim() && review.feedback.length <= 10000
    && Number.isInteger(review.score) && review.score >= 0 && review.score <= 10
}
export function validLeadershipReview(input: unknown): input is LeadershipReview {
  if (!validReviewInput(input)) return false
  const review = input as LeadershipReview
  // A deleted profile leaves historical feedback intact; its server DTO uses an empty author identifier.
  return typeof review.reviewedBy === 'string'
    && typeof review.reviewerName === 'string'
    && typeof review.reviewedAt === 'string' && !!review.reviewedAt && Number.isFinite(new Date(review.reviewedAt).getTime())
}
export function validPipelineStages(input: unknown): input is Stage[] {
  if (!Array.isArray(input) || !input.length || input.length > 40) return false
  const ids = new Set<string>()
  for (const stage of input as Stage[]) {
    if (!stage || typeof stage !== 'object' || typeof stage.id !== 'string' || typeof stage.pipelineId !== 'string'
      || typeof stage.name !== 'string' || stage.name.trim().length < 2 || stage.name.trim().length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(stage.name)
      || typeof stage.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(stage.color)
      || !['NORMAL', 'WON', 'LOST'].includes(stage.type) || typeof stage.active !== 'boolean'
      || !Number.isInteger(stage.position) || stage.position < 0) return false
    if (stage.id && ids.has(stage.id)) return false
    if (stage.id) ids.add(stage.id)
  }
  return input.filter(stage => stage.active && stage.type === 'WON').length === 1
    && input.filter(stage => stage.active && stage.type === 'LOST').length === 1
}
const optionalText = (value: unknown, maxLength: number) => value === undefined || (typeof value === 'string' && value.length <= maxLength)
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
    && (lead.stageId === undefined || (typeof lead.stageId === 'string' && !!lead.stageId && lead.stageId.length <= 128))
    && (lead.stageType === undefined || ['NORMAL', 'WON', 'LOST'].includes(lead.stageType))
    && optionalText(lead.stageName, 100)
    && (lead.lossReason === undefined || lead.lossReason === '' || LOSS_REASONS.includes(lead.lossReason as typeof LOSS_REASONS[number]))
    && optionalText(lead.lossComment, 4000)
    && optionalText(lead.nextStep, 10000)
    && (lead.recordingUrl === undefined || validRecordingUrl(lead.recordingUrl))
    && (lead.leadershipReview === undefined || validLeadershipReview(lead.leadershipReview))
}
export function validSettings(input: unknown): input is Settings {
  if (!input || typeof input !== 'object') return false
  const settings = input as Settings
  return typeof settings.name === 'string' && !!settings.name.trim()
    && typeof settings.revenueGoal === 'number' && Number.isFinite(settings.revenueGoal) && settings.revenueGoal > 0
    && typeof settings.commissionRate === 'number' && Number.isFinite(settings.commissionRate) && settings.commissionRate >= 0 && settings.commissionRate <= 100
}
