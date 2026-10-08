import type { Lead, LeadershipReviewInput, Settings, Stage } from '../types'
import type { WorkspaceRole } from './access-types'
import type { Activity, ActivityActions, OpportunityDetailsService } from './opportunity-types'

/** Cloud data is provided by the authenticated shell; this view never persists it locally. */
export interface CloudAppContext {
  workspaceId?: string
  opportunity?: ActivityActions & { activities: Activity[]; loading: boolean; error: string; detailsService: OpportunityDetailsService; onRetry: () => void }
  leads: Lead[]
  settings: Settings
  workspaceName: string
  userName: string
  role: WorkspaceRole
  userId: string
  canEdit: boolean
  canDelete: boolean
  canManageSettings: boolean
  canExport: boolean
  onSaveLead: (lead: Lead) => Promise<void>
  onDeleteLead: (id: string) => Promise<void>
  onSaveSettings: (settings: Settings) => Promise<void>
  onImportLeads: (leads: Lead[]) => Promise<{ imported: number; skipped?: number }>
  onOpenAdmin?: () => void
  onSignOut: () => Promise<void>
  loading: boolean
  error?: string
  members?: { userId: string; displayName: string; email: string }[]
  leadOwners?: Record<string, string>
  onAssignLead?: (leadId: string, userId: string) => Promise<void>
  stages?: Stage[]
  canManagePipeline?: boolean
  canReviewCalls?: boolean
  onSavePipelineStages?: (stages: Stage[]) => Promise<void>
  onReviewCall?: (leadId: string, input: LeadershipReviewInput) => Promise<void>
}
