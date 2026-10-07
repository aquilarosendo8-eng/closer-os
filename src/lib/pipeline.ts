import { STATUSES, type Lead, type LeadStatus, type Stage, type StageType } from '../types'

const stageColors = ['#afa3ce', '#9581c4', '#7194d6', '#d3a064', '#b67fc3', '#4e9e80', '#bf818a']

/** Stable identifiers are used only in the local demonstration. Cloud stages come from the database. */
export function defaultPipelineStages(): Stage[] {
  return STATUSES.map((name, position) => ({
    id: `demo-stage-${position}`, pipelineId: 'demo-main', name, position,
    color: stageColors[position], active: true,
    type: name === 'Fechado' ? 'WON' : name === 'Perdido' ? 'LOST' : 'NORMAL',
  }))
}

export function getLeadStageType(lead: Lead): StageType {
  return lead.stageType || (lead.status === 'Fechado' ? 'WON' : lead.status === 'Perdido' ? 'LOST' : 'NORMAL')
}
export const leadStageType = getLeadStageType
export const isWon = (lead: Lead) => getLeadStageType(lead) === 'WON'
export const isLost = (lead: Lead) => getLeadStageType(lead) === 'LOST'
export const getLeadStageName = (lead: Lead) => lead.stageName || lead.status

function legacyStatus(lead: Lead, stage: Stage): LeadStatus {
  if (stage.type === 'WON') return 'Fechado'
  if (stage.type === 'LOST') return 'Perdido'
  const named = STATUSES.find(status => status === stage.name && status !== 'Fechado' && status !== 'Perdido')
  if (named) return named
  return lead.status !== 'Fechado' && lead.status !== 'Perdido' ? lead.status : 'Follow-up'
}

/** Assign the stage's identity and type together, retaining the old status for compatible backups. */
export function stageLead(lead: Lead, stage: Stage): Lead {
  const status = legacyStatus(lead, stage)
  return {
    ...lead, stageId: stage.id, stageType: stage.type, stageName: stage.name, status,
    ...(stage.type === 'WON'
      ? { attendance: 'Compareceu' as const, closedAt: lead.closedAt || new Date().toISOString() }
      : { closedValue: 0, closedAt: '' }),
    ...(status === 'Compareceu' ? { attendance: 'Compareceu' as const } : {}),
  }
}

export function transitionLead(lead: Lead, stage: Stage, closedValue?: number, lossReason?: string, lossComment?: string): Lead {
  const next = stageLead(lead, stage)
  if (stage.type === 'WON' && closedValue !== undefined) next.closedValue = closedValue
  if (stage.type === 'LOST') {
    if (lossReason !== undefined) next.lossReason = lossReason
    if (lossComment !== undefined) next.lossComment = lossComment
  }
  return next
}

export function leadInStage(lead: Lead, stage: Stage): boolean {
  if (lead.stageId) return lead.stageId === stage.id
  if (getLeadStageType(lead) !== stage.type) return false
  return stage.type !== 'NORMAL' || getLeadStageName(lead) === stage.name
}

/** Compatibility mapping for old local data; this never resolves a foreign cloud stage identifier. */
export function normalizeLegacyLead(lead: Lead, stages: Stage[] = defaultPipelineStages()): Lead {
  const existing = lead.stageId ? stages.find(stage => stage.id === lead.stageId) : undefined
  const type = getLeadStageType(lead)
  const fallback = stages.find(stage => stage.type === type && stage.name === getLeadStageName(lead))
    || (type === 'NORMAL' ? stages.find(stage => stage.type === 'NORMAL' && stage.name === lead.status) : stages.find(stage => stage.type === type))
  const stage = existing || fallback
  return stage ? { ...lead, stageId: stage.id, stageType: stage.type, stageName: stage.name, status: legacyStatus(lead, stage) } : lead
}
