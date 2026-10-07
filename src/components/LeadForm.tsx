import { useState } from 'react'
import { Building2, Check, Trash2, UserRound, X } from 'lucide-react'
import { LOSS_REASONS, type Lead, type PipelineStage } from '../types'
import { defaultPipelineStages, getLeadStageType, isWon, isLost, leadInStage, stageLead, transitionLead } from '../lib/pipeline'
import StageTransitionModal from './StageTransitionModal'

const localDate = (value: string) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
export function makeLead(): Lead {
  return { id: crypto.randomUUID(), name: '', company: '', email: '', phone: '', ticket: 0, source: 'Instagram', createdAt: new Date().toISOString(), callDate: '', attendance: 'Pendente', objection: '', status: 'Lead novo', closedValue: 0, closedAt: '', lastContactAt: new Date().toISOString(), notes: '', pain: '', urgency: 'Média', financialCapacity: 'Não avaliada', decisionMaker: false, callScore: null, closerError: '', callSummary: '' }
}
interface LeadFormProps {
  lead: Lead
  isNew: boolean
  onSave: (lead: Lead, ownerId?: string) => void | Promise<void>
  onClose: () => void
  onDelete: (id: string) => void | Promise<void>
  canEdit?: boolean
  canDelete?: boolean
  members?: { userId: string; displayName: string; email: string }[]
  ownerId?: string
  canAssign?: boolean
  stages?: PipelineStage[]
}
export default function LeadForm({ lead, isNew, onSave, onClose, onDelete, canEdit = true, canDelete = true, members, ownerId, canAssign = false, stages = defaultPipelineStages() }: LeadFormProps) {
  const initialStage = stages.find(stage => leadInStage(lead, stage))
  const [draft, setDraft] = useState(() => initialStage ? { ...lead, stageId: initialStage.id, stageType: initialStage.type, stageName: initialStage.name } : lead)
  const [transitionStage, setTransitionStage] = useState<PipelineStage | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [selectedOwner, setSelectedOwner] = useState(ownerId || '')
  const set = <K extends keyof Lead>(key: K, value: Lead[K]) => setDraft(current => ({ ...current, [key]: value }))
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canEdit || saving) return
    if (isLost(draft) && (isNew || getLeadStageType(lead) !== 'LOST' || Boolean(lead.lossReason)) && !LOSS_REASONS.includes(draft.lossReason as typeof LOSS_REASONS[number])) { setError('Selecione o motivo da perda.'); return }
    setSaving(true); setError('')
    try {
      await onSave({ ...draft, name: draft.name.trim(), company: draft.company.trim(), attendance: isWon(draft) ? 'Compareceu' : draft.attendance, closedAt: isWon(draft) ? draft.closedAt || new Date().toISOString() : '', closedValue: isWon(draft) ? draft.closedValue : 0 }, canAssign ? selectedOwner || undefined : undefined)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível salvar. Suas alterações continuam neste formulário.') }
    finally { setSaving(false) }
  }
  const remove = async () => {
    if (!canDelete || saving) return
    setSaving(true); setError('')
    try { await onDelete(draft.id) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível excluir este lead.'); setConfirmDelete(false) }
    finally { setSaving(false) }
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className="lead-drawer" role="dialog" aria-modal="true" aria-labelledby="lead-dialog-title"><header className="drawer-header"><div className="drawer-heading-icon"><UserRound size={21} /></div><div><h2 id="lead-dialog-title">{isNew ? 'Uma nova oportunidade' : draft.name}</h2><p>{isNew ? 'Boas vendas começam com boas conversas.' : 'Cada detalhe ajuda a construir o próximo sim.'}</p></div><button type="button" className="icon-button" aria-label="Fechar formulário" onClick={onClose}><X size={21} /></button></header><form onSubmit={event => void save(event)} className="lead-form"><div className="form-scroll"><fieldset disabled={!canEdit || saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}><div className="form-section-title"><UserRound size={15} />Sobre o lead</div><div className="form-grid"><label className="full-field">Nome do lead <span>*</span><input required autoFocus maxLength={100} value={draft.name} onChange={event => set('name', event.target.value)} placeholder="Ex.: Mariana Costa" /></label><label className="full-field">Empresa<input maxLength={120} value={draft.company} onChange={event => set('company', event.target.value)} placeholder="Nome da empresa" /></label><label>E-mail<input type="email" value={draft.email} onChange={event => set('email', event.target.value)} placeholder="nome@empresa.com" /></label><label>WhatsApp<input type="tel" value={draft.phone} onChange={event => set('phone', event.target.value)} placeholder="(11) 99999-9999" /></label><label>Origem<select value={draft.source} onChange={event => set('source', event.target.value)}>{['Instagram', 'Indicação', 'Tráfego pago', 'LinkedIn', 'Outbound', 'Orgânico', 'Evento', 'Outro', ...(!['Instagram', 'Indicação', 'Tráfego pago', 'LinkedIn', 'Outbound', 'Orgânico', 'Evento', 'Outro'].includes(draft.source) ? [draft.source] : [])].map(source => <option key={source}>{source}</option>)}</select></label><label>Ticket previsto (R$)<input type="number" min="0" step="0.01" value={draft.ticket || ''} onChange={event => set('ticket', Number(event.target.value))} placeholder="15.000" /></label></div>{canAssign && members && <div className="form-grid"><label className="full-field">Responsável<select value={selectedOwner} onChange={event => setSelectedOwner(event.target.value)}><option value="">Selecionar responsável</option>{members.map(member => <option value={member.userId} key={member.userId}>{member.displayName || member.email}</option>)}</select></label></div>}<div className="form-section-title"><Building2 size={15} />Oportunidade e call</div><div className="form-grid"><label>Status<select value={draft.stageId || initialStage?.id || ''} onChange={event => {
      const stage = stages.find(item => item.id === event.target.value && item.active)
      if (stage?.type === 'LOST' && !isLost(draft)) setTransitionStage(stage)
      else if (stage) setDraft(current => stageLead(current, stage))
    }}>{stages.filter(stage => stage.active || stage.id === draft.stageId).map(stage => <option key={stage.id} value={stage.id} disabled={!stage.active}>{stage.name}{!stage.active ? ' (desativada)' : ''}</option>)}</select></label><label>Comparecimento<select value={draft.attendance} onChange={event => set('attendance', event.target.value as Lead['attendance'])} disabled={isWon(draft)}><option>Pendente</option><option>Compareceu</option><option>Não compareceu</option></select></label><label className="full-field">Data da call<input type="datetime-local" value={localDate(draft.callDate)} onChange={event => set('callDate', event.target.value ? new Date(event.target.value).toISOString() : '')} /></label><label className="full-field">Último contato<input type="datetime-local" required value={localDate(draft.lastContactAt)} onChange={event => set('lastContactAt', event.target.value ? new Date(event.target.value).toISOString() : '')} /><small>Após 5 dias sem contato, o lead aparece em vermelho.</small></label>{isWon(draft) && <><label>Valor fechado (R$) <span>*</span><input required type="number" min="0.01" step="0.01" value={draft.closedValue || ''} onChange={event => set('closedValue', Number(event.target.value))} /></label><label>Data de fechamento<input type="datetime-local" value={localDate(draft.closedAt)} onChange={event => set('closedAt', event.target.value ? new Date(event.target.value).toISOString() : '')} /></label></>}{isLost(draft) && <><label className="full-field">Motivo da perda <span>*</span><select aria-label="Motivo da perda" required={isNew || getLeadStageType(lead) !== 'LOST' || Boolean(lead.lossReason)} value={draft.lossReason || ''} onChange={event => set('lossReason', event.target.value)}><option value="">Selecione o motivo</option>{LOSS_REASONS.map(reason => <option key={reason}>{reason}</option>)}</select></label><label className="full-field">Comentário sobre a perda<textarea maxLength={4000} rows={3} value={draft.lossComment || ''} onChange={event => set('lossComment', event.target.value)} placeholder="Contexto adicional para entender a perda" /></label></>}<label className="full-field">Objeção principal<input list="objections" maxLength={100} value={draft.objection} onChange={event => set('objection', event.target.value)} placeholder="Qual é a principal barreira para o sim?" /><datalist id="objections"><option value="Preço" /><option value="Momento" /><option value="Decisor" /><option value="Confiança" /><option value="Caixa" /></datalist></label><label className="full-field">Observações<textarea rows={4} value={draft.notes} onChange={event => set('notes', event.target.value)} placeholder="Contexto, próximos passos e o que vale lembrar…" /></label></div></fieldset>{error && <p role="alert">{error}</p>}{!canEdit && <p className="muted">Você tem acesso somente para consulta.</p>}</div><footer className="drawer-footer">{!isNew && canDelete && <button type="button" className="icon-button danger" aria-label="Excluir lead" disabled={saving} onClick={() => setConfirmDelete(true)}><Trash2 size={18} /></button>}<button type="button" className="button button-secondary" onClick={onClose}>{canEdit ? 'Cancelar' : 'Fechar'}</button>{canEdit && <button type="submit" disabled={saving} className="button button-primary"><Check size={16} />{saving ? 'Salvando…' : isNew ? 'Cadastrar lead' : 'Salvar alterações'}</button>}</footer></form>{confirmDelete && <div className="drawer-confirm"><div><Trash2 size={28} /><h3>Excluir este lead?</h3><p>Os dados desta oportunidade serão removidos, incluindo a avaliação da call.</p><button className="button button-danger" disabled={saving} onClick={() => void remove()}>{saving ? 'Excluindo…' : 'Excluir lead'}</button><button className="button button-secondary" onClick={() => setConfirmDelete(false)}>Manter lead</button></div></div>}</section>{transitionStage && <StageTransitionModal lead={draft} stage={transitionStage} onClose={() => setTransitionStage(null)} onConfirm={input => { setDraft(current => transitionLead(current, transitionStage, input.closedValue, input.lossReason, input.lossComment)) }} />}</div>
}
