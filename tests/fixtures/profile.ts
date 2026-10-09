import { expect, type Page } from '@playwright/test'
import { defaultStageRows } from './pipeline'

export type ProfileRole = 'admin' | 'manager' | 'closer' | 'viewer' | 'platform'
export const profileWorkspaceA = '00000000-0000-4000-8000-000000000311'
export const profileWorkspaceB = '00000000-0000-4000-8000-000000000312'
export const profileUserIds: Record<ProfileRole, string> = {
  admin: '00000000-0000-4000-8000-000000000301', manager: '00000000-0000-4000-8000-000000000302',
  closer: '00000000-0000-4000-8000-000000000303', viewer: '00000000-0000-4000-8000-000000000304',
  platform: '00000000-0000-4000-8000-000000000305',
}
const originalNames: Record<ProfileRole, string> = { admin: 'Ana Administradora', manager: 'Marcos Gestor', closer: 'Caio Closer', viewer: 'Vera Consulta', platform: 'Paula Plataforma' }
interface ProfileRequest { path: string; method: string; query: string; body: Record<string, unknown> | null }
export interface ProfileState {
  names: Record<string, string>
  workspaceNames: Record<string, string>
  overrides: Record<string, Record<string, string | null>>
  requests: ProfileRequest[]
  unexpected: string[]
  errors: string[]
  failOwnName: boolean
  failMemberName: boolean
  failWorkspaceName: boolean
  failProfileReads: number
  delayNextProfileRead: Promise<void> | null
}
export function createProfileState(): ProfileState {
  return { names: Object.fromEntries(Object.entries(profileUserIds).map(([role, id]) => [id, originalNames[role as ProfileRole]])),
    workspaceNames: { [profileWorkspaceA]: 'Aurora Comercial', [profileWorkspaceB]: 'Outra Empresa' },
    overrides: { [profileWorkspaceA]: {}, [profileWorkspaceB]: {} },
    requests: [], unexpected: [], errors: [], failOwnName: false, failMemberName: false, failWorkspaceName: false,
    failProfileReads: 0, delayNextProfileRead: null }
}
export const profileEmail = (role: ProfileRole) => `${role}@example.invalid`
export const effectiveProfileName = (state: ProfileState, workspaceId: string, userId: string) => state.overrides[workspaceId]?.[userId] || state.names[userId]

// Browser fixtures test UI and RPC contracts, never production accounts. The
// independent PostgreSQL suite verifies actual authorization and isolation.
export async function mountProfile(page: Page, role: ProfileRole = 'admin', options: { state?: ProfileState; twoWorkspaces?: boolean; theme?: 'light' | 'dark'; staleAuthName?: string } = {}) {
  const state = options.state || createProfileState(), userId = profileUserIds[role], email = profileEmail(role)
  const allowedIds = role === 'platform' ? [] : options.twoWorkspaces ? [profileWorkspaceA, profileWorkspaceB] : [profileWorkspaceA]
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email,
    // Auth metadata deliberately stays unchanged when the canonical profile is renamed.
    // Re-issued login sessions must not override a valid profiles.display_name.
    app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: options.staleAuthName || originalNames[role] },
    created_at: '2026-10-01T00:00:00Z', email_confirmed_at: '2026-10-01T00:00:00Z', identities: [] }
  const payload = { sub: userId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }
  const jwt = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.profile-fixture`
  const session = { access_token: jwt, token_type: 'bearer', refresh_token: 'profile-fixture-refresh-token', expires_in: 3600, expires_at: payload.exp, user }
  page.on('pageerror', error => state.errors.push(error.message))
  await page.addInitScript(({ session, theme }) => {
    // Seed once per tab, rather than silently logging back in on every reload.
    if (!sessionStorage.getItem('profile-session-seeded')) {
      localStorage.setItem('sb-test-auth-token', JSON.stringify(session))
      sessionStorage.setItem('profile-session-seeded', '1')
    }
    if (theme && !sessionStorage.getItem('profile-theme-seeded')) { localStorage.setItem('closer-os-theme-v1', theme); sessionStorage.setItem('profile-theme-seeded', '1') }
  }, { session, theme: options.theme })
  await page.route('https://test.supabase.co/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method()
    let body: Record<string, unknown> | null = null
    try { body = request.postDataJSON() } catch { /* GET. */ }
    state.requests.push({ path, method, query: url.search, body })
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(value) })
    if (method === 'OPTIONS') { await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } }); return }
    if (path === '/auth/v1/user' && method === 'GET') { await json(user); return }
    if (path === '/auth/v1/token') { await json(session); return }
    if (path === '/auth/v1/logout') { await json({}); return }
    if (path === '/rest/v1/rpc/setup_owner') { await json(null); return }
    if (path === '/rest/v1/platform_admins') { await json(role === 'platform' ? [{ user_id: userId }] : []); return }
    if (path === '/rest/v1/profiles' && method === 'GET') {
      if (state.failProfileReads > 0) { state.failProfileReads -= 1; await json({ message: 'Não foi possível atualizar a leitura do perfil.' }, 503); return }
      // Capture the modeled server value when the request begins, so a delayed
      // reply can represent a truly older snapshot rather than reading new state.
      const result = { id: userId, display_name: state.names[userId], email }
      const delayed = state.delayNextProfileRead
      state.delayNextProfileRead = null
      if (delayed) await delayed
      await json(result); return
    }
    if (path === '/rest/v1/memberships' && method === 'GET') { await json(allowedIds.map(workspace_id => ({ workspace_id, user_id: userId, role, is_active: true, display_name: state.overrides[workspace_id][userId] || null }))); return }
    const workspace = (id: string) => ({ id, name: state.workspaceNames[id], owner_id: profileUserIds.admin, created_at: '2026-10-01T00:00:00Z' })
    const subscription = (workspace_id: string) => ({ workspace_id, status: 'active', plan: 'team', seat_limit: 10, current_period_end: '2030-01-01T00:00:00Z', billing_method: 'manual' })
    if (path === '/rest/v1/workspaces' && method === 'GET') { await json(url.searchParams.get('select')?.includes('retention_days') ? { retention_days: 365, privacy_contact_email: 'privacy@example.invalid' } : allowedIds.map(workspace)); return }
    if (path === '/rest/v1/subscriptions' && method === 'GET') { await json(allowedIds.map(subscription)); return }
    if (path === '/rest/v1/workspace_settings' && method === 'GET') {
      const settings = (workspace_id: string) => ({ workspace_id, name: 'Configuração comercial preservada', commission_rate: 10, revenue_goal: 200000 })
      const filter = url.searchParams.get('workspace_id')
      await json(filter?.startsWith('eq.') ? settings(filter.slice(3)) : allowedIds.map(settings)); return
    }
    if (path === '/rest/v1/rpc/list_platform_workspaces') { await json([profileWorkspaceA, profileWorkspaceB].map(id => ({ ...workspace(id), subscription: subscription(id), member_count: 4, admin_email: profileEmail('admin') }))); return }
    const workspaceId = String(body?.p_workspace_id || url.searchParams.get('workspace_id')?.replace(/^eq\./, '') || '')
    if (path === '/rest/v1/rpc/list_members') { await json(Object.entries(profileUserIds).filter(([memberRole]) => memberRole !== 'platform').map(([memberRole, memberId]) => ({ user_id: memberId, email: profileEmail(memberRole as ProfileRole), display_name: effectiveProfileName(state, workspaceId, memberId), role: memberRole, is_active: true }))); return }
    if (path === '/rest/v1/rpc/list_invitations' || path === '/rest/v1/rpc/list_audit' || path === '/rest/v1/rpc/list_call_reviews') { await json([]); return }
    if (path === '/rest/v1/rpc/list_pipeline_stages') { await json(defaultStageRows(workspaceId)); return }
    if (path === '/rest/v1/rpc/list_lead_activities') { await json({ items: [], next_offset: null }); return }
    if (path === '/rest/v1/rpc/list_lead_events') { await json({ items: [], next_cursor: null }); return }
    if (path === '/rest/v1/rpc/list_lead_call_history') { await json({ items: [], next_offset: null, call_count: 0 }); return }
    if (path === '/rest/v1/leads' && method === 'GET') { await json([]); return }
    if (path === '/rest/v1/rpc/update_my_display_name') {
      if (state.failOwnName) { await json({ message: 'Não foi possível salvar seu nome. Tente novamente.' }, 503); return }
      if (body?.p_workspace_id != null && !allowedIds.includes(String(body.p_workspace_id))) { state.unexpected.push('Own name attempted outside current membership'); await json({ message: 'Sem acesso à empresa' }, 403); return }
      const displayName = String(body?.p_display_name).trim()
      state.names[userId] = displayName
      if (body?.p_workspace_id) state.overrides[String(body.p_workspace_id)][userId] = null
      await json(null); return
    }
    if (path === '/rest/v1/rpc/update_member_display_name') {
      if (role !== 'admin' || !allowedIds.includes(workspaceId)) { state.unexpected.push('Member rename attempted without company-admin membership'); await json({ message: 'Somente administrador da empresa pode editar este nome' }, 403); return }
      if (state.failMemberName) { await json({ message: 'Não foi possível salvar o nome do membro. Tente novamente.' }, 503); return }
      state.overrides[workspaceId][String(body?.p_user_id)] = String(body?.p_display_name).trim()
      await json(null); return
    }
    if (path === '/rest/v1/rpc/rename_workspace') {
      if (role !== 'admin' || !allowedIds.includes(workspaceId)) { state.unexpected.push('Workspace rename attempted without company-admin membership'); await json({ message: 'Somente administrador da empresa pode alterar o nome' }, 403); return }
      if (state.failWorkspaceName) { await json({ message: 'Não foi possível salvar o nome da empresa. Tente novamente.' }, 503); return }
      state.workspaceNames[workspaceId] = String(body?.p_name).trim()
      await json(null); return
    }
    state.unexpected.push(`${method} ${path}`)
    await json({ message: 'This profile fixture rejects unrelated or unauthorized mutations.' }, 500)
  })
  await page.route('**/api/invitation*', route => { state.unexpected.push('Unexpected invitation/email delivery'); return route.abort() })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: role === 'platform' ? 'Clientes da plataforma' : 'Visão geral.', exact: true })).toBeVisible()
  if (role !== 'platform') await expect(page.getByText('Salvo na nuvem', { exact: true })).toBeVisible()
  return state
}
export async function openOwnProfile(page: Page) {
  await page.locator('.cloud-context-bar').getByRole('button', { name: 'Minha conta', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sua conta', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Editar nome', exact: true }).click()
  await expect(page.getByLabel('Nome de exibição', { exact: true })).toBeVisible()
}
export async function openProfileAdministration(page: Page) {
  await page.locator('.cloud-context-bar').getByRole('button', { name: 'Administrar', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Equipe', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Equipe', exact: true }).click()
}
