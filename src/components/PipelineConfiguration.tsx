import { useId, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, Check, GripVertical, LoaderCircle, Plus, Trash2 } from 'lucide-react'
import type { PipelineStage, StageType } from '../types'
import { validPipelineStages } from '../lib/validation'
import { PipelineFeatureDialog } from './StageTransitionModal'

type EditorRow = { key: string; stage: PipelineStage }
type Props = {
  stages: PipelineStage[]
  leadCounts: Record<string, number>
  onSave: (stages: PipelineStage[]) => Promise<void>
  onClose: () => void
}

const terminalTypes: StageType[] = ['WON', 'LOST']
const maxStages = 40
const typeLabels: Record<StageType, string> = { NORMAL: 'NORMAL · Em andamento', WON: 'WON · Venda ganha', LOST: 'LOST · Oportunidade perdida' }
const normalizePositions = (rows: EditorRow[]) => rows.map((row, position) => ({ ...row, stage: { ...row.stage, position } }))

export default function PipelineConfiguration({ stages, leadCounts, onSave, onClose }: Props) {
  const formId = useId()
  const nextKey = useRef(0)
  const saving = useRef(false)
  const pipelineId = useRef(stages.find(stage => stage.pipelineId)?.pipelineId || '')
  const [rows, setRows] = useState<EditorRow[]>(() => normalizePositions([...stages].sort((a, b) => a.position - b.position).map((stage, index) => ({ key: stage.id || `initial-stage-${index}`, stage: { ...stage } }))))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)

  const activeCount = (type: StageType) => rows.filter(row => row.stage.active && row.stage.type === type).length
  const protectedTerminal = (stage: PipelineStage) => stage.active && terminalTypes.includes(stage.type) && activeCount(stage.type) <= 1
  const countFor = (stage: PipelineStage) => stage.id ? leadCounts[stage.id] ?? stage.leadCount ?? 0 : 0
  const close = () => { if (!saving.current) onClose() }

  const updateStage = (key: string, patch: Partial<PipelineStage>) => {
    if (saving.current) return
    setError('')
    setRows(current => current.map(row => row.key === key ? { ...row, stage: { ...row.stage, ...patch } } : row))
  }

  const moveStage = (key: string, targetIndex: number) => {
    if (saving.current) return
    setError('')
    setRows(current => {
      const sourceIndex = current.findIndex(row => row.key === key)
      if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= current.length || sourceIndex === targetIndex) return current
      const reordered = [...current]
      const [row] = reordered.splice(sourceIndex, 1)
      reordered.splice(targetIndex, 0, row)
      return normalizePositions(reordered)
    })
  }

  const addStage = () => {
    if (saving.current || rows.length >= maxStages || !pipelineId.current) return
    setError('')
    const key = `new-stage-${nextKey.current++}`
    setRows(current => [...current, { key, stage: { id: '', pipelineId: pipelineId.current, name: 'Nova etapa', position: current.length, color: '#7194d6', type: 'NORMAL', active: true } }])
  }

  const removeStage = (row: EditorRow) => {
    if (saving.current || countFor(row.stage) > 0 || protectedTerminal(row.stage)) return
    setError('')
    setRows(current => normalizePositions(current.filter(item => item.key !== row.key)))
  }

  const startDrag = (event: DragEvent<HTMLElement>, key: string) => {
    if (saving.current || (event.target instanceof Element && event.target.closest('input, select, textarea, button'))) {
      event.preventDefault()
      return
    }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-closer-pipeline-stage', key)
    setDragging(key)
  }

  const dropStage = (event: DragEvent<HTMLElement>, targetIndex: number) => {
    event.preventDefault()
    if (!saving.current && dragging && event.dataTransfer.getData('application/x-closer-pipeline-stage') === dragging) moveStage(dragging, targetIndex)
    setDragging(null)
    setDragOver(null)
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving.current) return
    const draft = rows.map((row, position) => ({ ...row.stage, name: row.stage.name.trim(), position }))
    if (!draft.length || draft.length > maxStages) { setError(`O pipeline precisa ter entre 1 e ${maxStages} etapas.`); return }
    const invalidName = draft.find(stage => stage.name.length < 2 || stage.name.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(stage.name))
    if (invalidName) { setError('Cada etapa precisa de um nome de 2 a 80 caracteres, sem caracteres de controle.'); return }
    if (draft.some(stage => !/^#[0-9a-f]{6}$/i.test(stage.color))) { setError('Escolha uma cor válida para cada etapa.'); return }
    if (draft.filter(stage => stage.active && stage.type === 'WON').length !== 1 || draft.filter(stage => stage.active && stage.type === 'LOST').length !== 1) {
      setError('Mantenha exatamente uma etapa ativa do tipo WON e uma do tipo LOST. Você pode ajustar os tipos antes de salvar.')
      return
    }
    if (!pipelineId.current || draft.some(stage => stage.pipelineId !== pipelineId.current) || !validPipelineStages(draft)) { setError('Não foi possível validar a configuração do pipeline. Feche e abra a configuração para tentar novamente.'); return }
    saving.current = true
    setBusy(true)
    setError('')
    setDragging(null)
    setDragOver(null)
    try {
      await onSave(draft)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar o pipeline. Suas alterações foram mantidas; tente novamente.')
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  return <PipelineFeatureDialog title="Configurar pipeline" description="Organize o processo comercial da sua empresa." onClose={close} busy={busy}>
    <form className="pf-config-form" onSubmit={event => void save(event)} aria-busy={busy}>
      <p className="pf-config-intro">Arraste as etapas ou use as setas para mudar a ordem. WON identifica vendas ganhas e LOST identifica oportunidades perdidas, independentemente do nome.</p>
      {error && <p className="pf-config-error" role="alert">{error}</p>}
      <div className="pf-config-stages">
        {rows.map((row, index) => {
          const { stage } = row
          const leadCount = countFor(stage)
          const name = stage.name.trim() || 'sem nome'
          const isProtected = protectedTerminal(stage)
          const occupiedReason = leadCount > 0 ? `Mova ${leadCount === 1 ? 'o lead' : `os ${leadCount} leads`} para outra etapa antes de excluir ou alterar o tipo. O nome e a cor continuam editáveis.` : ''
          const terminalReason = isProtected ? `Defina outra etapa ativa do tipo ${stage.type} antes de excluir ou desativar esta.` : ''
          const fieldId = `${formId}-${row.key}`
          const deleteDescription = [occupiedReason ? `${fieldId}-occupied-reason` : '', terminalReason ? `${fieldId}-terminal-reason` : ''].filter(Boolean).join(' ') || undefined
          return <article key={row.key} className={`pf-config-stage${dragging === row.key ? ' is-dragging' : ''}${dragOver === row.key && dragging !== row.key ? ' is-drag-over' : ''}`} draggable={!busy} onDragStart={event => startDrag(event, row.key)} onDragEnd={() => { setDragging(null); setDragOver(null) }} onDragOver={event => {
            if (!busy && dragging) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOver(row.key) }
          }} onDrop={event => dropStage(event, index)} aria-label={`Etapa ${name}`}>
            <div className="pf-config-stage-heading">
              <span className="pf-config-stage-order"><GripVertical size={16} aria-hidden="true" /><span>{index + 1}</span></span>
              <strong className="pf-config-stage-title">{name}</strong>
              <span className="pf-config-stage-count">{leadCount} {leadCount === 1 ? 'lead' : 'leads'}</span>
              <div className="pf-config-stage-controls">
                <button type="button" className="icon-button" disabled={busy || index === 0} aria-label={`Mover etapa ${name} para cima`} onClick={() => moveStage(row.key, index - 1)}><ArrowUp size={16} /></button>
                <button type="button" className="icon-button" disabled={busy || index === rows.length - 1} aria-label={`Mover etapa ${name} para baixo`} onClick={() => moveStage(row.key, index + 1)}><ArrowDown size={16} /></button>
              </div>
            </div>
            <div className="pf-config-stage-grid">
              <label className="pf-config-field" htmlFor={`${fieldId}-name`}>Nome da etapa<input id={`${fieldId}-name`} required minLength={2} maxLength={80} value={stage.name} disabled={busy} autoFocus={!stage.id} onChange={event => updateStage(row.key, { name: event.target.value })} /></label>
              <label className="pf-config-field" htmlFor={`${fieldId}-type`}>Tipo da etapa<select id={`${fieldId}-type`} aria-label="Tipo da etapa" value={stage.type} disabled={busy || leadCount > 0} aria-describedby={occupiedReason ? `${fieldId}-occupied-reason` : undefined} onChange={event => updateStage(row.key, { type: event.target.value as StageType })}>{Object.entries(typeLabels).map(([type, label]) => <option key={type} value={type}>{label}</option>)}</select></label>
              <label className="pf-config-field pf-config-color-field" htmlFor={`${fieldId}-color`}>Cor da etapa<span><input id={`${fieldId}-color`} type="color" aria-label="Cor da etapa" value={stage.color} disabled={busy} onChange={event => updateStage(row.key, { color: event.target.value })} /><small aria-hidden="true">{stage.color}</small></span></label>
            </div>
            <div className="pf-config-stage-footer">
              <label className="pf-config-stage-active"><input type="checkbox" checked={stage.active} disabled={busy || isProtected} aria-describedby={terminalReason ? `${fieldId}-terminal-reason` : undefined} onChange={event => updateStage(row.key, { active: event.target.checked })} />Etapa ativa</label>
              <button type="button" className="button button-secondary" disabled={busy || leadCount > 0 || isProtected} aria-label={`Excluir etapa ${name}`} aria-describedby={deleteDescription} onClick={() => removeStage(row)}><Trash2 size={14} />Excluir etapa</button>
            </div>
            {occupiedReason && <p className="pf-config-stage-reason" id={`${fieldId}-occupied-reason`}>{occupiedReason}</p>}
            {terminalReason && <p className="pf-config-stage-reason" id={`${fieldId}-terminal-reason`}>{terminalReason}</p>}
          </article>
        })}
      </div>
      <button type="button" className="button button-secondary pf-config-add" disabled={busy || rows.length >= maxStages || !pipelineId.current} onClick={addStage}><Plus size={15} />Nova etapa</button>
      {rows.length >= maxStages && <p className="pf-config-stage-reason">O pipeline pode ter até {maxStages} etapas.</p>}
      <div className="pf-config-footer">
        <button type="button" className="button button-secondary" disabled={busy} onClick={close}>Cancelar</button>
        <button type="submit" className="button button-primary" disabled={busy || !rows.length}>{busy ? <LoaderCircle size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{busy ? 'Salvando pipeline…' : 'Salvar pipeline'}</button>
      </div>
    </form>
  </PipelineFeatureDialog>
}
