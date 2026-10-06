import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowRight, Bell, CalendarDays, Check, ChevronDown, ChevronRight, Command, Database, Download, LayoutDashboard, LifeBuoy, LogOut, PanelLeftClose, Plus, Search, Settings2, Sparkles, TrendingUp, UsersRound, Video, X } from 'lucide-react'
import type { Lead, LeadStatus, Page, Settings } from './types'
import { createDemoLeads, defaultSettings } from './lib/data'
import { getPeriodLeads, initials, isStale } from './lib/analytics'
import Dashboard from './components/Dashboard'
import Pipeline from './components/Pipeline'
import Calls from './components/Calls'
import Performance from './components/Performance'
import LeadForm, { makeLead } from './components/LeadForm'
import { validLead, validSettings } from './lib/validation'

const LEADS_KEY = 'closer-os-leads-v1'
const SETTINGS_KEY = 'closer-os-settings-v1'
const navigation = [
  { id: 'dashboard' as Page, name: 'Dashboard', icon: LayoutDashboard },
  { id: 'pipeline' as Page, name: 'Pipeline', icon: UsersRound },
  { id: 'calls' as Page, name: 'Calls', icon: Video },
  { id: 'performance' as Page, name: 'Performance', icon: TrendingUp },
]
let loadWarning = ''
function loadLeads(): Lead[] {
  try {
    const saved = localStorage.getItem(LEADS_KEY)
    if (!saved) return createDemoLeads()
    const parsed = JSON.parse(saved)
    if (!Array.isArray(parsed) || !parsed.every(validLead)) throw new Error('invalid')
    return parsed
  } catch { loadWarning = 'Não foi possível ler os dados locais. O armazenamento original foi preservado.'; return [] }
}
function loadSettings(): Settings {
  try { const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); return validSettings(saved) ? saved : defaultSettings } catch { return defaultSettings }
}
function download(name: string, contents: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = name; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function App() {
  const [leads, setLeads] = useState<Lead[]>(loadLeads)
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [page, setPage] = useState<Page>('dashboard')
  const [period, setPeriod] = useState<'month' | 'quarter' | 'all'>('month')
  const [editing, setEditing] = useState<{ lead: Lead; isNew: boolean } | null>(null)
  const [toast, setToast] = useState(loadWarning)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [recoveryMode, setRecoveryMode] = useState(Boolean(loadWarning))
  const searchRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const [settingsDraft, setSettingsDraft] = useState(settings)
  const [confirmClear, setConfirmClear] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)
  const persist = (next: Lead[], message?: string) => {
    if (recoveryMode) { setToast('Importe um backup para recuperar os dados antes de salvar.'); return }
    try { localStorage.setItem(LEADS_KEY, JSON.stringify(next)); setLeads(next); if (message) setToast(message) }
    catch { setToast('O navegador não conseguiu salvar. Exporte um backup e libere espaço.'); }
  }
  useEffect(() => {
    try {
      if (!localStorage.getItem(LEADS_KEY) && !recoveryMode) localStorage.setItem(LEADS_KEY, JSON.stringify(leads))
    } catch { setToast('Armazenamento indisponível. Exporte seus dados para preservá-los.') }
  }, [])
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(''), 5500); return () => clearTimeout(timer) } }, [toast])
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus() }
      if (event.key === 'Escape') { setEditing(null); setSettingsOpen(false); setHelpOpen(false); setNotificationsOpen(false); setSearchFocused(false); setSidebarOpen(false) }
      if (event.key === 'Tab' && dialogRef.current) {
        const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]'))
        const first = items[0], last = items[items.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [])
  useEffect(() => {
    if (editing || settingsOpen || helpOpen) {
      const previous = document.activeElement as HTMLElement
      document.body.style.overflow = 'hidden'
      const timer = setTimeout(() => dialogRef.current?.querySelector<HTMLElement>('input, button')?.focus(), 50)
      return () => { clearTimeout(timer); document.body.style.overflow = ''; previous?.focus() }
    }
  }, [editing, settingsOpen, helpOpen])
  const update = (lead: Lead) => persist(leads.map(item => item.id === lead.id ? lead : item), 'Oportunidade atualizada.')
  const save = (lead: Lead) => {
    const next = editing?.isNew ? [lead, ...leads] : leads.map(item => item.id === lead.id ? lead : item)
    persist(next, editing?.isNew ? 'Novo lead cadastrado. Vamos construir o próximo sim!' : 'Alterações salvas. Seus indicadores já foram atualizados.')
    if (!recoveryMode) setEditing(null)
  }
  const edit = (lead: Lead) => { setEditing({ lead, isNew: false }); setSearch(''); setSearchFocused(false) }
  const add = (status: LeadStatus = 'Lead novo') => setEditing({ lead: { ...makeLead(), status, attendance: status === 'Compareceu' || status === 'Fechado' ? 'Compareceu' : 'Pendente' }, isNew: true })
  const filteredLeads = getPeriodLeads(leads, period)
  const priorDate = new Date(); priorDate.setDate(1); priorDate.setMonth(priorDate.getMonth() - 1)
  const previousLeads = getPeriodLeads(leads, 'month', priorDate)
  const stale = leads.filter(lead => isStale(lead))
  const searchResults = search.trim() ? leads.filter(lead => `${lead.name} ${lead.company} ${lead.source}`.toLowerCase().includes(search.toLowerCase())).slice(0, 6) : []
  const hasDemo = leads.some(lead => lead.id.startsWith('demo-'))
  const titles = {
    dashboard: { title: 'Visão geral', description: 'Suas vendas, sua performance e o próximo passo. Tudo aqui.' },
    pipeline: { title: 'Pipeline de vendas', description: 'Transforme boas conversas em grandes resultados.' },
    calls: { title: 'Calls', description: 'Cada reunião é uma chance de fechar. E de evoluir.' },
    performance: { title: 'Evolução do Closer', description: 'Entenda seus padrões. Refine sua abordagem. Venda melhor.' },
  }
  const navigate = (next: Page) => { setPage(next); setSidebarOpen(false); window.scrollTo({ top: 0, behavior: 'smooth' }) }
  const exportCsv = () => {
    const keys: (keyof Lead)[] = ['name', 'company', 'email', 'phone', 'ticket', 'source', 'callDate', 'attendance', 'objection', 'status', 'closedValue', 'closedAt', 'lastContactAt', 'notes', 'callScore', 'closerError']
    const headers = ['Lead', 'Empresa', 'E-mail', 'WhatsApp', 'Ticket previsto', 'Origem', 'Data da call', 'Comparecimento', 'Objeção', 'Status', 'Valor fechado', 'Data de fechamento', 'Último contato', 'Observações', 'Nota da call', 'Erro do closer']
    const escape = (value: unknown) => { let text = String(value ?? ''); if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"` }
    download(`closer-os-${new Date().toISOString().slice(0, 10)}.csv`, '\uFEFF' + [headers.map(escape).join(';'), ...filteredLeads.map(lead => keys.map(key => escape(lead[key])).join(';'))].join('\r\n'), 'text/csv;charset=utf-8')
    setToast('CSV do período exportado.')
  }
  const exportBackup = () => { download(`closer-os-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ version: 1, leads, settings }, null, 2), 'application/json'); setToast('Backup exportado com todos os leads e configurações.') }
  const importBackup = async (file?: File) => {
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text())
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.leads) || !parsed.leads.every(validLead)) throw new Error('invalid')
      const next = [...leads]
      for (const lead of parsed.leads as Lead[]) { if (!next.some(item => item.id === lead.id)) next.push({ ...makeLead(), ...lead }) }
      localStorage.setItem(LEADS_KEY, JSON.stringify(next)); setLeads(next); setRecoveryMode(false)
      setToast(`${next.length - leads.length} leads importados. Os leads existentes foram preservados.`)
    } catch { setToast('Não foi possível importar. Use um backup JSON válido do Closer OS.') }
    if (importRef.current) importRef.current.value = ''
  }
  return <div className="app-shell"><aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}><a className="brand" href="#" onClick={event => { event.preventDefault(); navigate('dashboard') }} aria-label="Closer OS início"><span className="brand-mark"><span /><span /><span /></span><span>closer<span className="brand-os">os</span><i /></span></a><div className="workspace-selector"><span className="workspace-icon">A</span><span><strong>Meu workspace</strong><small>Seu espaço de vendas</small></span><ChevronDown size={14} /></div><div className="nav-group-label">WORKSPACE</div><nav aria-label="Menu principal">{navigation.slice(0, 3).map(({ id, name, icon: Icon }) => <button className={`nav-item ${page === id ? 'selected' : ''}`} onClick={() => navigate(id)} key={id}><Icon size={19} strokeWidth={1.7} /><span>{name}</span>{id === 'pipeline' && <span className="nav-count" aria-hidden="true">{leads.filter(lead => !['Fechado', 'Perdido'].includes(lead.status)).length}</span>}</button>)}<div className="nav-group-label intelligence-label">INTELIGÊNCIA</div>{navigation.slice(3).map(({ id, name, icon: Icon }) => <button className={`nav-item ${page === id ? 'selected' : ''}`} onClick={() => navigate(id)} key={id}><Icon size={19} strokeWidth={1.7} /><span>{name}</span><span className="new-pill" aria-hidden="true">Novo</span></button>)}</nav><div className="sidebar-bottom"><div className="growth-card"><span className="growth-icon"><Sparkles size={20} /></span><h3>Seu próximo nível.</h3><p>Pequenas melhorias.<br />Grandes fechamentos.</p><button onClick={() => navigate('performance')}>Acompanhar evolução <ArrowRight size={14} /></button></div><button className="nav-item" onClick={() => { setSettingsDraft(settings); setSettingsOpen(true) }}><Settings2 size={18} /><span>Configurações</span></button><button className="nav-item" onClick={() => setHelpOpen(true)}><LifeBuoy size={18} /><span>Central de ajuda</span></button><div className="sidebar-profile"><span className="profile-avatar">{initials(settings.name)}</span><span><strong>{settings.name}</strong><small>Closer high ticket</small></span><button aria-label="Abrir configurações de perfil" onClick={() => { setSettingsDraft(settings); setSettingsOpen(true) }}><ChevronDown size={15} /></button></div></div></aside>{sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
    <div className="main-shell"><header className="topbar"><div className="breadcrumb"><button className="mobile-menu icon-button" aria-label="Abrir menu" onClick={() => setSidebarOpen(!sidebarOpen)}><PanelLeftClose size={19} /></button><span>Workspace</span><ChevronRight size={13} /><strong>{navigation.find(item => item.id === page)?.name}</strong></div><div className="topbar-actions"><div className="global-search"><Search size={15} /><input ref={searchRef} aria-label="Buscar leads" value={search} onFocus={() => setSearchFocused(true)} onChange={event => setSearch(event.target.value)} placeholder="Buscar leads, empresas..." /><kbd><Command size={10} /> K</kbd>{searchFocused && search && <div className="search-results">{searchResults.length ? searchResults.map(lead => <button key={lead.id} onClick={() => edit(lead)}><span className="avatar small">{initials(lead.name)}</span><span><strong>{lead.name}</strong><small>{lead.company} · {lead.status}</small></span><ArrowRight size={14} /></button>) : <p>Nenhum lead encontrado.</p>}<button className="search-close" onClick={() => setSearchFocused(false)}>Fechar busca <X size={12} /></button></div>}</div><span className="topbar-divider" /><div className="notification-wrap"><button className="notification-button icon-button" aria-label="Notificações de follow-up" aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen(!notificationsOpen)}><Bell size={18} />{stale.length > 0 && <i />}</button>{notificationsOpen && <div className="notification-popover"><div><h3>Hora de retomar a conversa</h3><small>{stale.length} leads há mais de 5 dias sem contato</small></div>{stale.slice(0, 4).map(lead => <button key={lead.id} onClick={() => { edit(lead); setNotificationsOpen(false) }}><span className="avatar small">{initials(lead.name)}</span><span><strong>{lead.name}</strong><small>{lead.company}</small></span><ArrowRight size={14} /></button>)}{!stale.length && <p>Seus follow-ups estão em dia. Boa!</p>}</div>}</div><button className="profile-avatar top-avatar" aria-label="Seu perfil" onClick={() => { setSettingsDraft(settings); setSettingsOpen(true) }}>{initials(settings.name)}</button></div></header>
    <main><div className="welcome-row"><span className="eyebrow">SEU ESPAÇO PARA IR ALÉM</span><span className="current-date"><CalendarDays size={13} />{new Date().toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' })}<span className="timezone-tag">Horário local</span></span></div><div className="page-heading"><div><h1>{titles[page].title}<span className="heading-dot">.</span></h1><p>{titles[page].description}</p></div><div className="page-actions">{page === 'dashboard' && <label className="period-select"><CalendarDays size={15} /><select aria-label="Período do dashboard" value={period} onChange={event => setPeriod(event.target.value as typeof period)}><option value="month">Este mês</option><option value="quarter">Últimos 3 meses</option><option value="all">Todo o período</option></select><ChevronDown size={13} /></label>}<button className="button button-primary" onClick={() => add()}><Plus size={17} />Novo lead</button></div></div>
    {page === 'dashboard' && <div className="overview-strip"><div><span className="live-dot" /><span>Vamos fazer deste mês o seu melhor, <strong>{settings.name.split(' ')[0]}</strong>.</span></div><button onClick={exportCsv}><ArrowDownToLine size={14} />Exportar relatório</button></div>}
    {page === 'dashboard' && <Dashboard leads={filteredLeads} allLeads={leads} previousLeads={period === 'month' ? previousLeads : []} settings={settings} onPage={navigate} onEdit={edit} />}
    {page === 'pipeline' && <Pipeline leads={leads} onEdit={edit} onAdd={add} onUpdate={update} />}
    {page === 'calls' && <Calls leads={leads} onEdit={edit} onUpdate={update} />}
    {page === 'performance' && <Performance leads={leads} />}
    <footer className="main-footer"><span><span className="tiny-brand">c</span> Closer OS <span>·</span> Feito para quem fecha.</span><span><span className="live-dot" />{hasDemo ? 'Dados de demonstração · ' : ''}Salvo neste navegador</span></footer></main></div>
    {editing && <div ref={dialogRef}><LeadForm key={editing.lead.id} lead={editing.lead} isNew={editing.isNew} onSave={save} onClose={() => setEditing(null)} onDelete={id => { persist(leads.filter(lead => lead.id !== id), 'Lead excluído.'); setEditing(null) }} /></div>}
    {settingsOpen && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSettingsOpen(false) }}><div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref={dialogRef}><div className="panel-header"><div><h2 id="settings-title">Seu workspace</h2><p>Configure suas metas e mantenha seus dados seguros.</p></div><button className="icon-button" aria-label="Fechar configurações" onClick={() => setSettingsOpen(false)}><X size={20} /></button></div><form onSubmit={event => { event.preventDefault(); try { const nextSettings = { ...settingsDraft, name: settingsDraft.name.trim() }; if (!validSettings(nextSettings)) { setToast('Informe nome, meta e comissão válidos.'); return } localStorage.setItem(SETTINGS_KEY, JSON.stringify(nextSettings)); setSettings(nextSettings); setToast('Metas e configurações atualizadas.'); setSettingsOpen(false) } catch { setToast('Não foi possível salvar as configurações.') } }}><div className="form-grid"><label className="full-field">Seu nome<input required maxLength={80} value={settingsDraft.name} onChange={event => setSettingsDraft({ ...settingsDraft, name: event.target.value })} /></label><label>Meta de faturamento (R$)<input required type="number" min="1" value={settingsDraft.revenueGoal} onChange={event => setSettingsDraft({ ...settingsDraft, revenueGoal: Number(event.target.value) })} /></label><label>Comissão (%)<input required type="number" min="0" max="100" step="0.1" value={settingsDraft.commissionRate} onChange={event => setSettingsDraft({ ...settingsDraft, commissionRate: Number(event.target.value) })} /></label></div><button className="button button-primary settings-save" type="submit"><Check size={15} />Salvar configurações</button></form><div className="settings-data"><h3><Database size={16} />Seus dados</h3><p>Os dados ficam neste navegador. Exporte um backup antes de trocar de dispositivo ou limpar o armazenamento.</p><div className="settings-backup-actions"><button className="button button-secondary" onClick={exportBackup}><Download size={15} />Exportar backup</button><button className="button button-secondary" onClick={() => importRef.current?.click()}>Importar leads</button><input ref={importRef} type="file" accept="application/json,.json" hidden onChange={event => void importBackup(event.target.files?.[0])} /></div>{hasDemo && <>{confirmClear ? <div className="clear-confirm"><p>Remover apenas os leads de demonstração? Seus leads cadastrados serão preservados.</p><button className="button button-danger" onClick={() => { persist(leads.filter(lead => !lead.id.startsWith('demo-')), 'Dados de demonstração removidos.'); setConfirmClear(false) }}>Sim, remover demonstração</button><button className="text-button" onClick={() => setConfirmClear(false)}>Cancelar</button></div> : <button className="text-button danger" onClick={() => setConfirmClear(true)}>Remover dados de demonstração</button>}</>}</div></div></div>}
    {helpOpen && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setHelpOpen(false) }}><div className="settings-modal help-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="help-title"><div className="panel-header"><div><h2 id="help-title">Seu próximo nível começa aqui</h2><p>Um fluxo simples para vender melhor.</p></div><button className="icon-button" aria-label="Fechar ajuda" onClick={() => setHelpOpen(false)}><X size={20} /></button></div><ol><li><strong>Cadastre e qualifique.</strong><p>Registre ticket, origem e contexto. Mova a oportunidade pelo pipeline.</p></li><li><strong>Aprenda com suas calls.</strong><p>Registre comparecimento, objeções, nota e o que você pode melhorar. A leitura assistida usa regras locais para sugerir próximos passos.</p></li><li><strong>Feche e acompanhe.</strong><p>Ao marcar como fechado, informe o valor. Receita e comissão são calculadas automaticamente.</p></li><li><strong>Evolua toda semana.</strong><p>Observe suas notas, erros recorrentes e conversão por origem.</p></li></ol><div className="help-metrics"><h3>Como calculamos</h3><p><b>Comparecimento:</b> calls realizadas ÷ calls com presença ou falta registrada. Calls pendentes ficam fora.</p><p><b>Fechamento:</b> vendas fechadas ÷ calls realizadas. Vendas fechadas contam como comparecimento.</p><p><b>Ticket médio:</b> faturamento ÷ vendas fechadas. Receita usa a data de fechamento.</p></div><button className="button button-primary" onClick={() => setHelpOpen(false)}>Entendi. Vamos fechar!</button></div></div>}
    {toast && <div role="status" className={`toast ${toast.includes('Não') ? 'toast-error' : ''}`}><span className="toast-icon"><Check size={16} /></span>{toast}<button aria-label="Fechar aviso" onClick={() => setToast('')}><X size={15} /></button></div>}
  </div>
}
