import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowRightLeft, Check, LoaderCircle, X } from 'lucide-react'
import { LOSS_REASONS, type Lead, type PipelineStage } from '../types'
import { money } from '../lib/analytics'
import './pipeline-features.css'

export interface StageTransitionInput {
  closedValue?: number
  lossReason?: string
  lossComment?: string
}

interface PipelineFeatureDialogProps {
  title: string
  description?: string
  children: ReactNode
  onClose: () => void
  busy?: boolean
  icon?: ReactNode
}

/** Shared dialog shell for pipeline configuration and explicit stage outcomes. */
export function PipelineFeatureDialog({ title, description, children, onClose, busy = false, icon }: PipelineFeatureDialogProps) {
  const titleId = useId()
  const dialog = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const first = dialog.current?.querySelector<HTMLElement>('[data-autofocus]')
      ?? dialog.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')
      ?? dialog.current?.querySelector<HTMLElement>('button:not(:disabled)')
    first?.focus()
    return () => { document.body.style.overflow = previousOverflow; previous?.focus() }
  }, [])

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!busy) closeRef.current()
      }
      if (event.key !== 'Tab') return
      event.stopImmediatePropagation()
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') ?? [])
        .filter(element => element.getClientRects().length > 0)
      if (!focusable.length) { event.preventDefault(); return }
      const first = focusable[0], last = focusable.at(-1)
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keyboard, true)
    return () => document.removeEventListener('keydown', keyboard, true)
  }, [busy])

  return <div className="pf-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section ref={dialog} className="pf-dialog" role="dialog" aria-modal="true" aria-busy={busy} aria-labelledby={titleId}>
      <header className="pf-dialog-header">
        {icon && <span className="pf-dialog-icon">{icon}</span>}
        <div><h2 id={titleId}>{title}</h2>{description && <p>{description}</p>}</div>
        <button type="button" className="icon-button" aria-label="Fechar janela" disabled={busy} onClick={onClose}><X size={20}/></button>
      </header>
      {children}
    </section>
  </div>
}

export default function StageTransitionModal({ lead, stage, onConfirm, onClose }: {
  lead: Lead
  stage: PipelineStage
  onConfirm: (input: StageTransitionInput) => void | Promise<void>
  onClose: () => void
}) {
  const won = stage.type === 'WON'
  const [closedValue, setClosedValue] = useState(lead.closedValue > 0 ? String(lead.closedValue) : '')
  const [reason, setReason] = useState(LOSS_REASONS.includes(lead.lossReason as typeof LOSS_REASONS[number]) ? lead.lossReason! : '')
  const [comment, setComment] = useState(lead.lossComment || '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (pending) return
    const value = Number(closedValue)
    if (won && (!Number.isFinite(value) || value <= 0)) { setError('Informe o valor realmente fechado, maior que zero.'); return }
    if (!won && !LOSS_REASONS.includes(reason as typeof LOSS_REASONS[number])) { setError('Selecione o motivo da perda.'); return }
    setPending(true); setError('')
    try {
      await onConfirm(won ? { closedValue: value } : { lossReason: reason, lossComment: comment.trim() })
      onClose()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível atualizar esta oportunidade. Tente novamente.') }
    finally { setPending(false) }
  }

  return <PipelineFeatureDialog title={won ? 'Confirmar fechamento' : 'Por que esta oportunidade foi perdida?'} description={`Registre o resultado de ${lead.name} na etapa ${stage.name}.`} onClose={onClose} busy={pending} icon={<ArrowRightLeft size={22}/>}>
    <form className="pf-transition-form" onSubmit={event => void save(event)}>
      <div className="pf-transition-body">
        <div className="pf-transition-lead"><strong>{lead.name}</strong><span>{lead.company || 'Pessoa física'}</span><small>Ticket previsto: {money(lead.ticket)}</small></div>
        {won ? <label className="pf-field">Valor fechado (R$)<input data-autofocus type="number" required min="0.01" step="0.01" value={closedValue} disabled={pending} onChange={event => setClosedValue(event.target.value)} placeholder="Valor confirmado da venda"/><small>O faturamento considera o valor fechado informado.</small></label> : <>
          <label className="pf-field">Motivo da perda<select data-autofocus required value={reason} disabled={pending} onChange={event => setReason(event.target.value)}><option value="">Selecione um motivo</option>{LOSS_REASONS.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
          <label className="pf-field">Comentário adicional<textarea rows={4} maxLength={4000} value={comment} disabled={pending} onChange={event => setComment(event.target.value)} placeholder="Contexto e pontos importantes para aprender com esta oportunidade"/></label>
        </>}
        {error && <p className="pf-error" role="alert">{error}</p>}
      </div>
      <footer className="pf-dialog-footer"><button type="button" className="button button-secondary" disabled={pending} onClick={onClose}>Cancelar</button><button type="submit" className="button button-primary" disabled={pending}>{pending ? <LoaderCircle size={16} className="pf-spinning"/> : <Check size={16}/>} {won ? 'Confirmar fechamento' : 'Registrar perda'}</button></footer>
    </form>
  </PipelineFeatureDialog>
}
