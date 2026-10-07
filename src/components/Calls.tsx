import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, CalendarDays, Check, CheckCheck, ChevronRight, ClipboardList, Clock3, ExternalLink, Lightbulb, Play, Search, ShieldCheck, UserRound, SlidersHorizontal, Sparkles, Star, X } from 'lucide-react'
import type { Attendance, Lead, LeadLeadershipReview, LeadershipReviewInput } from '../types'
import type { WorkspaceRole } from '../lib/access-types'
import { isWon } from '../lib/pipeline'
import { normalizeRecordingUrl, validLeadershipReview, validRecordingUrl, validReviewInput } from '../lib/validation'
import './calls-performance.css'
import './calls-features.css'

export interface CallsProps {
  leads: Lead[]
  onEdit: (lead: Lead) => void
  onUpdate: (lead: Lead) => void | Promise<void>
  canEdit?: boolean
  role?: WorkspaceRole
  userId?: string
  leadOwners?: Record<string, string>
  ownerNames?: Record<string, string>
  canReview?: boolean
  onReview?: (leadId: string, input: LeadershipReviewInput) => Promise<LeadLeadershipReview | void>
}
type CallTab = 'all' | 'upcoming' | 'completed'
type Reading = { pain: string; objection: string; urgency: Lead['urgency'] | null; financialCapacity: Lead['financialCapacity'] | null; decisionMaker: boolean | null; recommendation: string; clues: string[] }
const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const dateValue = (value: string) => value ? new Date(value).getTime() : NaN
const formatCallDate = (value: string) => Number.isFinite(dateValue(value)) ? new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : 'Data a definir'
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase()

function readSummary(summary: string): Reading {
  const text = normalize(summary)
  const sentences = summary.split(/(?<=[.!?])\s+|\n/).map(value => value.trim()).filter(Boolean)
  const pain = sentences.find(value => /problema|dor|dificuldade|perdendo|parado|estoque|gargalo|custo|falta/.test(normalize(value))) ?? ''
  let objection = ''
  let recommendation = 'Confirme a dor principal, o impacto financeiro e quem participa da decisão antes de apresentar a proposta.'
  const clues: string[] = []
  if (/sem caixa|fluxo de caixa|caixa apertado|orcamento|caro|preco|dinheiro|investimento alto/.test(text)) {
    objection = 'Preço / caixa'
    recommendation = 'Explore o custo da inércia e confirme o orçamento disponível. Apresente condições somente depois de validar o valor percebido.'
    clues.push('O texto menciona preço, orçamento ou caixa.')
  } else if (/socio|consultar|esposa|marido|aprovacao|decisor/.test(text)) {
    objection = 'Precisa consultar'
    recommendation = 'Identifique os critérios de decisão e combine uma próxima conversa com todas as pessoas que precisam aprovar.'
    clues.push('Há uma referência a consulta ou aprovação de outra pessoa.')
  } else if (/pensar|avaliar|nao e o momento|sem tempo|depois|momento/.test(text)) {
    objection = 'Timing / prioridade'
    recommendation = 'Descubra o que precisa mudar para avançar e combine um próximo contato com data e objetivo claros.'
    clues.push('O texto menciona adiamento, avaliação ou falta de tempo.')
  } else if (/confianca|garantia|resultado|prova|receio|medo/.test(text)) {
    objection = 'Confiança / resultado'
    recommendation = 'Confirme o risco percebido e apresente evidências relevantes ao contexto do lead, sem prometer resultados.'
    clues.push('O texto menciona resultado, receio ou necessidade de prova.')
  }
  const urgency: Lead['urgency'] | null = /urgente|urgencia alta|imediato|esta semana|este mes|quanto antes|prazo/.test(text) ? 'Alta' : /sem pressa|sem urgencia|proximo ano|urgencia baixa/.test(text) ? 'Baixa' : null
  if (urgency) clues.push(`A urgência sugerida é ${urgency.toLowerCase()}, com base em expressões de prazo.`)
  const financialCapacity: Lead['financialCapacity'] | null = /sem caixa|sem dinheiro|nao tem orcamento|caixa apertado/.test(text) ? 'Baixa' : /orcamento aprovado|verba aprovada|dinheiro disponivel|tem caixa/.test(text) ? 'Alta' : null
  const decisionMaker = /precisa consultar|preciso consultar|consultar (o |a )?socio|aprovacao do/.test(text) ? false : /sou o decisor|e o decisor|decide sozinho|decido sozinho|decisao e minha/.test(text) ? true : null
  if (pain) clues.push('Uma frase com indicação de problema foi encontrada.')
  return { pain, objection, urgency, financialCapacity, decisionMaker, recommendation, clues }
}

function updateAttendance(lead: Lead, attendance: Attendance): Lead {
  if (lead.stageId) return { ...lead, attendance }
  let status = lead.status
  if (attendance === 'Compareceu' && (status === 'Call agendada' || status === 'Qualificado')) status = 'Compareceu'
  if (attendance !== 'Compareceu' && status === 'Compareceu') status = 'Call agendada'
  return { ...lead, attendance, status }
}

export function Calls({ leads, onEdit, onUpdate, canEdit = true, role, userId, leadOwners, ownerNames, canReview, onReview }: CallsProps) {
  const [tab, setTab] = useState<CallTab>('all')
  const [reviewFilter, setReviewFilter] = useState<'all' | 'pending' | 'reviewed'>('all')
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Lead | null>(null)
  const [reading, setReading] = useState<Reading | null>(null)
  const [applied, setApplied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reviewSaving, setReviewSaving] = useState(false)
  const [error, setError] = useState('')
  const [reviewError, setReviewError] = useState('')
  const [reviewNotice, setReviewNotice] = useState('')
  const [feedback, setFeedback] = useState('')
  const [leadershipScore, setLeadershipScore] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  const recordingRef = useRef<HTMLInputElement>(null)
  const leadershipAllowed = (role === 'admin' || role === 'manager') && canReview !== false && !!onReview
  const canEditCall = (lead: Lead) => canEdit && role !== 'viewer' && (role !== 'closer' || !!userId && leadOwners?.[lead.id] === userId)
  const editingAllowed = !!draft && canEditCall(draft)
  const busy = saving || reviewSaving
  const responsibleName = (lead: Lead) => {
    const ownerId = leadOwners?.[lead.id]
    return ownerId && ownerNames?.[ownerId] || (ownerId && ownerId === userId ? 'Você' : 'Não informado')
  }
  const isReviewed = (lead: Lead) => validLeadershipReview(lead.leadershipReview)
  const recordingLink = (lead: Lead) => lead.recordingUrl?.trim() && validRecordingUrl(lead.recordingUrl.trim()) ? lead.recordingUrl.trim() : ''
  const closeReview = () => { if (!busy) setDraft(null) }
  useEffect(() => {
    if (!draft) return
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.querySelector<HTMLElement>('button, input, select, textarea')?.focus()
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []).filter(element => !element.matches(':disabled'))
      const first = elements[0], last = elements.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', trapFocus)
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', trapFocus); previous?.focus() }
  }, [draft?.id])
  useEffect(() => {
    if (!draft) return
    const authoritative = leads.find(lead => lead.id === draft.id)?.leadershipReview
    setDraft(current => current && current.id === draft.id && current.leadershipReview !== authoritative ? { ...current, leadershipReview: authoritative } : current)
  }, [leads, draft?.id])
  const calls = useMemo(() => leads.filter(lead => lead.callDate || lead.attendance !== 'Pendente' || lead.callScore !== null), [leads])
  const completed = calls.filter(lead => lead.attendance === 'Compareceu')
  const scored = completed.filter(lead => lead.callScore !== null)
  const upcoming = calls.filter(lead => lead.attendance === 'Pendente' && dateValue(lead.callDate) >= Date.now())
  const average = scored.length ? (scored.reduce((sum, lead) => sum + (lead.callScore ?? 0), 0) / scored.length).toFixed(1).replace('.', ',') : '—'
  const visibleCalls = calls.filter(lead => {
    const matches = normalize(`${lead.name} ${lead.company} ${lead.objection} ${lead.source}`).includes(normalize(query.trim()))
    if (!matches || reviewFilter === 'pending' && isReviewed(lead) || reviewFilter === 'reviewed' && !isReviewed(lead)) return false
    if (tab === 'upcoming') return lead.attendance === 'Pendente' && dateValue(lead.callDate) >= Date.now()
    if (tab === 'completed') return lead.attendance !== 'Pendente'
    return true
  }).sort((a, b) => tab === 'upcoming' ? (dateValue(a.callDate) || 0) - (dateValue(b.callDate) || 0) : (dateValue(b.callDate) || 0) - (dateValue(a.callDate) || 0))
  const openReview = (lead: Lead) => {
    setDraft({ ...lead }); setReading(null); setApplied(false); setError(''); setReviewError(''); setReviewNotice('')
    setFeedback(lead.leadershipReview?.feedback ?? ''); setLeadershipScore(lead.leadershipReview ? String(lead.leadershipReview.score) : '')
  }
  const persistCall = async (lead: Lead) => {
    if (!canEditCall(lead)) return
    setError('')
    try { await onUpdate(lead) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível salvar a call. Tente novamente.') }
  }
  const saveReview = async () => {
    if (!draft || !editingAllowed || busy) return
    const recordingUrl = (draft.recordingUrl ?? '').trim()
    if (!validRecordingUrl(recordingUrl)) { setError('Use um link HTTPS válido, sem usuário ou senha no endereço, para a gravação.'); recordingRef.current?.focus(); return }
    setSaving(true); setError('')
    try { await onUpdate(updateAttendance({ ...draft, recordingUrl: normalizeRecordingUrl(recordingUrl), nextStep: (draft.nextStep ?? '').trim() }, draft.attendance)); setDraft(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível salvar o pós-call. Suas alterações continuam aqui.') }
    finally { setSaving(false) }
  }
  const saveLeadershipReview = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!draft || !leadershipAllowed || !onReview || busy) return
    const input = { feedback: feedback.trim(), score: Number(leadershipScore) }
    if (leadershipScore.trim() === '' || !validReviewInput(input)) { setReviewError('Preencha o feedback e uma nota inteira de 0 a 10.'); return }
    setReviewSaving(true); setReviewError(''); setReviewNotice('')
    try {
      const saved = await onReview(draft.id, input)
      if (saved && validLeadershipReview(saved)) setDraft(current => current && current.id === draft.id ? { ...current, leadershipReview: saved } : current)
      setReviewNotice('Revisão da liderança salva.')
    } catch (cause) { setReviewError(cause instanceof Error ? cause.message : 'Não foi possível salvar a revisão. Seu feedback continua aqui.') }
    finally { setReviewSaving(false) }
  }
  const review = validLeadershipReview(draft?.leadershipReview) ? draft.leadershipReview : undefined

  return <div className="cp-page">
    <div className="metrics-grid cp-call-metrics">
      <div className="stat-card"><span className="stat-label">Calls realizadas</span><div className="cp-stat-row"><strong className="stat-value">{completed.length}</strong><span className="cp-stat-icon"><CheckCheck size={20}/></span></div><span className="muted cp-stat-caption">Leads que compareceram</span></div>
      <div className="stat-card"><span className="stat-label">Próximas calls</span><div className="cp-stat-row"><strong className="stat-value">{upcoming.length}</strong><span className="cp-stat-icon cp-blue"><CalendarDays size={20}/></span></div><span className="muted cp-stat-caption">Agendadas a partir de agora</span></div>
      <div className="stat-card"><span className="stat-label">Nota média</span><div className="cp-stat-row"><strong className="stat-value">{average}<small>{scored.length ? ' / 10' : ''}</small></strong><span className="cp-stat-icon cp-amber"><Star size={20}/></span></div><span className="muted cp-stat-caption">{scored.length} {scored.length === 1 ? 'call avaliada' : 'calls avaliadas'}</span></div>
    </div>
    {error && !draft && <p role="alert">{error}</p>}
    <section className="panel cp-calls-panel">
      <div className="panel-header"><div><h2 className="panel-title">Seu histórico de conversas</h2><p className="muted">Registre o resultado e capture o que pode melhorar.</p></div><span className="badge">{calls.length} calls</span></div>
      <div className="cp-list-tools cf-list-tools"><div className="cp-tabs" role="tablist" aria-label="Filtrar calls">{([{ id: 'all', label: 'Todas' }, { id: 'upcoming', label: 'Próximas' }, { id: 'completed', label: 'Finalizadas' }] as const).map(item => <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}</div><div className="cf-list-filters"><label className="cf-review-filter">Revisão da liderança<select aria-label="Revisão da liderança" value={reviewFilter} onChange={event => setReviewFilter(event.target.value as typeof reviewFilter)}><option value="all">Todas</option><option value="pending">Pendentes</option><option value="reviewed">Revisadas</option></select></label><label className="cp-search"><Search size={17}/><input aria-label="Buscar calls" value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar lead ou empresa..." /></label></div></div>
      {visibleCalls.length ? <div className="cp-table-scroll"><table className="data-table cp-calls-table cf-calls-table"><thead><tr><th>Lead / empresa</th><th>Data da call</th><th>Comparecimento</th><th>Objeção principal</th><th>Nota</th><th>Revisão</th><th aria-label="Ações" /></tr></thead><tbody>{visibleCalls.map(lead => <tr key={lead.id}><td><button className="cp-person" onClick={() => onEdit(lead)} aria-label={`Editar lead ${lead.name}`}><span className="avatar cp-avatar">{initials(lead.name)}</span><span><strong>{lead.name}</strong><small>{lead.company || 'Empresa não informada'}</small>{leadOwners?.[lead.id] && <small className="cf-responsible">Closer: {responsibleName(lead)}</small>}</span></button></td><td><span className="cp-call-date">{formatCallDate(lead.callDate)}</span></td><td><select className={`cp-attendance ${lead.attendance === 'Compareceu' ? 'is-attended' : lead.attendance === 'Não compareceu' ? 'is-missed' : ''}`} aria-label={`Comparecimento de ${lead.name}`} value={lead.attendance} disabled={!canEditCall(lead) || isWon(lead)} onChange={event => void persistCall(updateAttendance(lead, event.target.value as Attendance))}><option>Pendente</option><option>Compareceu</option><option>Não compareceu</option></select></td><td><span className="cp-objection">{lead.objection || '—'}</span></td><td>{lead.callScore !== null ? <span className={`cp-score ${lead.callScore >= 8 ? 'good' : lead.callScore < 5 ? 'low' : ''}`}><Star size={13}/>{lead.callScore}<small>/10</small></span> : <span className="muted cp-no-score">Não avaliada</span>}</td><td><span className={`cf-review-status ${isReviewed(lead) ? 'reviewed' : ''}`}>{isReviewed(lead) ? <CheckCheck size={13}/> : <Clock3 size={13}/>} {isReviewed(lead) ? 'Revisada' : 'Pendente de revisão'}</span></td><td><button className="cp-review-button" onClick={() => openReview(lead)} aria-label={`Revisar call de ${lead.name}`}>Revisar<ChevronRight size={15}/></button></td></tr>)}</tbody></table></div> : <div className="empty-state cp-empty"><ClipboardList size={32}/><h3>{query || reviewFilter !== 'all' ? 'Nenhuma call encontrada' : tab === 'upcoming' ? 'Sua agenda está livre' : 'Ainda não há calls aqui'}</h3><p>{query || reviewFilter !== 'all' ? 'Ajuste a busca ou os filtros para encontrar outras conversas.' : 'Cadastre a data da reunião em um lead para acompanhar a conversa aqui.'}</p>{(query || reviewFilter !== 'all') && <button className="button button-secondary" onClick={() => { setQuery(''); setReviewFilter('all') }}>Limpar busca e filtros</button>}</div>}
    </section>
    <div className="cp-tip"><Lightbulb size={18}/><p><strong>Melhore uma coisa por call.</strong> Registre um erro e uma ação prática ao terminar a reunião. Pequenos ajustes acumulam grandes resultados.</p></div>
    {draft && <div className="cp-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeReview() }}><section ref={dialogRef} className="cp-review-modal cf-review-modal" role="dialog" aria-modal="true" aria-labelledby="call-review-title" onKeyDown={event => { if (event.key === 'Escape') closeReview() }}><div className="cp-modal-top"><div><span className="eyebrow">DETALHES DA CALL</span><h2 id="call-review-title">{draft.name}</h2><p>{draft.company || 'Lead sem empresa'} · {formatCallDate(draft.callDate)}</p></div><button className="cp-icon-button" aria-label="Fechar revisão" disabled={busy} onClick={closeReview}><X size={21}/></button></div><div className="cp-modal-body cf-modal-body">
      <section className="cf-recording"><div className="cf-section-heading"><div><span className="eyebrow">GRAVAÇÃO DA CALL</span><h3>A conversa, com contexto</h3></div><span className="cf-review-status"><UserRound size={13}/>Closer: {responsibleName(draft)}</span></div>{recordingLink(draft) ? <a className="button button-secondary cf-recording-link" href={recordingLink(draft)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><Play size={15}/>Assistir gravação<ExternalLink size={13}/></a> : <div className="cf-recording-empty"><Play size={18}/><p>Nenhuma gravação adicionada.</p>{editingAllowed && <button type="button" className="text-button" onClick={() => recordingRef.current?.focus()}>Adicionar gravação</button>}</div>}</section>
      <form id="call-post-form" className="cf-post-form" onSubmit={event => { event.preventDefault(); void saveReview() }}><div className="cf-section-heading"><div><span className="eyebrow">PÓS-CALL</span><h3>Registro do vendedor</h3></div>{draft.callScore !== null && <span className={`cp-score ${draft.callScore >= 8 ? 'good' : draft.callScore < 5 ? 'low' : ''}`}><Star size={13}/>{draft.callScore}<small>/10</small></span>}</div><fieldset disabled={!editingAllowed || busy} className="cf-post-fields"><div className="cp-review-grid"><label className="cp-field">Comparecimento<select value={draft.attendance} disabled={isWon(draft)} onChange={event => setDraft(updateAttendance(draft, event.target.value as Attendance))}><option>Pendente</option><option>Compareceu</option><option>Não compareceu</option></select></label><label className="cp-field">Objeção principal<input value={draft.objection} onChange={event => setDraft({ ...draft, objection: event.target.value })} placeholder="Ex.: preço, timing, confiança"/></label></div><div className="cp-score-field"><div className="cp-field-heading"><span>Como você avalia esta call?</span><span className="muted">{draft.callScore === null ? 'Ainda não avaliada' : `${draft.callScore} de 10`}</span></div><div className="cp-score-options" role="group" aria-label="Nota da call de 0 a 10">{Array.from({ length: 11 }, (_, score) => <button type="button" key={score} aria-pressed={draft.callScore === score} className={draft.callScore === score ? 'selected' : ''} onClick={() => setDraft({ ...draft, callScore: score })}>{score}</button>)}</div><div className="cp-score-scale"><span>Precisa melhorar</span>{draft.callScore !== null && <button type="button" onClick={() => setDraft({ ...draft, callScore: null })}>Limpar nota</button>}<span>Excelente</span></div></div>
        <div className="cp-summary-section"><div className="cp-field-heading"><span><ClipboardList size={16}/>Resumo da conversa</span><span className="muted">Seu registro da call</span></div><textarea aria-label="Resumo da conversa" rows={4} value={draft.callSummary} onChange={event => { setDraft({ ...draft, callSummary: event.target.value }); setReading(null); setApplied(false) }} placeholder="Cole ou escreva o resumo: contexto, problema, objeção e próximos passos..."/><div className="cp-analysis-bar"><span><SlidersHorizontal size={14}/>Análise local por regras, sem IA</span><button type="button" className="button button-secondary" disabled={!draft.callSummary.trim()} onClick={() => { setReading(readSummary(draft.callSummary)); setApplied(false) }}><Sparkles size={15}/>Leitura assistida</button></div>{reading && <div className="cp-reading"><div className="cp-reading-title"><Lightbulb size={17}/><strong>Sugestões para você revisar</strong></div><p>{reading.recommendation}</p>{reading.clues.length > 0 ? <ul>{reading.clues.map(clue => <li key={clue}>{clue}</li>)}</ul> : <p className="muted">Não encontramos pistas específicas. Complete o diagnóstico manualmente.</p>}<span className="cp-reading-disclaimer">A leitura procura palavras e expressões no resumo. Ela pode interpretar o contexto incorretamente.</span>{(reading.pain || reading.objection || reading.urgency || reading.financialCapacity || reading.decisionMaker !== null) && <button type="button" className="button button-secondary" disabled={applied} onClick={() => { setDraft({ ...draft, pain: reading.pain || draft.pain, objection: reading.objection || draft.objection, urgency: reading.urgency ?? draft.urgency, financialCapacity: reading.financialCapacity ?? draft.financialCapacity, decisionMaker: reading.decisionMaker ?? draft.decisionMaker }); setApplied(true) }}>{applied ? <Check size={15}/> : <ArrowUpRight size={15}/>} {applied ? 'Sugestões aplicadas' : 'Aplicar ao diagnóstico'}</button>}</div>}</div>
        <div className="cp-diagnosis-title"><span className="eyebrow">DIAGNÓSTICO DO LEAD</span></div><label className="cp-field">Dor principal<textarea rows={2} value={draft.pain} onChange={event => setDraft({ ...draft, pain: event.target.value })} placeholder="Qual problema o lead precisa resolver?"/></label><div className="cp-review-grid"><label className="cp-field">Urgência<select value={draft.urgency} onChange={event => setDraft({ ...draft, urgency: event.target.value as Lead['urgency'] })}><option>Baixa</option><option>Média</option><option>Alta</option></select></label><label className="cp-field">Capacidade financeira<select value={draft.financialCapacity} onChange={event => setDraft({ ...draft, financialCapacity: event.target.value as Lead['financialCapacity'] })}><option>Não avaliada</option><option>Baixa</option><option>Média</option><option>Alta</option></select></label></div><label className="cp-checkbox"><input type="checkbox" checked={draft.decisionMaker} onChange={event => setDraft({ ...draft, decisionMaker: event.target.checked })}/><span>O lead tem poder de decisão</span></label><label className="cp-field">Onde eu errei / o que melhorar<textarea rows={3} value={draft.closerError} onChange={event => setDraft({ ...draft, closerError: event.target.value })} placeholder="Ex.: apresentei a proposta antes de explorar o impacto do problema."/></label><label className="cp-field">Próximo passo<textarea aria-label="Próximo passo" rows={2} maxLength={10000} value={draft.nextStep ?? ''} onChange={event => setDraft({ ...draft, nextStep: event.target.value })} placeholder="Ação combinada, responsável e prazo para avançar."/></label><label className="cp-field">Link da gravação<input ref={recordingRef} aria-label="Link da gravação" aria-describedby="call-recording-help" maxLength={4096} type="url" inputMode="url" value={draft.recordingUrl ?? ''} onChange={event => setDraft({ ...draft, recordingUrl: event.target.value })} onInvalid={() => setError('Use um link HTTPS válido para a gravação.')} placeholder="https://..."/><small id="call-recording-help" className="cf-field-help">Somente um link HTTPS. A gravação fica no serviço de origem.</small></label></fieldset>{error && <p role="alert" className="cf-error">{error}</p>}{!editingAllowed && <p className="muted cf-readonly">Você tem acesso somente para consulta deste pós-call.</p>}</form>
      <section className="cf-leadership"><div className="cf-section-heading"><div><span className="eyebrow">REVISÃO DA LIDERANÇA</span><h3>Feedback para a próxima conversa</h3></div><ShieldCheck size={21}/></div><div className="cf-review-context"><span><UserRound size={14}/>Closer: <strong>{responsibleName(draft)}</strong></span><span><ClipboardList size={14}/>Pós-call preenchido pelo vendedor</span>{recordingLink(draft) && <a href={recordingLink(draft)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><Play size={13}/>Assistir gravação<ExternalLink size={12}/></a>}</div>{review && <div className="cf-review-attribution"><span className="cf-review-status reviewed"><CheckCheck size={14}/>Revisada</span><div><strong>Revisada por {review.reviewerName || 'Liderança'}</strong><time dateTime={review.reviewedAt}>{new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(review.reviewedAt))}</time></div><span className="cf-leadership-score">{review.score}<small>/10</small></span></div>}{leadershipAllowed ? <form className="cf-leadership-form" onSubmit={event => void saveLeadershipReview(event)}><label className="cp-field">Feedback da liderança<textarea aria-label="Feedback da liderança" rows={4} required maxLength={10000} value={feedback} onChange={event => setFeedback(event.target.value)} disabled={busy} placeholder="O que funcionou, o que precisa melhorar e qual ação aplicar na próxima call."/></label><label className="cp-field cf-leadership-score-field">Nota da liderança<input type="number" min={0} max={10} step={1} required value={leadershipScore} disabled={busy} onChange={event => setLeadershipScore(event.target.value)} placeholder="0 a 10"/></label>{reviewError && <p className="cf-error" role="alert">{reviewError}</p>}{reviewNotice && <p className="cf-notice" role="status"><Check size={15}/>{reviewNotice}</p>}<div className="cf-leadership-actions"><p>A avaliação da liderança é salva separadamente do pós-call.</p><button type="submit" className="button button-primary" disabled={busy}><CheckCheck size={15}/>{reviewSaving ? 'Salvando revisão…' : 'Marcar como revisada'}</button></div></form> : review ? <div className="cf-saved-feedback"><label className="cp-field">Feedback da liderança<textarea aria-label="Feedback da liderança" rows={4} value={review.feedback} readOnly/></label><p className="cf-readonly">Somente administradores e gestores podem editar esta revisão.</p></div> : <p className="cf-leadership-empty">A liderança ainda não revisou esta call.</p>}</section>
    </div><div className="cp-modal-footer"><span className="muted"><Clock3 size={14}/>Evolução começa com uma boa revisão.</span><div><button type="button" className="button button-secondary" disabled={busy} onClick={closeReview}>{editingAllowed ? 'Cancelar' : 'Fechar'}</button>{editingAllowed && <button type="submit" form="call-post-form" disabled={busy} className="button button-primary"><Check size={16}/>{saving ? 'Salvando…' : 'Salvar revisão'}</button>}</div></div></section></div>}
  </div>
}

export default Calls
