import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { AlertTriangle, Archive, Check, Copy, History, KeyRound, Link2, LoaderCircle, Pencil, Play, Plus, Power, RefreshCw, Search, ShieldCheck, Webhook, X } from 'lucide-react'
import type { Membership } from '../lib/access-types'
import type { InboundIntegration, InboundIntegrationInput, InboundIntegrationLog, InboundIntegrationService } from '../lib/inbound-types'
import { lockDialogScroll } from '../lib/dialog-scroll'
import type { Stage } from '../types'
import './inbound-integrations.css'

export interface InboundIntegrationsProps {
  workspaceId: string
  userId: string
  members: Membership[]
  service: InboundIntegrationService
  onLeadCreated?: () => void | Promise<void>
}

type MappingField = keyof InboundIntegrationInput['fieldMapping']
type Credential = { integration: InboundIntegration; token: string; webhookUrl: string }
type Confirmation = { kind: 'rotate' | 'disable' | 'archive'; integration: InboundIntegration }
const fields: { key: MappingField; label: string; sample: string | number }[] = [
  { key: 'name', label: 'Nome', sample: 'João Silva' },
  { key: 'email', label: 'E-mail', sample: 'joao@example.com' },
  { key: 'phone', label: 'Telefone / WhatsApp', sample: '77999999999' },
  { key: 'company', label: 'Empresa', sample: 'XPTO' },
  { key: 'ticket', label: 'Ticket estimado', sample: 15000 },
  { key: 'source', label: 'Origem', sample: 'Formulário Site' },
  { key: 'notes', label: 'Observações', sample: 'Tenho interesse em conhecer a solução.' },
]
const defaultMapping: InboundIntegrationInput['fieldMapping'] = Object.fromEntries(fields.map(field => [field.key, field.key]))
const statusLabels: Record<InboundIntegrationLog['status'], string> = { created: 'Lead criado', duplicate: 'Duplicado', rejected: 'Rejeitado', error: 'Erro' }
const message = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : typeof failure === 'object' && failure && 'message' in failure && typeof failure.message === 'string' ? failure.message : fallback
const date = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—'
const examplePayload = (integration: InboundIntegration, testing = false) => {
  const result: Record<string, string | number> = Object.create(null)
  for (const field of fields) {
    const property = integration.fieldMapping[field.key]
    if (!property || ['__proto__', 'prototype', 'constructor'].includes(property)) continue
    if (testing && field.key === 'phone') continue
    result[property] = testing && field.key === 'name' ? 'Teste da integração'
      : testing && field.key === 'email' ? `teste.${crypto.randomUUID()}@example.com`
        : testing && field.key === 'notes' ? 'Teste enviado pela Administração do HIGH CLOSER.' : field.key === 'source' ? integration.source : field.sample
  }
  return JSON.stringify(result, null, 2)
}

function IntegrationDialog({ title, description, children, onClose, busy = false }: { title: string; description?: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const id = useId(), descriptionId = useId()
  const dialog = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose), busyRef = useRef(busy)
  closeRef.current = onClose; busyRef.current = busy
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const release = lockDialogScroll()
    const first = dialog.current?.querySelector<HTMLElement>('[data-autofocus]:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')
      || dialog.current?.querySelector<HTMLElement>('button:not(:disabled)')
    ;(first || dialog.current)?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation()
        if (!busyRef.current) closeRef.current()
      }
      if (event.key !== 'Tab') return
      event.stopImmediatePropagation()
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])') || [])
        .filter(control => control.getClientRects().length > 0 && getComputedStyle(control).visibility !== 'hidden')
      const firstControl = controls[0], lastControl = controls.at(-1)
      if (!firstControl) { event.preventDefault(); dialog.current?.focus(); return }
      const outside = !dialog.current?.contains(document.activeElement)
      if (event.shiftKey && (document.activeElement === firstControl || outside)) { event.preventDefault(); lastControl?.focus() }
      else if (!event.shiftKey && (document.activeElement === lastControl || outside || document.activeElement === dialog.current)) { event.preventDefault(); firstControl.focus() }
    }
    window.addEventListener('keydown', keyboard, true)
    return () => {
      release(); window.removeEventListener('keydown', keyboard, true)
      const restored = previous?.isConnected && !previous.matches(':disabled') ? previous : document.querySelector<HTMLElement>('.inb-toolbar input:not(:disabled), .inb-panel .button:not(:disabled)')
      restored?.focus()
    }
  }, [])
  const close = () => { if (!busyRef.current) closeRef.current() }
  return <div className="inb-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <section className="inb-modal" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={id} aria-describedby={description ? descriptionId : undefined} aria-busy={busy}>
      <header className="inb-modal-header"><span className="inb-modal-icon"><Webhook size={19}/></span><div><h2 id={id}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div><button type="button" className="inb-icon-button" aria-label={`Fechar ${title}`} disabled={busy} onClick={close}><X size={18}/></button></header>
      {children}
    </section>
  </div>
}

export default function InboundIntegrations({ workspaceId, userId, members, service, onLeadCreated }: InboundIntegrationsProps) {
  const [integrations, setIntegrations] = useState<InboundIntegration[]>([])
  const [stages, setStages] = useState<Stage[]>([])
  const [stagesLoading, setStagesLoading] = useState(true), [stagesError, setStagesError] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('all')
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<{ integration?: InboundIntegration } | null>(null)
  const [draft, setDraft] = useState<InboundIntegrationInput>({ name: '', source: 'Formulário Site', stageId: '', ownerId: '', fieldMapping: { ...defaultMapping } })
  const [modalError, setModalError] = useState('')
  const [credential, setCredential] = useState<Credential | null>(null)
  const [rotated, setRotated] = useState(false), [copied, setCopied] = useState<'url' | 'token' | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [testOpen, setTestOpen] = useState(false), [testPayload, setTestPayload] = useState(''), [testNotice, setTestNotice] = useState('')
  const [logIntegration, setLogIntegration] = useState<InboundIntegration | null>(null)
  const [logs, setLogs] = useState<InboundIntegrationLog[]>([]), [cursor, setCursor] = useState<string | null>(null)
  const [logsLoading, setLogsLoading] = useState(false), [logsError, setLogsError] = useState('')
  const mounted = useRef(false), epoch = useRef(0), loadSequence = useRef(0), stageSequence = useRef(0), logSequence = useRef(0), saving = useRef(false)
  const serviceRef = useRef(service)
  serviceRef.current = service
  const normalStages = stages.filter(stage => stage.active && stage.type === 'NORMAL')
  const owners = members.filter(member => member.active && member.role !== 'viewer')
  const stageValid = normalStages.some(stage => stage.id === draft.stageId)
  const ownerValid = owners.some(member => member.userId === draft.ownerId)
  const current = (scope: number) => mounted.current && scope === epoch.current
  const loadStageOptions = useCallback(async () => {
    const sequence = ++stageSequence.current, scope = epoch.current
    setStagesLoading(true); setStagesError('')
    try {
      const rows = await serviceRef.current.listStages(workspaceId)
      if (current(scope) && sequence === stageSequence.current) setStages(rows)
    } catch (failure) {
      if (current(scope) && sequence === stageSequence.current) {
        setStages([])
        setStagesError(message(failure, 'O pipeline está temporariamente indisponível.'))
      }
    } finally { if (current(scope) && sequence === stageSequence.current) setStagesLoading(false) }
  }, [workspaceId])
  const refresh = useCallback(async (includeStages = false) => {
    const sequence = ++loadSequence.current, scope = epoch.current
    setLoading(true); setError('')
    if (includeStages) void loadStageOptions()
    try {
      const rows = await serviceRef.current.list(workspaceId)
      if (!current(scope) || sequence !== loadSequence.current) return
      setIntegrations(rows)
    } catch (failure) { if (current(scope) && sequence === loadSequence.current) setError(message(failure, 'Não foi possível carregar as integrações. Tente novamente.')) }
    finally { if (current(scope) && sequence === loadSequence.current) setLoading(false) }
  }, [workspaceId, loadStageOptions])
  useEffect(() => {
    mounted.current = true; epoch.current += 1
    setIntegrations([]); setStages([]); setStagesError(''); setCredential(null); setEditor(null); setConfirmation(null); setLogIntegration(null); setTestOpen(false)
    void refresh(true)
    return () => { mounted.current = false; epoch.current += 1; loadSequence.current += 1; stageSequence.current += 1; logSequence.current += 1 }
  }, [workspaceId, refresh])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 6000)
    return () => window.clearTimeout(timer)
  }, [notice])
  const updateRow = (integration: InboundIntegration) => setIntegrations(rows => rows.some(row => row.id === integration.id) ? rows.map(row => row.id === integration.id ? integration : row) : [integration, ...rows])
  const openEditor = (integration?: InboundIntegration) => {
    if (stagesLoading || stagesError) return
    setDraft(integration ? { name: integration.name, source: integration.source, stageId: integration.stageId || '', ownerId: integration.ownerId || '', fieldMapping: { ...integration.fieldMapping } }
      : { name: '', source: 'Formulário Site', stageId: normalStages[0]?.id || '', ownerId: owners.find(member => member.userId === userId)?.userId || owners[0]?.userId || '', fieldMapping: { ...defaultMapping } })
    setModalError(''); setEditor({ integration })
  }
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving.current || !editor) return
    if (stagesLoading || stagesError) { setModalError('Recarregue as etapas do pipeline antes de salvar a configuração.'); return }
    const fieldMapping: InboundIntegrationInput['fieldMapping'] = {}
    for (const field of fields) {
      const value = draft.fieldMapping[field.key]?.trim()
      if (value) fieldMapping[field.key] = value
    }
    if (!draft.name.trim() || !draft.source.trim() || !fieldMapping.name || !stageValid || !ownerValid) { setModalError('Informe o nome, a origem, o mapeamento de Nome, uma etapa NORMAL ativa e um responsável válido.'); return }
    if (Object.values(fieldMapping).some(value => value && (['__proto__', 'prototype', 'constructor'].includes(value) || /[\u0000-\u001f\u007f]/.test(value)))) { setModalError('Informe nomes de propriedades válidos, sem caracteres de controle ou nomes reservados.'); return }
    saving.current = true; setBusy(true); setModalError(''); setNotice('')
    const scope = epoch.current, editing = editor.integration
    try {
      const input = { ...draft, name: draft.name.trim(), source: draft.source.trim(), fieldMapping }
      if (editing) {
        const row = await serviceRef.current.update(workspaceId, editing.id, input)
        if (!current(scope)) return
        updateRow(row); setEditor(null); setNotice('Configuração da integração atualizada.')
      } else {
        const result = await serviceRef.current.create(workspaceId, input)
        if (!current(scope)) return
        updateRow(result.integration); setEditor(null); setCredential(result); setRotated(false); setCopied(null)
      }
      if (current(scope)) void refresh()
    } catch (failure) { if (current(scope)) setModalError(message(failure, 'Não foi possível salvar a integração. Revise os campos e tente novamente.')) }
    finally { if (current(scope)) { saving.current = false; setBusy(false) } }
  }
  const changeActive = async (integration: InboundIntegration) => {
    if (saving.current) return
    saving.current = true; setBusy(true); setError(''); setNotice('')
    const scope = epoch.current
    try {
      const row = await serviceRef.current.setActive(workspaceId, integration.id, true)
      if (current(scope)) { updateRow(row); setNotice('Integração ativada.'); void refresh() }
    } catch (failure) { if (current(scope)) setError(message(failure, 'Não foi possível ativar a integração. Revise a etapa e o responsável.')) }
    finally { if (current(scope)) { saving.current = false; setBusy(false) } }
  }
  const confirmAction = async () => {
    if (saving.current || !confirmation) return
    saving.current = true; setBusy(true); setModalError(''); setNotice('')
    const scope = epoch.current, target = confirmation
    try {
      if (target.kind === 'rotate') {
        const result = await serviceRef.current.rotate(workspaceId, target.integration.id)
        if (!current(scope)) return
        updateRow(result.integration); setCredential(result); setRotated(true); setCopied(null)
      } else {
        const row = target.kind === 'disable' ? await serviceRef.current.setActive(workspaceId, target.integration.id, false) : await serviceRef.current.archive(workspaceId, target.integration.id)
        if (!current(scope)) return
        updateRow(row); setNotice(target.kind === 'disable' ? 'Integração desativada. Novas entradas serão recusadas.' : 'Integração arquivada. O histórico foi preservado.')
      }
      setConfirmation(null); void refresh()
    } catch (failure) { if (current(scope)) setModalError(message(failure, 'Não foi possível concluir a ação. Tente novamente.')) }
    finally { if (current(scope)) { saving.current = false; setBusy(false) } }
  }
  const copy = async (kind: 'url' | 'token') => {
    if (!credential) return
    const scope = epoch.current
    try { await navigator.clipboard.writeText(kind === 'url' ? credential.webhookUrl : credential.token); if (current(scope)) { setCopied(kind); setModalError('') } }
    catch { if (current(scope)) setModalError('O navegador não permitiu copiar. Selecione o campo e copie manualmente.') }
  }
  const closeCredential = () => { setCredential(null); setCopied(null); setTestOpen(false); setTestPayload(''); setTestNotice(''); setModalError('') }
  const sendTest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving.current || !credential) return
    let payload: unknown
    try { payload = JSON.parse(testPayload) } catch { setModalError('Informe um objeto JSON válido para enviar o teste.'); return }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { setModalError('O payload de teste precisa ser um objeto JSON.'); return }
    if (new TextEncoder().encode(testPayload).length > 65536) { setModalError('O payload excede o limite de 64 KB.'); return }
    saving.current = true; setBusy(true); setModalError(''); setTestNotice('')
    const scope = epoch.current
    try {
      const result = await serviceRef.current.testWebhook(credential.webhookUrl, payload)
      if (!current(scope)) return
      setTestNotice(result.status === 'created' ? 'Lead criado no HIGH CLOSER.' : 'Envio recebido como duplicado. Nenhum novo lead criado.')
      await refresh()
      if (current(scope)) {
        try { await onLeadCreated?.() } catch { if (current(scope)) setModalError('O envio foi confirmado, mas não foi possível atualizar o CRM. Recarregue antes de reenviar.') }
      }
    } catch (failure) { if (current(scope)) setModalError(message(failure, 'O teste não foi confirmado. Verifique o payload e os logs antes de reenviar.')) }
    finally { if (current(scope)) { saving.current = false; setBusy(false) } }
  }
  const loadLogs = async (integration: InboundIntegration, beforeId?: string) => {
    const sequence = ++logSequence.current, scope = epoch.current
    setLogsLoading(true); setLogsError('')
    try {
      const result = await serviceRef.current.listLogs(workspaceId, integration.id, beforeId)
      if (!current(scope) || sequence !== logSequence.current) return
      setLogs(previous => beforeId ? [...previous, ...result.items.filter(row => !previous.some(existing => existing.id === row.id))] : result.items); setCursor(result.nextCursor)
    } catch (failure) { if (current(scope) && sequence === logSequence.current) setLogsError(message(failure, 'Não foi possível carregar os recebimentos. Tente novamente.')) }
    finally { if (current(scope) && sequence === logSequence.current) setLogsLoading(false) }
  }
  const openLogs = (integration: InboundIntegration) => { setLogs([]); setCursor(null); setLogsError(''); setLogIntegration(integration); void loadLogs(integration) }
  const visible = integrations.filter(row => `${row.name} ${row.source}`.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR')) && (filter === 'all' || filter === 'active' && row.active && !row.archivedAt || filter === 'disabled' && !row.active && !row.archivedAt || filter === 'archived' && !!row.archivedAt))
  const confirmationTitle = confirmation?.kind === 'rotate' ? 'Redefinir credencial' : confirmation?.kind === 'disable' ? 'Desativar integração' : 'Arquivar integração'

  return <div className="inb-area">
    {notice && <div className="inb-notice" role="status"><Check size={16}/><span>{notice}</span><button className="inb-icon-button" aria-label="Fechar mensagem da integração" onClick={() => setNotice('')}><X size={15}/></button></div>}
    {error && <div className="inb-error" role="alert"><span>{error}</span><button type="button" onClick={() => void refresh(true)} disabled={loading}><RefreshCw size={14}/>Tentar novamente</button></div>}
    {stagesError && <div className="inb-error" role="alert"><span>Não foi possível carregar as etapas do pipeline. Criação e edição ficam indisponíveis; logs e gestão das credenciais continuam disponíveis. {stagesError}</span><button type="button" disabled={stagesLoading || busy} onClick={() => void loadStageOptions()}><RefreshCw size={14}/>Tentar carregar etapas</button></div>}
    <section className="panel ad-panel inb-panel"><div className="panel-header"><div><h2>Formulários e Webhooks</h2><p>Receba leads do seu formulário com etapa, origem e responsável definidos.</p></div><button type="button" className="button button-primary" disabled={busy || loading || stagesLoading || !!stagesError || !normalStages.length || !owners.length} onClick={() => openEditor()}><Plus size={15}/>Nova integração</button></div>
      <div className="inb-toolbar"><label className="inb-search"><Search size={15}/><input aria-label="Buscar integrações" placeholder="Buscar nome ou origem..." value={search} onChange={event => setSearch(event.target.value)}/></label><select aria-label="Filtrar status das integrações" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Todos os status</option><option value="active">Ativas</option><option value="disabled">Desativadas</option><option value="archived">Arquivadas</option></select><button type="button" className="inb-action" disabled={loading || busy} onClick={() => void refresh(true)}><RefreshCw size={14}/>Atualizar</button></div>
      {!loading && !stagesLoading && !stagesError && !error && (!normalStages.length || !owners.length) && <p className="inb-prerequisite"><AlertTriangle size={15}/>{!normalStages.length ? 'Configure uma etapa NORMAL ativa no pipeline para receber leads.' : 'É necessário um responsável ativo com permissão de edição para criar a integração.'}</p>}
      {loading ? <div className="inb-empty" role="status"><LoaderCircle size={20} className="inb-spinning"/><p>Carregando integrações...</p></div> : visible.length ? <div className="inb-table-scroll"><table className="data-table inb-table"><thead><tr><th>Integração</th><th>Status</th><th>Destino</th><th>Criada em</th><th>Última entrada</th><th>Leads</th><th>Duplicados</th><th>Erros</th><th>Ações</th></tr></thead><tbody>{visible.map(integration => {
        const stageName = stages.find(stage => stage.id === integration.stageId)?.name || integration.stageName || 'Etapa indisponível'
        const ownerName = members.find(member => member.userId === integration.ownerId)?.displayName || integration.ownerName || 'Responsável indisponível'
        return <tr key={integration.id}><td><strong className="inb-name">{integration.name}</strong><small>{integration.source}</small><small className="inb-masked"><KeyRound size={11}/>Credencial ••••••••</small></td><td><span className={`inb-badge ${integration.archivedAt ? 'inb-badge-neutral' : integration.active ? 'inb-badge-success' : 'inb-badge-warning'}`}>{integration.archivedAt ? 'Arquivada' : integration.active ? 'Ativa' : 'Desativada'}</span></td><td><strong className="inb-destination">{stageName}</strong><small>{ownerName}</small></td><td>{date(integration.createdAt)}</td><td>{date(integration.lastReceivedAt)}</td><td className="inb-count">{integration.createdCount}</td><td className="inb-count">{integration.duplicateCount}</td><td className="inb-count">{integration.errorCount}</td><td><div className="inb-row-actions"><button type="button" className="inb-action" aria-label={`Editar ${integration.name}`} disabled={busy || stagesLoading || !!stagesError || !!integration.archivedAt} onClick={() => openEditor(integration)}><Pencil size={13}/>Editar</button><button type="button" className="inb-action" aria-label={`Logs de ${integration.name}`} disabled={busy} onClick={() => openLogs(integration)}><History size={13}/>Logs</button><button type="button" className="inb-icon-button" aria-label={`Redefinir credencial de ${integration.name}`} title="Redefinir credencial" disabled={busy || !!integration.archivedAt} onClick={() => { setConfirmation({ kind: 'rotate', integration }); setModalError('') }}><KeyRound size={15}/></button><button type="button" className="inb-icon-button" aria-label={`${integration.active ? 'Desativar' : 'Ativar'} ${integration.name}`} title={integration.active ? 'Desativar' : 'Ativar'} disabled={busy || !!integration.archivedAt} onClick={() => { if (integration.active) { setConfirmation({ kind: 'disable', integration }); setModalError('') } else void changeActive(integration) }}><Power size={15}/></button><button type="button" className="inb-icon-button" aria-label={`Arquivar ${integration.name}`} title="Arquivar" disabled={busy || !!integration.archivedAt} onClick={() => { setConfirmation({ kind: 'archive', integration }); setModalError('') }}><Archive size={15}/></button></div></td></tr>
      })}</tbody></table></div> : <div className="inb-empty"><Webhook size={26}/><h3>{search || filter !== 'all' ? 'Nenhuma integração encontrada' : 'Conecte o seu formulário'}</h3><p>{search || filter !== 'all' ? 'Ajuste a busca ou o status para ver outras integrações.' : 'Crie uma integração e use a URL como destino do webhook do seu formulário.'}</p></div>}
    </section>
    <section className="panel ad-panel inb-connect"><div className="panel-header"><div><h2>Como conectar</h2><p>Funciona com sites próprios e ferramentas que enviam HTTP POST.</p></div><Link2 size={18}/></div><div className="inb-connect-body"><div><h3>Formulário ou site com webhook</h3><ol><li>Crie a integração e copie a URL secreta.</li><li>Nas configurações do formulário, escolha webhook com método POST.</li><li>Envie JSON ou formulário codificado com os nomes de propriedades configurados.</li><li>Faça um teste e confirme o recebimento nos logs e no pipeline.</li></ol></div><div><h3>Make, Zapier ou n8n</h3><p>Formulário → HTTP POST / Webhook → URL HIGH CLOSER → campos configurados.</p><p className="inb-muted">A URL funciona como uma senha. Compartilhe apenas com quem configura o formulário e redefina a credencial se ela for exposta.</p></div></div></section>

    {editor && <IntegrationDialog title={editor.integration ? 'Editar integração' : 'Nova integração'} description="Cada entrada usa a etapa e o responsável configurados nesta empresa." busy={busy} onClose={() => { setEditor(null); setModalError('') }}><form onSubmit={event => void save(event)}>
      <div className="inb-modal-body"><div className="inb-form-grid"><label>Nome da integração<input aria-label="Nome da integração" data-autofocus required minLength={2} maxLength={120} value={draft.name} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="Formulário principal"/></label><label>Origem padrão<input aria-label="Origem padrão" required maxLength={120} value={draft.source} disabled={busy} onChange={event => setDraft({ ...draft, source: event.target.value })} placeholder="Formulário Site"/><small>Usada quando a entrada não informar uma origem mapeada.</small></label><label>Etapa de entrada<select aria-label="Etapa de entrada" required value={draft.stageId} disabled={busy} onChange={event => setDraft({ ...draft, stageId: event.target.value })}><option value="">Selecione uma etapa NORMAL ativa</option>{!stageValid && draft.stageId && <option value={draft.stageId} disabled>Etapa atual indisponível — selecione outra</option>}{normalStages.map(stage => <option value={stage.id} key={stage.id}>{stage.name}</option>)}</select></label><label>Responsável padrão<select aria-label="Responsável padrão" required value={draft.ownerId} disabled={busy} onChange={event => setDraft({ ...draft, ownerId: event.target.value })}><option value="">Selecione um membro ativo</option>{!ownerValid && draft.ownerId && <option value={draft.ownerId} disabled>Responsável atual indisponível — selecione outro</option>}{owners.map(member => <option value={member.userId} key={member.userId}>{member.displayName || member.email}</option>)}</select></label></div>
        {(!stageValid || !ownerValid) && <p className="inb-warning"><AlertTriangle size={15}/>Selecione uma etapa NORMAL ativa e um responsável ativo com permissão de edição.</p>}
        <div className="inb-section-heading"><h3>Mapeamento de campos</h3><p>Nome exato da propriedade recebida → campo HIGH CLOSER. Use propriedades no primeiro nível do payload.</p></div><div className="inb-mapping">{fields.map(field => <label className="inb-mapping-row" key={field.key}><input aria-label={`Propriedade externa para ${field.label}`} required={field.key === 'name'} maxLength={120} value={draft.fieldMapping[field.key] || ''} disabled={busy} onChange={event => setDraft({ ...draft, fieldMapping: { ...draft.fieldMapping, [field.key]: event.target.value } })} placeholder={field.key}/><span aria-hidden="true">→</span><span>{field.label}{field.key === 'name' && <b className="inb-required">Obrigatório</b>}</span></label>)}</div>
        <p className="inb-field-help">Recomendamos mapear e-mail ou telefone para identificar duplicados. Campos opcionais podem ficar sem mapeamento.</p>{!draft.fieldMapping.email?.trim() && !draft.fieldMapping.phone?.trim() && <p className="inb-warning"><AlertTriangle size={15}/>Sem e-mail ou telefone, não é possível identificar a mesma pessoa em envios diferentes.</p>}<div className="inb-duplicate-note"><ShieldCheck size={16}/><span>Duplicidade: não criar um novo lead quando já existir a mesma pessoa nesta empresa, comparando telefone e e-mail normalizados.</span></div>{modalError && <p className="inb-error" role="alert">{modalError}</p>}
      </div><footer className="inb-modal-footer"><button type="button" className="button button-secondary" disabled={busy} onClick={() => { setEditor(null); setModalError('') }}>Cancelar</button><button type="submit" className="button button-primary" disabled={busy || stagesLoading || !!stagesError || !stageValid || !ownerValid}>{busy ? <LoaderCircle size={15} className="inb-spinning"/> : <Check size={15}/>} {editor.integration ? 'Salvar configuração' : 'Criar integração'}</button></footer></form></IntegrationDialog>}

    {credential && !testOpen && <IntegrationDialog title={rotated ? 'Credencial redefinida' : 'Integração criada'} description={credential.integration.name} busy={busy} onClose={closeCredential}><div className="inb-modal-body"><p className="inb-warning"><ShieldCheck size={16}/><span>Esta URL funciona como uma credencial. Guarde-a em local seguro. Por segurança, ela não será exibida novamente.{rotated && ' A credencial anterior já deixou de valer.'}</span></p><label className="inb-credential-field">URL do Webhook<div><input readOnly aria-label="URL do Webhook" value={credential.webhookUrl} onFocus={event => event.currentTarget.select()}/><button type="button" className="button button-secondary" onClick={() => void copy('url')}>{copied === 'url' ? <Check size={14}/> : <Copy size={14}/>} {copied === 'url' ? 'URL copiada' : 'Copiar URL'}</button></div></label><label className="inb-credential-field">Token<div><input readOnly aria-label="Token" value={credential.token} onFocus={event => event.currentTarget.select()}/><button type="button" className="button button-secondary" onClick={() => void copy('token')}>{copied === 'token' ? <Check size={14}/> : <Copy size={14}/>} {copied === 'token' ? 'Token copiado' : 'Copiar token'}</button></div></label><div className="inb-section-heading"><h3>Exemplo de payload</h3><p>POST com Content-Type: application/json e as propriedades mapeadas.</p></div><pre className="inb-code">{examplePayload(credential.integration)}</pre><p className="inb-field-help">A URL completa já inclui a autenticação; não é necessário configurar um cabeçalho secreto no formulário.</p>{modalError && <p className="inb-error" role="alert">{modalError}</p>}</div><footer className="inb-modal-footer"><button type="button" className="button button-secondary" disabled={busy} onClick={() => { setTestPayload(examplePayload(credential.integration, true)); setTestNotice(''); setModalError(''); setTestOpen(true) }}><Play size={14}/>Testar integração</button><button type="button" className="button button-primary" disabled={busy} onClick={closeCredential}>Fechar</button></footer></IntegrationDialog>}

    {credential && testOpen && <IntegrationDialog title="Testar integração" description={credential.integration.name} busy={busy} onClose={() => { setTestOpen(false); setModalError(''); setTestPayload(''); setTestNotice('') }}><form onSubmit={event => void sendTest(event)}><div className="inb-modal-body"><p className="inb-warning"><AlertTriangle size={16}/><span>Este teste cria um lead real quando o contato ainda não existe nesta empresa. Confira os dados antes de enviar; um contato repetido será registrado como duplicado.</span></p><label className="inb-payload-label">Payload de teste<textarea data-autofocus aria-label="Payload de teste" spellCheck={false} value={testPayload} disabled={busy} onChange={event => setTestPayload(event.target.value)}/></label>{testNotice && <p className="inb-notice" role="status"><Check size={15}/>{testNotice}</p>}{modalError && <p className="inb-error" role="alert">{modalError}</p>}</div><footer className="inb-modal-footer"><button type="button" className="button button-secondary" disabled={busy} onClick={() => { setTestOpen(false); setModalError(''); setTestPayload(''); setTestNotice('') }}>Voltar</button><button type="submit" className="button button-primary" disabled={busy}>{busy ? <LoaderCircle size={15} className="inb-spinning"/> : <Play size={14}/>}Enviar teste real</button></footer></form></IntegrationDialog>}

    {confirmation && <IntegrationDialog title={confirmationTitle} description={confirmation.integration.name} busy={busy} onClose={() => { setConfirmation(null); setModalError('') }}><div className="inb-modal-body"><p className="inb-confirm-copy">{confirmation.kind === 'rotate' ? 'A URL e o token anteriores deixam de funcionar imediatamente. Atualize o webhook do formulário com a nova credencial para continuar recebendo leads.' : confirmation.kind === 'disable' ? 'A integração deixará de receber leads imediatamente. Você poderá ativá-la novamente; os logs e leads existentes serão preservados.' : 'A integração deixará de receber leads e será arquivada. O histórico de recebimentos e os leads existentes serão preservados.'}</p>{modalError && <p className="inb-error" role="alert">{modalError}</p>}</div><footer className="inb-modal-footer"><button type="button" className="button button-secondary" disabled={busy} onClick={() => { setConfirmation(null); setModalError('') }}>Cancelar</button><button type="button" className="button button-primary" disabled={busy} onClick={() => void confirmAction()}>{busy ? <LoaderCircle size={15} className="inb-spinning"/> : confirmation.kind === 'rotate' ? <KeyRound size={14}/> : <Power size={14}/>} {confirmation.kind === 'rotate' ? 'Redefinir credencial' : confirmation.kind === 'disable' ? 'Desativar' : 'Arquivar'}</button></footer></IntegrationDialog>}

    {logIntegration && <IntegrationDialog title={`Logs de ${logIntegration.name}`} description="Recebimentos recentes. O histórico não inclui payloads brutos nem credenciais." onClose={() => { logSequence.current += 1; setLogIntegration(null); setLogs([]); setCursor(null) }}><div className="inb-modal-body inb-logs-body"><div className="inb-logs-toolbar"><span>{logs.length} recebimentos carregados</span><button type="button" className="inb-action" disabled={logsLoading} onClick={() => void loadLogs(logIntegration)}><RefreshCw size={14}/>Atualizar logs</button></div>{logsError && <p className="inb-error" role="alert"><span>{logsError}</span><button type="button" onClick={() => void loadLogs(logIntegration)}>Tentar novamente</button></p>}{logsLoading && !logs.length ? <div className="inb-empty" role="status"><LoaderCircle size={19} className="inb-spinning"/>Carregando recebimentos...</div> : logs.length ? <div className="inb-table-scroll"><table className="data-table inb-logs-table"><thead><tr><th>Data</th><th>Resultado</th><th>Referência</th><th>Código de erro</th><th>Requisição</th></tr></thead><tbody>{logs.map(log => <tr key={log.id}><td>{date(log.createdAt)}</td><td><span className={`inb-badge ${log.status === 'created' ? 'inb-badge-success' : log.status === 'duplicate' ? 'inb-badge-neutral' : 'inb-badge-danger'}`}>{statusLabels[log.status]}</span></td><td><code>{log.leadId || log.duplicateLeadId || '—'}</code></td><td>{log.errorCode || '—'}</td><td><code>{log.requestId}</code></td></tr>)}</tbody></table></div> : !logsError && <div className="inb-empty"><History size={24}/><p>Nenhuma entrada recebida nesta integração.</p></div>}{cursor && <button type="button" className="button button-secondary inb-load-more" disabled={logsLoading} onClick={() => void loadLogs(logIntegration, cursor)}>{logsLoading && <LoaderCircle size={14} className="inb-spinning"/>}Carregar mais recebimentos</button>}</div><footer className="inb-modal-footer"><button type="button" className="button button-secondary" onClick={() => { logSequence.current += 1; setLogIntegration(null); setLogs([]); setCursor(null) }}>Fechar</button></footer></IntegrationDialog>}
  </div>
}
