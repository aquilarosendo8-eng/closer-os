import type { User } from '@supabase/supabase-js'
import type { AdministrationService, AuditEntry, Invitation, Membership, PlatformWorkspace, Subscription, WorkspaceAccess, WorkspaceRole } from './access-types'
import { requireSupabase } from './supabase'
import { defaultSettings } from './data'

type Row = Record<string, any>
const assert = (error: unknown) => { if (error) throw error }
const periodEnd = (row: Row | null): string | null => {
  if (!row) return null
  const dates = (row.status === 'trial' ? [row.trial_ends_at, row.current_period_end] : [row.current_period_end]).filter(Boolean)
  if (!dates.length) return null
  return dates.reduce((earliest: string, next: string) => new Date(next).getTime() < new Date(earliest).getTime() ? next : earliest)
}
const subscription = (row: Row | null): Subscription => ({
  plan: row?.plan === 'team' ? 'team' : 'individual',
  status: row?.status === 'canceled' ? 'cancelled' : ['active', 'trial', 'past_due', 'suspended', 'cancelled'].includes(row?.status) ? row!.status : 'suspended',
  seatLimit: Number(row?.seat_limit || 1),
  currentPeriodEnd: periodEnd(row),
})
export function subscriptionAllowsAccess(value: Subscription, now = new Date()): boolean {
  if (!['active', 'trial'].includes(value.status)) return false
  if (!value.currentPeriodEnd) return value.status === 'active'
  const end = new Date(value.currentPeriodEnd).getTime()
  return Number.isFinite(end) && end > now.getTime()
}
const member = (row: Row): Membership => ({ userId: row.user_id, email: row.email || '', displayName: row.display_name || row.email || 'Usuário', role: row.role as WorkspaceRole, active: Boolean(row.is_active) })
const invitation = (row: Row): Invitation => ({ id: row.id, email: row.email, role: row.role, expiresAt: row.expires_at, acceptedAt: row.accepted_at, revokedAt: row.revoked_at })

export interface AccessSnapshot { workspaces: WorkspaceAccess[]; isPlatformAdmin: boolean; displayName: string }
export async function loadAccess(user: User): Promise<AccessSnapshot> {
  const client = requireSupabase()
  const [membershipResult, adminResult, profileResult] = await Promise.all([
    client.from('memberships').select('workspace_id,user_id,role,is_active').eq('user_id', user.id).eq('is_active', true),
    client.from('platform_admins').select('user_id').eq('user_id', user.id),
    client.from('profiles').select('display_name,email').eq('id', user.id).maybeSingle(),
  ])
  assert(membershipResult.error); assert(adminResult.error); assert(profileResult.error)
  const isPlatformAdmin = Boolean(adminResult.data?.length)
  const displayName = profileResult.data?.display_name || user.user_metadata.display_name || user.email?.split('@')[0] || 'Closer'
  const memberships = membershipResult.data || []
  if (!memberships.length) return { workspaces: [], isPlatformAdmin, displayName }
  const ids = memberships.map(row => row.workspace_id)
  const [workspaceResult, subscriptionResult, settingsResult] = await Promise.all([
    client.from('workspaces').select('id,name,owner_id,created_at').in('id', ids),
    client.from('subscriptions').select('*').in('workspace_id', ids),
    client.from('workspace_settings').select('*').in('workspace_id', ids),
  ])
  assert(workspaceResult.error); assert(subscriptionResult.error); assert(settingsResult.error)
  const workspaces = memberships.flatMap(row => {
    const workspace = workspaceResult.data?.find(value => value.id === row.workspace_id)
    if (!workspace) return []
    const settings = settingsResult.data?.find(value => value.workspace_id === row.workspace_id)
    return [{
      workspace: { id: workspace.id, name: workspace.name, ownerId: workspace.owner_id, createdAt: workspace.created_at, settings: settings ? { name: settings.name, commissionRate: Number(settings.commission_rate), revenueGoal: Number(settings.revenue_goal) } : { ...defaultSettings, name: displayName } },
      membership: { userId: user.id, email: user.email || '', displayName, role: row.role as WorkspaceRole, active: row.is_active },
      subscription: subscription(subscriptionResult.data?.find(value => value.workspace_id === row.workspace_id) || null),
      isPlatformAdmin,
    }]
  })
  return { workspaces, isPlatformAdmin, displayName }
}

export async function invitationPreview(token: string): Promise<{ email: string; workspaceName: string; expiresAt: string }> {
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('Este convite não é válido.')
  const { data, error } = await requireSupabase().rpc('list_invitation_preview', { p_token: token })
  assert(error)
  if (!data?.email) throw new Error('Este convite expirou ou já foi utilizado. Solicite outro ao administrador.')
  return { email: data.email, workspaceName: data.workspace_name, expiresAt: data.expires_at }
}

export const administrationService: AdministrationService = {
  async listMembers(workspaceId) {
    const { data, error } = await requireSupabase().rpc('list_members', { p_workspace_id: workspaceId }); assert(error)
    return (data || []).map(member)
  },
  async updateMember(workspaceId, userId, changes) {
    const current = (await this.listMembers(workspaceId)).find(row => row.userId === userId)
    if (!current) throw new Error('Usuário não encontrado nesta empresa.')
    const { error } = await requireSupabase().rpc('update_member', { p_workspace_id: workspaceId, p_user_id: userId, p_role: changes.role || current.role, p_is_active: changes.active ?? current.active }); assert(error)
  },
  async listInvitations(workspaceId) {
    const { data, error } = await requireSupabase().rpc('list_invitations', { p_workspace_id: workspaceId }); assert(error)
    return (data || []).map(invitation)
  },
  async createInvitation(workspaceId, input) {
    const { data: session, error } = await requireSupabase().auth.getSession(); assert(error)
    if (!session.session) throw new Error('Entre novamente para enviar o convite.')
    const response = await fetch('/api/invitations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.session.access_token}` },
      body: JSON.stringify({ workspaceId, email: input.email.trim().toLowerCase(), role: input.role }),
    })
    const result = await response.json().catch(() => null)
    if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : result?.error?.message || 'Não foi possível enviar o convite por e-mail. Tente novamente.')
    if (!result?.invitation?.id || !result.url || result.emailSent !== true) throw new Error('Não recebemos a confirmação do envio. Atualize a lista de convites antes de tentar novamente.')
    return { invitation: invitation(result.invitation), url: result.url, emailSent: true }
  },
  async revokeInvitation(workspaceId, invitationId) {
    const { error } = await requireSupabase().rpc('revoke_invitation', { p_workspace_id: workspaceId, p_invitation_id: invitationId }); assert(error)
  },
  async listAudit(workspaceId): Promise<AuditEntry[]> {
    const { data, error } = await requireSupabase().rpc('list_audit', { p_workspace_id: workspaceId }); assert(error)
    return (data || []).map((row: Row) => ({ id: row.id, action: row.action, createdAt: row.created_at, actorId: row.actor_id, details: row.details }))
  },
  async listPlatformWorkspaces(): Promise<PlatformWorkspace[]> {
    const { data, error } = await requireSupabase().rpc('list_platform_workspaces'); assert(error)
    return (data || []).map((row: Row) => ({ id: row.id, name: row.name, ownerId: row.owner_id, createdAt: row.created_at, subscription: subscription(row.subscription), memberCount: Number(row.member_count || 0), adminEmail: row.admin_email }))
  },
  async createWorkspace(input) {
    const { data, error } = await requireSupabase().rpc('create_workspace', { p_name: input.name.trim(), p_owner_name: input.ownerName?.trim() || null }); assert(error)
    const workspaceId = typeof data === 'string' ? data : data?.id
    if (!workspaceId) throw new Error('Não foi possível criar a empresa.')
    try {
      const result = await this.createInvitation(workspaceId, { email: input.ownerEmail, role: 'admin' })
      return { id: workspaceId, invitationUrl: result.url, emailSent: true }
    } catch (error) {
      throw Object.assign(new Error(`A empresa foi criada, mas não foi possível enviar o convite. Selecione-a e tente convidar o administrador novamente. ${error instanceof Error ? error.message : ''}`), { workspaceId })
    }
  },
  async updateSubscription(workspaceId, changes) {
    const { error } = await requireSupabase().rpc('admin_update_subscription', { p_workspace_id: workspaceId, p_plan: changes.plan, p_status: changes.status, p_seat_limit: changes.seatLimit, p_current_period_end: changes.currentPeriodEnd, p_trial_ends_at: changes.status === 'trial' ? changes.currentPeriodEnd : null }); assert(error)
  },
  async getWorkspacePrivacy(workspaceId) {
    const { data, error } = await requireSupabase().from('workspaces').select('retention_days,privacy_contact_email').eq('id', workspaceId).single(); assert(error)
    return { retentionDays: data!.retention_days, privacyContactEmail: data!.privacy_contact_email }
  },
  async updateWorkspacePrivacy(workspaceId, values) {
    const { error } = await requireSupabase().rpc('update_workspace_privacy', { p_workspace_id: workspaceId, p_retention_days: values.retentionDays, p_privacy_contact_email: values.privacyContactEmail }); assert(error)
  },
  async exportWorkspace(workspaceId) {
    const { data, error } = await requireSupabase().rpc('export_workspace', { p_workspace_id: workspaceId }); assert(error)
    return data
  },
  async deleteWorkspace(workspaceId, confirmation) {
    const { error } = await requireSupabase().rpc('delete_workspace', { p_workspace_id: workspaceId, p_confirmation: confirmation }); assert(error)
  },
  async transferWorkspaceOwner(workspaceId, userId) {
    const { error } = await requireSupabase().rpc('transfer_workspace_owner', { p_workspace_id: workspaceId, p_new_owner_id: userId }); assert(error)
  },
}
