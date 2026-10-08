import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowUpRight, CalendarDays, Check, CheckCircle2, Clock3, ListTodo, LoaderCircle, Pencil, Plus, Search, UserRound, X, XCircle } from 'lucide-react'
import type { Lead } from '../types'
import { ACTIVITY_TYPE_LABELS, type Activity, type ActivityBucket, type ActivityInput, type ActivityViewProps } from '../lib/opportunity-types'
import { activityBucket, activityDateFields, formatActivityDate, operationalCounts, overdueActivityLabel } from '../lib/opportunity'
import ActivityForm, { ActivityDialog } from './ActivityForm'
import './activities.css'

type PendingFilter = 'pending' | 'overdue' | 'today' | 'upcoming'
const GROUP_LABELS: Record<ActivityBucket, string> = { overdue: 'Atrasadas', today: 'Hoje', upcoming: 'Próximas', completed: 'Concluídas', cancelled: 'Canceladas' }
const GROUP_ORDER: ActivityBucket[] = ['overdue', 'today', 'upcoming', 'completed', 'cancelled']

export interface ActivityListProps extends ActivityViewProps {
  lead?: Lead
  leadId?: string
  embedded?: boolean
  bucket?: ActivityBucket | 'pending'
}

function useActivityClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const update = () => setNow(new Date())
    const visible = () => { if (document.visibilityState === 'visible') update() }
    const timer = window.setInterval(update, 60_000)
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', update)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])
  return now
}

function errorMessage(cause: unknown, fallback: string) { return cause instanceof Error ? cause.message : fallback }

export default function Activities(props: ActivityViewProps) {
  const [filter, setFilter] = useState<PendingFilter | 'calls'>('pending')
  const now = useActivityClock()
  const counts = operationalCounts(props.activities, props.leads, now)
  const cards = [
    { key: 'overdue', label: 'Atrasadas', value: counts.overdue, icon: AlertCircle, detail: 'Contatos que precisam de atenção', tone: 'danger' },
    { key: 'today', label: 'Para hoje', value: counts.today, icon: ListTodo, detail: 'Próximas tarefas do dia', tone: 'primary' },
    { key: 'calls', label: 'Calls de hoje', value: counts.callsToday, icon: CalendarDays, detail: 'Calls nas oportunidades', tone: 'neutral' },
    { key: 'upcoming', label: 'Próximas', value: counts.upcoming, icon: Clock3, detail: 'Atividades dos próximos dias', tone: 'neutral' },
  ] as const
  return <div className="at-central">
    <div className="at-metrics" aria-label="Resumo das atividades">
      {cards.map(({ key, label, value, icon: Icon, detail, tone }) => <button type="button" key={key} className={`at-metric at-metric-${tone} ${filter === key ? 'at-metric-active' : ''}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>
        <span className="at-metric-label"><Icon size={17} />{label}</span><strong>{value}</strong><small>{detail}</small>
      </button>)}
    </div>
    <div className="at-central-heading"><div><h2>{filter === 'calls' ? 'Agenda de calls' : 'Próximos contatos'}</h2><p>Horário de Brasília</p></div><span className="at-central-note">{props.canEdit ? 'Organize cada próximo passo' : 'Acesso somente para consulta'}</span></div>
    <div className="at-filter-tabs" aria-label="Filtrar atividades pendentes">
      {([{ key: 'pending', label: 'Todos' }, { key: 'overdue', label: 'Atrasadas' }, { key: 'today', label: 'Hoje' }, { key: 'upcoming', label: 'Próximas' }] as const).map(item => <button type="button" key={item.key} aria-pressed={filter === item.key} className={filter === item.key ? 'at-filter-active' : ''} onClick={() => setFilter(item.key)}>{item.label}</button>)}
    </div>
    {filter === 'calls' ? <TodaysCalls {...props} now={now} /> : <ActivityList {...props} bucket={filter} />}
  </div>
}

function TodaysCalls({ leads, onOpenLead, loading, error, onRetry, now }: ActivityViewProps & { now: Date }) {
  const [query, setQuery] = useState('')
  const today = activityDateFields(now).date
  const calls = leads.filter(lead => lead.callDate && Number.isFinite(new Date(lead.callDate).getTime()) && activityDateFields(lead.callDate).date === today)
    .filter(lead => `${lead.name} ${lead.company}`.toLocaleLowerCase('pt-BR').includes(query.trim().toLocaleLowerCase('pt-BR')))
    .sort((a, b) => new Date(a.callDate).getTime() - new Date(b.callDate).getTime() || a.id.localeCompare(b.id))
  return <section className="at-list at-calls-list" aria-label="Calls de hoje">
    <div className="at-toolbar"><label className="at-search"><Search size={16} /><input aria-label="Buscar calls de hoje" placeholder="Buscar por lead ou empresa" value={query} onChange={event => setQuery(event.target.value)} /></label><span className="at-toolbar-note">Agenda das oportunidades</span></div>
    {error && <div className="at-error" role="alert"><AlertCircle size={16} /><span>{error}</span>{onRetry && <button type="button" className="at-link-button" onClick={onRetry}>Tentar novamente</button>}</div>}
    {loading && <div className="at-loading" role="status"><LoaderCircle size={18} className="at-spinning" />Carregando calls…</div>}
    {!loading && !calls.length && <div className="at-empty"><CalendarDays size={25} /><strong>{query ? 'Nenhuma call nesta busca' : 'Nenhuma call para hoje'}</strong><p>{query ? 'Busque por outro lead ou empresa.' : 'As calls com data de hoje nas oportunidades aparecerão aqui.'}</p></div>}
    {!!calls.length && <div className="at-rows">{calls.map(lead => <article className="at-row at-call-row" key={lead.id}>
      <span className="at-row-type-icon"><CalendarDays size={18} /></span><div className="at-row-main"><h3>{lead.name}</h3><p className="at-row-description">{lead.company || 'Pessoa física'}</p><div className="at-row-meta"><span><Clock3 size={13} />{formatActivityDate(lead.callDate, now)}</span><span className={`at-badge ${lead.attendance === 'Compareceu' ? 'at-badge-success' : lead.attendance === 'Não compareceu' ? 'at-badge-danger' : ''}`}>{lead.attendance}</span></div></div>
      {onOpenLead && <button type="button" className="at-small-button at-open-lead" aria-label={`Abrir oportunidade ${lead.name}`} onClick={() => onOpenLead(lead)}>Ver oportunidade<ArrowUpRight size={15} /></button>}
    </article>)}</div>}
  </section>
}

export function ActivityList(props: ActivityListProps) {
  const { activities, members, userId, userName, leadOwners, canEdit, canManage, onOpenLead, loading, error, onRetry, onSaveActivity, onSetActivityStatus, embedded = false, bucket } = props
  const fixedLeadId = props.leadId ?? props.lead?.id
  const leads = props.lead && !props.leads.some(lead => lead.id === props.lead!.id) ? [...props.leads, props.lead] : props.leads
  const [query, setQuery] = useState('')
  const [form, setForm] = useState<{ activity?: Activity } | null>(null)
  const [cancelling, setCancelling] = useState<Activity | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const busyRef = useRef(false)
  const now = useActivityClock()
  const leadById = new Map(leads.map(lead => [lead.id, lead]))
  const mayWriteLead = (id: string) => canEdit && leadById.has(id) && (canManage || leadOwners?.[id] === userId)
  const eligibleLeads = leads.filter(lead => (!fixedLeadId || lead.id === fixedLeadId) && mayWriteLead(lead.id))
  const fixedLead = fixedLeadId ? leadById.get(fixedLeadId) : undefined
  const scoped = activities.filter(activity => !fixedLeadId || activity.leadId === fixedLeadId)
  const buckets = useMemo(() => new Map(activities.filter(activity => !fixedLeadId || activity.leadId === fixedLeadId).map(activity => [activity.id, activityBucket(activity, now)] as const)), [activities, fixedLeadId, now])
  const search = query.trim().toLocaleLowerCase('pt-BR')
  const visible = scoped.filter(activity => {
    const currentBucket = buckets.get(activity.id)
    if (bucket === 'pending' && activity.status !== 'pending') return false
    if (bucket && bucket !== 'pending' && currentBucket !== bucket) return false
    const lead = leadById.get(activity.leadId)
    return `${activity.title} ${activity.description} ${ACTIVITY_TYPE_LABELS[activity.type]} ${activity.assignedName} ${lead?.name ?? ''} ${lead?.company ?? ''}`.toLocaleLowerCase('pt-BR').includes(search)
  })
  const grouped = GROUP_ORDER.map(key => ({ key, items: visible.filter(item => buckets.get(item.id) === key).sort((a, b) => {
    const left = a.status === 'pending' ? a.dueAt : a.completedAt ?? a.updatedAt
    const right = b.status === 'pending' ? b.dueAt : b.completedAt ?? b.updatedAt
    return (new Date(left).getTime() - new Date(right).getTime()) * (a.status === 'pending' ? 1 : -1) || a.id.localeCompare(b.id)
  }) })).filter(group => group.items.length)

  useEffect(() => { setQuery(''); setForm(null); setCancelling(null); setActionError(''); setNotice('') }, [fixedLeadId])
  useEffect(() => { if (!canEdit) { setForm(null); setCancelling(null) } }, [canEdit])

  const openCreate = () => { if (!eligibleLeads.length || busyRef.current) return; setActionError(''); setNotice(''); setForm({}) }
  const openEdit = (activity: Activity) => { if (activity.status !== 'pending' || !mayWriteLead(activity.leadId) || busyRef.current) return; setActionError(''); setNotice(''); setForm({ activity }) }
  const save = async (input: ActivityInput, id?: string) => {
    if (!mayWriteLead(input.leadId) || (fixedLeadId && input.leadId !== fixedLeadId)) throw new Error('Sua permissão não permite alterar esta atividade.')
    if (id && !activities.some(item => item.id === id && item.leadId === input.leadId && item.status === 'pending')) throw new Error('Esta atividade não está mais pendente. Feche a janela e atualize a lista.')
    const result = await onSaveActivity(input, id)
    setActionError('')
    setNotice(id ? 'Atividade atualizada.' : 'Atividade criada.')
    return result
  }
  const setStatus = async (activity: Activity, status: 'completed' | 'cancelled') => {
    if (busyRef.current) return false
    const current = activities.find(item => item.id === activity.id)
    if (!current || current.status !== 'pending' || !mayWriteLead(current.leadId)) { setActionError('Esta atividade não pode mais ser alterada. Atualize a lista e tente novamente.'); return false }
    busyRef.current = true
    setBusyId(activity.id)
    setActionError('')
    setNotice('')
    try {
      await onSetActivityStatus(activity.id, status)
      setNotice(status === 'completed' ? 'Atividade concluída.' : 'Atividade cancelada.')
      return true
    } catch (cause) {
      setActionError(errorMessage(cause, 'Não foi possível atualizar a atividade. Tente novamente.'))
      return false
    } finally { busyRef.current = false; setBusyId(null) }
  }
  const confirmCancel = async () => { if (cancelling && await setStatus(cancelling, 'cancelled')) setCancelling(null) }

  return <section className={`at-list ${embedded ? 'at-list-embedded' : ''}`} aria-label={embedded ? 'Atividades da oportunidade' : 'Lista de atividades'}>
    <div className="at-toolbar"><label className="at-search"><Search size={16} /><input aria-label="Buscar atividades" placeholder="Buscar atividades" value={query} onChange={event => setQuery(event.target.value)} /></label>
      {!!eligibleLeads.length && <button type="button" className="at-primary-button" onClick={openCreate} disabled={!!busyId}><Plus size={16} />Nova atividade</button>}
    </div>
    {error && <div className="at-error" role="alert"><AlertCircle size={16} /><span>{error}</span>{onRetry && <button type="button" className="at-link-button" onClick={onRetry}>Tentar novamente</button>}</div>}
    {actionError && !cancelling && <div className="at-error" role="alert"><AlertCircle size={16} /><span>{actionError}</span><button type="button" className="at-icon-button" aria-label="Fechar aviso de erro" onClick={() => setActionError('')}><X size={16} /></button></div>}
    {notice && <div className="at-notice" role="status"><CheckCircle2 size={16} /><span>{notice}</span><button type="button" className="at-icon-button" aria-label="Fechar confirmação" onClick={() => setNotice('')}><X size={16} /></button></div>}
    {loading && <div className="at-loading" role="status"><LoaderCircle size={18} className="at-spinning" />Carregando atividades…</div>}
    {!loading && !visible.length && <div className="at-empty"><ListTodo size={25} /><strong>{query ? 'Nenhuma atividade nesta busca' : bucket && bucket !== 'pending' ? `Nenhuma atividade em ${GROUP_LABELS[bucket].toLocaleLowerCase('pt-BR')}` : 'Nenhuma atividade por aqui'}</strong><p>{query ? 'Experimente buscar pelo título, lead ou responsável.' : !leads.length ? 'Cadastre uma oportunidade para organizar os próximos contatos.' : eligibleLeads.length ? 'Registre o próximo contato para manter a oportunidade em movimento.' : 'As atividades desta equipe aparecerão aqui.'}</p>{query && <button type="button" className="at-link-button" onClick={() => setQuery('')}>Limpar busca</button>}</div>}
    {grouped.map(group => <section className={`at-group at-group-${group.key}`} key={group.key} aria-label={`Atividades ${GROUP_LABELS[group.key].toLocaleLowerCase('pt-BR')}`}><div className="at-group-heading"><h3>{GROUP_LABELS[group.key]}</h3><span>{group.items.length}</span></div><div className="at-rows">{group.items.map(activity => {
      const lead = leadById.get(activity.leadId)
      const writable = activity.status === 'pending' && mayWriteLead(activity.leadId)
      const isBusy = busyId === activity.id
      return <article key={activity.id} className={`at-row at-row-${group.key}`} aria-label={activity.title} aria-busy={isBusy}>
        <span className="at-row-type-icon">{group.key === 'completed' ? <CheckCircle2 size={18} /> : group.key === 'cancelled' ? <XCircle size={18} /> : <Clock3 size={18} />}</span>
        <div className="at-row-main"><h4>{activity.title}</h4>{!fixedLeadId && <div className="at-row-lead">{lead && onOpenLead ? <button type="button" aria-label={`Abrir oportunidade ${lead.name}`} onClick={() => onOpenLead(lead)}>{lead.name}<ArrowUpRight size={12} /></button> : <strong>{lead?.name || 'Oportunidade indisponível'}</strong>}{lead?.company && <span>{lead.company}</span>}</div>}
          {activity.description && <p className="at-row-description">{activity.description}</p>}
          <div className="at-row-meta"><span className={`at-due ${group.key === 'overdue' ? 'at-due-overdue' : ''}`}><Clock3 size={13} />{group.key === 'overdue' ? overdueActivityLabel(activity, now) : formatActivityDate(activity.dueAt, now)}</span>{group.key === 'overdue' && <span>{formatActivityDate(activity.dueAt, now)}</span>}<span className="at-badge">{ACTIVITY_TYPE_LABELS[activity.type]}</span><span className="at-assignee"><UserRound size={13} />{activity.assignedName || (activity.assignedTo === userId ? userName || 'Você' : 'Responsável')}</span>{activity.status !== 'pending' && <span className={`at-badge ${activity.status === 'completed' ? 'at-badge-success' : ''}`}>{activity.status === 'completed' ? 'Concluída' : 'Cancelada'}</span>}</div>
        </div>
        {writable && <div className="at-row-actions"><button type="button" className="at-small-button at-complete-button" aria-label={`Concluir atividade ${activity.title}`} disabled={!!busyId} onClick={() => { void setStatus(activity, 'completed') }}>{isBusy ? <LoaderCircle size={15} className="at-spinning" /> : <Check size={15} />}Concluir</button><button type="button" className="at-icon-button" aria-label={`Editar atividade ${activity.title}`} title="Editar atividade" disabled={!!busyId} onClick={() => openEdit(activity)}><Pencil size={15} /></button><button type="button" className="at-icon-button at-cancel-button" aria-label={`Cancelar atividade ${activity.title}`} title="Cancelar atividade" disabled={!!busyId} onClick={() => { setCancelling(activity); setActionError(''); setNotice('') }}><X size={16} /></button></div>}
      </article>
    })}</div></section>)}
    {embedded && !!scoped.length && <p className="at-timezone-note">Datas e horários de Brasília</p>}
    {form && <ActivityForm leads={leads} members={members} userId={userId} userName={userName} leadOwners={leadOwners} canEdit={canEdit} canManage={canManage} lead={fixedLead} activity={form.activity} onSave={save} onClose={() => setForm(null)} />}
    {cancelling && <ActivityDialog title="Cancelar atividade?" onClose={() => { if (!busyRef.current) { setCancelling(null); setActionError('') } }} busy={!!busyId}>
      <div className="at-modal-body at-cancel-content"><p>A atividade <strong>{cancelling.title}</strong> deixará de fazer parte das pendências desta oportunidade.</p><p className="at-form-help">Ela continuará no histórico como cancelada.</p>{actionError && <div className="at-error" role="alert"><AlertCircle size={16} /><span>{actionError}</span></div>}</div>
      <div className="at-modal-footer"><button type="button" className="at-secondary-button" disabled={!!busyId} onClick={() => { setCancelling(null); setActionError('') }}>Manter atividade</button><button type="button" className="at-danger-button" disabled={!!busyId} onClick={() => { void confirmCancel() }}>{busyId ? <LoaderCircle size={16} className="at-spinning" /> : <XCircle size={16} />}Confirmar cancelamento</button></div>
    </ActivityDialog>}
  </section>
}
