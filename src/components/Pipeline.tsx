import { useState } from 'react'
import { AlertCircle, ArrowUpRight, CalendarDays, Columns3, LayoutList, Plus, Search, Settings2, SlidersHorizontal, UserRound } from 'lucide-react'
import type { Lead, PipelineStage } from '../types'
import type { Activity } from '../lib/opportunity-types'
import { nextActivity, overdueActivityLabel, formatActivityDate, activityTypeLabel } from '../lib/opportunity'
import { initials, isStale, money } from '../lib/analytics'
import { defaultPipelineStages, leadInStage, leadStageType, transitionLead } from '../lib/pipeline'
import PipelineConfiguration from './PipelineConfiguration'
import StageTransitionModal, { type StageTransitionInput } from './StageTransitionModal'
import './pipeline-features.css'

interface PipelineProps {
  leads: Lead[]
  stages?: PipelineStage[]
  onEdit: (lead: Lead) => void
  onAdd: (stage?: PipelineStage) => void
  onUpdate: (lead: Lead) => void | Promise<void>
  canEdit?: boolean
  canConfigure?: boolean
  onSaveStages?: (stages: PipelineStage[]) => Promise<void>
  owners?: Record<string, string>
  onOpen?: (lead: Lead) => void
  activities?: Activity[]
  now?: Date
}

export default function Pipeline({ leads, stages, onEdit, onAdd, onUpdate, canEdit = true, canConfigure = false, onSaveStages, owners = {}, onOpen, activities = [], now = new Date() }: PipelineProps) {
  const [search, setSearch] = useState('')
  const [view, setView] = useState<'board' | 'list'>('board')
  const [source, setSource] = useState('Todas as origens')
  const [onlyStale, setOnlyStale] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const [configuring, setConfiguring] = useState(false)
  const [transition, setTransition] = useState<{ lead: Lead; stage: PipelineStage } | null>(null)
  const [error, setError] = useState('')
  const configured = [...(stages ?? defaultPipelineStages())].sort((a, b) => a.position - b.position)
  const demo = configured.length > 0 && configured.every(stage => stage.pipelineId === 'demo-main')
  // Preserve the legacy demonstration's select values while cloud stages use IDs.
  const optionValue = (stage: PipelineStage) => demo ? stage.name : stage.id
  const stageForLead = (lead: Lead) => configured.find(stage => leadInStage(lead, stage))
  const leadCounts = Object.fromEntries(configured.map(stage => [stage.id, Math.max(stage.leadCount ?? 0, leads.filter(lead => leadInStage(lead, stage)).length)]))
  const displayedStages = configured.filter(stage => stage.active || leads.some(lead => leadInStage(lead, stage)))
  const filtered = leads.filter(lead => `${lead.name} ${lead.company}`.toLowerCase().includes(search.toLowerCase())
    && (source === 'Todas as origens' || source === lead.source) && (!onlyStale || isStale(lead)))
  const showOwners = Object.keys(owners).length > 0
  const amount = (lead: Lead) => leadStageType(lead) === 'WON' ? lead.closedValue : lead.ticket
  const move = async (id: string, stage: PipelineStage) => {
    if (!canEdit || moving || !stage.active) return
    setError('')
    const lead = leads.find(item => item.id === id)
    if (!lead || leadInStage(lead, stage)) return
    if (stage.type === 'LOST' || (stage.type === 'WON' && !(Number.isFinite(lead.closedValue) && lead.closedValue > 0))) {
      setTransition({ lead, stage }); return
    }
    setMoving(id)
    try { await onUpdate(transitionLead(lead, stage)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível atualizar a etapa. Tente novamente.') }
    finally { setMoving(null) }
  }
  const selectStage = (lead: Lead, value: string) => {
    const stage = configured.find(item => optionValue(item) === value)
    if (stage) void move(lead.id, stage)
  }
  const confirmTransition = async (input: StageTransitionInput) => {
    if (!transition || !canEdit) throw new Error('Sua permissão não permite alterar esta oportunidade.')
    const currentStage = configured.find(stage => stage.id === transition.stage.id && stage.active)
    if (!currentStage) throw new Error('Esta etapa foi desativada. Feche a janela e escolha outra etapa.')
    await onUpdate(transitionLead(transition.lead, currentStage, input.closedValue, input.lossReason, input.lossComment))
  }
  const nextAction = (lead: Lead) => {
    const activity = nextActivity(activities, lead.id)
    if (!activity) return null
    const overdue = overdueActivityLabel(activity, now)
    return <span className={`op-next-action${overdue ? ' is-overdue' : ''}`}><CalendarDays size={12}/><span>{overdue || `${activityTypeLabel(activity.type)} · ${formatActivityDate(activity.dueAt, now)}`}</span></span>
  }
  const stageOptions = () => configured.map(stage => <option key={stage.id} value={optionValue(stage)} disabled={!stage.active}>{stage.name}{!stage.active ? ' (inativa)' : ''}</option>)

  return <>
    <div className="pipeline-toolbar">
      <div className="filter-search"><Search size={16}/><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar por lead ou empresa" aria-label="Buscar no pipeline"/></div>
      <div className="pipeline-filters">
        <label className="select-wrap"><SlidersHorizontal size={14}/><select aria-label="Filtrar por origem" value={source} onChange={event => setSource(event.target.value)}><option>Todas as origens</option>{Array.from(new Set(leads.map(lead => lead.source))).map(item => <option key={item}>{item}</option>)}</select></label>
        <button className={`button ${onlyStale ? 'button-danger-light' : 'button-secondary'}`} onClick={() => setOnlyStale(!onlyStale)}><AlertCircle size={15}/>Sem resposta<span className="count-pill">{leads.filter(lead => isStale(lead)).length}</span></button>
        <div className="view-switch"><button aria-label="Visualização em colunas" className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}><Columns3 size={17}/></button><button aria-label="Visualização em lista" className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}><LayoutList size={17}/></button></div>
        {canConfigure && onSaveStages && <button className="button button-secondary pf-config-trigger" disabled={!!moving} onClick={() => { setConfiguring(true); setError('') }}><Settings2 size={15}/>Configurar pipeline</button>}
      </div>
    </div>
    {error && <p className="pf-error" role="alert">{error}</p>}
    <div className="pipeline-summary"><strong>{filtered.length}</strong> oportunidades <span>•</span> <strong>{money(filtered.filter(lead => leadStageType(lead) !== 'LOST').reduce((sum, lead) => sum + amount(lead), 0))}</strong> em negócios <small>{canEdit ? 'Arraste os cards para atualizar a etapa' : 'Acesso somente para consulta'}</small></div>
    {view === 'board' ? <div className="kanban-board">{displayedStages.map(stage => {
      const items = filtered.filter(lead => leadInStage(lead, stage))
      return <section key={stage.id} className={`kanban-column ${dragging && stage.active ? 'drop-enabled' : ''} ${!stage.active ? 'pf-column-inactive' : ''}`}
        onDragOver={event => { if (canEdit && stage.active && !moving) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
        onDrop={event => { event.preventDefault(); void move(event.dataTransfer.getData('text/plain'), stage); setDragging(null) }}>
        <div className="kanban-column-header"><i style={{ background: stage.color }}/><h2>{stage.name}</h2><span>{items.length}</span>{canEdit && stage.active && <button aria-label={`Adicionar lead em ${stage.name}`} disabled={!!moving} onClick={() => onAdd(stage)}><Plus size={15}/></button>}</div>
        {!stage.active && <span className="pf-stage-inactive">Inativa · oportunidades existentes</span>}
        <p className="kanban-column-total">{money(items.reduce((sum, lead) => sum + amount(lead), 0))}</p>
        <div className="kanban-cards">{items.map(lead => <article className={`lead-card ${isStale(lead) ? 'stale' : ''} ${dragging === lead.id ? 'dragging' : ''}`} key={lead.id}
          draggable={canEdit && !moving} onDragStart={event => { event.dataTransfer.setData('text/plain', lead.id); event.dataTransfer.effectAllowed = 'move'; setDragging(lead.id) }} onDragEnd={() => setDragging(null)}>
          <button className="lead-card-main" onClick={() => (onOpen || onEdit)(lead)}><span className="lead-card-heading"><span className="avatar small">{initials(lead.name)}</span><ArrowUpRight size={15}/></span><h3>{lead.name}</h3><p>{lead.company || 'Pessoa física'}</p><strong>{money(amount(lead))}</strong>
            {owners[lead.id] && <span className="pf-lead-owner"><UserRound size={12}/>{owners[lead.id]}</span>}
            <span className="lead-card-source">{lead.source}</span>{lead.callDate && <span className="lead-card-date"><CalendarDays size={12}/>{new Date(lead.callDate).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}</span>}{isStale(lead) && <span className="stale-note"><AlertCircle size={12}/>Há mais de 5 dias sem contato</span>}
            {nextAction(lead)}
          </button>
          <label className="card-status-label">Mover para<select disabled={!canEdit || !!moving} aria-label={`Etapa de ${lead.name}`} value={stageForLead(lead) ? optionValue(stageForLead(lead)!) : ''} onChange={event => selectStage(lead, event.target.value)}>{stageOptions()}</select></label>
        </article>)}{!items.length && <div className="kanban-empty">Nenhuma oportunidade nesta etapa</div>}</div>
      </section>
    })}{!displayedStages.length && <div className="empty-state pf-pipeline-empty">As etapas do pipeline aparecerão aqui.</div>}</div> : <div className="panel table-scroll"><table className="data-table"><thead><tr><th>Lead / Empresa</th>{showOwners && <th>Responsável</th>}<th>Ticket</th><th>Origem</th><th>Etapa</th><th>Último contato</th><th>Próxima ação</th><th/></tr></thead><tbody>{filtered.map(lead => <tr key={lead.id} className={isStale(lead) ? 'stale-row' : ''}>
      <td><button className="lead-identity" onClick={() => (onOpen || onEdit)(lead)}><span className="avatar">{initials(lead.name)}</span><span><strong>{lead.name}</strong><small>{lead.company}</small></span></button></td>
      {showOwners && <td>{owners[lead.id] || '—'}</td>}<td className="table-money">{money(amount(lead))}</td><td>{lead.source}</td>
      <td><select disabled={!canEdit || !!moving} aria-label={`Etapa de ${lead.name}`} value={stageForLead(lead) ? optionValue(stageForLead(lead)!) : ''} onChange={event => selectStage(lead, event.target.value)}>{stageOptions()}</select></td>
      <td>{new Date(lead.lastContactAt).toLocaleDateString('pt-BR')}{isStale(lead) && <span className="stale-note">Follow-up pendente</span>}</td><td>{nextAction(lead) || <span className="muted">—</span>}</td><td><button className="icon-button" aria-label={`Editar ${lead.name}`} onClick={() => onEdit(lead)}><ArrowUpRight size={17}/></button></td>
    </tr>)}</tbody></table>{!filtered.length && <div className="empty-state">Nenhum lead encontrado. Experimente ajustar os filtros.</div>}</div>}
    {configuring && canConfigure && onSaveStages && <PipelineConfiguration stages={configured} leadCounts={leadCounts} onSave={onSaveStages} onClose={() => setConfiguring(false)}/>}
    {transition && <StageTransitionModal lead={transition.lead} stage={transition.stage} onConfirm={confirmTransition} onClose={() => setTransition(null)}/>}
  </>
}
