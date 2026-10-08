import { requireSupabase } from './supabase'
import { validActivityInput } from './opportunity'
import { ACTIVITY_TYPES, type Activity, type ActivityInput, type ActivityStatus, type CallPage, type EventPage, type LeadCall, type OpportunityDetailsService, type OpportunityEvent } from './opportunity-types'
import { validLeadershipReview } from './validation'

type Row = Record<string, unknown>
const text = (row: Row, key: string) => typeof row[key] === 'string' ? row[key] as string : ''
const timestamp = (value: string) => value && Number.isFinite(new Date(value).getTime())
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A resposta da oportunidade está incompleta. Atualize e tente novamente.')
  return value as Row
}
function activity(value: unknown, workspaceId: string): Activity {
  const r = object(value), status = text(r, 'status') as ActivityStatus
  if (r.workspace_id !== workspaceId || !text(r,'id') || !text(r,'lead_id') || !text(r,'assigned_to') || !ACTIVITY_TYPES.includes(r.type as Activity['type']) || !['pending','completed','cancelled'].includes(status) || !timestamp(text(r,'due_at'))) throw new Error('Há uma atividade incompatível com o acesso selecionado.')
  return { id:text(r,'id'),workspaceId,leadId:text(r,'lead_id'),assignedTo:text(r,'assigned_to'),assignedName:text(r,'assigned_name') || 'Responsável',createdBy:text(r,'created_by'),createdByName:text(r,'created_by_name') || 'Usuário removido',type:r.type as Activity['type'],title:text(r,'title'),description:text(r,'description'),dueAt:text(r,'due_at'),status,completedAt:typeof r.completed_at === 'string' ? r.completed_at : null,createdAt:text(r,'created_at'),updatedAt:text(r,'updated_at') }
}
function event(value: unknown, workspaceId: string, leadId: string): OpportunityEvent {
  const r = object(value)
  if (r.workspace_id !== workspaceId || r.lead_id !== leadId || !/^\d+$/.test(text(r,'id')) || !timestamp(text(r,'created_at'))) throw new Error('O histórico não corresponde à oportunidade selecionada.')
  return {id:text(r,'id'),workspaceId,leadId,actorId:typeof r.actor_id === 'string' ? r.actor_id : null,actorName:text(r,'actor_name') || 'Sistema',eventType:text(r,'event_type'),metadata:object(r.metadata),createdAt:text(r,'created_at')}
}
function call(value: unknown): LeadCall {
  const r = object(value), score = r.call_score
  if (!['Pendente','Compareceu','Não compareceu'].includes(text(r,'attendance')) || (score !== null && (!Number.isInteger(score) || Number(score)<0 || Number(score)>10))) throw new Error('Há uma call incompatível no histórico.')
  const rawReview = r.leadership_review && typeof r.leadership_review === 'object' ? object(r.leadership_review) : null
  const review = rawReview ? { feedback:text(rawReview,'feedback'),score:Number(rawReview.score),reviewedBy:text(rawReview,'reviewed_by'),reviewerName:text(rawReview,'reviewer_name') || 'Liderança',reviewedAt:text(rawReview,'reviewed_at') } : undefined
  if (review && !validLeadershipReview(review)) throw new Error('Há uma revisão incompatível no histórico da call.')
  return {id:text(r,'id') || text(r,'call_date') || 'undated',callDate:text(r,'call_date'),attendance:r.attendance as LeadCall['attendance'],callScore:score as number|null,callSummary:text(r,'call_summary'),objection:text(r,'objection'),pain:text(r,'pain'),urgency:(text(r,'urgency') || 'Média') as LeadCall['urgency'],financialCapacity:(text(r,'financial_capacity') || 'Não avaliada') as LeadCall['financialCapacity'],decisionMaker:r.decision_maker === true,closerError:text(r,'closer_error'),recordingUrl:text(r,'recording_url'),nextStep:text(r,'next_step'),leadershipReview:review,recordedAt:text(r,'recorded_at'),legacy:r.legacy === true}
}
export interface OpportunityService extends OpportunityDetailsService {
  listPending: () => Promise<Activity[]>
  saveActivity: (input: ActivityInput, activityId?: string) => Promise<Activity>
  setActivityStatus: (activityId: string, status: 'completed'|'cancelled') => Promise<Activity>
}
export function createOpportunityService(workspaceId: string): OpportunityService {
  const rpc = async (name: string, args: Row) => {
    const result = await requireSupabase().rpc(name, { p_workspace_id:workspaceId, ...args })
    if (result.error) throw result.error
    return result.data
  }
  const listActivities = async (leadId?: string): Promise<Activity[]> => {
    const items: Activity[] = []
    let offset: number | null = 0
    do {
      const page = object(await rpc('list_lead_activities', { p_lead_id:leadId || null,p_limit:200,p_offset:offset }))
      if (!Array.isArray(page.items)) throw new Error('Não foi possível carregar as atividades.')
      for (const row of page.items) {
        const parsed = activity(row,workspaceId)
        if (leadId && parsed.leadId !== leadId || !leadId && parsed.status !== 'pending') throw new Error('As atividades não correspondem ao contexto solicitado.')
        items.push(parsed)
      }
      if (page.next_offset === null) offset = null
      else if (Number.isInteger(page.next_offset) && Number(page.next_offset)>offset) offset = Number(page.next_offset)
      else throw new Error('Não foi possível continuar a lista de atividades.')
    } while (offset !== null)
    return items
  }
  return {
    listPending: () => listActivities(), listActivities: leadId => {
      if (!leadId) return Promise.reject(new Error('Selecione uma oportunidade válida.'))
      return listActivities(leadId)
    },
    async saveActivity(input, activityId) {
      if (!validActivityInput(input)) throw new Error('Revise o título, responsável e horário da atividade.')
      const result = activity(await rpc('save_activity', {p_lead_id:input.leadId,p_title:input.title.trim(),p_type:input.type,p_due_at:input.dueAt,p_assigned_to:input.assignedTo,p_description:input.description.trim(),p_activity_id:activityId || null}),workspaceId)
      if (result.leadId !== input.leadId || activityId && result.id !== activityId) throw new Error('A atividade salva não corresponde à oportunidade.')
      return result
    },
    async setActivityStatus(activityId,status) {
      if (!activityId || !['completed','cancelled'].includes(status)) throw new Error('Selecione uma atividade pendente.')
      const result = activity(await rpc('set_activity_status',{p_activity_id:activityId,p_status:status}),workspaceId)
      if (result.id !== activityId || result.status !== status) throw new Error('A atividade atualizada não corresponde à seleção.')
      return result
    },
    async listEvents(leadId,beforeId): Promise<EventPage> {
      if (!leadId || beforeId && !/^\d+$/.test(beforeId)) throw new Error('Selecione uma oportunidade válida.')
      const p = object(await rpc('list_lead_events',{p_lead_id:leadId,p_before_id:beforeId || null,p_limit:30}))
      if (!Array.isArray(p.items) || p.next_cursor !== null && (typeof p.next_cursor !== 'string' || !/^\d+$/.test(p.next_cursor))) throw new Error('Não foi possível carregar o histórico da oportunidade.')
      return {items:p.items.map(row=>event(row,workspaceId,leadId)),nextCursor:p.next_cursor as string|null}
    },
    async listCalls(leadId,offset=0): Promise<CallPage> {
      if (!leadId || !Number.isInteger(offset) || offset<0) throw new Error('Selecione uma oportunidade válida.')
      const p = object(await rpc('list_lead_call_history',{p_lead_id:leadId,p_limit:20,p_offset:offset}))
      if (!Array.isArray(p.items) || !Number.isInteger(p.call_count) || Number(p.call_count)<0 || p.next_offset !== null && (!Number.isInteger(p.next_offset) || Number(p.next_offset)<=offset)) throw new Error('Não foi possível carregar as calls da oportunidade.')
      return {items:p.items.map(call),nextOffset:p.next_offset as number|null,callCount:Number(p.call_count),ownerName:text(p,'owner_name'),ownerId:text(p,'owner_id'),lastEventAt:text(p,'last_event_at')}
    },
  }
}
