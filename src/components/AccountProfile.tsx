import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Check, LoaderCircle, Mail, Pencil, UserRound } from 'lucide-react'
import { updateMyDisplayName } from '../lib/access'
import { readableError } from '../lib/supabase'
import './account-profile.css'

export interface AccountProfileProps {
  userId: string
  displayName: string
  email: string
  workspaceId?: string
  onSaved: () => void | Promise<void>
}

export default function AccountProfile({ userId, displayName, email, workspaceId, onSaved }: AccountProfileProps) {
  const id = useId()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(displayName)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const editButtonRef = useRef<HTMLButtonElement>(null)
  const wasEditing = useRef(false)
  const scope = `${userId}:${workspaceId || ''}`
  const currentScope = useRef(scope)
  currentScope.current = scope

  useEffect(() => { setDraft(displayName); setEditing(false); setError(''); setNotice(''); setPending(false) }, [userId, workspaceId])
  useEffect(() => { if (!editing) setDraft(displayName) }, [displayName, editing])
  useEffect(() => {
    if (editing) inputRef.current?.focus()
    else if (wasEditing.current) editButtonRef.current?.focus()
    wasEditing.current = editing
  }, [editing])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (pending) return
    const requestedScope = scope
    let saved = false
    setPending(true); setError(''); setNotice('')
    try {
      await updateMyDisplayName(draft, workspaceId)
      saved = true
      if (currentScope.current !== requestedScope) return
      await onSaved()
      if (currentScope.current !== requestedScope) return
      setEditing(false); setNotice('Nome atualizado com sucesso.')
      editButtonRef.current?.focus()
    } catch (cause) {
      if (currentScope.current === requestedScope) setError(saved ? 'Seu nome foi salvo, mas não foi possível atualizar a tela. Use Atualizar acesso antes de tentar novamente.' : readableError(cause))
    } finally { if (currentScope.current === requestedScope) setPending(false) }
  }

  return <section className="account-profile" aria-labelledby={`${id}-title`}>
    <div className="account-profile-heading"><div><h2 id={`${id}-title`}>Dados pessoais</h2><p>Seu perfil pessoal no HIGH CLOSER.</p></div><UserRound size={21} aria-hidden="true"/></div>
    <form onSubmit={event => void save(event)}>
      <label className="account-profile-field" htmlFor={`${id}-name`}>Nome de exibição<input ref={inputRef} id={`${id}-name`} autoComplete="name" value={editing ? draft : displayName} onChange={event => setDraft(event.target.value)} required minLength={2} maxLength={120} readOnly={!editing} disabled={pending} aria-describedby={`${id}-name-help`}/></label>
      <p id={`${id}-name-help`} className="account-profile-help">Você pode editar somente o próprio nome. Ao salvar, o nome usado na empresa selecionada também acompanha sua escolha.</p>
      <label className="account-profile-field" htmlFor={`${id}-email`}>E-mail<span className="account-profile-email"><Mail size={16} aria-hidden="true"/><input id={`${id}-email`} type="email" value={email} readOnly autoComplete="email" aria-describedby={`${id}-email-help`}/></span></label>
      <p id={`${id}-email-help`} className="account-profile-help">E-mail confirmado da conta · Somente consulta.</p>
      {error && <p className="account-profile-error" role="alert">{error}</p>}
      {notice && <p className="account-profile-success" role="status"><Check size={16}/>{notice}</p>}
      <div className="account-profile-actions">{editing ? <><button type="button" className="button button-secondary" disabled={pending} onClick={() => { setEditing(false); setDraft(displayName); setError(''); editButtonRef.current?.focus() }}>Cancelar</button><button type="submit" className="button button-primary" disabled={pending}>{pending ? <LoaderCircle size={15} className="account-profile-spinning"/> : <Check size={15}/>} {pending ? 'Salvando…' : 'Salvar nome'}</button></> : <button ref={editButtonRef} type="button" className="button button-secondary" onClick={() => { setDraft(displayName); setEditing(true); setError(''); setNotice('') }}><Pencil size={15}/>Editar nome</button>}</div>
    </form>
  </section>
}
