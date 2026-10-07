import type { Settings } from '../types'

export type WorkspaceRole = 'admin' | 'manager' | 'closer' | 'viewer'
export type SubscriptionPlan = 'individual' | 'team'
export type SubscriptionStatus = 'trial' | 'active' | 'past_due' | 'suspended' | 'cancelled'

export interface Workspace {
  id: string
  name: string
  settings?: Settings
  createdAt?: string
  ownerId?: string
}

export interface Membership {
  userId: string
  email: string
  displayName: string
  role: WorkspaceRole
  active: boolean
}

export interface Subscription {
  plan: SubscriptionPlan
  status: SubscriptionStatus
  seatLimit: number
  currentPeriodEnd: string | null
}

export interface Invitation {
  id: string
  email: string
  role: WorkspaceRole
  expiresAt: string
  acceptedAt?: string | null
  revokedAt?: string | null
}

export interface AuditEntry {
  id: string
  action: string
  createdAt: string
  actorId: string | null
  details?: Record<string, unknown>
}

export interface WorkspaceAccess {
  workspace: Workspace
  membership: Membership
  subscription: Subscription
  isPlatformAdmin: boolean
}

export interface PlatformWorkspace extends Workspace {
  subscription: Subscription
  memberCount: number
  adminEmail?: string
}

export interface MemberUpdate {
  role?: WorkspaceRole
  active?: boolean
}

export interface SubscriptionUpdate {
  plan: SubscriptionPlan
  status: SubscriptionStatus
  seatLimit: number
  currentPeriodEnd: string | null
}

export interface WorkspacePrivacy {
  retentionDays: number
  privacyContactEmail: string
}

/** Every method must enforce authorization on the server, including platform access. */
export interface AdministrationService {
  listMembers(workspaceId: string): Promise<Membership[]>
  updateMember(workspaceId: string, userId: string, changes: MemberUpdate): Promise<void>
  listInvitations(workspaceId: string): Promise<Invitation[]>
  createInvitation(workspaceId: string, input: { email: string; role: WorkspaceRole }): Promise<{ invitation: Invitation; url: string }>
  revokeInvitation(workspaceId: string, invitationId: string): Promise<void>
  listAudit(workspaceId: string): Promise<AuditEntry[]>
  listPlatformWorkspaces(): Promise<PlatformWorkspace[]>
  createWorkspace(input: { name: string; ownerEmail: string; ownerName?: string }): Promise<{ id: string; invitationUrl: string }>
  updateSubscription(workspaceId: string, changes: SubscriptionUpdate): Promise<void>
  getWorkspacePrivacy(workspaceId: string): Promise<WorkspacePrivacy>
  updateWorkspacePrivacy(workspaceId: string, values: WorkspacePrivacy): Promise<void>
  exportWorkspace(workspaceId: string): Promise<unknown>
  deleteWorkspace(workspaceId: string, confirmation: string): Promise<void>
  transferWorkspaceOwner(workspaceId: string, userId: string): Promise<void>
}
