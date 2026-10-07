#!/usr/bin/env node
// Real Auth/REST/RLS smoke test. Creates and removes only uniquely identified fixtures.
// Never prints credentials, passwords, session tokens, invitation tokens, or client data.
import { randomBytes, randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { createClient } from '@supabase/supabase-js'

const { values } = parseArgs({ options: { 'env-file': { type: 'string' } } })
if (values['env-file']) process.loadEnvFile(values['env-file'])
const first = (...names) => names.map(name => process.env[name]).find(Boolean) || ''
const url = first('SUPABASE_URL', 'VITE_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL')
const publicKey = first('SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY')
const serviceKey = first('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY')
const salt = randomBytes(8).toString('hex')
const users = [], workspaces = [], clients = []
let service, step = 'Configuração', assertions = 0, cleanupFailed = false

function publicCredential(key) {
  if (key.startsWith('sb_publishable_')) return true
  try { return JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role === 'anon' } catch { return false }
}
function check(condition, label) {
  step = label
  if (!condition) throw new Error(label)
  assertions++
  console.log(`PASS: ${label}`)
}
function unwrap(result, label) {
  step = label
  if (result.error) throw new Error(label)
  return result.data
}
function client(key) {
  const result = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal || AbortSignal.timeout(20000) }) },
  })
  clients.push(result)
  return result
}
async function fixtureUser(label) {
  step = 'Criação de conta temporária sem envio de e-mail'
  const email = `closeros-live-${salt}-${label}@example.invalid`
  const password = `${randomBytes(24).toString('base64url')}Aa1!`
  const created = unwrap(await service.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { display_name: 'Verificação temporária Closer OS' },
  }), step)
  if (!created?.user?.id) throw new Error(step)
  const fixture = { id: created.user.id, email, password, client: client(publicKey) }
  users.push(fixture)
  const signed = unwrap(await fixture.client.auth.signInWithPassword({ email, password }), 'Login real da conta temporária')
  check(signed.user?.id === fixture.id && Boolean(signed.session), 'Login real com conta confirmada')
  return fixture
}
async function rpc(api, name, args, label) {
  return unwrap(await api.rpc(name, args), label)
}
async function invitation(inviter, workspaceId, member, role) {
  const value = await rpc(inviter, 'invite_member', { p_workspace_id: workspaceId, p_email: member.email, p_role: role }, 'Convite real com papel definido')
  check(/^[a-f0-9]{64}$/.test(value?.token || ''), 'Convite usa token aleatório válido')
  await rpc(member.client, 'record_policy_acceptance', { p_terms_version: '2026-10-06', p_privacy_version: '2026-10-06' }, 'Registro real de aceite dos documentos')
  const accepted = await rpc(member.client, 'accept_invitation', { p_token: value.token }, 'Aceite real do convite')
  check(accepted === workspaceId, 'Convite vincula somente a empresa autorizada')
  return value
}
async function rows(api, workspaceId, label = 'Consulta autenticada de leads') {
  return unwrap(await api.from('leads').select('id,owner_id,data').eq('workspace_id', workspaceId), label)
}
function payload(id, name) {
  const now = new Date().toISOString()
  return { id, name, company: 'Empresa temporária de verificação', email: '', phone: '', ticket: 9900,
    source: 'Indicação', createdAt: now, callDate: '', attendance: 'Pendente', objection: '', status: 'Lead novo',
    closedValue: 0, closedAt: '', lastContactAt: now, notes: '', pain: '', urgency: 'Média',
    financialCapacity: 'Não avaliada', decisionMaker: false, callScore: null, closerError: '', callSummary: '' }
}
async function deniedWrite(operation, verify, label) {
  const result = await operation
  check(Boolean(result.error) || (Array.isArray(result.data) && result.data.length === 0), label)
  check(await verify(), 'Tentativa bloqueada preservou o registro original')
}

async function run() {
  check(Boolean(url && serviceKey && publicCredential(publicKey)), 'Credenciais públicas e administrativas separadas')
  const destination = new URL(url)
  check(destination.protocol === 'https:' && destination.hostname.endsWith('.supabase.co'), 'Conexão de teste usa HTTPS do Supabase')
  service = client(serviceKey)
  const anonymous = client(publicKey)
  const anonymousRows = await anonymous.from('leads').select('id').limit(1)
  check(Boolean(anonymousRows.error) || anonymousRows.data?.length === 0, 'Sem login não há acesso a leads')

  const platform = await fixtureUser('platform')
  const adminA = await fixtureUser('admin-a'), adminB = await fixtureUser('admin-b')
  const closerA = await fixtureUser('closer-a'), closerB = await fixtureUser('closer-b')
  const viewer = await fixtureUser('viewer'), manager = await fixtureUser('manager')
  unwrap(await service.from('platform_admins').insert({ user_id: platform.id }), 'Papel de plataforma exclusivo da conta temporária')
  const deniedBootstrap = await adminA.client.rpc('setup_owner', { p_name: 'Conta temporária' })
  check(Boolean(deniedBootstrap.error), 'Conta convidada não pode se tornar administradora da plataforma')

  for (const [label, owner] of [['A', adminA], ['B', adminB]]) {
    const name = `Verificação temporária ${salt} ${label}`
    const id = await rpc(platform.client, 'create_workspace', { p_name: name, p_owner_name: 'Verificação temporária' }, 'Criação real de empresa isolada')
    if (typeof id !== 'string') throw new Error('Criação real de empresa isolada')
    const fixture = { id, name, owner }
    workspaces.push(fixture)
    await rpc(platform.client, 'admin_update_subscription', {
      p_workspace_id: id, p_plan: 'team', p_status: 'active', p_seat_limit: 6,
      p_current_period_end: new Date(Date.now() + 86400000).toISOString(), p_trial_ends_at: null,
    }, 'Ativação real do plano da empresa temporária')
    await invitation(platform.client, id, owner, 'admin')
  }
  const [workspaceA, workspaceB] = workspaces
  for (const [member, role] of [[closerA, 'closer'], [closerB, 'closer'], [viewer, 'viewer'], [manager, 'manager']]) {
    await invitation(adminA.client, workspaceA.id, member, role)
  }
  const memberships = unwrap(await adminA.client.from('memberships').select('user_id,role').eq('workspace_id', workspaceA.id), 'Consulta de equipe real')
  check(memberships.length === 5 && memberships.some(row => row.user_id === viewer.id && row.role === 'viewer'), 'Papéis de equipe persistidos no banco')

  const pending = await rpc(adminA.client, 'invite_member', {
    p_workspace_id: workspaceA.id, p_email: platform.email, p_role: 'viewer',
  }, 'Convite temporário para verificar identidade e limite')
  const preview = await rpc(anonymous, 'list_invitation_preview', { p_token: pending.token }, 'Prévia pública limitada ao token')
  check(preview?.email === platform.email && preview?.workspace_name === workspaceA.name, 'Prévia corresponde ao convite específico')
  const wrongEmail = await closerA.client.rpc('accept_invitation', { p_token: pending.token })
  check(Boolean(wrongEmail.error), 'Outro e-mail não pode aceitar o convite')
  const fullSeats = await adminA.client.rpc('invite_member', { p_workspace_id: workspaceA.id, p_email: `closeros-unclaimed-${salt}@example.invalid`, p_role: 'viewer' })
  check(Boolean(fullSeats.error), 'Convites pendentes contam no limite de acessos')
  await rpc(adminA.client, 'revoke_invitation', { p_workspace_id: workspaceA.id, p_invitation_id: pending.id }, 'Revogação de convite temporário')
  check((await rpc(anonymous, 'list_invitation_preview', { p_token: pending.token }, 'Prévia de convite revogado')) === null, 'Convite revogado perde validade')
  const invalid = '0'.repeat(64)
  check((await rpc(anonymous, 'list_invitation_preview', { p_token: invalid }, 'Prévia de token inexistente')) === null, 'Token inexistente não revela dados')
  check(Boolean((await closerA.client.rpc('accept_invitation', { p_token: invalid })).error), 'Token inexistente não concede acesso')

  const leadAdmin = payload(`live-${randomUUID()}`, 'Lead temporário de administrador')
  const leadA = payload(`live-${randomUUID()}`, 'Lead temporário de closer A')
  const leadOtherCloser = payload(`live-${randomUUID()}`, 'Lead temporário de closer B')
  const leadB = payload(`live-${randomUUID()}`, 'Lead temporário da outra empresa')
  for (const [api, ws, owner, data] of [
    [adminA.client, workspaceA.id, adminA.id, leadAdmin], [closerA.client, workspaceA.id, closerA.id, leadA],
    [closerB.client, workspaceA.id, closerB.id, leadOtherCloser], [adminB.client, workspaceB.id, adminB.id, leadB],
  ]) unwrap(await api.from('leads').insert({ workspace_id: ws, id: data.id, owner_id: owner, data }), 'Cadastro real de lead no banco')
  check((await rows(adminA.client, workspaceA.id)).length === 3, 'Administrador da empresa consulta toda a própria equipe')
  check((await rows(manager.client, workspaceA.id)).length === 3, 'Gestor consulta os leads da equipe')
  check((await rows(viewer.client, workspaceA.id)).length === 3, 'Leitura consulta os leads autorizados')
  check((await rows(closerA.client, workspaceA.id)).map(row => row.id).join() === leadA.id, 'Closer consulta somente seus próprios leads')
  check((await rows(adminA.client, workspaceB.id)).length === 0 && (await rows(adminB.client, workspaceA.id)).length === 0, 'Empresas não consultam leads umas das outras')
  check((await rows(platform.client, workspaceA.id)).length === 0 && (await rows(platform.client, workspaceB.id)).length === 0, 'Administrador da plataforma não recebe acesso aos leads dos clientes')
  const crossTenantInsert = payload(`live-${randomUUID()}`, 'Tentativa bloqueada entre empresas')
  check(Boolean((await adminA.client.from('leads').insert({ workspace_id: workspaceB.id, id: crossTenantInsert.id, owner_id: adminB.id, data: crossTenantInsert })).error), 'Outra empresa não pode cadastrar lead neste cliente')
  await deniedWrite(adminA.client.from('leads').update({ data: { ...leadB, notes: 'Tentativa indevida' } }).eq('workspace_id', workspaceB.id).eq('id', leadB.id).select('id'),
    async () => (await rows(adminB.client, workspaceB.id))[0].data.notes === '', 'Outra empresa não pode alterar lead deste cliente')
  await deniedWrite(closerA.client.from('leads').update({ data: { ...leadOtherCloser, notes: 'Tentativa indevida' } }).eq('workspace_id', workspaceA.id).eq('id', leadOtherCloser.id).select('id'),
    async () => (await rows(adminA.client, workspaceA.id)).find(row => row.id === leadOtherCloser.id)?.data.notes === '', 'Closer não altera lead de outro responsável')
  check(Boolean((await closerA.client.from('leads').insert({ workspace_id: workspaceA.id, id: crossTenantInsert.id, owner_id: closerB.id, data: crossTenantInsert })).error), 'Closer não cadastra lead para outro responsável')
  await deniedWrite(viewer.client.from('leads').update({ data: { ...leadA, notes: 'Tentativa indevida' } }).eq('workspace_id', workspaceA.id).eq('id', leadA.id).select('id'),
    async () => (await rows(adminA.client, workspaceA.id)).find(row => row.id === leadA.id)?.data.notes === '', 'Leitura não altera lead')
  await deniedWrite(viewer.client.from('leads').delete().eq('workspace_id', workspaceA.id).eq('id', leadA.id).select('id'),
    async () => (await rows(adminA.client, workspaceA.id)).some(row => row.id === leadA.id), 'Leitura não exclui lead')
  check(Boolean((await viewer.client.from('leads').insert({ workspace_id: workspaceA.id, id: crossTenantInsert.id, owner_id: adminA.id, data: crossTenantInsert })).error), 'Leitura não cadastra lead')
  check(Boolean((await viewer.client.rpc('export_workspace', { p_workspace_id: workspaceA.id })).error), 'Leitura não exporta toda a empresa')
  check(Boolean((await platform.client.rpc('export_workspace', { p_workspace_id: workspaceA.id })).error), 'Plataforma não exporta dados comerciais do cliente')
  const managerAssigned = unwrap(await manager.client.from('leads').update({ owner_id: closerB.id }).eq('workspace_id', workspaceA.id).eq('id', leadAdmin.id).select('id'), 'Distribuição real de leads pelo gestor')
  check(managerAssigned.length === 1 && (await rows(closerB.client, workspaceA.id)).length === 2, 'Gestor distribui lead e o novo closer passa a consultá-lo')

  const closedLead = { ...leadA, status: 'Fechado', attendance: 'Compareceu', closedValue: 12500, closedAt: new Date().toISOString(), callScore: 8, closerError: 'Anotação temporária de avaliação' }
  unwrap(await closerA.client.from('leads').update({ data: closedLead }).eq('workspace_id', workspaceA.id).eq('id', leadA.id).select('id').single(), 'Fechamento real de oportunidade própria')
  const fresh = client(publicKey)
  unwrap(await fresh.auth.signInWithPassword({ email: closerA.email, password: closerA.password }), 'Novo login para conferir persistência')
  const persisted = (await rows(fresh, workspaceA.id)).find(row => row.id === leadA.id)
  check(persisted?.data.closedValue === 12500 && persisted.data.status === 'Fechado' && persisted.data.callScore === 8, 'Fechamento e avaliação persistem no servidor após novo login')
  const exported = await rpc(adminA.client, 'export_workspace', { p_workspace_id: workspaceA.id }, 'Exportação real pelo administrador da empresa')
  check(exported?.leads?.length === 3 && exported.leads.some(row => row.id === leadA.id && row.closedValue === 12500), 'Exportação da empresa inclui somente seus dados persistidos')

  check(Boolean((await adminA.client.rpc('admin_update_subscription', { p_workspace_id: workspaceA.id, p_plan: 'team', p_status: 'active', p_seat_limit: 6 })).error), 'Empresa cliente não altera o próprio plano comercial')
  await rpc(platform.client, 'admin_update_subscription', { p_workspace_id: workspaceA.id, p_plan: 'team', p_status: 'suspended', p_seat_limit: 6 }, 'Suspensão real da empresa temporária')
  check((await rows(closerA.client, workspaceA.id)).length === 0 && (await rows(adminA.client, workspaceA.id)).length === 0, 'Suspensão bloqueia consultas CRM mesmo com sessão existente')
  check(Boolean((await closerA.client.from('leads').insert({ workspace_id: workspaceA.id, id: crossTenantInsert.id, owner_id: closerA.id, data: crossTenantInsert })).error), 'Suspensão bloqueia novos cadastros')
  const suspendedExport = await rpc(adminA.client, 'export_workspace', { p_workspace_id: workspaceA.id }, 'Portabilidade do administrador após suspensão')
  check(suspendedExport?.leads?.length === 3, 'Administrador mantém exportação de portabilidade após suspensão')
  await rpc(platform.client, 'admin_update_subscription', { p_workspace_id: workspaceA.id, p_plan: 'team', p_status: 'active', p_seat_limit: 6 }, 'Reativação da empresa temporária')
  await rpc(adminA.client, 'update_member', { p_workspace_id: workspaceA.id, p_user_id: closerA.id, p_role: 'closer', p_is_active: false }, 'Desativação real de membro')
  check((await rows(closerA.client, workspaceA.id)).length === 0 && (await rows(fresh, workspaceA.id)).length === 0, 'Desativação bloqueia todas as sessões existentes do membro')
  check(Boolean((await closerA.client.from('leads').insert({ workspace_id: workspaceA.id, id: crossTenantInsert.id, owner_id: closerA.id, data: crossTenantInsert })).error), 'Membro desativado não cadastra leads')
  check((await rows(adminA.client, workspaceA.id)).length === 3, 'Desativar acesso preserva os dados da empresa')
}

async function cleanup() {
  if (!service) return
  const ids = workspaces.map(row => row.id), userIds = users.map(row => row.id)
  const clean = async (operation, label) => {
    try { const result = await operation; if (result.error) throw new Error(label) }
    catch { cleanupFailed = true; console.error(`CLEANUP FAILED: ${label}`) }
  }
  // Restrict every deletion to IDs created by this invocation; never enumerate real customers.
  if (ids.length) {
    await clean(service.from('leads').delete().in('workspace_id', ids), 'Leads temporários')
    await clean(service.from('audit_logs').delete().in('workspace_id', ids), 'Auditoria das empresas temporárias')
    await clean(service.from('workspaces').delete().in('id', ids), 'Empresas temporárias e vínculos')
  }
  if (userIds.length) {
    await clean(service.from('audit_logs').delete().in('actor_id', userIds), 'Auditoria das contas temporárias')
    await clean(service.from('platform_admins').delete().in('user_id', userIds), 'Papel administrativo temporário')
    for (const user of users) await clean(service.auth.admin.deleteUser(user.id), 'Conta temporária de autenticação')
  }
  if (ids.length) {
    const remaining = await service.from('workspaces').select('id').in('id', ids)
    if (remaining.error || remaining.data?.length) { cleanupFailed = true; console.error('CLEANUP FAILED: Conferência das empresas temporárias') }
  }
  if (userIds.length) {
    const remaining = await service.from('profiles').select('id').in('id', userIds)
    if (remaining.error || remaining.data?.length) { cleanupFailed = true; console.error('CLEANUP FAILED: Conferência das contas temporárias') }
  }
  for (const api of clients) api.auth.stopAutoRefresh()
  if (!cleanupFailed) console.log('CLEANUP: todas as contas e empresas temporárias removidas.')
}

try {
  await run()
  console.log(`Verificação real concluída: ${assertions} verificações aprovadas.`)
} catch {
  console.error(`FAIL: ${step}. Nenhuma credencial ou dado de cliente foi registrado.`)
  process.exitCode = 1
} finally {
  await cleanup()
  if (cleanupFailed) process.exitCode = 1
}
