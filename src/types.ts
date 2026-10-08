export const STATUSES = ['Lead novo', 'Qualificado', 'Call agendada', 'Compareceu', 'Follow-up', 'Fechado', 'Perdido'] as const
export type LeadStatus = typeof STATUSES[number]
export type Attendance = 'Pendente' | 'Compareceu' | 'Não compareceu'
export type StageType = 'NORMAL' | 'WON' | 'LOST'
export interface Stage {
  id: string
  pipelineId: string
  name: string
  position: number
  color: string
  type: StageType
  active: boolean
  leadCount?: number
}
export type PipelineStage = Stage
export interface LeadershipReview {
  feedback: string
  score: number
  reviewedBy: string
  reviewerName: string
  reviewedAt: string
}
export type LeadLeadershipReview = LeadershipReview
export interface LeadershipReviewInput { feedback: string; score: number }
export const LOSS_REASONS = ['Investimento', 'Sem urgência', 'Sem capacidade financeira', 'Decisor não participou', 'Escolheu concorrente', 'Timing', 'Sumiu', 'Não percebeu valor', 'Outro'] as const
export type LossReason = typeof LOSS_REASONS[number]
export interface Lead {
  id: string
  name: string
  company: string
  email: string
  phone: string
  ticket: number
  source: string
  createdAt: string
  callDate: string
  attendance: Attendance
  objection: string
  status: LeadStatus
  closedValue: number
  closedAt: string
  lastContactAt: string
  notes: string
  pain: string
  urgency: 'Baixa' | 'Média' | 'Alta'
  financialCapacity: 'Não avaliada' | 'Baixa' | 'Média' | 'Alta'
  decisionMaker: boolean
  callScore: number | null
  closerError: string
  callSummary: string
  stageId?: string
  stageType?: StageType
  stageName?: string
  lossReason?: string
  lossComment?: string
  recordingUrl?: string
  nextStep?: string
  leadershipReview?: LeadershipReview
}
export type Page = 'dashboard' | 'pipeline' | 'calls' | 'performance' | 'activities'
export interface Settings { name: string; commissionRate: number; revenueGoal: number }
