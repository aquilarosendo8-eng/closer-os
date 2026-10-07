import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { Building2, LogOut, RefreshCw, ShieldCheck } from 'lucide-react'
import App from './App'
import AuthScreen, { type AuthMode } from './components/AuthScreen'
import Administration from './components/Administration'
import { administrationService, invitationPreview, loadAccess, subscriptionAllowsAccess, type AccessSnapshot } from './lib/access'
import { applicationUrl, cloudConfigured, readableError, requireSupabase, supabase } from './lib/supabase'
import { useCloudData } from './lib/useCloudData'
import './saas.css'

const isDemo = new URLSearchParams(window.location.search).get('demo') === '1'
const invitedToken = new URLSearchParams(window.location.search).get('invite') || ''
const activationFlow = ['recovery', 'activate'].includes(new URLSearchParams(window.location.search).get('flow') || '')
const legalContact = import.meta.env.VITE_SUPPORT_EMAIL || undefined
const emptyAccess: AccessSnapshot = { workspaces: [], isPlatformAdmin: false, displayName: '' }

function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function SaaSApp() {
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(!cloudConfigured)
  const [snapshot, setSnapshot] = useState(emptyAccess)
  const [snapshotUserId, setSnapshotUserId] = useState<string | null>(null)
  const [accessLoading, setAccessLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [authMode, setAuthMode] = useState<AuthMode>('login')
  const [passwordRequired, setPasswordRequired] = useState(activationFlow)
  const [selectedWorkspace, setSelectedWorkspace] = useState(() => new URLSearchParams(window.location.search).get('workspace') || '')
  const [adminOpen, setAdminOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [invite, setInvite] = useState<{ email: string; workspaceName: string; expiresAt: string } | null>(null)
  const [invitePending, setInvitePending] = useState(Boolean(invitedToken && cloudConfigured))
  const userId = session?.user.id
  const currentUserId = useRef(userId)
  currentUserId.current = userId
  const workspace = snapshot.workspaces.find(row => row.workspace.id === selectedWorkspace) || snapshot.workspaces[0] || null
  const allowed = workspace && subscriptionAllowsAccess(workspace.subscription)
  const data = useCloudData(allowed && !isDemo ? workspace : null)

  const refreshAccess = useCallback(async () => {
    if (!session?.user) return
    const requestedId = session.user.id
    try {
      const result = await loadAccess(session.user)
      if (currentUserId.current !== requestedId) return
      setSnapshot(result); setSnapshotUserId(requestedId); setError('')
    } catch (cause) { if (currentUserId.current === requestedId) { setSnapshot(emptyAccess); setError(readableError(cause)) } }
    finally { if (currentUserId.current === requestedId) setAccessLoading(false) }
  }, [session?.user.id])

  useEffect(() => {
    if (!supabase || isDemo) return
    let alive = true
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!alive) return
      setSession(data.session); setAuthReady(true)
      if (error) setError(readableError(error))
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, next) => {
      if (!alive) return
      setSession(next); setAuthReady(true)
      if (event === 'PASSWORD_RECOVERY') setPasswordRequired(true)
      if (event === 'SIGNED_OUT') { setSnapshot(emptyAccess); setSnapshotUserId(null); setSelectedWorkspace(''); setAdminOpen(false); setAccountOpen(false); setPasswordRequired(false) }
    })
    return () => { alive = false; subscription.unsubscribe() }
  }, [])

  useEffect(() => {
    setSnapshot(emptyAccess); setError('')
    if (!session?.user || isDemo) { setAccessLoading(false); return }
    setAccessLoading(true)
    let canceled = false
    void (async () => {
      // Bootstrap is authorized exclusively by the protected database allowlist.
      await requireSupabase().rpc('setup_owner', { p_name: session.user.user_metadata.display_name || null })
      if (!canceled) await refreshAccess()
    })()
    const timer = window.setInterval(() => { if (!document.hidden) void refreshAccess() }, 15000)
    const visible = () => { if (!document.hidden) void refreshAccess() }
    document.addEventListener('visibilitychange', visible)
    return () => { canceled = true; clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [userId, refreshAccess])

  useEffect(() => {
    if (!invitedToken || !cloudConfigured || isDemo) return
    let canceled = false
    void invitationPreview(invitedToken).then(value => { if (!canceled) setInvite(value) }).catch(cause => { if (!canceled) setError(readableError(cause)) }).finally(() => { if (!canceled) setInvitePending(false) })
    return () => { canceled = true }
  }, [])

  const signOut = async () => {
    const { error } = await requireSupabase().auth.signOut({ scope: 'local' })
    if (error) throw error
    setSession(null); setSnapshot(emptyAccess)
    window.history.replaceState({}, '', applicationUrl())
  }
  const signIn = async (email: string, password: string) => {
    setError(''); setNotice('')
    const { error } = await requireSupabase().auth.signInWithPassword({ email, password })
    if (error) throw new Error(readableError(error))
  }
  const resetPassword = async (email: string) => {
    const redirect = new URL(applicationUrl()); redirect.searchParams.set('flow', 'recovery')
    const { error } = await requireSupabase().auth.resetPasswordForEmail(email, { redirectTo: redirect.toString() })
    if (error) throw new Error(readableError(error))
  }
  const setPassword = async (password: string) => {
    if (password.length < 12) throw new Error('Use uma senha com pelo menos 12 caracteres.')
    const { error } = await requireSupabase().auth.updateUser({ password })
    if (error) throw new Error(readableError(error))
    const { error: revokeError } = await requireSupabase().auth.signOut({ scope: 'others' })
    if (revokeError) throw new Error(readableError(revokeError))
    setPasswordRequired(false); setNotice(invitedToken ? 'Senha definida. Conclua o convite para entrar na sua empresa.' : 'Senha definida. Seu acesso está pronto.')
    const destination = new URL(applicationUrl())
    if (invitedToken) destination.searchParams.set('invite', invitedToken)
    window.history.replaceState({}, '', destination.toString())
    await refreshAccess()
  }
  const acceptInvitation = async (token: string, displayName: string, password?: string) => {
    const preview = await invitationPreview(token)
    const client = requireSupabase()
    const { data: current } = await client.auth.getUser()
    if (current.user && current.user.email?.toLowerCase() !== preview.email.toLowerCase()) throw new Error('Este convite pertence a outro e-mail. Saia da conta atual e entre com o e-mail convidado.')
    if (!current.user) {
      if (!password || password.length < 12) throw new Error('Use uma senha com pelo menos 12 caracteres.')
      const login = await client.auth.signInWithPassword({ email: preview.email, password })
      if (login.error) {
        const redirect = new URL(applicationUrl()); redirect.searchParams.set('invite', token)
        const signup = await client.auth.signUp({ email: preview.email, password, options: { emailRedirectTo: redirect.toString(), data: { display_name: displayName.trim(), terms_version: '2026-10-06', terms_accepted_at: new Date().toISOString() } } })
        if (signup.error) throw new Error(readableError(signup.error))
        if (signup.data.user?.identities?.length === 0) throw new Error('Se você já possui conta, use sua senha atual. Se necessário, recupere a senha antes de aceitar o convite.')
        if (!signup.data.session) { setNotice('Enviamos a confirmação para seu e-mail. Abra o link recebido e depois conclua o convite.'); return { pendingConfirmation: true } }
      }
    }
    const update = await client.auth.updateUser({ data: { display_name: displayName.trim(), terms_version: '2026-10-06', terms_accepted_at: new Date().toISOString() } })
    if (update.error) throw new Error(readableError(update.error))
    const acceptance = await client.rpc('record_policy_acceptance', { p_terms_version: '2026-10-06', p_privacy_version: '2026-10-06' })
    if (acceptance.error) throw new Error(readableError(acceptance.error))
    const { data: id, error } = await client.rpc('accept_invitation', { p_token: token })
    if (error) throw new Error(readableError(error))
    setSelectedWorkspace(id); setInvite(null)
    const destination = new URL(applicationUrl()); destination.searchParams.set('workspace', id)
    window.location.replace(destination.toString())
  }

  if (isDemo) return <><div className="cloud-context-bar"><span>Demonstração local · os dados desta tela ficam neste navegador</span><a href={applicationUrl()}>Voltar ao acesso privado</a></div><App demo /></>
  if (!cloudConfigured) return <AuthScreen mode="setup" onDemo={() => window.location.assign(`${applicationUrl()}?demo=1`)} legalContactEmail={legalContact} />
  if (!authReady || invitePending) return <div className="access-loading" role="status"><ShieldCheck size={28} /><p>Verificando seu acesso…</p></div>
  if (passwordRequired && session) return <AuthScreen mode="set-password" onSetPassword={setPassword} error={error} legalContactEmail={legalContact} />
  if (invitedToken && invite) return <AuthScreen mode="invite" invitationToken={invitedToken} invitedEmail={invite.email} invitationRequiresPassword={!session} onAcceptInvitation={acceptInvitation} onBack={() => { if (session) void signOut(); else window.location.assign(applicationUrl()) }} error={error} notice={notice} legalContactEmail={legalContact} />
  if (!session) return <AuthScreen mode={authMode} onSignIn={signIn} onResetPassword={resetPassword} onForgotPassword={() => { setAuthMode('reset'); setError('') }} onBack={() => { setAuthMode('login'); setError('') }} error={error} notice={notice} legalContactEmail={legalContact} />
  if (accessLoading || (snapshotUserId !== session.user.id && !error)) return <div className="access-loading" role="status"><ShieldCheck size={28} /><p>Carregando suas empresas…</p></div>

  const accountBar = <div className="cloud-context-bar"><span><Building2 size={15} />{snapshot.isPlatformAdmin ? 'Administração da plataforma' : workspace?.workspace.name || 'Sua conta'}</span><div>{snapshot.workspaces.length > 1 && <select aria-label="Selecionar empresa" value={workspace?.workspace.id} onChange={event => { setSelectedWorkspace(event.target.value); const destination = new URL(applicationUrl()); destination.searchParams.set('workspace', event.target.value); window.history.replaceState({}, '', destination.toString()); setAdminOpen(false); setAccountOpen(false) }}>{snapshot.workspaces.map(row => <option value={row.workspace.id} key={row.workspace.id}>{row.workspace.name}</option>)}</select>}{workspace && (adminOpen || accountOpen) && <button onClick={() => { setAdminOpen(false); setAccountOpen(false) }}>Voltar ao CRM</button>}{(workspace?.membership.role === 'admin' || snapshot.isPlatformAdmin) && <button onClick={() => { setAdminOpen(true); setAccountOpen(false) }}>Administrar</button>}<button onClick={() => { setAccountOpen(true); setAdminOpen(false) }}>Minha conta</button><button onClick={() => void signOut().catch(cause => setError(readableError(cause)))}><LogOut size={14} />Sair</button></div></div>
  if (!accountOpen && ((adminOpen && (workspace?.membership.role === 'admin' || snapshot.isPlatformAdmin)) || (snapshot.isPlatformAdmin && !workspace))) return <>{accountBar}<div className="administration-shell"><Administration access={workspace} isPlatformAdmin={snapshot.isPlatformAdmin} service={administrationService} onAccessChange={() => { void refreshAccess(); void data.refresh() }} /></div></>

  if (!workspace || !allowed || error || accountOpen) return <>{accountBar}<main className="account-state"><ShieldCheck size={34} /><h1>{error ? 'Não conseguimos verificar seu acesso' : !workspace && !snapshot.isPlatformAdmin ? 'Sua conta aguarda um convite' : workspace && !allowed ? 'O acesso desta empresa está pausado' : 'Sua conta'}</h1><p>{error || (!workspace ? snapshot.isPlatformAdmin ? `Administrador da plataforma · ${session.user.email}` : 'Peça ao administrador o link de convite para a sua empresa. Ter uma conta não libera acesso aos dados de outros clientes.' : !allowed ? 'Consulte o administrador para verificar o plano e retomar o acesso ao CRM. Seus dados não foram apagados.' : `${workspace.membership.displayName} · ${workspace.membership.email} · Perfil: ${workspace.membership.role}`)}</p><div className="account-state-actions"><button className="button button-secondary" onClick={() => { setAccessLoading(true); void refreshAccess() }}><RefreshCw size={15} />Atualizar acesso</button><button className="button button-secondary" onClick={() => { setPasswordRequired(true); setAdminOpen(false); setAccountOpen(false) }}>Alterar minha senha</button>{workspace?.membership.role === 'admin' && <button className="button button-secondary" onClick={async () => { try { downloadJson(`closer-os-empresa-${workspace.workspace.id}.json`, await administrationService.exportWorkspace(workspace.workspace.id)) } catch (cause) { setError(readableError(cause)) } }}>Exportar dados da empresa</button>}</div></main></>

  if (data.loading) return <>{accountBar}<div className="access-loading" role="status"><ShieldCheck size={28} /><p>Carregando seu CRM…</p></div></>
  const canEdit = workspace.membership.role !== 'viewer'
  const canManage = ['admin', 'manager'].includes(workspace.membership.role)
  return <>{accountBar}<App cloud={{ leads: data.leads, settings: data.settings, workspaceName: workspace.workspace.name, userName: snapshot.displayName, role: workspace.membership.role, userId: session.user.id, canEdit, canDelete: canManage, canManageSettings: workspace.membership.role === 'admin', canExport: workspace.membership.role !== 'viewer', onSaveLead: data.saveLead, onDeleteLead: data.deleteLead, onSaveSettings: data.saveSettings, onImportLeads: data.importLeads, onOpenAdmin: workspace.membership.role === 'admin' || snapshot.isPlatformAdmin ? () => setAdminOpen(true) : undefined, onSignOut: signOut, loading: data.loading, error: data.error, members: data.members, leadOwners: data.owners, onAssignLead: canManage ? data.assignLead : undefined }} /></>
}
