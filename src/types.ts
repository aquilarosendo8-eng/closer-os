export const STATUSES = ['Lead novo', 'Qualificado', 'Call agendada', 'Compareceu', 'Follow-up', 'Fechado', 'Perdido'] as const
export type LeadStatus = typeof STATUSES[number]
export type Attendance = 'Pendente' | 'Compareceu' | 'Não compareceu'
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
}
export type Page = 'dashboard' | 'pipeline' | 'calls' | 'performance'
export interface Settings { name: string; commissionRate: number; revenueGoal: number }
