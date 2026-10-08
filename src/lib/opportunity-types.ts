import type { Attendance, Lead, LeadLeadershipReview } from '../types'

export const ACTIVITY_TYPES = ['follow_up', 'call', 'whatsapp', 'email', 'meeting', 'other'] as const
export type ActivityType = typeof ACTIVITY_TYPES[number]
export type ActivityStatus = 'pending' | 'completed' | 'cancelled'
export type ActivityBucket = 'overdue' | 'today' | 'upcoming' | 'completed' | 'cancelled'
export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = { follow_up: 'Follow-up', call: 'Ligação', whatsapp: 'WhatsApp', email: 'E-mail', meeting: 'Reunião', other: 'Outro' }
export interface Activity {
  id: string
  workspaceId: string
  leadId: string
  assignedTo: string
  assignedName: string
  createdBy: string
  createdByName: string
  type: ActivityType
  title: string
  description: string
  dueAt: string
  status: ActivityStatus
  completedAt: string | null
  createdAt: string
  updatedAt: string
}
export interface ActivityInput {
  leadId: string
  assignedTo: string
  type: ActivityType
  title: string
  description: string
  dueAt: string
}
export interface ActivityMember { userId: string; displayName: string; email?: string }
export interface OpportunityEvent {
  id: string
  workspaceId: string
  leadId: string
  actorId: string | null
  actorName: string
  eventType: string
  metadata: Record<string, unknown>
  createdAt: string
}
export interface LeadCall {
  id: string
  callDate: string
  attendance: Attendance
  callScore: number | null
  callSummary: string
  objection: string
  pain: string
  urgency: Lead['urgency']
  financialCapacity: Lead['financialCapacity']
  decisionMaker: boolean
  closerError: string
  recordingUrl: string
  nextStep: string
  leadershipReview?: LeadLeadershipReview
  recordedAt: string
  legacy: boolean
}
export interface EventPage { items: OpportunityEvent[]; nextCursor: string | null }
export interface CallPage { items: LeadCall[]; nextOffset: number | null; callCount: number; ownerName?: string; ownerId?: string; lastEventAt?: string }
export interface OpportunityDetailsService {
  listEvents: (leadId: string, beforeId?: string) => Promise<EventPage>
  listCalls: (leadId: string, offset?: number) => Promise<CallPage>
  listActivities: (leadId: string) => Promise<Activity[]>
}
export interface ActivityActions {
  onSaveActivity: (input: ActivityInput, activityId?: string) => Promise<Activity>
  onSetActivityStatus: (activityId: string, status: 'completed' | 'cancelled') => Promise<Activity>
}
export interface ActivityViewProps extends ActivityActions {
  activities: Activity[]
  leads: Lead[]
  members: ActivityMember[]
  userId: string
  userName?: string
  leadOwners?: Record<string, string>
  canEdit: boolean
  canManage: boolean
  onOpenLead?: (lead: Lead) => void
  loading?: boolean
  error?: string
  onRetry?: () => void
}
