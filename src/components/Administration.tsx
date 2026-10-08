import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeft, Building2, Check, ChevronDown, Copy, CreditCard, Download, ExternalLink, History, Link2, LoaderCircle, LockKeyhole, Mail, MessageCircle, Pencil, Plus, RefreshCw, Search, Send, ShieldCheck, Trash2, UserCheck, UserMinus, Users, X } from 'lucide-react'
import type { AdministrationService, AuditEntry, Invitation, Membership, PlatformWorkspace, Subscription, SubscriptionPlan, SubscriptionStatus, WorkspaceAccess, WorkspacePrivacy, WorkspaceRole } from '../lib/access-types'
import './administration.css'
import './administration-names.css'

export interface AdministrationProps {
  access: WorkspaceAccess | null
  isPlatformAdmin?: boolean
  service: AdministrationService
  onAccessChange?: () => void | Promise<void>
}

const roles: Record<WorkspaceRole, string> = { admin: 'Administrador', manager: 'Gestor', closer: 'Closer', viewer: 'Visualização' }
const statuses: Record<SubscriptionStatus, string> = { trial: 'Em teste', active: 'Ativo', past_due: 'Pagamento pendente', suspended: 'Suspenso', cancelled: 'Cancelado' }
const actions: Record<string, string> = {
  'workspace.created': 'Empresa criada', 'workspace.updated': 'Empresa atualizada', 'workspace.deleted': 'Empresa removida',
  'member.updated': 'Acesso de membro atualizado', 'member.joined': 'Membro entrou na equipe', 'member.deactivated': 'Membro desativado',
  'invitation.created': 'Convite criado', 'invitation.accepted': 'Convite aceito', 'invitation.revoked': 'Convite revogado',
  'subscription.updated': 'Plano ou assinatura atualizados', 'lead.created': 'Lead cadastrado', 'lead.updated': 'Lead atualizado', 'lead.deleted': 'Lead excluído',
  'settings.updated': 'Configurações atualizadas', 'workspace.exported': 'Dados exportados',
  'membership.updated': 'Permissões ou acesso atualizados', 'workspace.owner_transferred': 'Responsável da empresa atualizado',
  'profile.display_name_updated': 'Nome pessoal atualizado', 'membership.display_name_updated': 'Nome do membro atualizado nesta empresa', 'workspace.renamed': 'Nome da empresa atualizado',
  'workspace.privacy_updated': 'Política de dados atualizada',
  'lead.insert': 'Lead cadastrado', 'lead.update': 'Lead atualizado', 'lead.delete': 'Lead excluído',
  'leads.imported': 'Leads importados', 'lead.privacy_recorded': 'Base legal do lead registrada',
  'leads.retention_purged': 'Retenção de dados aplicada', 'platform.bootstrap': 'Administrador da plataforma configurado',
}
const date = (value?: string | null, time = false) => value && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', ...(time ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(new Date(value)) : 'Não definido'
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error && typeof error.message === 'string' ? error.message : fallback
const localDate = (value: string | null) => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return ''
  const parsed = new Date(value)
  return new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
const memberInitials = (name: string) => name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?'
type InvitationInput = { email: string; role: WorkspaceRole; name?: string }
type GeneratedInvitationLink = { url: string; email: string; workspaceId: string; invitationId?: string; role: WorkspaceRole; name?: string; mode: 'email' | 'manual'; replaced: boolean; requiresSignIn?: boolean }
type NameEditor = { workspaceId: string; kind: 'workspace' } | { workspaceId: string; kind: 'member'; member: Membership }

export default function Administration({ access, isPlatformAdmin, service, onAccessChange }: AdministrationProps) {
  const platform = isPlatformAdmin ?? access?.isPlatformAdmin ?? false
  const [tab, setTab] = useState<'clients' | 'team' | 'plan' | 'audit' | 'company'>(platform ? 'clients' : 'team')
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(access?.workspace.id ?? '')
  const [clients, setClients] = useState<PlatformWorkspace[]>([])
  const [members, setMembers] = useState<Membership[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [clientsLoading, setClientsLoading] = useState(platform)
  const [error, setError] = useState('')
  const [clientError, setClientError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [memberSearch, setMemberSearch] = useState('')
  const [clientSearch, setClientSearch] = useState('')
  const [roleEdits, setRoleEdits] = useState<Record<string, WorkspaceRole>>({})
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteName, setInviteName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>('closer')
  const [createOpen, setCreateOpen] = useState(false)
  const [clientName, setClientName] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [generatedLink, setGeneratedLink] = useState<GeneratedInvitationLink | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmation, setConfirmation] = useState<{ member?: Membership; invitation?: Invitation; workspaceDelete?: boolean; newOwner?: Membership } | null>(null)
  const [subscriptionDraft, setSubscriptionDraft] = useState<Subscription | null>(null)
  const [privacyDraft, setPrivacyDraft] = useState<WorkspacePrivacy | null>(null)
  const [privacyLoading, setPrivacyLoading] = useState(false)
  const [privacyError, setPrivacyError] = useState('')
  const [newOwnerId, setNewOwnerId] = useState('')
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [nameEditor, setNameEditor] = useState<NameEditor | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [nameError, setNameError] = useState('')
  const savingName = useRef(false)
  const serviceRef = useRef(service)
  const sequence = useRef(0)
  const clientSequence = useRef(0)
  const currentWorkspaceId = useRef(selectedWorkspaceId)
  currentWorkspaceId.current = selectedWorkspaceId
  const dialogRef = useRef<HTMLDivElement>(null)
  const selectedClient = clients.find(client => client.id === selectedWorkspaceId)
  const workspace = selectedClient ?? (access?.workspace.id === selectedWorkspaceId ? access.workspace : null)
  const subscription = selectedClient?.subscription ?? (access?.workspace.id === selectedWorkspaceId ? access.subscription : null)
  const canManage = platform || !!(access?.membership.active && access.membership.role === 'admin' && access.workspace.id === selectedWorkspaceId)
  const memberAdmin = !!(access?.membership.active && access.membership.role === 'admin' && access.workspace.id === selectedWorkspaceId)
  const isOwner = memberAdmin && workspace?.ownerId === access?.membership.userId
  const activeMembers = members.filter(member => member.active)
  const activeAdminCount = activeMembers.filter(member => member.role === 'admin').length
  const pendingInvitations = invitations.filter(invitation => !invitation.acceptedAt && !invitation.revokedAt && new Date(invitation.expiresAt).getTime() > Date.now())
  const visibleInvitations = invitations.filter(invitation => !invitation.revokedAt)
  const reservedSeats = activeMembers.length + pendingInvitations.length
  const seatsFull = !!subscription && reservedSeats >= subscription.seatLimit

  useEffect(() => { serviceRef.current = service }, [service])
  useEffect(() => {
    setNameEditor(null); setNameDraft(''); setNameError('')
  }, [selectedWorkspaceId, memberAdmin])
  useEffect(() => {
    if (!platform) setSelectedWorkspaceId(access?.workspace.id ?? '')
  }, [access?.workspace.id, platform])
  const refreshTeam = useCallback(async (workspaceId: string) => {
    if (workspaceId !== currentWorkspaceId.current) return
    const current = ++sequence.current
    if (!workspaceId) { setMembers([]); setInvitations([]); setAudit([]); return }
    setLoading(true)
    setError('')
    const result = await Promise.allSettled([
      serviceRef.current.listMembers(workspaceId),
      serviceRef.current.listInvitations(workspaceId),
      serviceRef.current.listAudit(workspaceId),
    ])
    if (current !== sequence.current || workspaceId !== currentWorkspaceId.current) return
    if (result[0].status === 'fulfilled') { setMembers(result[0].value); setRoleEdits({}) }
    if (result[1].status === 'fulfilled') setInvitations(result[1].value)
    if (result[2].status === 'fulfilled') setAudit(result[2].value)
    const failures = result.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
    if (failures.length) setError(errorMessage(failures[0].reason, 'Não foi possível carregar a administração. Tente novamente.'))
    setLoading(false)
  }, [])
  const refreshClients = useCallback(async () => {
    const current = ++clientSequence.current
    setClientsLoading(true)
    setClientError('')
    try {
      const next = await serviceRef.current.listPlatformWorkspaces()
      if (current === clientSequence.current) setClients(next)
    } catch (failure) {
      if (current === clientSequence.current) setClientError(errorMessage(failure, 'Não foi possível carregar os clientes.'))
    } finally { if (current === clientSequence.current) setClientsLoading(false) }
  }, [])
  useEffect(() => {
    setMembers([]); setInvitations([]); setAudit([]); setRoleEdits({}); setGeneratedLink(null); setMemberSearch(''); setConfirmation(null); setInviteOpen(false)
    if (canManage && selectedWorkspaceId) void refreshTeam(selectedWorkspaceId)
    return () => { sequence.current += 1 }
  }, [selectedWorkspaceId, canManage, refreshTeam])
  useEffect(() => { if (platform) void refreshClients(); return () => { clientSequence.current += 1 } }, [platform, refreshClients])
  useEffect(() => {
    if (generatedLink?.invitationId && invitations.some(invitation => invitation.id === generatedLink.invitationId && (invitation.acceptedAt || invitation.revokedAt))) setGeneratedLink(null)
  }, [invitations, generatedLink?.invitationId])
  useEffect(() => { setSubscriptionDraft(subscription ? { ...subscription } : null) }, [selectedWorkspaceId, subscription?.plan, subscription?.status, subscription?.seatLimit, subscription?.currentPeriodEnd])
  useEffect(() => {
    let active = true
    setPrivacyDraft(null); setPrivacyError(''); setNewOwnerId(''); setDeleteConfirmation('')
    if (!memberAdmin || !selectedWorkspaceId) return
    setPrivacyLoading(true)
    serviceRef.current.getWorkspacePrivacy(selectedWorkspaceId).then(value => {
      if (active) setPrivacyDraft(value)
    }).catch(failure => {
      if (active) setPrivacyError(errorMessage(failure, 'Não foi possível carregar a configuração de privacidade.'))
    }).finally(() => { if (active) setPrivacyLoading(false) })
    return () => { active = false }
  }, [selectedWorkspaceId, memberAdmin])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 6000)
    return () => clearTimeout(timer)
  }, [notice])
  const hasModal = inviteOpen || createOpen || !!confirmation || !!nameEditor
  useEffect(() => {
    if (!hasModal) return
    const previous = document.activeElement as HTMLElement | null
    const originalOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const isNameModal = !!dialogRef.current?.classList.contains('ad-name-modal')
    const nameInput = dialogRef.current?.querySelector<HTMLInputElement>('[data-name-autofocus]:not(:disabled)')
    if (nameInput) { nameInput.focus(); nameInput.select() }
    else if (isNameModal) dialogRef.current?.focus()
    else dialogRef.current?.querySelector<HTMLElement>('input, select, button')?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) { setInviteOpen(false); setCreateOpen(false); setConfirmation(null); setNameEditor(null); setNameError('') }
      if (event.key !== 'Tab') return
      const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)') ?? [])
      if (isNameModal && !items.length) { event.preventDefault(); dialogRef.current?.focus(); return }
      if (isNameModal && !dialogRef.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? items.at(-1) : items[0])?.focus(); return }
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus() }
      if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus() }
    }
    document.addEventListener('keydown', keyboard)
    return () => { document.body.style.overflow = originalOverflow; document.removeEventListener('keydown', keyboard); previous?.focus() }
  }, [hasModal, pending])
  const run = async (key: string, operation: () => Promise<void>, success: string | (() => string), refresh = true) => {
    setPending(key); setError(''); setNotice('')
    let completed = false
    try {
      await operation()
      completed = true
      if (refresh && selectedWorkspaceId) await refreshTeam(selectedWorkspaceId)
      if (platform) await refreshClients()
      await onAccessChange?.()
      setNotice(typeof success === 'function' ? success() : success)
    } catch (failure) { setError(completed ? 'A alteração foi salva, mas não foi possível atualizar a tela. Recarregue antes de repetir a ação.' : errorMessage(failure, 'Não foi possível concluir a ação. Tente novamente.')) }
    finally { setPending(null) }
  }
  const editName = (target: NameEditor, value: string) => {
    if (!memberAdmin || pending || loading || target.workspaceId !== selectedWorkspaceId) return
    setNameEditor(target); setNameDraft(value); setNameError(''); setError(''); setNotice('')
  }
  const saveName = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending || savingName.current || !nameEditor) return
    const target = nameEditor
    if (!memberAdmin || target.workspaceId !== selectedWorkspaceId || target.workspaceId !== currentWorkspaceId.current) {
      setNameError('Somente um administrador ativo desta empresa pode editar o nome.'); return
    }
    const value = nameDraft.trim()
    const minimum = target.kind === 'workspace' ? 1 : 2
    if (value.length < minimum || value.length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
      setNameError(`Informe um nome de ${minimum} a 120 caracteres, sem caracteres de controle.`); return
    }
    setNameError(''); savingName.current = true
    try {
      await run(target.kind === 'workspace' ? 'workspace-name' : `member-name:${target.member.userId}`, async () => {
        if (target.kind === 'workspace') await serviceRef.current.renameWorkspace(target.workspaceId, value)
        else await serviceRef.current.updateMemberName(target.workspaceId, target.member.userId, value)
        setNameEditor(null); setNameDraft('')
      }, target.kind === 'workspace' ? 'Nome da empresa atualizado.' : 'Nome do membro atualizado nesta empresa.')
    } finally { savingName.current = false }
  }
  const writeClipboard = async (url: string) => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2500); return true }
    catch { setCopied(false); return false }
  }
  const performInvitation = async (workspaceId: string, input: InvitationInput, manual: boolean, replaced: boolean, key = 'invite') => {
    setGeneratedLink(null); setCopied(false)
    let linkCopied = false
    let requiresSignIn = false
    await run(key, async () => {
      try {
        if (manual) {
          const result = await serviceRef.current.createManualInvitation(workspaceId, input)
          if (result.manualLink !== true) throw new Error('Não foi possível confirmar o novo link. Atualize a lista antes de tentar novamente.')
          requiresSignIn = result.requiresSignIn === true
          setGeneratedLink({ url: result.url, email: result.invitation.email, workspaceId, invitationId: result.invitation.id, role: input.role, name: input.name, mode: 'manual', replaced, requiresSignIn })
          linkCopied = await writeClipboard(result.url)
        } else {
          const result = await serviceRef.current.createInvitation(workspaceId, input)
          if (result.emailSent !== true) throw new Error('O envio do convite não foi confirmado. Atualize a lista antes de tentar novamente.')
          setGeneratedLink({ url: result.url, email: result.invitation.email, workspaceId, invitationId: result.invitation.id, role: input.role, name: input.name, mode: 'email', replaced })
        }
        setInviteOpen(false); setInviteName(''); setInviteEmail(''); setInviteRole('closer')
      } catch (failure) {
        setInviteName(input.name ?? ''); setInviteEmail(input.email); setInviteRole(input.role); setInviteOpen(true)
        await refreshTeam(workspaceId)
        throw failure
      }
    }, () => {
      if (!manual) return `${replaced ? 'Convite reenviado' : 'Convite enviado'} por e-mail. ${replaced ? 'O link anterior deixa de valer.' : 'O link de acesso também está disponível abaixo.'}`
      const label = requiresSignIn ? 'Link do convite' : 'Link de ativação'
      return `${label} ${linkCopied ? 'copiado.' : 'pronto para copiar.'} ${replaced ? 'O convite anterior deixa de valer. ' : ''}Envie diretamente pelo WhatsApp para a pessoa convidada.`
    })
  }
  const invitationInput = (invitation: Invitation): InvitationInput => ({ email: invitation.email, role: invitation.role, ...(invitation.name ? { name: invitation.name } : {}) })
  const formInvitation = (): InvitationInput => ({ email: inviteEmail.trim().toLowerCase(), role: inviteRole, name: inviteName.trim() })
  const createInvite = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!inviteName.trim()) { setError('Informe o nome da pessoa convidada.'); return }
    const input = formInvitation()
    await performInvitation(selectedWorkspaceId, input, false, invitations.some(invitation => !invitation.acceptedAt && !invitation.revokedAt && invitation.email.toLowerCase() === input.email))
  }
  const createManualInvite = async (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!event.currentTarget.form?.reportValidity()) return
    if (!inviteName.trim()) { setError('Informe o nome da pessoa convidada.'); return }
    const input = formInvitation()
    await performInvitation(selectedWorkspaceId, input, true, invitations.some(invitation => !invitation.acceptedAt && !invitation.revokedAt && invitation.email.toLowerCase() === input.email), 'manual-invite')
  }
  const copyLink = async () => {
    if (!generatedLink) return
    if (generatedLink.mode === 'email') {
      await performInvitation(generatedLink.workspaceId, { email: generatedLink.email, role: generatedLink.role, name: generatedLink.name }, true, true, 'manual-link')
      return
    }
    if (await writeClipboard(generatedLink.url)) setNotice('Link copiado. Compartilhe diretamente com a pessoa convidada pelo WhatsApp.')
    else setError('Não foi possível copiar automaticamente. Selecione e copie o link abaixo.')
  }
  const createClient = async (event: React.FormEvent) => {
    event.preventDefault()
    const email = ownerEmail.trim().toLowerCase()
    const personName = ownerName.trim()
    await run('create-client', async () => {
      try {
        const result = await serviceRef.current.createWorkspace({ name: clientName.trim(), ownerEmail: email, ...(ownerName.trim() ? { ownerName: ownerName.trim() } : {}) })
        if (result.emailSent !== true) throw Object.assign(new Error('A empresa foi criada, mas o envio do convite não foi confirmado. Tente enviar o convite ao administrador nesta empresa.'), { workspaceId: result.id })
        setCreateOpen(false); setClientName(''); setOwnerEmail(''); setOwnerName('')
        setGeneratedLink({ url: result.invitationUrl, email, workspaceId: result.id, role: 'admin', name: personName, mode: 'email', replaced: false }); setCopied(false)
      } catch (failure) {
        const createdId = typeof failure === 'object' && failure && 'workspaceId' in failure && typeof failure.workspaceId === 'string' ? failure.workspaceId : null
        if (createdId) {
          setCreateOpen(false); setClientName(''); setOwnerEmail(''); setOwnerName(''); setGeneratedLink(null)
          setSelectedWorkspaceId(createdId); setTab('team'); setInviteName(personName); setInviteEmail(email); setInviteRole('admin')
          await refreshClients()
        }
        throw failure
      }
    }, 'Empresa criada e convite enviado por e-mail ao administrador.', false)
  }
  const selectClient = (client: PlatformWorkspace) => { setSelectedWorkspaceId(client.id); setTab('team'); setNotice(''); setError('') }
  const saveSubscription = (event: React.FormEvent) => {
    event.preventDefault()
    if (!subscriptionDraft) return
    const end = subscriptionDraft.currentPeriodEnd ? new Date(subscriptionDraft.currentPeriodEnd).getTime() : null
    if (!Number.isInteger(subscriptionDraft.seatLimit) || subscriptionDraft.seatLimit < Math.max(1, reservedSeats)) {
      setError('O limite de lugares deve ser inteiro e comportar os membros ativos e convites pendentes.'); return
    }
    if ((end !== null && !Number.isFinite(end)) || (subscriptionDraft.status === 'trial' && end === null)) {
      setError('Informe uma data de término válida para o período de teste.'); return
    }
    if (['active', 'trial'].includes(subscriptionDraft.status) && end !== null && end <= Date.now()) {
      setError('Para liberar o acesso, escolha uma vigência futura ou deixe a vigência vazia no plano ativo.'); return
    }
    void run('subscription', () => serviceRef.current.updateSubscription(selectedWorkspaceId, subscriptionDraft), 'Plano e acesso atualizados.')
  }
  const exportCompany = () => void run('export-company', async () => {
    const data = await serviceRef.current.exportWorkspace(selectedWorkspaceId)
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url; link.download = `high-closer-empresa-${new Date().toISOString().slice(0, 10)}.json`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, 'Dados da empresa exportados.', false)
  const confirmAction = () => {
    if (!confirmation) return
    const target = confirmation
    const message = target.workspaceDelete ? 'Empresa e dados excluídos.' : target.newOwner ? 'Responsabilidade transferida.' : target.member ? 'Acesso desativado.' : 'Convite revogado.'
    void run('confirm', async () => {
      if (target.workspaceDelete) {
        await serviceRef.current.deleteWorkspace(selectedWorkspaceId, deleteConfirmation)
        setSelectedWorkspaceId(''); setTab(platform ? 'clients' : 'team'); setGeneratedLink(null)
      }
      if (target.newOwner) {
        await serviceRef.current.transferWorkspaceOwner(selectedWorkspaceId, target.newOwner.userId)
        setNewOwnerId('')
      }
      if (target.member) await serviceRef.current.updateMember(selectedWorkspaceId, target.member.userId, { active: false })
      if (target.invitation) {
        await serviceRef.current.revokeInvitation(selectedWorkspaceId, target.invitation.id)
        if (generatedLink?.invitationId === target.invitation.id) setGeneratedLink(null)
      }
      setConfirmation(null)
    }, message, !target.workspaceDelete)
  }
  const visibleMembers = members.filter(member => `${member.displayName} ${member.email}`.toLowerCase().includes(memberSearch.toLowerCase()))
  const visibleClients = clients.filter(client => `${client.name} ${client.adminEmail ?? ''}`.toLowerCase().includes(clientSearch.toLowerCase()))
  if (!access && !platform) return null
  if (!canManage) return <section className="panel ad-restricted"><LockKeyhole size={30}/><h2>Acesso à administração restrito</h2><p>Um administrador ativo da empresa pode gerenciar a equipe e os convites.</p></section>

  return <div className="ad-page">
    <div className="ad-context"><div className="ad-context-title"><span className="ad-context-icon">{platform ? <Building2 size={19}/> : <ShieldCheck size={19}/>}</span><div><strong>{tab === 'clients' ? 'Administração da plataforma' : workspace?.name ?? 'Selecione uma empresa'}</strong><small>{platform ? 'Gestão comercial e de acesso · sem acesso às conversas dos clientes' : 'Equipe, permissões e histórico da sua empresa'}</small></div></div>{platform && tab !== 'clients' && <button className="button button-secondary" onClick={() => { setTab('clients'); setGeneratedLink(null); setError('') }}><ArrowLeft size={14}/> Todos os clientes</button>}{!platform && subscription && <span className={`ad-status ad-status-${subscription.status}`}>{statuses[subscription.status]}</span>}</div>
    <div className="ad-tabs" role="tablist" aria-label="Seções de administração">{platform && <button role="tab" aria-selected={tab === 'clients'} className={tab === 'clients' ? 'active' : ''} onClick={() => setTab('clients')}><Building2 size={15}/>Clientes</button>}{selectedWorkspaceId && <><button role="tab" aria-selected={tab === 'team'} className={tab === 'team' ? 'active' : ''} onClick={() => setTab('team')}><Users size={15}/>Equipe</button><button role="tab" aria-selected={tab === 'plan'} className={tab === 'plan' ? 'active' : ''} onClick={() => setTab('plan')}><CreditCard size={15}/>Plano</button><button role="tab" aria-selected={tab === 'audit'} className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}><History size={15}/>Auditoria</button>{memberAdmin && <button role="tab" aria-selected={tab === 'company'} className={tab === 'company' ? 'active' : ''} onClick={() => setTab('company')}><ShieldCheck size={15}/>Empresa</button>}</>}</div>
    {notice && <div className="ad-notice" role="status"><Check size={16}/>{notice}<button aria-label="Fechar mensagem" onClick={() => setNotice('')}><X size={14}/></button></div>}
    {error && <div className="ad-error" role="alert"><span>{error}</span><button onClick={() => selectedWorkspaceId ? void refreshTeam(selectedWorkspaceId) : void refreshClients()}><RefreshCw size={13}/>Tentar novamente</button></div>}
    {generatedLink && <section className="ad-link-card">
      <div><span className="ad-link-icon">{generatedLink.mode === 'manual' ? <MessageCircle size={18}/> : <Mail size={18}/>}</span><div>
        <strong>{generatedLink.mode === 'manual' ? generatedLink.requiresSignIn ? 'Link do convite para WhatsApp' : 'Link de ativação para WhatsApp' : 'Convite enviado por e-mail'}</strong>
        <p>{generatedLink.mode === 'manual' ? <>Envie este link diretamente para {generatedLink.name || generatedLink.email}. Nenhum e-mail foi enviado por esta ação.</> : <>Envio solicitado para {generatedLink.email}. Peça à pessoa para conferir a caixa de entrada e o spam.</>}</p>
      </div></div>
      <div className="ad-link-actions"><input readOnly aria-label="Link do convite" value={generatedLink.url} onFocus={event => event.currentTarget.select()}/><button className="button button-secondary" disabled={!!pending} onClick={() => void copyLink()}>{pending === 'manual-link' ? <LoaderCircle size={15} className="ad-spinning"/> : copied ? <Check size={15}/> : <Copy size={15}/>} {copied ? 'Copiado' : 'Copiar link'}</button><button className="ad-icon-button" aria-label="Ocultar link do convite" disabled={!!pending} onClick={() => setGeneratedLink(null)}><X size={17}/></button></div>
      <small>{generatedLink.replaced ? 'Novo link gerado; o convite anterior deixa de valer. ' : ''}{generatedLink.mode === 'manual' ? `${generatedLink.requiresSignIn ? 'Esta pessoa deve entrar com sua própria senha para aceitar o convite.' : 'O convidado poderá ativar o acesso à empresa com a própria conta.'} Compartilhe somente com a pessoa indicada.` : 'Para compartilhar pelo WhatsApp, use Copiar link: será gerado um novo link de ativação e o convite anterior deixará de valer.'}</small>
    </section>}
    {tab === 'clients' && platform && <>
      <div className="ad-metrics"><div className="stat-card"><span className="stat-label">Empresas cadastradas</span><strong>{clients.length}</strong><small>Todos os clientes da plataforma</small></div><div className="stat-card"><span className="stat-label">Assinaturas ativas</span><strong>{clients.filter(client => client.subscription.status === 'active').length}</strong><small>Status confirmado manualmente</small></div><div className="stat-card"><span className="stat-label">Pagamentos pendentes</span><strong>{clients.filter(client => client.subscription.status === 'past_due').length}</strong><small>Clientes que precisam de atenção</small></div></div>
      <section className="panel ad-panel"><div className="panel-header"><div><h2>Clientes da plataforma</h2><p>Gerencie clientes, convites por e-mail e planos. A cobrança é administrada separadamente.</p></div><button className="button button-primary" onClick={() => { setCreateOpen(true); setError('') }} disabled={!!pending}><Plus size={16}/>Nova empresa</button></div><div className="ad-toolbar"><label className="ad-search"><Search size={15}/><input aria-label="Buscar empresas" value={clientSearch} onChange={event => setClientSearch(event.target.value)} placeholder="Buscar empresa ou administrador..."/></label><button className="ad-refresh" onClick={() => void refreshClients()} disabled={clientsLoading}><RefreshCw size={14}/>Atualizar</button></div>{clientError && <div className="ad-error" role="alert">{clientError}<button onClick={() => void refreshClients()}>Tentar novamente</button></div>}{clientsLoading ? <div className="ad-loading"><LoaderCircle size={22}/>Carregando clientes...</div> : visibleClients.length ? <div className="ad-table-scroll"><table className="data-table ad-client-table"><thead><tr><th>Empresa</th><th>Plano</th><th>Assinatura</th><th>Membros</th><th>Vigência até</th><th><span className="ad-sr-only">Administrar cliente</span></th></tr></thead><tbody>{visibleClients.map(client => <tr key={client.id}><td><div className="ad-identity"><span className="ad-avatar"><Building2 size={17}/></span><div><strong>{client.name}</strong><small>{client.adminEmail || 'Administrador convidado'}</small></div></div></td><td>{client.subscription.plan === 'team' ? 'Equipe' : 'Individual'}</td><td><span className={`ad-status ad-status-${client.subscription.status}`}>{statuses[client.subscription.status]}</span></td><td>{client.memberCount} / {client.subscription.seatLimit}</td><td>{date(client.subscription.currentPeriodEnd)}</td><td><button className="ad-table-action" disabled={!!pending} onClick={() => selectClient(client)}>Administrar <ExternalLink size={13}/></button></td></tr>)}</tbody></table></div> : <div className="empty-state ad-empty"><Building2 size={29}/><h3>{clientSearch ? 'Nenhuma empresa encontrada' : 'Sua primeira empresa começa aqui'}</h3><p>{clientSearch ? 'Tente outro nome ou e-mail.' : 'Cadastre o cliente e envie o convite ao administrador por e-mail.'}</p></div>}</section>
    </>}
    {tab === 'team' && selectedWorkspaceId && <>
      <div className="ad-team-overview"><div><span className="ad-overview-icon"><Users size={21}/></span><div><strong>{activeMembers.length} {activeMembers.length === 1 ? 'membro ativo' : 'membros ativos'}</strong><small>{subscription ? `${subscription.seatLimit} lugares no plano · ${pendingInvitations.length} convites pendentes` : 'Convide as pessoas que constroem seu resultado'}</small></div></div><button className="button button-primary" onClick={() => { setInviteOpen(true); setError('') }} disabled={!!pending || loading || seatsFull}><Plus size={15}/>Convidar pessoa</button></div>{seatsFull && <p className="ad-seat-note">Todos os lugares do plano estão ocupados ou reservados por convites pendentes. Revogue um convite, desative um membro ou solicite mais lugares ao operador.</p>}
      <section className="panel ad-panel"><div className="panel-header"><div><h2>Pessoas e permissões</h2><p>Defina o papel de cada membro. A autorização é verificada também no servidor.</p></div><ShieldCheck size={19} className="ad-muted-icon"/></div><div className="ad-toolbar"><label className="ad-search"><Search size={15}/><input aria-label="Buscar membros" value={memberSearch} onChange={event => setMemberSearch(event.target.value)} placeholder="Buscar por nome ou e-mail..."/></label><button className="ad-refresh" onClick={() => void refreshTeam(selectedWorkspaceId)} disabled={loading}><RefreshCw size={14}/>Atualizar</button></div>{loading ? <div className="ad-loading"><LoaderCircle size={22}/>Carregando equipe...</div> : visibleMembers.length ? <div className="ad-table-scroll"><table className="data-table ad-member-table"><thead><tr><th>Pessoa</th><th>Papel</th><th>Acesso</th><th><span className="ad-sr-only">Gerenciar membro</span></th></tr></thead><tbody>{visibleMembers.map(member => {
        const self = member.userId === access?.membership.userId
        const lastAdmin = member.role === 'admin' && member.active && activeAdminCount <= 1
        const ownerMember = member.userId === workspace?.ownerId
        const protectedMember = self || lastAdmin || ownerMember
        const editedRole = roleEdits[member.userId] ?? member.role
        return <tr key={member.userId}><td><div className="ad-identity"><span className="ad-avatar">{memberInitials(member.displayName || member.email)}</span><div><div className="ad-name-heading"><strong>{member.displayName || member.email}{self && <span className="ad-you">Você</span>}</strong>{memberAdmin && <button type="button" className="ad-name-action" aria-label={`Editar nome de ${member.displayName || member.email}`} disabled={!!pending || loading} onClick={() => editName({ workspaceId: selectedWorkspaceId, kind: 'member', member }, member.displayName || '')}><Pencil size={13} aria-hidden="true"/>Editar nome</button>}</div><small>{member.email}</small></div></div></td><td><div className="ad-role-editor"><select aria-label={`Papel de ${member.email}`} value={editedRole} disabled={protectedMember || !!pending} onChange={event => setRoleEdits({ ...roleEdits, [member.userId]: event.target.value as WorkspaceRole })}>{Object.entries(roles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{editedRole !== member.role && <button className="ad-save-role" disabled={!!pending} aria-label={`Salvar papel de ${member.email}`} onClick={() => void run(`role:${member.userId}`, () => serviceRef.current.updateMember(selectedWorkspaceId, member.userId, { role: editedRole }), 'Permissão atualizada.')}><Check size={13}/>Salvar</button>}</div>{(lastAdmin || ownerMember) && <small className="ad-protected-label">{ownerMember ? 'Responsável pela empresa' : 'Último administrador ativo'}</small>}</td><td><span className={`ad-status ${member.active ? 'ad-status-active' : 'ad-status-suspended'}`}>{member.active ? 'Ativado' : 'Desativado'}</span></td><td>{member.active ? <button className="ad-table-action ad-danger-action" disabled={protectedMember || !!pending} title={ownerMember ? 'Transfira a responsabilidade antes de desativar este acesso.' : self ? 'Seu próprio acesso não pode ser desativado aqui.' : lastAdmin ? 'Mantenha ao menos um administrador ativo.' : undefined} onClick={() => setConfirmation({ member })}><UserMinus size={14}/>Desativar</button> : <button className="ad-table-action" disabled={!!pending || seatsFull} onClick={() => void run(`activate:${member.userId}`, () => serviceRef.current.updateMember(selectedWorkspaceId, member.userId, { active: true }), 'Membro reativado.')}><UserCheck size={14}/>Reativar</button>}</td></tr>
      })}</tbody></table></div> : <div className="empty-state ad-empty"><Users size={28}/><p>{memberSearch ? 'Nenhum membro encontrado.' : 'Nenhum membro nesta empresa. Compartilhe um convite para começar.'}</p></div>}<div className="ad-role-guide"><span><b>Administrador</b>Equipe e configurações</span><span><b>Gestor</b>Operação e performance</span><span><b>Closer</b>Rotina de vendas</span><span><b>Visualização</b>Somente leitura</span></div></section>
      <section className="panel ad-panel"><div className="panel-header"><div><h2>Convites e ativações</h2><p>{pendingInvitations.length} convites pendentes · {activeMembers.length} pessoas com acesso ativado. Reenviar ou gerar outro link invalida o convite anterior.</p></div><Mail size={18} className="ad-muted-icon"/></div>
        {loading ? <div className="ad-loading"><LoaderCircle size={19}/>Carregando convites...</div> : visibleInvitations.length ? <div className="ad-table-scroll"><table className="data-table ad-invitation-table"><thead><tr><th>Pessoa</th><th>Papel</th><th>Situação</th><th>Válido até</th><th>Ações</th></tr></thead><tbody>{visibleInvitations.map(invitation => {
          const member = members.find(person => person.email.toLowerCase() === invitation.email.toLowerCase())
          const expired = !Number.isFinite(new Date(invitation.expiresAt).getTime()) || new Date(invitation.expiresAt).getTime() <= Date.now()
          const state = invitation.acceptedAt ? member?.active ? 'Ativado' : member ? 'Acesso desativado' : 'Aceito' : expired ? 'Expirado' : 'Pendente'
          return <tr key={invitation.id}><td><div className="ad-invitation-person"><strong>{invitation.name || invitation.email}</strong>{invitation.name && <small>{invitation.email}</small>}</div></td><td>{roles[invitation.role]}</td><td><span className={`ad-status ${state === 'Ativado' ? 'ad-status-active' : state === 'Expirado' || state === 'Acesso desativado' ? 'ad-status-suspended' : 'ad-status-trial'}`}>{state}</span></td><td>{invitation.acceptedAt ? <span className="ad-invitation-accepted">Aceito em {date(invitation.acceptedAt)}</span> : date(invitation.expiresAt, true)}</td><td>{!invitation.acceptedAt ? <div className="ad-invitation-actions">
            <button className="ad-table-action" aria-label={`${expired ? 'Gerar outro convite' : 'Reenviar convite'} para ${invitation.email}`} disabled={!!pending} onClick={() => void performInvitation(selectedWorkspaceId, invitationInput(invitation), false, true, `resend:${invitation.id}`)}><Send size={13}/>{expired ? 'Gerar outro convite' : 'Reenviar'}</button>
            <button className="ad-table-action" aria-label={`Copiar link de ${invitation.email}`} disabled={!!pending} onClick={() => void performInvitation(selectedWorkspaceId, invitationInput(invitation), true, true, `manual:${invitation.id}`)}><Copy size={13}/>{expired ? 'Copiar novo link' : 'Copiar link'}</button>
            {!expired && <button className="ad-table-action ad-danger-action" aria-label={`Revogar convite de ${invitation.email}`} disabled={!!pending} onClick={() => setConfirmation({ invitation })}><Trash2 size={13}/>Revogar</button>}
          </div> : <small className="ad-invitation-accepted">Gerencie o acesso na lista de pessoas.</small>}</td></tr>
        })}</tbody></table></div> : <div className="empty-state ad-small-empty"><Mail size={23}/><p>Nenhum convite pendente. Novos convites e ativações aparecerão aqui.</p></div>}
      </section>
    </>}
    {tab === 'plan' && selectedWorkspaceId && <section className="panel ad-panel ad-plan-panel"><div className="panel-header"><div><h2>Plano e acesso</h2><p>{platform ? 'Atualize os direitos de acesso após confirmar a contratação ou o pagamento.' : 'A contratação e a cobrança são administradas pelo operador do HIGH CLOSER.'}</p></div><CreditCard size={21} className="ad-muted-icon"/></div>{subscription ? <><div className="ad-plan-summary"><div><span className="eyebrow">PLANO ATUAL</span><strong>{subscription.plan === 'team' ? 'Equipe' : 'Individual'}</strong><p>{subscription.seatLimit} {subscription.seatLimit === 1 ? 'lugar' : 'lugares'} disponíveis no plano</p></div><div><span className={`ad-status ad-status-${subscription.status}`}>{statuses[subscription.status]}</span><small>{subscription.currentPeriodEnd ? `Vigência até ${date(subscription.currentPeriodEnd)}` : subscription.status === 'active' ? 'Sem vencimento por data' : 'Vigência não definida'}</small></div></div>{platform && subscriptionDraft ? <form className="ad-plan-form" onSubmit={saveSubscription}><div className="ad-form-grid"><label>Plano<select value={subscriptionDraft.plan} onChange={event => setSubscriptionDraft({ ...subscriptionDraft, plan: event.target.value as SubscriptionPlan })}><option value="individual">Individual</option><option value="team">Equipe</option></select></label><label>Status da assinatura<select value={subscriptionDraft.status} onChange={event => setSubscriptionDraft({ ...subscriptionDraft, status: event.target.value as SubscriptionStatus })}>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Limite de lugares<input type="number" required min={Math.max(1, reservedSeats)} max={10000} step={1} value={subscriptionDraft.seatLimit} onChange={event => setSubscriptionDraft({ ...subscriptionDraft, seatLimit: Number(event.target.value) })}/><small>Deve comportar membros ativos e convites pendentes.</small></label><label>Vigência até<input type="datetime-local" required={subscriptionDraft.status === 'trial'} value={localDate(subscriptionDraft.currentPeriodEnd)} onChange={event => setSubscriptionDraft({ ...subscriptionDraft, currentPeriodEnd: event.target.value ? new Date(event.target.value).toISOString() : null })}/><small>{subscriptionDraft.status === 'trial' ? 'Um período de teste precisa ter data de término.' : 'Vigência vazia em plano ativo significa acesso sem vencimento por data.'}</small></label></div><div className="ad-billing-note"><LockKeyhole size={16}/><p>Esta ação altera o acesso, sem processar pagamentos. Confirme o recebimento e registre o comprovante no seu processo financeiro antes de ativar a assinatura.</p></div><button className="button button-primary" type="submit" disabled={!!pending || loading}>{pending === 'subscription' ? <LoaderCircle size={15} className="ad-spinning"/> : <Check size={15}/>}Salvar plano e acesso</button></form> : <div className="ad-billing-note ad-customer-billing"><CreditCard size={17}/><p>Para contratar, renovar ou alterar seu plano, fale com o operador que forneceu o acesso à sua empresa. Nenhuma cobrança é realizada por esta tela.</p></div>}</> : <div className="empty-state ad-empty"><CreditCard size={28}/><p>Não foi possível localizar as informações de assinatura desta empresa.</p></div>}</section>}
    {tab === 'audit' && selectedWorkspaceId && <section className="panel ad-panel"><div className="panel-header"><div><h2>Histórico de atividade</h2><p>Eventos registrados pelo servidor. Os dados abaixo não incluem tokens de convite.</p></div><button className="ad-refresh" onClick={() => void refreshTeam(selectedWorkspaceId)} disabled={loading}><RefreshCw size={14}/>Atualizar</button></div>{loading ? <div className="ad-loading"><LoaderCircle size={22}/>Carregando histórico...</div> : audit.length ? <div className="ad-audit-list">{audit.map(entry => { const actor = members.find(member => member.userId === entry.actorId); return <div className="ad-audit-entry" key={entry.id}><span className="ad-audit-icon"><History size={15}/></span><div><strong>{actions[entry.action] ?? entry.action.replaceAll('_', ' ').replaceAll('.', ' · ')}</strong><small>{actor?.displayName || actor?.email || (entry.actorId ? 'Usuário registrado' : 'Sistema / operação da plataforma')}</small></div><time dateTime={entry.createdAt}>{date(entry.createdAt, true)}</time></div>})}</div> : <div className="empty-state ad-empty"><History size={28}/><h3>O histórico aparecerá aqui</h3><p>Convites, mudanças de acesso e outras ações são exibidos quando registrados pelo servidor.</p></div>}</section>}
    {tab === 'company' && memberAdmin && selectedWorkspaceId && <div className="ad-company-sections">
      <section className="panel ad-panel ad-company-name-panel"><div className="panel-header"><div><h2>Dados da empresa</h2><p>Defina o nome que identifica sua empresa no HIGH CLOSER.</p></div><Building2 size={20} className="ad-muted-icon"/></div><div className="ad-company-body ad-company-name-body"><div><span>Nome da empresa</span><strong>{workspace?.name}</strong></div><button type="button" className="button button-secondary" disabled={!!pending || loading || !workspace} onClick={() => editName({ workspaceId: selectedWorkspaceId, kind: 'workspace' }, workspace?.name || '')}><Pencil size={15} aria-hidden="true"/>Editar nome da empresa</button></div></section>
      <section className="panel ad-panel"><div className="panel-header"><div><h2>Privacidade e retenção</h2><p>Registre o contato da empresa e o período definido na sua política de dados.</p></div><ShieldCheck size={20} className="ad-muted-icon"/></div>{privacyLoading ? <div className="ad-loading"><LoaderCircle size={20}/>Carregando configurações...</div> : privacyError ? <div className="ad-error" role="alert">{privacyError}</div> : privacyDraft && <form className="ad-company-form" onSubmit={event => { event.preventDefault(); void run('privacy', () => serviceRef.current.updateWorkspacePrivacy(selectedWorkspaceId, privacyDraft), 'Configurações de privacidade atualizadas.', false) }}><div className="ad-form-grid"><label>Contato de privacidade<input type="email" maxLength={254} value={privacyDraft.privacyContactEmail} onChange={event => setPrivacyDraft({ ...privacyDraft, privacyContactEmail: event.target.value })} placeholder="privacidade@suaempresa.com"/><small>Canal para receber pedidos sobre os dados da empresa.</small></label><label>Retenção declarada (dias)<input type="number" required min={1} max={3650} step={1} value={privacyDraft.retentionDays} onChange={event => setPrivacyDraft({ ...privacyDraft, retentionDays: Number(event.target.value) })}/><small>Use o prazo definido pela empresa para sua operação.</small></label></div><div className="ad-billing-note"><History size={16}/><p>O período é um registro da sua política. Não há exclusão automática de leads por esta configuração. A empresa deve revisar os dados e executar a retenção conforme as obrigações aplicáveis.</p></div><button className="button button-primary" disabled={!!pending} type="submit">{pending === 'privacy' ? <LoaderCircle size={15} className="ad-spinning"/> : <Check size={15}/>}Salvar política de dados</button></form>}</section>
      <section className="panel ad-panel"><div className="panel-header"><div><h2>Exportar dados da empresa</h2><p>Portabilidade dos dados autorizados, inclusive quando a assinatura estiver bloqueada.</p></div><Download size={20} className="ad-muted-icon"/></div><div className="ad-company-body"><p>Baixe o JSON retornado pelo servidor com dados da empresa, leads, configurações e metadados de privacidade. O arquivo não inclui senhas ou tokens e deve ser guardado em local protegido.</p><p className="ad-company-help">Esta exportação não substitui o backup do banco. Usuários de autenticação e restauração da operação exigem o procedimento do operador.</p><button className="button button-secondary" disabled={!!pending} onClick={exportCompany}>{pending === 'export-company' ? <LoaderCircle size={15} className="ad-spinning"/> : <Download size={15}/>}Exportar dados da empresa</button></div></section>
      <section className="panel ad-panel"><div className="panel-header"><div><h2>Responsável pelo workspace</h2><p>Transfira a responsabilidade para outro administrador ativo da equipe.</p></div><Users size={20} className="ad-muted-icon"/></div><div className="ad-company-body"><p>Responsável atual: <strong>{members.find(member => member.userId === workspace?.ownerId)?.displayName || members.find(member => member.userId === workspace?.ownerId)?.email || 'Não identificado nesta lista'}</strong>.</p>{isOwner ? <><label className="ad-owner-select">Novo responsável<select value={newOwnerId} onChange={event => setNewOwnerId(event.target.value)} disabled={!!pending || loading}><option value="">Selecione um administrador</option>{activeMembers.filter(member => member.role === 'admin' && member.userId !== workspace?.ownerId).map(member => <option key={member.userId} value={member.userId}>{member.displayName || member.email} · {member.email}</option>)}</select></label><p className="ad-company-help">O novo responsável precisa ser administrador ativo. A transferência não altera automaticamente os papéis de quem já participa da equipe.</p><button className="button button-secondary" disabled={!newOwnerId || !!pending || loading} onClick={() => { const member = members.find(item => item.userId === newOwnerId); if (member) setConfirmation({ newOwner: member }) }}>Transferir responsabilidade</button></> : <p className="ad-company-help">Somente o responsável atual pode iniciar a transferência. Peça a ele para selecionar outro administrador ativo.</p>}</div></section>
      <section className="panel ad-panel ad-danger-panel"><div className="panel-header"><div><h2>Excluir empresa e dados</h2><p>Esta ação remove os registros do workspace no banco e não pode ser desfeita pela aplicação.</p></div><AlertTriangle size={20}/></div><div className="ad-company-body"><p>Antes de continuar, exporte os dados necessários e confira a política de retenção. A exclusão não apaga automaticamente as contas de autenticação, arquivos já exportados ou cópias em backups.</p><button className="button button-danger-light" disabled={!!pending} onClick={() => { setDeleteConfirmation(''); setConfirmation({ workspaceDelete: true }); setError('') }}><Trash2 size={15}/>Excluir empresa</button></div></section>
    </div>}
    {nameEditor && memberAdmin && nameEditor.workspaceId === selectedWorkspaceId && <div className="ad-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !pending) { setNameEditor(null); setNameError('') } }}><div ref={dialogRef} className="ad-modal ad-name-modal" role="dialog" tabIndex={-1} aria-modal="true" aria-busy={!!pending} aria-labelledby="ad-name-modal-title"><div className="ad-modal-header"><span className="ad-context-icon"><Pencil size={20} aria-hidden="true"/></span><div><h2 id="ad-name-modal-title">{nameEditor.kind === 'workspace' ? 'Editar nome da empresa' : 'Editar nome do membro'}</h2><p>{nameEditor.kind === 'workspace' ? 'Atualize como sua empresa aparece no HIGH CLOSER.' : nameEditor.member.email}</p></div><button type="button" className="ad-icon-button" aria-label="Fechar formulário" disabled={!!pending} onClick={() => { setNameEditor(null); setNameError('') }}><X size={19}/></button></div><form onSubmit={event => void saveName(event)}><div className="ad-modal-fields"><label>{nameEditor.kind === 'workspace' ? 'Nome da empresa' : 'Nome na empresa'}<input data-name-autofocus required minLength={nameEditor.kind === 'workspace' ? 1 : 2} maxLength={120} disabled={!!pending} value={nameDraft} aria-describedby="ad-name-help" aria-invalid={!!(nameError || error)} onChange={event => { setNameDraft(event.target.value); setNameError(''); setError('') }}/></label><p id="ad-name-help" className="ad-name-help">{nameEditor.kind === 'workspace' ? 'Use entre 1 e 120 caracteres para identificar a empresa.' : 'Este nome é usado apenas nesta empresa. O perfil pessoal e os nomes em outras empresas continuam independentes.'}</p>{(nameError || error) && <div className="ad-error" role="alert">{nameError || error}</div>}</div><div className="ad-modal-footer"><button type="button" className="button button-secondary" disabled={!!pending} onClick={() => { setNameEditor(null); setNameError('') }}>Cancelar</button><button type="submit" className="button button-primary" disabled={!!pending}>{pending ? <LoaderCircle size={15} className="ad-spinning"/> : <Check size={15}/>}Salvar nome</button></div></form></div></div>}
    {hasModal && !nameEditor && <div className="ad-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !pending) { setInviteOpen(false); setCreateOpen(false); setConfirmation(null) } }}><div ref={dialogRef} className="ad-modal" role="dialog" aria-modal="true" aria-labelledby="ad-modal-title"><div className="ad-modal-header"><span className="ad-context-icon">{confirmation ? <LockKeyhole size={21}/> : createOpen ? <Building2 size={21}/> : <Mail size={21}/>}</span><div><h2 id="ad-modal-title">{confirmation ? confirmation.workspaceDelete ? 'Excluir esta empresa?' : confirmation.newOwner ? 'Transferir a responsabilidade?' : confirmation.member ? 'Desativar este acesso?' : 'Revogar este convite?' : createOpen ? 'Uma nova empresa' : 'Convide alguém para a equipe'}</h2><p>{confirmation ? 'Confirme os dados antes de continuar.' : createOpen ? 'Cadastre o cliente e envie o convite ao administrador por e-mail.' : 'A pessoa convidada receberá acesso com o papel escolhido.'}</p></div><button className="ad-icon-button" aria-label="Fechar formulário" disabled={!!pending} onClick={() => { setInviteOpen(false); setCreateOpen(false); setConfirmation(null) }}><X size={19}/></button></div>{error && <div className="ad-error" role="alert">{error}</div>}{confirmation ? <div className="ad-confirm-body"><p>{confirmation.workspaceDelete ? <>A empresa <strong>{workspace?.name}</strong> e seus dados serão removidos do banco. Faça uma exportação antes de confirmar. Esta ação não pode ser desfeita pela aplicação.</> : confirmation.newOwner ? <>A responsabilidade pelo workspace será transferida para <strong>{confirmation.newOwner.displayName || confirmation.newOwner.email}</strong>. Os papéis dos membros permanecem iguais. Confira se essa pessoa é a responsável correta.</> : confirmation.member ? <>O membro <strong>{confirmation.member.displayName || confirmation.member.email}</strong> perderá o acesso a esta empresa. Seus registros permanecerão preservados. Você poderá reativar o acesso.</> : <>O link enviado para <strong>{confirmation.invitation?.email}</strong> deixará de funcionar. Para convidar novamente, envie um novo convite.</>}</p>{confirmation.workspaceDelete && <label className="ad-delete-confirmation">Digite o nome exato da empresa para confirmar<input value={deleteConfirmation} disabled={!!pending} onChange={event => setDeleteConfirmation(event.target.value)} placeholder={workspace?.name}/></label>}<div className="ad-modal-footer"><button className="button button-secondary" disabled={!!pending} onClick={() => setConfirmation(null)}>Cancelar</button><button className={`button ${confirmation.newOwner ? 'button-primary' : 'button-danger'}`} disabled={!!pending || !!(confirmation.workspaceDelete && deleteConfirmation !== workspace?.name)} onClick={confirmAction}>{pending === 'confirm' && <LoaderCircle size={15} className="ad-spinning"/>}{confirmation.workspaceDelete ? 'Excluir empresa e dados' : confirmation.newOwner ? 'Confirmar transferência' : confirmation.member ? 'Desativar acesso' : 'Revogar convite'}</button></div></div> : <form onSubmit={createOpen ? event => void createClient(event) : event => void createInvite(event)}><div className="ad-modal-fields">{createOpen ? <><label>Nome da empresa<input required maxLength={120} value={clientName} onChange={event => setClientName(event.target.value)} placeholder="Ex.: Lumina Consultoria"/></label><label>Nome do administrador<input minLength={2} maxLength={120} value={ownerName} onChange={event => setOwnerName(event.target.value)} placeholder="Nome da pessoa responsável"/></label><label>E-mail do administrador<input type="email" required maxLength={254} value={ownerEmail} onChange={event => setOwnerEmail(event.target.value)} placeholder="responsavel@empresa.com"/></label></> : <><label>Nome da pessoa<input required minLength={2} maxLength={120} value={inviteName} onChange={event => setInviteName(event.target.value)} placeholder="Nome da pessoa convidada"/></label><label>E-mail da pessoa<input type="email" required maxLength={254} value={inviteEmail} onChange={event => setInviteEmail(event.target.value)} placeholder="pessoa@empresa.com"/></label><label>Papel na empresa<span className="ad-select-field"><select value={inviteRole} onChange={event => setInviteRole(event.target.value as WorkspaceRole)}>{Object.entries(roles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><ChevronDown size={14}/></span></label></>}<p className="ad-form-help"><Link2 size={15}/>Enviar convite envia o acesso por e-mail. Se preferir WhatsApp ou se o envio falhar, use Copiar link do convite para gerar um link de ativação sem enviar e-mail.</p></div><div className="ad-modal-footer ad-invitation-footer"><button type="button" className="button button-secondary" disabled={!!pending} onClick={() => { setCreateOpen(false); setInviteOpen(false) }}>Cancelar</button>{!createOpen && <button type="button" className="button button-secondary" disabled={!!pending || seatsFull} onClick={event => void createManualInvite(event)}><MessageCircle size={15}/>Copiar link do convite</button>}<button type="submit" className="button button-primary" disabled={!!pending}>{pending ? <LoaderCircle size={15} className="ad-spinning"/> : <Send size={15}/>} {createOpen ? 'Criar empresa e enviar convite' : 'Enviar convite'}</button></div></form>}</div></div>}
  </div>
}
