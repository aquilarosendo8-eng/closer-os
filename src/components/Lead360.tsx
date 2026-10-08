import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ArrowRightLeft, BadgeCheck, CalendarDays, Check, ClipboardList, Clock3, ExternalLink, Flag, History, Layers3, LoaderCircle, MessageSquare, Pencil, Play, RefreshCw, ShieldCheck, Star, Target, TrendingUp, UserRound, Video, X } from 'lucide-react'
import type { Lead, PipelineStage } from '../types'
import type { Activity, ActivityActions, ActivityMember, CallPage, EventPage, LeadCall, OpportunityDetailsService, OpportunityEvent } from '../lib/opportunity-types'
import { activityBucket, activityTypeLabel, eventPresentation, formatActivityDate, nextActivity, overdueActivityLabel } from '../lib/opportunity'
import { initials, isStale, money } from '../lib/analytics'
import { getLeadStageName, isLost, isWon } from '../lib/pipeline'
import { validLeadershipReview, validRecordingUrl } from '../lib/validation'
import { lockDialogScroll } from '../lib/dialog-scroll'
import { ActivityList } from './Activities'
import './lead-360.css'

export interface Lead360Props extends ActivityActions {
  lead: Lead
  ownerDisplayName: string
  stages?: PipelineStage[]
  detailsService: OpportunityDetailsService
  activities: Activity[]
  members: ActivityMember[]
  userId: string
  userName?: string
  leadOwners?: Record<string, string>
  canEdit: boolean
  canManage: boolean
  onEdit: (lead: Lead) => void
  onClose: () => void
  loadingActivity?: boolean
  errorActivity?: string
  onRetryActivity?: () => void
}

type Tab = 'overview' | 'calls' | 'activities' | 'timeline'
const tabs: { id: Tab; label: string; icon: typeof Layers3 }[] = [
  { id: 'overview', label: 'Visão geral', icon: Layers3 },
  { id: 'calls', label: 'Calls', icon: Video },
  { id: 'activities', label: 'Atividades', icon: ClipboardList },
  { id: 'timeline', label: 'Timeline', icon: History },
]
const safeDate = (value: string) => value && Number.isFinite(new Date(value).getTime()) ? formatActivityDate(value) : 'Não informada'
const safeRecording = (value: string | undefined) => value && validRecordingUrl(value) ? value : ''
const pendingActivityFingerprint = (activities: Activity[], leadId: string) => JSON.stringify(activities.filter(item => item.leadId === leadId && item.status === 'pending').sort((a, b) => a.id.localeCompare(b.id)).map(item => [item.id, item.updatedAt, item.status, item.title, item.description, item.type, item.dueAt, item.assignedTo, item.assignedName]))

function Detail({ label, value, wide = false }: { label: string; value: ReactNode; wide?: boolean }) {
  const empty = value === '' || value === undefined || value === null
  return <div className={`l360-detail${wide ? ' is-wide' : ''}`}><dt>{label}</dt><dd className={empty ? 'is-empty' : undefined}>{empty ? 'Não informado' : value}</dd></div>
}

function Score({ value }: { value: number | null }) {
  return value === null ? <span className="l360-muted">Sem nota</span> : <span className="l360-score"><Star size={13}/>{value}<small>/10</small></span>
}

function LoadingState({ loading, error, onRetry, compact = false }: { loading: boolean; error: string; onRetry: () => void; compact?: boolean }) {
  return <div className={`l360-load-state${compact ? ' is-compact' : ''}`} role={error ? 'alert' : 'status'}>
    {error ? <><RefreshCw size={20} className="l360-error"/><p className="l360-error">{error}</p><button type="button" className="l360-button" disabled={loading} onClick={onRetry}>Tentar novamente</button></> : <><LoaderCircle size={22} className="l360-spinning"/><p>Carregando histórico da oportunidade...</p></>}
  </div>
}

function CallCard({ call, expanded, onToggle }: { call: LeadCall; expanded: boolean; onToggle: () => void }) {
  const detailsId = useId()
  const recording = safeRecording(call.recordingUrl)
  const review = validLeadershipReview(call.leadershipReview) ? call.leadershipReview : undefined
  return <article className="l360-call">
    <header className="l360-call-header"><div><h4 className="l360-call-date"><CalendarDays size={15}/>{safeDate(call.callDate)}</h4><span className="l360-call-byline">{call.legacy ? 'Registro da oportunidade' : `Registrada em ${safeDate(call.recordedAt)}`}</span></div><div className="l360-call-badges"><span className={`l360-pill${call.attendance === 'Compareceu' ? ' is-success' : call.attendance === 'Não compareceu' ? ' is-danger' : ''}`}>{call.attendance}</span><Score value={call.callScore}/></div></header>
    <div className="l360-call-content"><div><span className="l360-call-label">Resumo da conversa</span><p className={!call.callSummary ? 'l360-muted' : undefined}>{call.callSummary || 'Resumo ainda não registrado.'}</p></div><div><span className="l360-call-label">Objeção principal</span><p className={!call.objection ? 'l360-muted' : undefined}>{call.objection || 'Não registrada.'}</p></div></div>
    {review && <section className="l360-call-review"><div className="l360-call-review-heading"><strong><ShieldCheck size={15}/>Revisão da liderança</strong><Score value={review.score}/></div><p>{review.feedback}</p><small>{review.reviewerName || 'Liderança'} · {safeDate(review.reviewedAt)}</small></section>}
    {expanded && <dl className="l360-detail-grid l360-call-expanded" id={detailsId}>
      <Detail label="Dor principal" value={call.pain} wide/>
      <Detail label="Urgência" value={call.urgency}/><Detail label="Capacidade financeira" value={call.financialCapacity}/>
      <Detail label="Poder de decisão" value={call.decisionMaker ? 'É decisor' : 'Decisão ainda não confirmada'} wide/>
      <Detail label="Erro do closer / aprendizado" value={call.closerError} wide/>
      <Detail label="Próximo passo combinado" value={call.nextStep} wide/>
      {!review && <Detail label="Revisão da liderança" value="Ainda não revisada" wide/>}
    </dl>}
    <footer className="l360-call-footer"><button type="button" className="l360-button" aria-expanded={expanded} aria-controls={detailsId} onClick={onToggle}>{expanded ? 'Ocultar detalhes' : 'Ver call'}</button>{recording && <a className="l360-button" href={recording} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><Play size={13}/>Assistir gravação<ExternalLink size={12}/></a>}</footer>
  </article>
}

function eventIcon(event: OpportunityEvent): { icon: typeof Layers3; tone: string } {
  if (event.eventType === 'lead.won') return { icon: TrendingUp, tone: 'is-success' }
  if (event.eventType === 'lead.lost') return { icon: Flag, tone: 'is-danger' }
  if (event.eventType === 'activity.completed') return { icon: Check, tone: 'is-success' }
  if (event.eventType === 'activity.cancelled') return { icon: X, tone: '' }
  if (event.eventType.startsWith('activity.')) return { icon: ClipboardList, tone: '' }
  if (event.eventType === 'lead.owner_changed') return { icon: UserRound, tone: '' }
  if (event.eventType === 'lead.stage_changed' || event.eventType === 'lead.reopened') return { icon: ArrowRightLeft, tone: '' }
  if (event.eventType === 'call.reviewed') return { icon: ShieldCheck, tone: '' }
  if (event.eventType.startsWith('call.')) return { icon: Video, tone: '' }
  return { icon: Target, tone: '' }
}

/** A keyed detail view prevents a response for the previous lead from reaching the new one. */
export default function Lead360(props: Lead360Props) {
  return <Lead360Content key={props.lead.id} {...props}/>
}

function Lead360Content({ lead, ownerDisplayName, stages, detailsService, activities, members, userId, userName, leadOwners, canEdit, canManage, onEdit, onClose, onSaveActivity, onSetActivityStatus, loadingActivity = false, errorActivity = '' }: Lead360Props) {
  const [tab, setTab] = useState<Tab>('overview')
  const [calls, setCalls] = useState<CallPage | null>(null)
  const [callsLoading, setCallsLoading] = useState(false)
  const [callsError, setCallsError] = useState('')
  const [events, setEvents] = useState<EventPage | null>(null)
  const [eventsLoading, setEventsLoading] = useState(false)
  const [eventsError, setEventsError] = useState('')
  const [leadActivities, setLeadActivities] = useState(() => activities.filter(item => item.leadId === lead.id))
  const [activitiesLoading, setActivitiesLoading] = useState(true)
  const [activitiesError, setActivitiesError] = useState('')
  const [activityInteractionAt, setActivityInteractionAt] = useState('')
  const [activityMutationVersion, setActivityMutationVersion] = useState(0)
  const [expandedCallId, setExpandedCallId] = useState<string | null>(null)
  const dialog = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const tabPrefix = useId()
  const closeRef = useRef(onClose)
  const serviceRef = useRef(detailsService)
  const callsRef = useRef(calls)
  const eventsRef = useRef(events)
  const callsBusy = useRef(false)
  const callsRequest = useRef(0)
  const eventsBusy = useRef(false)
  const disposed = useRef(false)
  const eventsRevision = useRef(0)
  const activitiesRequest = useRef(0)
  const activitiesBusy = useRef(false)
  const ownActivityMutations = useRef(0)
  const scopedActivitiesRef = useRef(leadActivities)
  const globalPendingFingerprint = pendingActivityFingerprint(activities, lead.id)
  const lastGlobalPendingFingerprint = useRef(globalPendingFingerprint)
  const originalFocus = useRef<HTMLElement | null>(null)
  const focusCaptured = useRef(false)
  const callFingerprint = JSON.stringify([lead.callDate, lead.attendance, lead.callScore, lead.callSummary, lead.objection, lead.pain, lead.urgency, lead.financialCapacity, lead.decisionMaker, lead.closerError, lead.recordingUrl, lead.nextStep, lead.leadershipReview])
  const lastCallFingerprint = useRef(callFingerprint)
  closeRef.current = onClose
  serviceRef.current = detailsService
  callsRef.current = calls
  eventsRef.current = events
  scopedActivitiesRef.current = leadActivities

  const loadCalls = useCallback(async (append = false, force = false) => {
    if (callsBusy.current && !force || disposed.current) return
    const offset = append ? callsRef.current?.nextOffset : undefined
    if (append && (offset === null || offset === undefined)) return
    const request = ++callsRequest.current
    callsBusy.current = true; setCallsLoading(true); setCallsError('')
    try {
      const page = await serviceRef.current.listCalls(lead.id, offset ?? undefined)
      if (disposed.current || request !== callsRequest.current) return
      setCalls(previous => ({ ...page, items: append && previous ? [...previous.items, ...page.items.filter(item => !previous.items.some(old => old.id === item.id))] : page.items }))
    } catch (cause) {
      if (!disposed.current && request === callsRequest.current) setCallsError(cause instanceof Error ? cause.message : 'Não foi possível carregar as calls. Tente novamente.')
    } finally { if (!disposed.current && request === callsRequest.current) { callsBusy.current = false; setCallsLoading(false) } }
  }, [lead.id])

  const loadEvents = useCallback(async (append = false) => {
    if (eventsBusy.current || disposed.current) return
    const cursor = append ? eventsRef.current?.nextCursor : undefined
    if (append && !cursor) return
    const revision = eventsRevision.current
    eventsBusy.current = true; setEventsLoading(true); setEventsError('')
    try {
      const page = await serviceRef.current.listEvents(lead.id, cursor ?? undefined)
      if (disposed.current || revision !== eventsRevision.current) return
      setEvents(previous => ({ ...page, items: append && previous ? [...previous.items, ...page.items.filter(item => !previous.items.some(old => old.id === item.id))] : page.items }))
    } catch (cause) {
      if (!disposed.current && revision === eventsRevision.current) setEventsError(cause instanceof Error ? cause.message : 'Não foi possível carregar a timeline. Tente novamente.')
    } finally { if (!disposed.current) { eventsBusy.current = false; setEventsLoading(false) } }
  }, [lead.id])

  const loadActivities = useCallback(async (force = false) => {
    if (activitiesBusy.current && !force || disposed.current) return
    const request = ++activitiesRequest.current
    activitiesBusy.current = true
    setActivitiesLoading(true); setActivitiesError('')
    try {
      const result = await serviceRef.current.listActivities(lead.id)
      if (!disposed.current && request === activitiesRequest.current) {
        const scoped = result.filter(item => item.leadId === lead.id)
        setLeadActivities(scoped)
        const latestUpdate = scoped.reduce((latest, item) => Number.isFinite(new Date(item.updatedAt).getTime()) && (!latest || new Date(item.updatedAt).getTime() > new Date(latest).getTime()) ? item.updatedAt : latest, '')
        if (latestUpdate) setActivityInteractionAt(previous => !previous || new Date(latestUpdate).getTime() > new Date(previous).getTime() ? latestUpdate : previous)
      }
    } catch (cause) {
      if (!disposed.current && request === activitiesRequest.current) setActivitiesError(cause instanceof Error ? cause.message : 'Não foi possível carregar as atividades. Tente novamente.')
    } finally { if (!disposed.current && request === activitiesRequest.current) { activitiesBusy.current = false; setActivitiesLoading(false) } }
  }, [lead.id])

  useEffect(() => {
    disposed.current = false
    void loadCalls()
    void loadActivities()
    return () => { disposed.current = true }
  }, [loadCalls, loadActivities])

  useEffect(() => { if (tab === 'timeline' && !events && !eventsError) void loadEvents() }, [tab, events, eventsError, eventsLoading, loadEvents])
  useEffect(() => {
    if (lastCallFingerprint.current === callFingerprint) return
    lastCallFingerprint.current = callFingerprint
    eventsRevision.current += 1; eventsRef.current = null; setEvents(null); setEventsError('')
    void loadCalls(false, true)
  }, [callFingerprint, loadCalls])
  useEffect(() => {
    if (loadingActivity || errorActivity || activitiesLoading || ownActivityMutations.current > 0 || lastGlobalPendingFingerprint.current === globalPendingFingerprint) return
    lastGlobalPendingFingerprint.current = globalPendingFingerprint
    // Unchanged polls and changes to other leads never refresh this detail view.
    if (pendingActivityFingerprint(scopedActivitiesRef.current, lead.id) === globalPendingFingerprint) return
    eventsRevision.current += 1; eventsRef.current = null; setEvents(null); setEventsError('')
    void loadActivities()
  }, [globalPendingFingerprint, loadingActivity, errorActivity, activitiesLoading, activityMutationVersion, lead.id, loadActivities])
  useEffect(() => { if (body.current) body.current.scrollTop = 0 }, [tab])

  useEffect(() => {
    if (!focusCaptured.current) { originalFocus.current = document.activeElement as HTMLElement | null; focusCaptured.current = true }
    const releaseScroll = lockDialogScroll()
    dialog.current?.querySelector<HTMLElement>('[aria-label="Fechar oportunidade"]')?.focus()
    const keyboard = (event: KeyboardEvent) => {
      const visibleDialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')).filter(item => item.getClientRects().length > 0)
      if (visibleDialogs.at(-1) !== dialog.current) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') ?? []).filter(item => item.getClientRects().length > 0)
      const first = focusable[0], last = focusable.at(-1)
      if (!first) { event.preventDefault(); dialog.current?.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keyboard, true)
    return () => { releaseScroll(); document.removeEventListener('keydown', keyboard, true); if (originalFocus.current?.isConnected) originalFocus.current.focus() }
  }, [])

  const next = nextActivity(leadActivities)
  const pendingCount = leadActivities.filter(item => item.status === 'pending').length
  const overdue = next && activityBucket(next) === 'overdue'
  const stage = stages?.find(item => item.id === lead.stageId)
  const stageName = stage?.name || getLeadStageName(lead)
  const hasOwnerName = !!ownerDisplayName && !['Não informado', 'Sem responsável', 'Responsável'].includes(ownerDisplayName)
  const ownerName = hasOwnerName ? ownerDisplayName : calls?.ownerName || ownerDisplayName || 'Sem responsável'
  const lastInteractionAt = [lead.lastContactAt, calls?.lastEventAt, activityInteractionAt, ...leadActivities.map(item => item.updatedAt)].filter((value): value is string => typeof value === 'string' && Number.isFinite(new Date(value).getTime())).reduce((latest, value) => !latest || new Date(value).getTime() > new Date(latest).getTime() ? value : latest, '') || lead.createdAt
  const stageColor = stage?.color && /^#[0-9a-f]{6}$/i.test(stage.color) ? stage.color : undefined
  const lastCall = calls?.items[0]
  const currentHistoryCall = calls?.items.find(call => call.callDate === lead.callDate || !!call.callDate && !!lead.callDate && new Date(call.callDate).getTime() === new Date(lead.callDate).getTime())
  const currentReview = validLeadershipReview(currentHistoryCall?.leadershipReview) ? currentHistoryCall.leadershipReview : undefined
  const recording = safeRecording(lead.recordingUrl)
  const statusLabel = isWon(lead) ? 'Venda fechada' : isLost(lead) ? 'Oportunidade perdida' : 'Em andamento'
  const invalidateTimeline = () => { eventsRevision.current += 1; eventsRef.current = null; setEvents(null); setEventsError('') }
  const applyActivity = async (result: Activity) => {
    if (disposed.current) return
    if (result.leadId === lead.id) setLeadActivities(previous => [...previous.filter(item => item.id !== result.id), result])
    if (result.updatedAt && Number.isFinite(new Date(result.updatedAt).getTime())) setActivityInteractionAt(previous => !previous || new Date(result.updatedAt).getTime() > new Date(previous).getTime() ? result.updatedAt : previous)
    invalidateTimeline()
    await loadActivities(true)
  }
  const finishActivityMutation = () => { ownActivityMutations.current -= 1; if (!disposed.current) setActivityMutationVersion(previous => previous + 1) }
  const saveActivity: ActivityActions['onSaveActivity'] = async (input, activityId) => {
    ownActivityMutations.current += 1
    try { const result = await onSaveActivity(input, activityId); await applyActivity(result); return result }
    finally { finishActivityMutation() }
  }
  const setActivityStatus: ActivityActions['onSetActivityStatus'] = async (activityId, status) => {
    ownActivityMutations.current += 1
    try { const result = await onSetActivityStatus(activityId, status); await applyActivity(result); return result }
    finally { finishActivityMutation() }
  }

  return <div className="l360-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="l360-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="l360-header"><span className="l360-avatar" aria-hidden="true">{initials(lead.name)}</span><div className="l360-heading"><span className="l360-eyebrow">OPORTUNIDADE 360°</span><h2 id={titleId}><span className="l360-sr-only">Oportunidade de </span>{lead.name}</h2><p className="l360-company">{lead.company || 'Empresa não informada'}</p><div className="l360-header-meta"><span className="l360-stage" style={{ '--stage-color': stageColor } as CSSProperties}><i aria-hidden="true"/>{stageName}</span><span className="l360-meta-item"><UserRound size={13}/>{ownerName}</span><span className="l360-meta-item"><TrendingUp size={13}/>{money(lead.ticket)}</span><span className="l360-meta-item"><Target size={13}/>{lead.source || 'Origem não informada'}</span><span className={`l360-pill${isWon(lead) ? ' is-success' : isLost(lead) ? ' is-danger' : ''}`}>{statusLabel}</span>{next && !activitiesLoading && !activitiesError && <span className="l360-meta-item"><CalendarDays size={13}/>Próxima ação: {formatActivityDate(next.dueAt)}</span>}{isStale(lead) && <span className="l360-pill is-warning"><Clock3 size={12}/>5+ dias sem contato</span>}</div></div><div className="l360-actions">{canEdit && <button type="button" className="l360-button" aria-label="Editar oportunidade" onClick={() => onEdit(lead)}><Pencil size={13}/>Editar</button>}<button type="button" className="l360-icon-button" aria-label="Fechar oportunidade" onClick={onClose}><X size={20}/></button></div></header>
      <nav className="l360-tabs" role="tablist" aria-label="Seções da oportunidade">{tabs.map(({ id, label, icon: Icon }, index) => <button key={id} type="button" id={`${tabPrefix}-${id}`} className="l360-tab" role="tab" aria-selected={tab === id} aria-controls={`${tabPrefix}-${id}-panel`} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={event => {
        const nextIndex = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined
        if (nextIndex === undefined) return
        event.preventDefault(); setTab(tabs[nextIndex].id); document.getElementById(`${tabPrefix}-${tabs[nextIndex].id}`)?.focus()
      }}><Icon size={14}/>{label}{id === 'calls' && calls && <span className="l360-tab-count" aria-hidden="true">{calls.callCount}</span>}{id === 'activities' && pendingCount > 0 && <span className="l360-tab-count" aria-hidden="true">{pendingCount}</span>}</button>)}</nav>
      <div className="l360-body" ref={body}>
        <div className="l360-panel" role="tabpanel" id={`${tabPrefix}-${tab}-panel`} aria-labelledby={`${tabPrefix}-${tab}`} aria-busy={tab === 'calls' ? callsLoading : tab === 'timeline' ? eventsLoading : undefined}>
          {tab === 'overview' && <>
            {isStale(lead) && <div className="l360-alert"><Clock3 size={16}/><p><strong>Mais de 5 dias sem contato.</strong> Retome a conversa ou combine a próxima ação para esta oportunidade.</p></div>}
            <dl className="l360-summary"><div className="l360-stat"><dt><TrendingUp size={13}/>Valor potencial</dt><dd>{money(lead.ticket)}</dd></div><div className="l360-stat"><dt><Layers3 size={13}/>Etapa atual</dt><dd>{stageName}</dd></div><div className="l360-stat"><dt><UserRound size={13}/>Responsável</dt><dd>{ownerName}</dd></div><div className="l360-stat"><dt><MessageSquare size={13}/>Última interação</dt><dd>{safeDate(lastInteractionAt)}</dd></div><div className="l360-stat"><dt><CalendarDays size={13}/>Próxima atividade</dt><dd>{activitiesLoading ? 'Carregando...' : activitiesError ? 'Indisponível' : next ? formatActivityDate(next.dueAt) : 'Não agendada'}{next && !activitiesLoading && !activitiesError && <small>{next.title}</small>}</dd></div><div className="l360-stat"><dt><Video size={13}/>Calls registradas</dt><dd aria-live="polite">{calls ? calls.callCount : callsError ? 'Indisponível' : 'Carregando...'}{calls && <small>{lastCall?.callScore !== undefined && lastCall.callScore !== null ? `Última nota: ${lastCall.callScore}/10` : calls.callCount ? 'Última call ainda sem nota' : 'Nenhuma call registrada'}</small>}</dd></div></dl>
            {isWon(lead) && <section className="l360-outcome is-won"><h3><BadgeCheck size={15}/>Venda fechada</h3><p>{money(lead.closedValue)}</p><small>Fechamento em {safeDate(lead.closedAt)}</small></section>}
            {isLost(lead) && <section className="l360-outcome is-lost"><h3><Flag size={15}/>Motivo da perda</h3><p>{lead.lossReason || 'Motivo ainda não registrado.'}</p>{lead.lossComment && <small>{lead.lossComment}</small>}</section>}
            <div className="l360-overview-grid"><div className="l360-column">
              <section className="l360-card"><div className="l360-card-heading"><h3><UserRound size={16}/>Dados do lead</h3></div><dl className="l360-detail-grid"><Detail label="Nome" value={lead.name}/><Detail label="Empresa" value={lead.company}/><Detail label="E-mail" value={lead.email}/><Detail label="Telefone / WhatsApp" value={lead.phone}/><Detail label="Origem" value={lead.source}/><Detail label="Cadastrado em" value={safeDate(lead.createdAt)}/></dl></section>
              <section className="l360-card"><div className="l360-card-heading"><h3><Target size={16}/>Diagnóstico comercial</h3></div><dl className="l360-detail-grid"><Detail label="Dor principal" value={lead.pain} wide/><Detail label="Objeção principal" value={lead.objection} wide/><Detail label="Urgência" value={lead.urgency}/><Detail label="Capacidade financeira" value={lead.financialCapacity}/><Detail label="Poder de decisão" value={lead.decisionMaker ? 'É decisor' : 'Decisão ainda não confirmada'} wide/></dl></section>
              <section className="l360-card"><div className="l360-card-heading"><h3><MessageSquare size={16}/>Observações</h3></div><p className={`l360-note${!lead.notes ? ' l360-muted' : ''}`}>{lead.notes || 'Nenhuma observação adicionada.'}</p></section>
            </div><div className="l360-column">
              <section className="l360-card"><div className="l360-card-heading"><h3><CalendarDays size={16}/>Próxima ação</h3><button type="button" className="l360-text-button" onClick={() => setTab('activities')}>{canEdit ? 'Gerenciar atividades' : 'Ver atividades'}</button></div>{activitiesLoading || activitiesError ? <LoadingState loading={activitiesLoading} error={activitiesError} compact onRetry={() => void loadActivities()}/> : next ? <><div className={`l360-next-action${overdue ? ' is-overdue' : ''}`}><span className="l360-next-icon"><ClipboardList size={18}/></span><div><strong>{next.title}</strong><p>{activityTypeLabel(next.type)} · {formatActivityDate(next.dueAt)}</p><small><UserRound size={11}/> {next.assignedName || members.find(member => member.userId === next.assignedTo)?.displayName || 'Responsável não informado'}</small></div></div>{overdue && <span className="l360-pill is-warning l360-overdue-label">{overdueActivityLabel(next)}</span>}{next.description && <p className="l360-next-description">{next.description}</p>}</> : <div className="l360-empty is-compact"><CalendarDays size={22}/><p>Nenhuma atividade pendente.{canEdit ? ' Combine o próximo contato na aba Atividades.' : ''}</p></div>}</section>
              <section className="l360-card"><div className="l360-card-heading"><h3><Video size={16}/>{lead.attendance === 'Pendente' && lead.callDate ? 'Call agendada' : 'Call atual'}</h3><button type="button" className="l360-text-button" onClick={() => setTab('calls')}>Ver histórico</button></div>{lead.callDate || lead.callSummary || lead.callScore !== null ? <><div className="l360-call-header"><div><strong className="l360-call-date">{safeDate(lead.callDate)}</strong></div><div className="l360-call-badges"><span className="l360-pill">{lead.attendance}</span><Score value={lead.callScore}/></div></div>{lead.callSummary && <p className="l360-note l360-summary-preview">{lead.callSummary}</p>}{lead.nextStep && <div className="l360-current-next"><span className="l360-call-label">Próximo passo combinado</span><p className="l360-note">{lead.nextStep}</p></div>}{recording && <a className="l360-button l360-current-recording" href={recording} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><Play size={13}/>Assistir gravação<ExternalLink size={12}/></a>}</> : <div className="l360-empty is-compact"><Video size={23}/><p>Nenhuma call registrada para esta oportunidade.</p></div>}{currentReview && <section className="l360-call-review"><div className="l360-call-review-heading"><strong><ShieldCheck size={15}/>Revisão da liderança</strong><Score value={currentReview.score}/></div><p>{currentReview.feedback}</p><small>{currentReview.reviewerName || 'Liderança'} · {safeDate(currentReview.reviewedAt)}</small></section>}</section>
              {callsError && <section className="l360-card"><LoadingState loading={callsLoading} error={callsError} compact onRetry={() => void loadCalls()}/></section>}
            </div></div>
          </>}
          {tab === 'calls' && <><div className="l360-section-title"><div><h3><Video size={17}/>Histórico de calls</h3><p>Conversas, diagnóstico e feedback desta oportunidade.</p></div></div>{!calls ? <LoadingState loading={callsLoading} error={callsError} onRetry={() => void loadCalls()}/> : calls.items.length ? <div className="l360-call-list">{calls.items.map(call => <CallCard key={call.id} call={call} expanded={expandedCallId === call.id} onToggle={() => setExpandedCallId(current => current === call.id ? null : call.id)}/>)}</div> : <div className="l360-empty"><Video size={30}/><h3>A primeira conversa começa aqui</h3><p>As calls registradas para esta oportunidade aparecerão neste histórico.</p></div>}{calls && callsError && <LoadingState loading={callsLoading} error={callsError} compact onRetry={() => void loadCalls(Boolean(calls.nextOffset !== null))}/>} {calls?.nextOffset !== null && calls?.nextOffset !== undefined && <div className="l360-pagination"><button type="button" className="l360-button" disabled={callsLoading} onClick={() => void loadCalls(true)}>{callsLoading && <LoaderCircle size={14} className="l360-spinning"/>}Carregar mais calls</button></div>}</>}
          {tab === 'activities' && <ActivityList embedded lead={lead} activities={leadActivities} leads={[lead]} members={members} userId={userId} userName={userName} leadOwners={leadOwners} canEdit={canEdit} canManage={canManage} onSaveActivity={saveActivity} onSetActivityStatus={setActivityStatus} loading={activitiesLoading} error={activitiesError} onRetry={() => void loadActivities()}/>}
          {tab === 'timeline' && <><div className="l360-section-title"><div><h3><History size={17}/>História da oportunidade</h3><p>As movimentações comerciais mais recentes aparecem primeiro.</p></div></div>{!events ? <LoadingState loading={eventsLoading} error={eventsError} onRetry={() => void loadEvents()}/> : events.items.length ? <ol className="l360-timeline">{events.items.map(event => {
            const { title, detail } = eventPresentation(event), { icon: Icon, tone } = eventIcon(event)
            return <li className={`l360-event ${tone}`} key={event.id}><span className="l360-event-icon"><Icon size={14}/></span><div><div className="l360-event-header"><h4>{title}</h4><time dateTime={event.createdAt}>{safeDate(event.createdAt)}</time></div>{detail && <p>{detail}</p>}<small className="l360-event-byline">{event.actorName || (event.actorId ? 'Autor não disponível' : 'Sistema')}</small></div></li>
          })}</ol> : <div className="l360-empty"><History size={30}/><h3>Uma história para construir</h3><p>Novas calls, atividades e movimentações aparecerão automaticamente aqui.</p></div>}{events && eventsError && <LoadingState loading={eventsLoading} error={eventsError} compact onRetry={() => void loadEvents(Boolean(events.nextCursor))}/>} {events?.nextCursor && <div className="l360-pagination"><button type="button" className="l360-button" disabled={eventsLoading} onClick={() => void loadEvents(true)}>{eventsLoading && <LoaderCircle size={14} className="l360-spinning"/>}Carregar mais eventos</button></div>}</>}
        </div>
      </div>
    </section>
  </div>
}
