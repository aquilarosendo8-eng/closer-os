import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { CalendarCheck2, Check, LoaderCircle, X } from 'lucide-react'
import type { Lead } from '../types'
import { ACTIVITY_TYPES, ACTIVITY_TYPE_LABELS, type Activity, type ActivityInput, type ActivityMember, type ActivityType, type ActivityViewProps } from '../lib/opportunity-types'
import { activityDateFields, activityDateToIso, validActivityInput } from '../lib/opportunity'
import { lockDialogScroll } from '../lib/dialog-scroll'
import './activities.css'

export interface ActivityFormProps extends Pick<ActivityViewProps, 'leads' | 'members' | 'userId' | 'userName' | 'leadOwners' | 'canEdit' | 'canManage'> {
  lead?: Lead
  activity?: Activity
  onSave: (input: ActivityInput, activityId?: string) => Promise<Activity>
  onClose: () => void
}

export interface ActivityDialogProps {
  title: string
  description?: string
  children: ReactNode
  onClose: () => void
  busy?: boolean
  labelId?: string
}

/** Window capture keeps a nested opportunity drawer from receiving modal keyboard events. */
export function ActivityDialog({ title, description, children, onClose, busy = false, labelId }: ActivityDialogProps) {
  const generatedTitleId = useId()
  const titleId = labelId || generatedTitleId
  const descriptionId = useId()
  const dialog = useRef<HTMLElement>(null)
  const busyRef = useRef(busy)
  busyRef.current = busy
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const close = () => { if (!busyRef.current) closeRef.current() }

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    const originList = previousFocus?.closest('.at-list') || dialog.current?.closest('.at-list')
    const fallbackFocus = originList?.querySelector<HTMLElement>('.at-toolbar input:not(:disabled), .at-toolbar button:not(:disabled)') || null
    const releaseScroll = lockDialogScroll()
    const first = dialog.current?.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)')
      || dialog.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)')
    ;(first || dialog.current)?.focus()

    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!busyRef.current) closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      event.stopImmediatePropagation()
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])') || [])
        .filter(element => !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true' && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
      if (!focusable.length) { event.preventDefault(); dialog.current?.focus(); return }
      const first = focusable[0], last = focusable[focusable.length - 1]
      const outside = !dialog.current?.contains(document.activeElement) || document.activeElement === dialog.current
      if (event.shiftKey && (document.activeElement === first || outside)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || outside)) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', keyboard, true)
    return () => {
      window.removeEventListener('keydown', keyboard, true)
      releaseScroll()
      const restoredFocus = previousFocus?.isConnected && !previousFocus.matches(':disabled') ? previousFocus : fallbackFocus?.isConnected && !fallbackFocus.matches(':disabled') ? fallbackFocus : null
      restoredFocus?.focus()
    }
  }, [])

  return <div className="at-modal-backdrop" onMouseDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) close() }}>
    <section ref={dialog} className="at-modal" tabIndex={-1} role="dialog" aria-modal="true" aria-busy={busy} aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}>
      <header className="at-modal-header">
        <span className="at-modal-icon"><CalendarCheck2 size={21} aria-hidden="true" /></span>
        <div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div>
        <button type="button" className="at-icon-button" aria-label="Fechar atividade" disabled={busy} onClick={close}><X size={20} /></button>
      </header>
      {children}
    </section>
  </div>
}

export default function ActivityForm({ leads, members, userId, userName, leadOwners = {}, canEdit, canManage, lead, activity, onSave, onClose }: ActivityFormProps) {
  const pending = useRef(false)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const availableLeads = canManage ? leads : leads.filter(item => leadOwners[item.id] === userId)
  const initialLeadId = activity?.leadId || lead?.id || availableLeads[0]?.id || ''
  const self: ActivityMember = members.find(member => member.userId === userId) || { userId, displayName: userName || 'Você' }
  const assignableMembers = [...new Map([...members, ...(userId ? [self] : [])].map(member => [member.userId, member])).values()]
  const defaultAssignee = (id: string) => canManage && assignableMembers.some(member => member.userId === leadOwners[id]) ? leadOwners[id] : userId
  const [leadId, setLeadId] = useState(initialLeadId)
  const [assignedTo, setAssignedTo] = useState(activity?.assignedTo || defaultAssignee(initialLeadId))
  const [title, setTitle] = useState(activity?.title || '')
  const [type, setType] = useState<ActivityType>(activity?.type || 'follow_up')
  const [description, setDescription] = useState(activity?.description || '')
  const [dateFields, setDateFields] = useState(() => {
    if (activity && !Number.isFinite(new Date(activity.dueAt).getTime())) return { date: '', time: '' }
    return activityDateFields(activity?.dueAt || new Date(Date.now() + 60 * 60 * 1000))
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const finalState = Boolean(activity && activity.status !== 'pending')
  const fixedLead = Boolean(lead || activity)
  const selectedLead = leads.find(item => item.id === leadId) || (lead?.id === leadId ? lead : undefined)
  const permitted = canEdit && Boolean(userId) && (canManage || leadOwners[leadId] === userId)
  const editable = permitted && !finalState
  const selectedMembers = canManage ? assignableMembers : userId ? [self] : []
  const assigneeOptions = [...selectedMembers]
  if (activity?.assignedTo && !assigneeOptions.some(member => member.userId === activity.assignedTo)) {
    assigneeOptions.push({ userId: activity.assignedTo, displayName: activity.assignedName || 'Responsável atual' })
  }
  const assigneeUnavailable = Boolean(assignedTo && !assigneeOptions.some(member => member.userId === assignedTo))
  const leadOptions = fixedLead ? selectedLead ? [selectedLead] : [] : availableLeads
  const readonlyReason = finalState
    ? 'Atividades concluídas ou canceladas ficam disponíveis apenas para consulta.'
    : !canEdit ? 'Você tem acesso somente para consulta.'
    : !permitted ? 'A edição está disponível para o responsável pela oportunidade e para a liderança.' : ''
  const close = () => { if (!pending.current) closeRef.current() }

  const changeLead = (id: string) => {
    if (pending.current || !canEdit || fixedLead || finalState || !availableLeads.some(item => item.id === id)) return
    setLeadId(id)
    setAssignedTo(defaultAssignee(id))
    setError('')
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending.current || !editable) return
    if (!selectedLead || (fixedLead && leadId !== (activity?.leadId || lead?.id))) { setError('Selecione uma oportunidade disponível.'); return }
    if (!title.trim() || title.trim().length > 180 || /[\u0000-\u001f\u007f-\u009f]/.test(title)) { setError('Informe um título válido de até 180 caracteres.'); return }
    if (description.length > 4000) { setError('A descrição pode ter até 4.000 caracteres.'); return }
    const preservedAssignee = Boolean(activity && assignedTo === activity.assignedTo)
    if (!assignedTo || (!preservedAssignee && (canManage ? !assignableMembers.some(member => member.userId === assignedTo) : assignedTo !== userId))) {
      setError('Selecione um responsável disponível para esta atividade.')
      return
    }
    let dueAt: string
    try { dueAt = activityDateToIso(dateFields.date, dateFields.time) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Informe uma data e um horário válidos.'); return }
    const input: ActivityInput = { leadId, assignedTo, title: title.trim(), type, description, dueAt }
    if (!validActivityInput(input)) { setError('Confira o título, o tipo, a data e o responsável pela atividade.'); return }
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await onSave(input, activity?.id)
      closeRef.current()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar. Suas alterações foram mantidas; tente novamente.')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return <ActivityDialog title={activity ? 'Editar atividade' : 'Nova atividade'} description="Defina o próximo passo para esta oportunidade." onClose={close} busy={busy}>
      <form className="at-modal-form" onSubmit={event => void save(event)}>
        <div className="at-modal-body">
          {error && <p className="at-error" role="alert">{error}</p>}
          {readonlyReason && <p className="at-form-help" role="status">{readonlyReason}</p>}
          <div className="at-form-grid">
            <label className="at-form-field at-form-wide">Título da atividade<input data-autofocus required maxLength={180} disabled={!editable || busy} value={title} onChange={event => { setTitle(event.target.value); setError('') }} placeholder="Ex.: Retomar a proposta com o decisor" /></label>
            <label className="at-form-field">Tipo de atividade<select aria-label="Tipo de atividade" disabled={!editable || busy} value={type} onChange={event => { setType(event.target.value as ActivityType); setError('') }}>{ACTIVITY_TYPES.map(value => <option key={value} value={value}>{ACTIVITY_TYPE_LABELS[value]}</option>)}</select></label>
            <label className="at-form-field">Oportunidade<select aria-label="Oportunidade" required disabled={fixedLead || !canEdit || busy || finalState || !availableLeads.length} value={leadId} onChange={event => changeLead(event.target.value)}>{!leadOptions.some(item => item.id === leadId) && <option value={leadId}>{leadId ? 'Oportunidade indisponível' : 'Selecione uma oportunidade'}</option>}{leadOptions.map(item => <option key={item.id} value={item.id}>{item.name}{item.company ? ` · ${item.company}` : ''}</option>)}</select></label>
            <label className="at-form-field">Data da atividade<input type="date" required disabled={!editable || busy} value={dateFields.date} onChange={event => { setDateFields(current => ({ ...current, date: event.target.value })); setError('') }} /></label>
            <label className="at-form-field">Hora da atividade<input type="time" required disabled={!editable || busy} value={dateFields.time} onChange={event => { setDateFields(current => ({ ...current, time: event.target.value })); setError('') }} /></label>
            <p className="at-form-help at-form-wide">Horário de Brasília (UTC−3).</p>
            <label className="at-form-field at-form-wide">Responsável pela atividade<select aria-label="Responsável pela atividade" required disabled={!editable || busy || (!canManage && assigneeOptions.length < 2)} value={assignedTo} onChange={event => { setAssignedTo(event.target.value); setError('') }}>{assigneeUnavailable && <option value={assignedTo} disabled>Responsável indisponível</option>}{!assignedTo && <option value="">Selecione um responsável</option>}{assigneeOptions.map(member => <option key={member.userId} value={member.userId}>{member.displayName || member.email || (member.userId === userId ? userName || 'Você' : 'Membro da equipe')}</option>)}</select></label>
            <label className="at-form-field at-form-wide">Descrição da atividade<textarea rows={4} maxLength={4000} disabled={!editable || busy} value={description} onChange={event => { setDescription(event.target.value); setError('') }} placeholder="Contexto, objetivo e o que vale lembrar…" /></label>
          </div>
        </div>
        <footer className="at-modal-footer">
          <button type="button" className="button button-secondary" disabled={busy} onClick={close}>Cancelar</button>
          {editable && <button type="submit" className="button button-primary" disabled={busy || !selectedLead}>{busy ? <LoaderCircle size={16} className="at-spinning" aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{busy ? 'Salvando…' : activity ? 'Salvar atividade' : 'Criar atividade'}</button>}
        </footer>
      </form>
  </ActivityDialog>
}
