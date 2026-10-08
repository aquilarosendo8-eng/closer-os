import type { Lead } from '../types'
import { ACTIVITY_TYPES, ACTIVITY_TYPE_LABELS, type Activity, type ActivityBucket, type ActivityInput, type ActivityType, type OpportunityEvent } from './opportunity-types'
import { money } from './analytics'

export const OPPORTUNITY_TIME_ZONE = 'America/Bahia'
const parts = (value: string | Date) => new Intl.DateTimeFormat('en-CA', { timeZone: OPPORTUNITY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value))
export function activityDateFields(value: string | Date): { date: string; time: string } {
  const p = Object.fromEntries(parts(value).map(part => [part.type, part.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }
}
export function activityDateToIso(date: string, time: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new Error('Informe uma data e um horário válidos.')
  const result = new Date(`${date}T${time}:00-03:00`)
  if (!Number.isFinite(result.getTime())) throw new Error('Informe uma data e um horário válidos.')
  const normalized = activityDateFields(result)
  if (normalized.date !== date || normalized.time !== time) throw new Error('Informe uma data e um horário válidos.')
  return result.toISOString()
}
export function formatActivityDate(value: string, now = new Date()): string {
  if (!Number.isFinite(new Date(value).getTime())) return 'Data não informada'
  const fields = activityDateFields(value), today = activityDateFields(now).date
  const tomorrow = activityDateFields(new Date(now.getTime() + 86400000)).date
  const day = fields.date === today ? 'Hoje' : fields.date === tomorrow ? 'Amanhã' : new Intl.DateTimeFormat('pt-BR', { timeZone: OPPORTUNITY_TIME_ZONE, day: '2-digit', month: 'short', year: new Date(value).getFullYear() !== now.getFullYear() ? 'numeric' : undefined }).format(new Date(value))
  return `${day}, ${fields.time}`
}
export function activityBucket(activity: Pick<Activity, 'status' | 'dueAt'>, now = new Date()): ActivityBucket {
  if (activity.status !== 'pending') return activity.status
  if (new Date(activity.dueAt).getTime() < now.getTime()) return 'overdue'
  return activityDateFields(activity.dueAt).date === activityDateFields(now).date ? 'today' : 'upcoming'
}
export function nextActivity(activities: Activity[], leadId?: string): Activity | undefined {
  return activities.filter(item => item.status === 'pending' && (!leadId || item.leadId === leadId)).sort((a,b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime() || a.id.localeCompare(b.id))[0]
}
export function overdueActivityLabel(activity: Activity, now = new Date()): string {
  if (activity.status !== 'pending' || new Date(activity.dueAt).getTime() >= now.getTime()) return ''
  const days = Math.floor((now.getTime() - new Date(activity.dueAt).getTime()) / 86400000)
  const label = ACTIVITY_TYPE_LABELS[activity.type]
  return days >= 1 ? `${label} atrasado há ${days} ${days === 1 ? 'dia' : 'dias'}` : `${label} atrasado`
}
export function operationalCounts(activities: Activity[], leads: Lead[], now = new Date()) {
  const today = activityDateFields(now).date
  return {
    overdue: activities.filter(item => activityBucket(item, now) === 'overdue').length,
    today: activities.filter(item => activityBucket(item, now) === 'today').length,
    upcoming: activities.filter(item => activityBucket(item, now) === 'upcoming').length,
    callsToday: leads.filter(lead => lead.callDate && Number.isFinite(new Date(lead.callDate).getTime()) && activityDateFields(lead.callDate).date === today).length,
  }
}
export function validActivityInput(input: ActivityInput): boolean {
  return !!input.leadId && !!input.assignedTo && ACTIVITY_TYPES.includes(input.type) && input.title.trim().length >= 1 && input.title.trim().length <= 180 && input.description.length <= 4000 && !/[\u0000-\u001f\u007f-\u009f]/.test(input.title) && Number.isFinite(new Date(input.dueAt).getTime()) && /(?:Z|[+-]\d{2}:\d{2})$/i.test(input.dueAt)
}
export function activityTypeLabel(type: ActivityType): string { return ACTIVITY_TYPE_LABELS[type] }
/** Only business fields are rendered; raw logs and arbitrary metadata stay out of the UI. */
export function eventPresentation(event: OpportunityEvent): { title: string; detail: string } {
  const m = event.metadata
  const text = (key: string) => typeof m[key] === 'string' ? m[key] as string : ''
  const amount = (key: string) => typeof m[key] === 'number' ? money(m[key] as number) : ''
  const titles: Record<string, string> = {
    'lead.created': 'Oportunidade criada', 'lead.owner_changed': 'Responsável alterado', 'lead.stage_changed': 'Etapa atualizada',
    'lead.ticket_changed': 'Ticket atualizado', 'call.scheduled': 'Call agendada', 'call.recorded': 'Call registrada',
    'call.updated': 'Pós-call atualizado', 'call.recording_added': 'Gravação adicionada', 'call.reviewed': 'Revisão da liderança', 'call.snapshot': 'Call do cadastro anterior',
    'activity.created': 'Atividade criada', 'activity.updated': 'Atividade atualizada', 'activity.completed': 'Atividade concluída',
    'activity.cancelled': 'Atividade cancelada', 'lead.won': 'Venda fechada', 'lead.lost': 'Oportunidade perdida',
    'lead.loss_reason_changed': 'Motivo de perda atualizado', 'lead.reopened': 'Oportunidade reaberta',
  }
  let detail = ''
  if (event.eventType === 'lead.stage_changed') detail = [text('from_stage_name'), text('to_stage_name')].filter(Boolean).join(' → ')
  if (event.eventType === 'lead.owner_changed') detail = text('assigned_name') || text('to_owner_name')
  if (event.eventType === 'lead.ticket_changed') detail = [amount('previous_ticket') || amount('from_ticket'), amount('ticket') || amount('to_ticket')].filter(Boolean).join(' → ')
  if (event.eventType.startsWith('activity.')) detail = [text('title'), text('due_at') ? formatActivityDate(text('due_at')) : ''].filter(Boolean).join(' · ')
  if (event.eventType === 'lead.won') detail = amount('closed_value')
  if (event.eventType === 'lead.lost' || event.eventType === 'lead.loss_reason_changed') detail = [text('loss_reason'), text('loss_comment')].filter(Boolean).join(' · ')
  if (event.eventType === 'call.recorded' || event.eventType === 'call.updated') {
    const snapshot = m.call && typeof m.call === 'object' ? m.call as Record<string,unknown> : m
    const score = snapshot.callScore ?? snapshot.call_score
    detail = typeof score === 'number' ? `Nota ${score}/10` : typeof snapshot.attendance === 'string' ? snapshot.attendance : ''
  }
  if (event.eventType === 'call.reviewed') detail = typeof m.score === 'number' ? `Nota da liderança: ${m.score}/10` : ''
  return { title: titles[event.eventType] || 'Oportunidade atualizada', detail }
}
