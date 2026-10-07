import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowRight, Building2, Check, Download, Eye, EyeOff, KeyRound, LockKeyhole, Mail, ShieldCheck, Sparkles, UsersRound, X } from 'lucide-react'
import { readableError } from '../lib/supabase'
import LegalPage, { type LegalDocument } from './LegalPage'
import './auth.css'

export type AuthMode = 'login' | 'reset' | 'set-password' | 'invite' | 'signup' | 'onboarding' | 'confirm' | 'expired' | 'activation-expired' | 'invite-error' | 'setup'

export interface RegistrationInput { displayName: string; companyName: string; email: string; password: string; acceptTerms: true }

export interface AuthScreenProps {
  mode?: AuthMode
  invitationToken?: string
  invitedEmail?: string
  invitedName?: string | null
  invitedWorkspaceName?: string
  initialDisplayName?: string
  initialCompanyName?: string
  invitationRequiresPassword?: boolean
  invitationNeedsLogin?: boolean
  onSignIn?: (email: string, password: string) => Promise<void>
  onResetPassword?: (email: string) => Promise<void>
  onSetPassword?: (password: string) => Promise<void>
  onAcceptInvitation?: (token: string, displayName: string, password?: string) => Promise<void | { pendingConfirmation?: boolean }>
  onSignUp?: (input: RegistrationInput) => Promise<{ pendingConfirmation: boolean }>
  onCreateWorkspace?: (input: Pick<RegistrationInput, 'displayName' | 'companyName' | 'acceptTerms'>) => Promise<void>
  onOpenSignUp?: () => void
  onRetry?: () => Promise<void>
  onForgotPassword?: () => void
  onBack?: () => void
  onDemo?: () => void
  error?: string
  notice?: string
  legalContactEmail?: string
}

const content: Record<AuthMode, { eyebrow: string; title: string; description: string; action: string }> = {
  login: { eyebrow: 'SEU ESPAÇO DE VENDAS', title: 'Bom ter você de volta.', description: 'Entre para acompanhar suas oportunidades e o próximo fechamento.', action: 'Entrar no meu workspace' },
  reset: { eyebrow: 'RECUPERAR ACESSO', title: 'Vamos recuperar sua senha.', description: 'Informe seu e-mail para receber um link seguro de recuperação.', action: 'Enviar link de recuperação' },
  'set-password': { eyebrow: 'PROTEJA SUA CONTA', title: 'Uma nova senha. Um novo começo.', description: 'Escolha uma senha exclusiva para sua conta no Closer OS.', action: 'Salvar nova senha' },
  invite: { eyebrow: 'VOCÊ FOI CONVIDADO', title: 'Seu próximo nível começa aqui.', description: 'Complete seu acesso para entrar no workspace que convidou você.', action: 'Aceitar e entrar' },
  signup: { eyebrow: 'COMECE SUA PRÓXIMA FASE', title: 'Seu CRM. Seu próximo nível.', description: 'Crie sua conta e organize suas vendas em uma empresa só sua. Confirme seu e-mail para começar.', action: 'Criar minha conta' },
  onboarding: { eyebrow: 'SEU ESPAÇO, DO SEU JEITO', title: 'Vamos criar sua empresa.', description: 'Seu acesso foi confirmado. Dê um nome ao seu workspace e comece seu teste de 14 dias.', action: 'Criar meu workspace' },
  confirm: { eyebrow: 'FALTA SÓ UM PASSO', title: 'Confirme seu e-mail.', description: 'Abra o link de confirmação recebido no seu e-mail. Depois, volte aqui para criar seu workspace.', action: '' },
  'invite-error': { eyebrow: 'VERIFICAR SEU CONVITE', title: 'Vamos verificar seu acesso.', description: 'Não conseguimos verificar este convite agora. Tente novamente em alguns instantes.', action: '' },
  'activation-expired': { eyebrow: 'VAMOS RENOVAR SEU ACESSO', title: 'Link de ativação expirado', description: 'Por segurança, os links de ativação têm prazo de validade. Peça um novo link ao administrador da sua empresa.', action: '' },
  expired: { eyebrow: 'PRECISAMOS DE UM NOVO LINK', title: 'Convite expirado', description: 'Este convite expirou, foi cancelado ou já foi utilizado. Peça ao administrador da empresa um novo convite.', action: '' },
  setup: { eyebrow: 'ACESSO PRIVADO', title: 'Seu workspace está em preparação.', description: 'O acesso por conta está indisponível enquanto a configuração de autenticação e banco de dados é concluída.', action: '' },
}

function safeParse(value: string | null): unknown {
  try { return value ? JSON.parse(value) : null } catch { return null }
}

/** Reads legacy browser data only after an explicit download request. */
function downloadLegacyBackup(): boolean {
  const rawLeads = localStorage.getItem('closer-os-leads-v1')
  const rawSettings = localStorage.getItem('closer-os-settings-v1')
  if (rawLeads === null && rawSettings === null) return false
  const parsedLeads = safeParse(rawLeads)
  const parsedSettings = safeParse(rawSettings)
  const contents = {
    version: 1,
    exportedAt: new Date().toISOString(),
    leads: Array.isArray(parsedLeads) ? parsedLeads : [],
    settings: parsedSettings && typeof parsedSettings === 'object' ? parsedSettings : null,
    legacyStorage: { 'closer-os-leads-v1': rawLeads, 'closer-os-settings-v1': rawSettings },
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(contents, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `closer-os-backup-local-${new Date().toISOString().slice(0, 10)}.json`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  return true
}

export default function AuthScreen({ mode = 'login', invitationToken, invitedEmail, invitedName, invitedWorkspaceName, initialDisplayName, initialCompanyName, invitationRequiresPassword = true, invitationNeedsLogin = false, onSignIn, onResetPassword, onSetPassword, onAcceptInvitation, onSignUp, onCreateWorkspace, onOpenSignUp, onRetry, onForgotPassword, onBack, onDemo, error: externalError, notice, legalContactEmail }: AuthScreenProps) {
  const id = useId()
  const [email, setEmail] = useState(invitedEmail ?? '')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [displayName, setDisplayName] = useState(invitedName || initialDisplayName || '')
  const [companyName, setCompanyName] = useState(initialCompanyName || '')
  const [showPassword, setShowPassword] = useState(false)
  const [acceptedTerms, setAcceptedTerms] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [legalDocument, setLegalDocument] = useState<LegalDocument | null>(null)
  const legalRef = useRef<HTMLDivElement>(null)
  const text = content[mode]
  const requiresTerms = ['invite', 'signup', 'onboarding'].includes(mode)
  const requiresNewPassword = mode === 'signup' || mode === 'set-password' || (mode === 'invite' && invitationRequiresPassword)
  const requiresPassword = mode === 'login' || requiresNewPassword || (mode === 'invite' && invitationNeedsLogin)

  useEffect(() => {
    setPassword(''); setConfirmation(''); setError(''); setSuccess(''); setAcceptedTerms(false)
    setEmail(invitedEmail ?? '')
    setDisplayName(invitedName || initialDisplayName || '')
    setCompanyName(initialCompanyName || '')
  }, [mode, invitedEmail, invitedName, initialDisplayName, initialCompanyName])

  useEffect(() => {
    if (!legalDocument) return
    const previousFocus = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    legalRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLegalDocument(null)
      if (event.key !== 'Tab' || !legalRef.current) return
      const items = Array.from(legalRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]'))
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', handleKey)
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = previousOverflow; previousFocus?.focus() }
  }, [legalDocument])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending) return
    setError(''); setSuccess('')
    if (requiresNewPassword && password.length < 12) { setError('Use uma senha com pelo menos 12 caracteres.'); return }
    if (requiresNewPassword && password !== confirmation) { setError('As senhas precisam ser iguais.'); return }
    if (requiresTerms && !acceptedTerms) { setError('Leia e aceite os termos de uso e a política de privacidade para continuar.'); return }
    if (mode === 'invite' && !invitationToken) { setError('Este convite está incompleto. Solicite um novo convite ao administrador.'); return }
    setPending(true)
    try {
      if (mode === 'signup' && onSignUp) {
        const result = await onSignUp({ email: email.trim().toLowerCase(), password, displayName: displayName.trim(), companyName: companyName.trim(), acceptTerms: true })
        setPassword(''); setConfirmation('')
        if (result.pendingConfirmation) setSuccess('Confira seu e-mail para confirmar o cadastro. Abra o link recebido para criar sua empresa. Veja também a pasta de spam.')
      } else if (mode === 'onboarding' && onCreateWorkspace) {
        await onCreateWorkspace({ displayName: displayName.trim(), companyName: companyName.trim(), acceptTerms: true })
      } else if (mode === 'login' && onSignIn) await onSignIn(email.trim().toLowerCase(), password)
      else if (mode === 'reset' && onResetPassword) {
        await onResetPassword(email.trim().toLowerCase())
        setSuccess('Se esse e-mail estiver cadastrado, você receberá um link de recuperação. Confira também a pasta de spam.')
      } else if (mode === 'set-password' && onSetPassword) {
        await onSetPassword(password)
        setPassword(''); setConfirmation('')
        setSuccess('Sua senha foi atualizada. Você já pode continuar com sua conta.')
      } else if (mode === 'invite' && onAcceptInvitation && invitationToken) {
        const result = await onAcceptInvitation(invitationToken, displayName.trim(), (invitationRequiresPassword || invitationNeedsLogin) ? password : undefined)
        setPassword(''); setConfirmation('')
        if (!result?.pendingConfirmation) setSuccess('Convite aceito. Seu acesso foi preparado.')
      } else throw new Error('Este serviço está indisponível. Entre em contato com o administrador do workspace.')
    } catch (caught) {
      setError(readableError(caught))
    } finally { setPending(false) }
  }

  const exportBackup = () => {
    setError(''); setSuccess('')
    try { setSuccess(downloadLegacyBackup() ? 'Backup baixado. Os dados originais continuam neste navegador.' : 'Não encontramos dados da versão anterior neste navegador.') }
    catch { setError('Não foi possível acessar o armazenamento deste navegador. Tente novamente no navegador em que você usava o CRM.') }
  }

  return <div className={`auth-shell auth-mode-${mode}`}>
    <aside className="auth-story" aria-label="Sobre o Closer OS">
      <a className="auth-brand" href="/" aria-label="Closer OS início"><span className="brand-mark"><span /><span /><span /></span><span>closer<span className="brand-os">os</span><i /></span></a>
      <div className="auth-story-copy"><span className="auth-story-pill"><Sparkles size={14} /> PARA QUEM VENDE TRANSFORMAÇÃO</span><h1>Grandes vendas.<br />Um próximo nível<span>.</span></h1><p>Organize suas oportunidades, aprenda com cada call e transforme consistência em resultado.</p>
        <div className="auth-preview" aria-hidden="true"><div className="auth-preview-header"><span>Seu próximo fechamento</span><span className="auth-preview-dot" /></div><div className="auth-preview-value">Boas conversas.<br /><strong>Grandes resultados.</strong></div><div className="auth-preview-chart">{[27, 39, 33, 53, 44, 68, 60, 83, 73, 100].map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div><div className="auth-preview-footer"><span><UsersRound size={13} /> Sua equipe, conectada</span><span><Check size={13} /> Seu ritmo, em evolução</span></div></div>
      </div>
      <div className="auth-story-footer"><ShieldCheck size={16} /><span>Dados separados por empresa. Acesso por permissão.</span></div>
    </aside>
    <main className="auth-main">
      <div className="auth-mobile-brand"><span className="brand-mark"><span /><span /><span /></span><strong>closer<span>os</span></strong></div>
      <section className="auth-card" aria-labelledby={`${id}-title`}>
        {mode !== 'login' && mode !== 'setup' && onBack && <button type="button" className="auth-back" onClick={onBack} disabled={pending}><ArrowLeft size={15} /> Voltar para entrar</button>}
        <span className="auth-card-icon">{mode === 'reset' || mode === 'set-password' ? <KeyRound size={24} /> : mode === 'invite' ? <UsersRound size={24} /> : <LockKeyhole size={24} />}</span>
        <p className="auth-eyebrow">{text.eyebrow}</p><h2 id={`${id}-title`}>{text.title}</h2><p className="auth-description">{text.description}</p>
        {mode === 'invite' && invitedWorkspaceName && <div className="auth-workspace-invite"><span className="auth-workspace-avatar"><Building2 size={22} /></span><div><span>VOCÊ ESTÁ ENTRANDO EM</span><strong>{invitedWorkspaceName}</strong><p>Um espaço privado para você e sua equipe.</p></div><ShieldCheck size={19} /></div>}
        {(mode === 'signup' || mode === 'onboarding') && <div className="auth-trial-note"><Check size={15} /><span>14 dias para experimentar · Sem cartão de crédito</span></div>}
        {(error || externalError) && <p role="alert" className="auth-message auth-message-error">{error || externalError}</p>}
        {notice && <p role="status" className="auth-message">{notice}</p>}
        {success && <p role="status" className="auth-message auth-message-success"><Check size={17} /><span>{success}</span></p>}
        {mode === 'setup' ? <div className="auth-setup">
          <div className="auth-setup-note"><ShieldCheck size={20} /><p>O acesso aos dados da empresa será liberado por convite após a conexão dos serviços.</p></div>
          <button type="button" className="auth-secondary-button" onClick={exportBackup}><Download size={16} /> Baixar backup da versão anterior</button>
          <p className="auth-field-help">Use o mesmo navegador em que cadastrou seus leads. O download preserva os dados locais e não os envia para outra empresa.</p>
          {onDemo && <button type="button" className="auth-demo-link" onClick={onDemo}>Explorar demonstração <ArrowRight size={14} /></button>}
          {onDemo && <p className="auth-demo-note">A demonstração usa dados fictícios e não salva informações na nuvem.</p>}
        </div> : (mode === 'expired' || mode === 'activation-expired' || mode === 'invite-error' || mode === 'confirm') ? <div className="auth-empty-state"><div className="auth-setup-note"><Mail size={20} /><p>{mode === 'invite-error' ? 'A conexão com o serviço de acesso está indisponível. Seus dados continuam protegidos enquanto verificamos o convite.' : (mode === 'expired' || mode === 'activation-expired') ? 'Fale com quem convidou você. O administrador pode reenviar um convite ou gerar um novo link seguro.' : 'A confirmação protege seu acesso e os dados da sua empresa. Se o link não chegou, confira o spam ou peça ajuda ao suporte.'}</p></div>{mode === 'invite-error' && onRetry && <button className="auth-primary-button" type="button" onClick={() => void onRetry()}>Tentar novamente <ArrowRight size={16} /></button>}{onBack && <button className="auth-secondary-button" type="button" onClick={onBack}>Voltar ao acesso <ArrowRight size={16} /></button>}</div> : <form className="auth-form" onSubmit={submit}>
          {requiresTerms && <label htmlFor={`${id}-name`}>Seu nome<input id={`${id}-name`} name="name" autoComplete="name" required minLength={2} maxLength={120} value={displayName} onChange={event => setDisplayName(event.target.value)} disabled={pending} placeholder="Como podemos chamar você?" /></label>}
          {(mode === 'signup' || mode === 'onboarding') && <label htmlFor={`${id}-company`}>Nome da empresa<input id={`${id}-company`} name="company" autoComplete="organization" required minLength={1} maxLength={120} value={companyName} onChange={event => setCompanyName(event.target.value)} disabled={pending} placeholder="Sua empresa ou seu nome profissional" /></label>}
          {(mode === 'login' || mode === 'reset' || mode === 'signup' || ((mode === 'invite' || mode === 'onboarding') && invitedEmail)) && <label htmlFor={`${id}-email`}>E-mail<span className="auth-input-wrap"><Mail size={16} /><input id={`${id}-email`} name="email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} disabled={pending || mode === 'invite' || mode === 'onboarding'} placeholder="voce@empresa.com.br" /></span></label>}
          {requiresPassword && <label htmlFor={`${id}-password`}>{requiresNewPassword ? 'Nova senha' : invitationNeedsLogin ? 'Senha atual' : 'Senha'}<span className="auth-input-wrap"><LockKeyhole size={16} /><input id={`${id}-password`} name="password" type={showPassword ? 'text' : 'password'} autoComplete={requiresNewPassword ? 'new-password' : 'current-password'} required minLength={requiresNewPassword ? 12 : undefined} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} disabled={pending} placeholder={requiresNewPassword ? 'Pelo menos 12 caracteres' : 'Sua senha'} aria-describedby={requiresNewPassword ? `${id}-password-help` : undefined} /><button type="button" className="auth-password-toggle" aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'} aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)} disabled={pending}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></label>}
          {requiresNewPassword && <><p id={`${id}-password-help`} className="auth-field-help">Use 12 ou mais caracteres e uma senha exclusiva. Uma frase longa é uma boa opção.</p><label htmlFor={`${id}-confirm`}>Confirmar senha<input id={`${id}-confirm`} name="password-confirmation" type={showPassword ? 'text' : 'password'} autoComplete="new-password" required minLength={12} maxLength={128} value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={pending} placeholder="Repita sua nova senha" /></label></>}
          {mode === 'invite' && invitationNeedsLogin && <p className="auth-field-help">Você já tem uma conta. Use sua senha atual para entrar nesta empresa.</p>}
          {(mode === 'login' || mode === 'invite' && invitationNeedsLogin) && onForgotPassword && <button className="auth-forgot" type="button" onClick={onForgotPassword} disabled={pending}>Esqueci minha senha</button>}
          {requiresTerms && <div className="auth-consent"><input id={`${id}-consent`} type="checkbox" checked={acceptedTerms} onChange={event => setAcceptedTerms(event.target.checked)} required disabled={pending} /><label htmlFor={`${id}-consent`}>Li e aceito os <button type="button" onClick={() => setLegalDocument('terms')}>Termos de uso</button> e a <button type="button" onClick={() => setLegalDocument('privacy')}>Política de privacidade</button>.</label></div>}
          <button type="submit" className="auth-primary-button" disabled={pending || (mode === 'invite' && !invitationToken)}>{pending ? 'Aguarde...' : success && mode === 'reset' ? 'Enviar novamente' : mode === 'invite' && invitationNeedsLogin ? 'Entrar e aceitar convite' : mode === 'invite' && invitationRequiresPassword ? 'Ativar e entrar na empresa' : text.action}{pending ? <span className="auth-spinner" aria-hidden="true" /> : <ArrowRight size={17} />}</button>
          {mode === 'login' && onOpenSignUp && <div className="auth-signup-link"><span>Ainda não tem uma conta?</span><button type="button" onClick={onOpenSignUp} disabled={pending}>Criar conta <ArrowRight size={14} /></button></div>}
          {mode === 'invite' && <p className="auth-invite-note"><LockKeyhole size={12} /> Seu acesso será liberado apenas para esta empresa.</p>}
          {mode === 'onboarding' && <p className="auth-invite-note">Já foi convidado para uma equipe? Abra o link enviado pelo administrador.</p>}
        </form>}
        <footer className="auth-legal-links"><button type="button" onClick={() => setLegalDocument('terms')}>Termos de uso</button><span aria-hidden="true">·</span><button type="button" onClick={() => setLegalDocument('privacy')}>Privacidade</button></footer>
      </section>
      <p className="auth-main-footer">Closer OS · Clareza para vender. Espaço para evoluir.</p>
    </main>
    {legalDocument && <div className="auth-legal-backdrop" onClick={event => { if (event.target === event.currentTarget) setLegalDocument(null) }}><div ref={legalRef} className="auth-legal-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-legal-title"><button type="button" className="auth-legal-close" onClick={() => setLegalDocument(null)} aria-label="Fechar documento"><X size={20} /></button><LegalPage document={legalDocument} contactEmail={legalContactEmail} /></div></div>}
  </div>
}
