import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from 'react'
import { AlertTriangle, ArrowLeft, ArrowRight, Building2, Check, CheckCircle2, Download, FileSpreadsheet, FileUp, LoaderCircle, ShieldCheck, X } from 'lucide-react'
import type { WorkspaceRole } from '../lib/access-types'
import type { Stage } from '../types'
import { money } from '../lib/analytics'
import { lockDialogScroll } from '../lib/dialog-scroll'
import { buildImportRows, IMPORT_FIELDS, importCellText, readLeadImportFile, suggestColumnMappings } from '../lib/lead-import-reader'
import { LeadImportInterruptedError, leadImportService } from '../lib/lead-import-service'
import type { ColumnMapping, ImportPreview, ImportProgress, ImportResult, ParsedImportFile, PreparedImport } from '../lib/lead-import-types'
import './import-leads.css'

export interface ImportLeadsWizardProps {
  workspace: { id: string; name: string }
  userId: string
  role: WorkspaceRole
  stages: Stage[]
  members: { userId: string; displayName: string; email: string }[]
  pipelineName?: string
  onClose: () => void
  onComplete: (result: { imported: number; skipped: number; conflicts?: number }) => void | Promise<void>
  onImportBackup: (file: File) => Promise<{ imported: number; skipped?: number }>
}

const steps = ['Enviar arquivo', 'Relacionar campos', 'Pipeline e responsáveis', 'Validar e conferir', 'Confirmar importação']
const shortStatus = { new: 'Novo', valid: 'Novo', duplicate: 'Duplicado — ignorar', conflict: 'Conflito — revisar', error: 'Erro — revisar' }
const backendProblem = (code?: string) => {
  const normalized = code?.toLowerCase()
  if (normalized === 'identity_conflict' || normalized === 'conflict') return 'e-mail e telefone indicam registros diferentes. Revise esta linha antes de importar.'
  if (normalized === 'invalid_owner' || normalized === 'owner') return 'responsável indisponível. Relacione novamente os responsáveis.'
  if (normalized === 'invalid_stage' || normalized === 'stage') return 'etapa indisponível. Relacione novamente as etapas.'
  return 'registro não aprovado pelo servidor. Revise os campos e o destino antes de importar.'
}
const number = (value: number) => new Intl.NumberFormat('pt-BR').format(value)

function ValueMappings({ kind, values, mapping, onChange, options }: {
  kind: 'Etapa' | 'Responsável'
  values: string[]
  mapping: Record<string, string>
  onChange: (value: string, destination: string) => void
  options: { id: string; label: string }[]
}) {
  const [page, setPage] = useState(0)
  const lastPage = Math.max(0, Math.ceil(values.length / 25) - 1)
  const visiblePage = Math.min(page, lastPage)
  if (!values.length) return null
  return <div className="li-value-mappings">
    {values.slice(visiblePage * 25, (visiblePage + 1) * 25).map(value => <label className="li-value-row" key={value}>
      <span>{value}</span><select aria-label={`${kind} para ${value}`} value={Object.hasOwn(mapping, value) ? mapping[value] : '__unmapped__'} onChange={event => onChange(value, event.target.value)}>
        <option value="__unmapped__">Selecione uma correspondência</option>
        <option value="">Usar {kind === 'Etapa' ? 'etapa' : 'responsável'} padrão</option>
        {options.map(option => <option value={option.id} key={option.id}>{option.label}</option>)}
      </select>
    </label>)}
    {lastPage > 0 && <div className="li-pagination"><span>{visiblePage * 25 + 1}–{Math.min((visiblePage + 1) * 25, values.length)} de {number(values.length)}</span><button type="button" className="button button-secondary" disabled={visiblePage === 0} onClick={() => setPage(visiblePage - 1)}>Anteriores</button><button type="button" className="button button-secondary" disabled={visiblePage === lastPage} onClick={() => setPage(visiblePage + 1)}>Próximos</button></div>}
  </div>
}

/** Commercial files stay in this dialog's memory. Authorization and duplicate checks remain server-side. */
function ImportLeadsWizardContent({ workspace, userId, role, stages, members, pipelineName = 'Pipeline principal', onClose, onComplete, onImportBackup }: ImportLeadsWizardProps) {
  const titleId = useId(), descriptionId = useId(), sectionId = useId()
  const dialog = useRef<HTMLElement>(null), fileInput = useRef<HTMLInputElement>(null), body = useRef<HTMLDivElement>(null)
  const mounted = useRef(false), epoch = useRef(0), operation = useRef(false), controller = useRef<AbortController | null>(null)
  const closeRef = useRef(onClose), completeRef = useRef(onComplete), legacyRef = useRef(onImportBackup)
  closeRef.current = onClose; completeRef.current = onComplete; legacyRef.current = onImportBackup
  const [step, setStep] = useState(0), [busy, setBusy] = useState(false), [dragging, setDragging] = useState(false), [error, setError] = useState('')
  const [file, setFile] = useState<File | null>(null), [parsed, setParsed] = useState<ParsedImportFile | null>(null), [legacy, setLegacy] = useState(false)
  const [mapping, setMapping] = useState<ColumnMapping>({}), [stageMap, setStageMap] = useState<Record<string, string>>({}), [ownerMap, setOwnerMap] = useState<Record<string, string>>({})
  const [pipelineId, setPipelineId] = useState(stages.find(stage => stage.active && stage.type === 'NORMAL')?.pipelineId || '')
  const [defaultStageId, setDefaultStageId] = useState(stages.find(stage => stage.active && stage.type === 'NORMAL')?.id || '')
  const [defaultOwnerId, setDefaultOwnerId] = useState(members.find(member => member.userId === userId)?.userId || '')
  const [numericFormat, setNumericFormat] = useState<'br' | 'international' | 'auto'>('br'), [dateFormat, setDateFormat] = useState<'br' | 'iso'>('br')
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo')
  const [sourceNamespace, setSourceNamespace] = useState('')
  const [prepared, setPrepared] = useState<PreparedImport | null>(null), [preview, setPreview] = useState<ImportPreview | null>(null)
  const [confirmed, setConfirmed] = useState(false), [result, setResult] = useState<ImportResult | null>(null), [progress, setProgress] = useState<ImportProgress | null>(null)
  const [interrupted, setInterrupted] = useState<ImportProgress | null>(null)
  const backendByRow = useMemo(() => new Map(preview?.results.map(row => [row.rowNumber, row]) || []), [preview])
  const importCandidates = useMemo(() => prepared?.records.filter(record => {
    const status = backendByRow.get(record.rowNumber)?.status
    // A preview is an estimate. Recheck duplicates and conflicts at write time;
    // only rows rejected by validation are left out of the transaction.
    return status !== undefined && status !== 'error'
  }) || [], [prepared, backendByRow])
  const callDateFormatter = useMemo(() => {
    try { return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone }) }
    catch { return null }
  }, [timeZone])
  const previewCallDate = (value?: string) => {
    if (!value) return '—'
    const date = new Date(value)
    if (!Number.isFinite(date.getTime())) return 'Data inválida — revise'
    return callDateFormatter?.format(date) || 'Fuso inválido — revise'
  }
  const authorized = role === 'admin' || role === 'manager'
  const activeStages = stages.filter(stage => stage.active && stage.pipelineId === pipelineId)
  const pipelines = [...new Set(stages.filter(stage => stage.active).map(stage => stage.pipelineId))]
  const scope = `${workspace.id}:${userId}:${role}`
  const scopeRef = useRef(scope); scopeRef.current = scope
  const current = (requestEpoch: number, requestScope: string) => mounted.current && epoch.current === requestEpoch && scopeRef.current === requestScope

  useEffect(() => {
    mounted.current = true; epoch.current += 1
    return () => { mounted.current = false; epoch.current += 1; controller.current?.abort(); controller.current = null }
  }, [scope])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const release = lockDialogScroll()
    dialog.current?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!operation.current) closeRef.current(); return }
      if (event.key !== 'Tab') return
      event.stopImmediatePropagation()
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])') || [])].filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
      const first = controls[0], last = controls.at(-1), outside = !dialog.current?.contains(document.activeElement)
      if (!first) { event.preventDefault(); dialog.current?.focus(); return }
      if (event.shiftKey && (document.activeElement === first || outside)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || outside || document.activeElement === dialog.current)) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', keyboard, true)
    return () => { window.removeEventListener('keydown', keyboard, true); release(); if (previous?.isConnected && !previous.matches(':disabled')) previous.focus() }
  }, [])
  useEffect(() => {
    const preventUnload = (event: BeforeUnloadEvent) => { if (operation.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', preventUnload)
    return () => window.removeEventListener('beforeunload', preventUnload)
  }, [])
  useEffect(() => {
    body.current?.scrollTo({ top: 0 })
    dialog.current?.querySelector<HTMLElement>(`#${CSS.escape(sectionId)}`)?.focus()
  }, [step, sectionId])

  const sourceValues = (field: string) => {
    if (!parsed) return []
    const column = Object.entries(mapping).find(([, target]) => target === field)
    return column ? [...new Set(parsed.rows.map(row => importCellText(row.values[Number(column[0])]).trim()).filter(Boolean))] : []
  }
  const oldStages = useMemo(() => sourceValues('stage'), [parsed, mapping])
  const oldOwners = useMemo(() => sourceValues('owner'), [parsed, mapping])
  const invalidate = () => { setPrepared(null); setPreview(null); setConfirmed(false); setError('') }
  const close = () => { if (!operation.current) closeRef.current() }
  const navigate = (next: number) => { if (!operation.current) { setStep(next); setError(''); setConfirmed(false) } }
  const startOperation = () => {
    operation.current = true; setBusy(true); setError('')
    controller.current?.abort(); controller.current = new AbortController()
    return { requestedEpoch: epoch.current, requestedScope: scope, signal: controller.current.signal }
  }
  const endOperation = (requestedEpoch: number, requestedScope: string) => { if (current(requestedEpoch, requestedScope)) { operation.current = false; setBusy(false) } }

  const readFile = async (selected?: File, sheetName?: string) => {
    if (!selected || operation.current || !authorized) return
    const { requestedEpoch, requestedScope, signal } = startOperation()
    try {
      if (selected.name.toLowerCase().endsWith('.json')) {
        if (!selected.size || selected.size > 10 * 1024 * 1024) throw new Error('Escolha um backup JSON válido de até 10 MB.')
        if (current(requestedEpoch, requestedScope)) { setFile(selected); setLegacy(true); setParsed(null); setPrepared(null); setPreview(null); setProgress(null); setStep(4); setResult(null); setInterrupted(null); setConfirmed(false) }
        return
      }
      const next = await readLeadImportFile(selected, sheetName, signal)
      if (!current(requestedEpoch, requestedScope)) return
      setFile(selected); setParsed(next); setLegacy(false); setPrepared(null); setPreview(null); setResult(null); setInterrupted(null); setProgress(null); setConfirmed(false)
      setMapping(suggestColumnMappings(next.headers)); setStageMap({}); setOwnerMap({}); setSourceNamespace('')
    } catch (failure) {
      if (current(requestedEpoch, requestedScope) && !signal.aborted) setError(failure instanceof Error ? failure.message : 'Não foi possível ler o arquivo. Use um CSV, Excel (.xlsx) ou backup JSON válido.')
    } finally { endOperation(requestedEpoch, requestedScope); if (fileInput.current) fileInput.current.value = '' }
  }
  const dropFile = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(false); if (!operation.current) void readFile(event.dataTransfer.files[0]) }

  const validate = async () => {
    if (!parsed || operation.current || !authorized) return
    const { requestedEpoch, requestedScope, signal } = startOperation()
    try {
      const local = await buildImportRows(parsed, mapping, { stages, members, defaultStageId, defaultOwnerId, stageMap, ownerMap, timeZone, numericFormat, dateFormat, sourceNamespace: sourceNamespace.trim() || undefined })
      if (!current(requestedEpoch, requestedScope) || signal.aborted) return
      setProgress({ imported: 0, skipped: 0, conflicts: 0, processed: 0, total: local.records.length })
      const remote = await leadImportService.preview(workspace.id, local.records, sourceNamespace.trim() || undefined, next => { if (current(requestedEpoch, requestedScope)) setProgress(next) }, signal)
      if (!current(requestedEpoch, requestedScope)) return
      setPrepared(local); setPreview(remote); setStep(3); setProgress(null); setConfirmed(false)
    } catch (failure) {
      if (current(requestedEpoch, requestedScope) && !signal.aborted) setError(failure instanceof Error ? failure.message : 'Não foi possível validar os registros. Nenhum lead foi importado. Tente novamente.')
    } finally { endOperation(requestedEpoch, requestedScope) }
  }

  const importRecords = async () => {
    if (operation.current || !authorized || !confirmed || (!legacy && (!prepared || !preview)) || !file) return
    const { requestedEpoch, requestedScope, signal } = startOperation()
    setResult(null); setInterrupted(null)
    setProgress(legacy ? null : { imported: 0, skipped: 0, conflicts: 0, processed: 0, total: importCandidates.length })
    try {
      const actual = legacy
        ? await legacyRef.current(file).then(backup => ({ imported: backup.imported, skipped: backup.skipped || 0, conflicts: 0, processed: backup.imported + (backup.skipped || 0), total: backup.imported + (backup.skipped || 0) }))
        : await leadImportService.import(workspace.id, importCandidates, sourceNamespace.trim() || undefined, next => { if (current(requestedEpoch, requestedScope)) setProgress(next) }, signal)
      if (!current(requestedEpoch, requestedScope)) return
      setResult(actual); setProgress(null)
      // The database confirmation is the result; a view refresh failure must not turn it into a retry.
      try { await completeRef.current(actual) } catch { if (current(requestedEpoch, requestedScope)) setError('Os registros foram confirmados no banco. Atualize o CRM para visualizar a base atualizada.') }
    } catch (failure) {
      if (!current(requestedEpoch, requestedScope)) return
      if (failure instanceof LeadImportInterruptedError) {
        setInterrupted({ imported: failure.imported, skipped: failure.skipped, conflicts: failure.conflicts, processed: failure.processed, total: failure.total })
        setError('A importação foi interrompida. Os lotes confirmados foram preservados. Tente novamente com o mesmo arquivo e mapeamento; os registros já existentes serão ignorados.')
        try { await completeRef.current({ imported: failure.imported, skipped: failure.skipped, conflicts: failure.conflicts }) } catch { /* The interrupted totals remain visible; no fabricated success. */ }
      } else setError(failure instanceof Error ? failure.message : 'Não foi possível concluir a importação. Revise o arquivo e tente novamente.')
      setProgress(null)
    } finally { endOperation(requestedEpoch, requestedScope) }
  }

  const issues = useMemo(() => {
    const local = prepared?.errors.map(issue => ({ rowNumber: issue.rowNumber, message: issue.message.replace(/^Linha \d+:\s*/u, '') })) || []
    const server = preview?.results.filter(row => row.status === 'error' || row.status === 'conflict').map(row => ({ rowNumber: row.rowNumber, message: backendProblem(row.code) })) || []
    const localConflicts = prepared?.rows.filter(row => row.status === 'conflict' && !backendByRow.has(row.rowNumber)).map(row => ({ rowNumber: row.rowNumber, message: 'e-mail, telefone ou identificador indicam linhas diferentes do próprio arquivo. Revise esta linha antes de importar.' })) || []
    return [...local, ...localConflicts, ...server].sort((a, b) => a.rowNumber - b.rowNumber)
  }, [prepared, preview, backendByRow])
  const duplicates = preview?.duplicateCount || 0
  const conflicts = preview?.conflictCount || 0
  const errors = (prepared ? new Set(prepared.errors.map(issue => issue.rowNumber)).size : 0) + (preview?.errorCount || 0)
  const canValidate = Boolean(defaultStageId && defaultOwnerId && pipelineId && Object.values(mapping).includes('name'))

  return <div className="li-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <section className="li-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy}>
      <header className="li-header"><span className="li-header-icon"><FileUp size={21}/></span><div><h2 id={titleId}>Importar leads</h2><p id={descriptionId}>Migre sua base comercial com conferência antes de gravar.</p></div><button type="button" className="li-icon-button" aria-label="Fechar importação" disabled={busy} onClick={close}><X size={20}/></button></header>
      <div className="li-destination"><Building2 size={16}/><span>Empresa de destino: <strong>{workspace.name}</strong></span><span className="li-private"><ShieldCheck size={14}/>Base privada</span></div>
      <ol className="li-steps" aria-label="Etapas da importação">{steps.map((label, index) => <li key={label} className={`${index === step ? 'is-current' : ''} ${index < step ? 'is-complete' : ''}`} aria-current={index === step ? 'step' : undefined}><span aria-hidden="true">{index < step ? <Check size={13}/> : index + 1}</span><strong>{label}</strong></li>)}</ol>
      <div className="li-body" ref={body}>
        <h3 className="li-step-heading" id={sectionId} tabIndex={-1}>{result ? 'Relatório da importação' : steps[step]}</h3>
        {!authorized ? <div className="li-notice li-notice-warning" role="alert"><ShieldCheck size={18}/><p>Somente administradores e gestores da própria empresa podem importar arquivos de outros CRMs.</p></div> : <fieldset className="li-fields" disabled={busy}>
          {error && <div className="li-notice li-notice-danger" role="alert"><AlertTriangle size={18}/><p>{error}</p></div>}
          {step === 0 && <>
            <p className="li-help">Exporte os contatos ou negócios do seu CRM em CSV ou Excel. Você poderá revisar os campos, etapas e responsáveis antes da importação.</p>
            <div className={`li-dropzone${dragging ? ' is-dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={dropFile}>
              <FileSpreadsheet size={31}/><strong>Arraste seu arquivo para cá</strong><span>CSV, Excel (.xlsx) ou backup JSON do HIGH CLOSER</span><button type="button" className="button button-primary" disabled={busy} onClick={() => fileInput.current?.click()}><FileUp size={16}/>{busy ? 'Lendo arquivo…' : 'Selecionar arquivo'}</button><small>Até 10 MB · 10.000 linhas · 100 colunas. O arquivo é lido neste navegador.</small>
              <input ref={fileInput} type="file" tabIndex={-1} accept=".csv,.xlsx,.json,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="Selecionar arquivo CSV, Excel ou JSON" className="li-file-input" disabled={busy} onChange={event => void readFile(event.target.files?.[0])}/>
            </div>
            <a className="li-template" href="/modelo-importacao-leads.csv" download><Download size={15}/>Baixar modelo CSV</a>
            {parsed && <div className="li-file-summary"><FileSpreadsheet size={20}/><div><strong>{file?.name}</strong><span>{number(parsed.rows.length)} registros · {parsed.headers.length} colunas</span></div><button type="button" className="button button-secondary" disabled={busy} onClick={() => fileInput.current?.click()}>Trocar arquivo</button></div>}
            {parsed && parsed.sheets.length > 1 && <label className="li-field">Aba da planilha<select aria-label="Aba da planilha" value={parsed.sheetName} disabled={busy} onChange={event => void readFile(file || undefined, event.target.value)}>{parsed.sheets.map(sheet => <option value={sheet} key={sheet}>{sheet}</option>)}</select><small>Uma aba será importada por vez. Confira a quantidade de registros após selecionar.</small></label>}
          </>}
          {step === 1 && parsed && <>
            <p className="li-help">As sugestões consideram os nomes das colunas. Confira cada associação: campos desconhecidos ficam ignorados até você escolher um destino.</p>
            <div className="li-mapping-heading"><span>Coluna do arquivo</span><span>Campo HIGH CLOSER</span></div>
            <div className="li-column-mappings">{parsed.headers.map((header, index) => <div className="li-column-row" key={`${index}-${header}`}><div><strong>{header || `Coluna ${index + 1}`}</strong><small>{importCellText(parsed.rows.find(row => importCellText(row.values[index]).trim())?.values[index]).slice(0, 180) || 'Células vazias'}</small></div><select aria-label={`Campo para ${header || `Coluna ${index + 1}`}`} value={mapping[index] || 'ignore'} onChange={event => { setMapping({ ...mapping, [index]: event.target.value as ColumnMapping[number] }); invalidate() }}><option value="ignore">Ignorar esta coluna</option><option value="notes-extra">Acrescentar às observações</option>{IMPORT_FIELDS.map(field => <option value={field.value} key={field.value}>{field.label}</option>)}</select></div>)}</div>
            {!Object.values(mapping).includes('name') && <p className="li-inline-warning">Relacione uma coluna ao campo Nome para continuar.</p>}
            <div className="li-form-grid"><label className="li-field">Formato dos valores<select value={numericFormat} onChange={event => { setNumericFormat(event.target.value as typeof numericFormat); invalidate() }}><option value="br">Brasileiro — 1.234,56</option><option value="international">Internacional — 1,234.56</option><option value="auto">Automático — revisar valores ambíguos</option></select></label><label className="li-field">Formato das datas<select value={dateFormat} onChange={event => { setDateFormat(event.target.value as typeof dateFormat); invalidate() }}><option value="br">Brasileiro — dia/mês/ano</option><option value="iso">ISO — ano-mês-dia</option></select></label><label className="li-field li-field-wide">Fuso das datas sem indicação de fuso<input value={timeZone} maxLength={100} onChange={event => { setTimeZone(event.target.value); invalidate() }} placeholder="America/Sao_Paulo"/><small>Ex.: America/Sao_Paulo. Datas com fuso explícito preservam esse fuso. Calls precisam de data e horário.</small></label></div>
            {Object.values(mapping).includes('sourceId') && <label className="li-field">Sistema de origem<input value={sourceNamespace} maxLength={100} onChange={event => { setSourceNamespace(event.target.value); invalidate() }} placeholder="Ex.: pipedrive-operacao-principal"/><small>Use um identificador estável do CRM e da base exportada. Ele diferencia IDs de origens distintas; mantenha o mesmo ao repetir a importação.</small></label>}
          </>}
          {step === 2 && parsed && <>
            <p className="li-help">Relacione as etapas e os responsáveis do arquivo à estrutura existente desta empresa. Não serão criadas etapas ou contas de usuário.</p>
            <div className="li-form-grid"><label className="li-field li-field-wide">Pipeline de destino<select aria-label="Pipeline de destino" value={pipelineId} onChange={event => { const next = event.target.value; setPipelineId(next); setDefaultStageId(stages.find(stage => stage.pipelineId === next && stage.active && stage.type === 'NORMAL')?.id || ''); setStageMap({}); invalidate() }}>{pipelines.map((id, index) => <option value={id} key={id}>{pipelines.length === 1 ? pipelineName : `${pipelineName} ${index + 1}`}</option>)}</select></label><label className="li-field">Etapa padrão<select aria-label="Etapa padrão" value={defaultStageId} onChange={event => { setDefaultStageId(event.target.value); invalidate() }}><option value="">Selecione uma etapa</option>{activeStages.map(stage => <option value={stage.id} key={stage.id}>{stage.name}</option>)}</select><small>Usada quando a linha não tiver etapa ou quando você escolher “Usar etapa padrão”.</small></label><label className="li-field">Responsável padrão<select aria-label="Responsável padrão" value={defaultOwnerId} onChange={event => { setDefaultOwnerId(event.target.value); invalidate() }}><option value="">Selecione uma pessoa</option>{members.map(member => <option value={member.userId} key={member.userId}>{member.displayName || member.email}</option>)}</select><small>Somente membros ativos da empresa com permissão de edição.</small></label></div>
            {oldStages.length > 0 && <section className="li-section"><h4>Etapas encontradas no arquivo <span>{number(oldStages.length)}</span></h4><p className="li-help">Escolha um destino para cada valor, incluindo uma escolha explícita para usar a etapa padrão. Sem correspondência, a linha ficará com erro na prévia.</p><ValueMappings kind="Etapa" values={oldStages} mapping={stageMap} onChange={(value, id) => { const next = { ...stageMap }; if (id === '__unmapped__') delete next[value]; else Object.defineProperty(next, value, { value: id, enumerable: true, configurable: true, writable: true }); setStageMap(next); invalidate() }} options={activeStages.map(stage => ({ id: stage.id, label: stage.name }))}/></section>}
            {oldOwners.length > 0 && <section className="li-section"><h4>Responsáveis encontrados no arquivo <span>{number(oldOwners.length)}</span></h4><p className="li-help">Escolha uma pessoa ou confirme o responsável padrão para cada valor do arquivo.</p><ValueMappings kind="Responsável" values={oldOwners} mapping={ownerMap} onChange={(value, id) => { const next = { ...ownerMap }; if (id === '__unmapped__') delete next[value]; else Object.defineProperty(next, value, { value: id, enumerable: true, configurable: true, writable: true }); setOwnerMap(next); invalidate() }} options={members.map(member => ({ id: member.userId, label: member.displayName || member.email }))}/></section>}
            <div className="li-notice li-notice-neutral"><ShieldCheck size={18}/><p>Datas passadas não tornam uma call realizada. Vendas ganhas exigem dados válidos de fechamento; campos ausentes recebem padrões seguros, sem criar histórico comercial.</p></div>
          </>}
          {step === 3 && prepared && preview && <>
            <p className="li-help">A prévia foi conferida pelo servidor apenas nesta empresa. Registros existentes serão preservados. Duplicados e conflitos serão conferidos novamente na gravação; linhas com erro ficam fora da importação.</p>
            <div className="li-counts" aria-label="Resumo da validação">{[['Registros encontrados', prepared.total], ['Leads novos previstos', preview.newCount], ['Possíveis duplicados', duplicates], ['Registros com erros', errors], ['Conflitos para revisão', conflicts], ['Sem campos essenciais', prepared.missingEssential], ['Etapas sem correspondência', prepared.unmappedStages], ['Responsáveis não identificados', prepared.unmappedOwners]].map(([label, count]) => <div key={label}><span>{label}</span><strong>{number(Number(count))}</strong></div>)}</div>
            <section className="li-section"><h4>Prévia dos registros <span>Até 20 linhas</span></h4><div className="li-table-scroll" tabIndex={0} role="region" aria-label="Prévia dos registros"><table className="li-preview-table"><thead><tr><th>Linha</th><th>Nome / empresa</th><th>Contato</th><th>Ticket</th><th>Etapa / responsável</th><th>Data da call</th><th>Resultado</th></tr></thead><tbody>{prepared.rows.slice(0, 20).map(row => { const remote = backendByRow.get(row.rowNumber); const status = remote?.status || row.status; return <tr key={row.rowNumber}><td>{row.rowNumber}</td><td><strong>{row.lead?.name || '—'}</strong><small>{row.lead?.company || '—'}</small></td><td><span>{row.lead?.email || '—'}</span><small>{row.lead?.phone || '—'}</small></td><td>{row.lead ? money(row.lead.ticket) : '—'}</td><td><span>{stages.find(stage => stage.id === row.stageId)?.name || '—'}</span><small>{members.find(member => member.userId === row.ownerId)?.displayName || '—'}</small></td><td>{previewCallDate(row.lead?.callDate)}</td><td><span className={`li-badge li-badge-${status}`}>{shortStatus[status]}</span></td></tr> })}</tbody></table></div></section>
            {issues.length > 0 && <section className="li-section"><h4>Linhas que precisam de revisão <span>{number(issues.length)} apontamentos</span></h4><ul className="li-issues">{issues.map((issue, index) => <li key={`${issue.rowNumber}-${index}`}><strong>Linha {issue.rowNumber}:</strong> {issue.message}</li>)}</ul><p className="li-help">Volte às etapas anteriores para corrigir o mapeamento. O arquivo continuará disponível enquanto esta janela estiver aberta.</p></section>}
            {!preview.newCount && <div className="li-notice li-notice-neutral"><ShieldCheck size={18}/><p>Nenhum lead novo está pronto para importação. Os duplicados já estão preservados; corrija as linhas com erro ou conflito antes de continuar.</p></div>}
          </>}
          {step === 4 && !result && <>
            {legacy ? <div className="li-notice li-notice-neutral"><FileSpreadsheet size={18}/><p>O arquivo <strong>{file?.name}</strong> será restaurado pelo importador original de backups JSON. IDs existentes são preservados e não serão sobrescritos.</p></div> : <><div className="li-confirm-summary"><div><span>Leads novos previstos</span><strong>{number(preview?.newCount || 0)}</strong></div><div><span>Duplicados previstos</span><strong>{number(duplicates)}</strong></div><div><span>Registros com erros excluídos</span><strong>{number(errors)}</strong></div></div>{conflicts > 0 && <div className="li-notice li-notice-warning"><AlertTriangle size={18}/><p>{number(conflicts)} registros com conflito na prévia. O banco os conferirá novamente e não importará identidades que continuem em conflito.</p></div>}</>}
            <dl className="li-confirm-destination"><div><dt>Empresa de destino</dt><dd>{workspace.name}</dd></div><div><dt>Pipeline de destino</dt><dd>{pipelineName}</dd></div><div><dt>Arquivo</dt><dd>{file?.name}</dd></div></dl>
            <p className="li-help">Os números acima são estimativas da prévia. A confirmação do banco define o resultado final: duplicados e conflitos são conferidos novamente na gravação, inclusive se outra pessoa importar ao mesmo tempo. Nenhum registro existente será sobrescrito ou mesclado.</p>
            <label className="li-confirm-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}/><span>Confirmo a importação para esta empresa e pipeline.</span></label>
            {interrupted && <div className="li-notice li-notice-warning"><AlertTriangle size={18}/><p><strong>{number(interrupted.imported)} leads confirmados no banco</strong> antes da interrupção; {number(interrupted.skipped)} ignorados e {number(interrupted.conflicts)} conflitos. Tentar novamente repete a operação com os mesmos identificadores seguros.</p></div>}
          </>}
          {busy && <div className="li-progress" role="status" aria-live="polite"><LoaderCircle size={18}/><div><strong>{step === 0 ? 'Lendo o arquivo no navegador…' : step === 4 ? legacy ? 'Restaurando backup JSON…' : 'Importando e aguardando confirmação dos lotes…' : 'Validando registros e duplicidades…'}</strong>{progress && <><span>{number(progress.processed)} de {number(progress.total)} registros processados · {number(progress.imported)} novos confirmados</span><progress max={Math.max(1, progress.total)} value={progress.processed}/></>}</div></div>}
          {result && <>
            <div className="li-notice li-notice-success" role="status"><CheckCircle2 size={22}/><p><strong>Importação confirmada no banco</strong><br/>Os leads anteriores foram preservados.</p></div>
            <div className="li-confirm-summary"><div><span>Leads importados</span><strong>{number(result.imported)}</strong></div><div><span>Duplicados ignorados pelo banco</span><strong>{number(result.skipped)}</strong></div><div><span>Conflitos identificados pelo banco</span><strong>{number(result.conflicts)}</strong></div></div>
            {!legacy && <p className="li-help">Ficaram fora da gravação {number(errors)} registros com erro de validação. Os duplicados e conflitos acima refletem a conferência final do banco. Guarde o arquivo original em local protegido caso precise revisar essas linhas.</p>}
          </>}
        </fieldset>}
      </div>
      <footer className="li-footer">
        <button type="button" className="button button-secondary" disabled={busy} onClick={result || !authorized ? close : step > 0 ? () => navigate(legacy ? 0 : step - 1) : close}>{step > 0 && !result && !legacy && authorized ? <><ArrowLeft size={15}/>Voltar</> : result ? 'Concluir' : 'Cancelar'}</button>
        {authorized && !result && <button type="button" className="button button-primary" disabled={busy || (step === 0 && !parsed) || (step === 1 && !Object.values(mapping).includes('name')) || (step === 2 && !canValidate) || (step === 3 && !preview?.newCount) || (step === 4 && (!confirmed || (!legacy && !prepared?.records.length)))} onClick={() => { if (step === 2) void validate(); else if (step === 4) void importRecords(); else navigate(step + 1) }}>{busy ? <LoaderCircle size={16}/> : step === 4 ? <Check size={16}/> : <ArrowRight size={16}/>} {step === 2 ? 'Validar registros' : step === 3 ? 'Ir para confirmação' : step === 4 ? interrupted ? 'Tentar novamente com segurança' : legacy ? 'Importar backup JSON' : 'Importar registros válidos' : 'Continuar'}</button>}
      </footer>
    </section>
  </div>
}

/** Remount on company, identity or role changes so no prior company's file or preview remains visible. */
export default function ImportLeadsWizard(props: ImportLeadsWizardProps) {
  return <ImportLeadsWizardContent key={`${props.workspace.id}:${props.userId}:${props.role}`} {...props}/>
}
