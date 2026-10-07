import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Lead } from '../src/types'

// Local HTTP fixtures exercise presentation only. No production account,
// database, invitation delivery or billing request is used by this suite.
const userId = '00000000-0000-4000-8000-000000000101'
const workspaceId = '00000000-0000-4000-8000-000000000111'
const secondAdminId = '00000000-0000-4000-8000-000000000102'
const themeKey = 'closer-os-theme-v1'
const authKey = 'sb-test-auth-token'
const token = 'a'.repeat(64)
type Theme = 'light' | 'dark'
type RequestRecord = { path: string; method: string }
interface FixtureOptions { authenticated?: boolean; storedTheme?: string; blockThemeStorage?: boolean; platform?: boolean }

function fixtureLead(id: string, name: string, offset: number, changes: Partial<Lead> = {}): Lead {
  const date = new Date(); date.setDate(date.getDate() + offset)
  const value = date.toISOString()
  return { id, name, company: 'Aurora Consultoria', email: 'lead@example.com', phone: '', ticket: 18000,
    source: 'Indicação', createdAt: new Date().toISOString(), callDate: value, attendance: 'Compareceu',
    objection: 'Momento', status: 'Follow-up', closedValue: 0, closedAt: '', lastContactAt: value,
    notes: 'Próximo passo: aprofundar o impacto antes de apresentar a proposta.', pain: 'Operação sem previsibilidade',
    urgency: 'Alta', financialCapacity: 'Alta', decisionMaker: true, callScore: 8,
    closerError: 'Apresentei a proposta cedo demais', callSummary: 'A empresa quer previsibilidade e tem urgência. Objeção: momento.', ...changes }
}

async function mockPresentation(page: Page, options: FixtureOptions = {}) {
  const requests: RequestRecord[] = [], unexpected: string[] = [], errors: string[] = []
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'owner@example.com',
    app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: 'Ana Responsável' },
    created_at: '2026-10-01T00:00:00Z', email_confirmed_at: '2026-10-01T00:00:00Z', identities: [] }
  const payload = { sub: userId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }
  const jwt = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture-signature`
  const session = { access_token: jwt, token_type: 'bearer', refresh_token: 'theme-fixture-refresh-token', expires_in: 3600, expires_at: payload.exp, user }
  const workspace = { id: workspaceId, name: 'Aurora Consultoria', owner_id: userId, created_at: '2026-10-01T00:00:00Z' }
  const subscription = { workspace_id: workspaceId, status: 'active', plan: 'team', seat_limit: 5, current_period_end: '2030-01-01T00:00:00Z', billing_method: 'manual' }
  const members = [{ user_id: userId, email: user.email, display_name: 'Ana Responsável', role: 'admin', is_active: true },
    { user_id: secondAdminId, email: 'bruno@example.com', display_name: 'Bruno Administrador', role: 'admin', is_active: true }]
  const leads = [
    fixtureLead('theme-won', 'Marina Alves', -1, { status: 'Fechado', closedValue: 18000, closedAt: new Date().toISOString(), objection: 'Preço', callScore: 9 }),
    fixtureLead('theme-stale', 'Ricardo Lima', -9, { objection: 'Caixa', callScore: 6 }),
    fixtureLead('theme-scheduled', 'Helena Costa', 2, { status: 'Call agendada', attendance: 'Pendente', callScore: null, objection: '', closerError: '' }),
    fixtureLead('theme-lost', 'Lucas Martins', -3, { status: 'Perdido', objection: 'Momento', callScore: 4 }),
    fixtureLead('theme-new', 'Pedro Ramos', 0, { status: 'Lead novo', attendance: 'Pendente', callDate: '', callScore: null, objection: '', closerError: '' }),
    fixtureLead('theme-qualified', 'Bianca Duarte', 4, { status: 'Qualificado', attendance: 'Pendente', callScore: null, objection: '', closerError: '' }),
  ]
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(({ authenticated, savedSession, storageKey, preference, preferenceKey, blocked }) => {
    if (authenticated) localStorage.setItem(storageKey, JSON.stringify(savedSession))
    // Seed the preference once, so reload exercises the app's own persistence.
    if (preference !== undefined && !sessionStorage.getItem('theme-fixture-seeded')) {
      localStorage.setItem(preferenceKey, preference); sessionStorage.setItem('theme-fixture-seeded', '1')
    }
    if (blocked) {
      const read = Storage.prototype.getItem, write = Storage.prototype.setItem
      Storage.prototype.getItem = function (key: string) { if (this === localStorage && key === preferenceKey) throw new DOMException('Storage blocked', 'SecurityError'); return read.call(this, key) }
      Storage.prototype.setItem = function (key: string, value: string) { if (this === localStorage && key === preferenceKey) throw new DOMException('Storage blocked', 'SecurityError'); return write.call(this, key, value) }
    }
  }, { authenticated: options.authenticated !== false, savedSession: session, storageKey: authKey, preference: options.storedTheme, preferenceKey: themeKey, blocked: Boolean(options.blockThemeStorage) })
  await page.route('https://test.supabase.co/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname
    requests.push({ path, method: request.method() })
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(value) })
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } }); return }
    if (path === '/auth/v1/user') { await json(user); return }
    if (path === '/auth/v1/token') { await json(session); return }
    if (path === '/auth/v1/logout') { await json({}); return }
    if (path === '/rest/v1/rpc/setup_owner') { await json(null); return }
    if (path === '/rest/v1/rpc/list_invitation_preview') { await json({ name: 'Pessoa convidada', email: user.email, workspace_name: workspace.name, expires_at: '2030-01-01T00:00:00Z' }); return }
    if (path === '/rest/v1/memberships') { await json(options.platform ? [] : [{ workspace_id: workspaceId, user_id: userId, role: 'admin', is_active: true }]); return }
    if (path === '/rest/v1/platform_admins') { await json(options.platform ? [{ user_id: userId }] : []); return }
    if (path === '/rest/v1/profiles') { await json({ email: user.email, display_name: 'Ana Responsável' }); return }
    if (path === '/rest/v1/workspaces') { await json(url.searchParams.get('select')?.includes('retention_days') ? { retention_days: 365, privacy_contact_email: 'privacy@example.com' } : [workspace]); return }
    if (path === '/rest/v1/subscriptions') { await json([subscription]); return }
    if (path === '/rest/v1/workspace_settings') {
      const settings = { workspace_id: workspaceId, name: 'Ana Responsável', commission_rate: 10, revenue_goal: 200000 }
      await json(url.searchParams.get('workspace_id')?.startsWith('eq.') ? settings : [settings]); return
    }
    if (path === '/rest/v1/leads') { await json(leads.map(data => ({ id: data.id, owner_id: userId, data }))); return }
    if (path === '/rest/v1/rpc/list_members') { await json(members); return }
    if (path === '/rest/v1/rpc/list_invitations') { await json([
      { id: 'pending-theme', workspace_id: workspaceId, email: 'nova@example.com', name: 'Nina Convidada', role: 'closer', expires_at: '2030-01-01T00:00:00Z', accepted_at: null, revoked_at: null },
      { id: 'expired-theme', workspace_id: workspaceId, email: 'expired@example.com', name: 'Convite antigo', role: 'viewer', expires_at: '2000-01-01T00:00:00Z', accepted_at: null, revoked_at: null },
    ]); return }
    if (path === '/rest/v1/rpc/list_audit') { await json([{ id: 'audit-theme', action: 'member.joined', created_at: new Date().toISOString(), actor_id: userId, details: {} }]); return }
    if (path === '/rest/v1/rpc/list_platform_workspaces') { await json([{ ...workspace, subscription, member_count: 2, admin_email: user.email }]); return }
    unexpected.push(`${request.method()} ${path}`)
    await json({ message: 'This visual fixture does not permit business mutations.' }, 500)
  })
  await page.route('**/api/invitation*', route => { unexpected.push('Invitation delivery attempted by a visual test'); return route.abort() })
  return { requests, unexpected, errors }
}

async function openCRM(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible()
  await expect(page.getByText('Salvo na nuvem', { exact: true })).toBeVisible()
}
async function expectTheme(page: Page, theme: Theme) {
  await expect(page.locator('.crm-visual')).toHaveAttribute('data-theme', theme)
  await expect(page.getByLabel('Tema da interface')).toHaveValue(theme)
}
async function noDocumentOverflow(page: Page) {
  const size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }))
  expect(size.width, 'Horizontal scrolling must stay inside the board/table, not the document').toBeLessThanOrEqual(size.viewport + 1)
}
async function navigate(page: Page, name: 'Dashboard' | 'Pipeline' | 'Calls' | 'Performance') {
  const mobileMenu = page.getByRole('button', { name: 'Abrir menu', exact: true })
  if (await mobileMenu.isVisible() && !await page.locator('.sidebar').evaluate(element => element.classList.contains('open'))) await mobileMenu.click()
  await page.getByRole('navigation', { name: 'Menu principal' }).getByRole('button', { name: new RegExp(`^${name}\\s*\\d*\\s*(Novo)?$`) }).click()
}
async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(async () => { await document.fonts.ready })
  const folder = resolve('.playwright/theme-shots')
  await mkdir(folder, { recursive: true })
  const filename = resolve(folder, `${testInfo.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${name}.png`)
  await page.screenshot({ path: filename, fullPage: true, animations: 'disabled' })
  await testInfo.attach(name, { path: filename, contentType: 'image/png' })
}

// Computed foreground + composited ancestor backgrounds provide an objective
// contrast check alongside the screenshots, rather than hard-coding a palette.
async function textContrast(locator: Locator, minimum = 4.5) {
  const measured = await locator.evaluate(element => {
    type Color = [number, number, number, number]
    const parse = (value: string): Color => {
      const channels = value.match(/[\d.]+/g)?.map(Number) || []
      const scale = value.startsWith('color(srgb') ? 255 : 1
      return [(channels[0] || 0) * scale, (channels[1] || 0) * scale, (channels[2] || 0) * scale, channels[3] ?? 1]
    }
    const blend = (front: Color, back: Color): Color => [front[0] * front[3] + back[0] * (1 - front[3]), front[1] * front[3] + back[1] * (1 - front[3]), front[2] * front[3] + back[2] * (1 - front[3]), 1]
    const lineage: Element[] = []
    for (let current: Element | null = element; current; current = current.parentElement) lineage.unshift(current)
    const background = lineage.reduce<Color>((color, current) => blend(parse(getComputedStyle(current).backgroundColor), color), [255, 255, 255, 1])
    const style = getComputedStyle(element)
    const foreground = blend(parse(element instanceof SVGElement ? style.fill : style.color), background)
    const luminance = (color: Color) => color.slice(0, 3).reduce((sum, channel, index) => {
      const n = channel / 255, linear = n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4
      return sum + linear * [0.2126, 0.7152, 0.0722][index]
    }, 0)
    const a = luminance(foreground), b = luminance(background)
    return { ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), text: element.textContent?.trim().slice(0, 80), color: style.color, background: background.slice(0, 3) }
  })
  expect(measured.ratio, `Unreadable text: ${JSON.stringify(measured)}`).toBeGreaterThanOrEqual(minimum)
}

for (const initial of ['light', 'dark'] as const) {
  test(`OS ${initial} initializes the internal theme and follows OS changes until an explicit choice`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: initial })
    const state = await mockPresentation(page)
    await openCRM(page); await expectTheme(page, initial)
    expect(await page.evaluate(key => localStorage.getItem(key), themeKey)).toBeNull()
    const other = initial === 'light' ? 'dark' : 'light'
    await page.emulateMedia({ colorScheme: other }); await expectTheme(page, other)
    await page.getByLabel('Tema da interface').selectOption(initial)
    await page.emulateMedia({ colorScheme: other }); await expectTheme(page, initial)
    expect(await page.evaluate(key => localStorage.getItem(key), themeKey)).toBe(initial)
    expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([])
  })
}

test('instant theme changes preserve DOM, current inputs, metrics and session without API writes or Auth calls', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  const state = await mockPresentation(page)
  await openCRM(page)
  await page.getByLabel('Buscar leads', { exact: true }).fill('Marina')
  const revenue = page.locator('.stat-card').filter({ has: page.getByText('Faturamento', { exact: true }) }).locator('.stat-value')
  const before = await revenue.innerText(), url = page.url(), count = state.requests.length
  await page.evaluate(() => { (window as unknown as { themeAnchor: Element | null }).themeAnchor = document.querySelector('.app-shell') })
  await page.getByLabel('Tema da interface').selectOption('dark'); await expectTheme(page, 'dark')
  expect(await page.evaluate(() => (window as unknown as { themeAnchor: Element | null }).themeAnchor === document.querySelector('.app-shell'))).toBe(true)
  await expect(page.getByLabel('Buscar leads', { exact: true })).toHaveValue('Marina')
  await expect(revenue).toHaveText(before); expect(page.url()).toBe(url)
  expect(state.requests.slice(count)).toEqual([])
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).user.email, authKey)).toBe('owner@example.com')
  await page.reload(); await expectTheme(page, 'dark')
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([])
})

test('stored explicit light preference overrides a dark OS and survives internal navigation', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  const state = await mockPresentation(page, { storedTheme: 'light' })
  await openCRM(page); await expectTheme(page, 'light')
  await page.locator('.cloud-context-bar').getByRole('button', { name: 'Administrar', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Equipe', exact: true })).toBeVisible(); await expectTheme(page, 'light')
  await page.getByRole('tab', { name: 'Plano', exact: true }).click(); await expectTheme(page, 'light')
  await page.locator('.cloud-context-bar').getByRole('button', { name: 'Minha conta', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sua conta', exact: true })).toBeVisible(); await expectTheme(page, 'light')
  await page.locator('.cloud-context-bar').getByRole('button', { name: 'Voltar ao CRM', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible(); await expectTheme(page, 'light')
  await page.reload(); await expectTheme(page, 'light')
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([])
})

test('blocked theme storage still allows a visual change without affecting Auth', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  const state = await mockPresentation(page, { blockThemeStorage: true })
  await openCRM(page); await expectTheme(page, 'dark')
  await page.getByLabel('Tema da interface').selectOption('light'); await expectTheme(page, 'light')
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible()
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([])
})

test('unknown stored values fall back to OS and are replaced by a valid explicit preference', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  const state = await mockPresentation(page, { storedTheme: 'not-a-theme' })
  await openCRM(page); await expectTheme(page, 'dark')
  await page.getByLabel('Tema da interface').selectOption('light'); await expectTheme(page, 'light')
  expect(await page.evaluate(key => localStorage.getItem(key), themeKey)).toBe('light')
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([])
})

test('public login, signup, invite, legal documents and demo keep their appearance and expose no theme control', async ({ page }) => {
  const state = await mockPresentation(page, { authenticated: false, storedTheme: 'dark' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Bom ter você de volta.' })).toBeVisible()
  const publicAppearance = () => page.evaluate(() => ['.auth-card h2', '.auth-main', '.auth-primary-button'].map(selector => { const element = document.querySelector(selector)!; const style = getComputedStyle(element); return { color: style.color, background: style.backgroundColor } }))
  const darkAppearance = await publicAppearance()
  await expect(page.locator('.crm-visual')).toHaveCount(0); await expect(page.getByLabel('Tema da interface')).toHaveCount(0)
  await page.emulateMedia({ colorScheme: 'light' }); await page.reload()
  expect(await publicAppearance()).toEqual(darkAppearance)
  await page.getByRole('button', { name: 'Privacidade', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Política de privacidade' })).toBeVisible()
  await expect(page.getByLabel('Tema da interface')).toHaveCount(0); await page.keyboard.press('Escape')
  for (const address of ['/?signup=1', `/?invite=${token}`, '/?demo=1']) {
    await page.goto(address)
    await expect(page.locator('.crm-visual')).toHaveCount(0); await expect(page.getByLabel('Tema da interface')).toHaveCount(0)
  }
  expect(state.requests.filter(request => request.path === '/rest/v1/leads')).toEqual([])
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([])
})

for (const theme of ['light', 'dark'] as const) {
  test(`visual ${theme} covers dashboard charts, pipeline, calls, performance, administration, modals and account`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1366, height: 768 })
    const state = await mockPresentation(page, { storedTheme: theme })
    await openCRM(page); await expectTheme(page, theme); await noDocumentOverflow(page)
    await textContrast(page.locator('.stat-label').first())
    await textContrast(page.locator('.stat-value').first(), 3)
    await textContrast(page.locator('.panel-header h2').first())
    await capture(page, testInfo, 'dashboard')
    const chart = page.locator('.revenue-chart .recharts-wrapper')
    await expect(chart).toBeVisible()
    const box = await chart.boundingBox(); if (!box) throw new Error('Revenue chart has no layout box.')
    await chart.hover({ position: { x: box.width * 0.78, y: box.height * 0.45 } })
    const tooltip = page.locator('.revenue-chart .recharts-default-tooltip')
    await expect(tooltip).toBeVisible(); await textContrast(tooltip.locator('.recharts-tooltip-label'))
    await capture(page, testInfo, 'chart-tooltip')
    await navigate(page, 'Pipeline'); await noDocumentOverflow(page)
    await expect(page.locator('.stale-note').first()).toBeVisible(); await textContrast(page.locator('.stale-note').first())
    await capture(page, testInfo, 'pipeline')
    await page.getByRole('button', { name: 'Visualização em lista', exact: true }).click()
    await capture(page, testInfo, 'pipeline-table')
    await navigate(page, 'Calls'); await noDocumentOverflow(page)
    await capture(page, testInfo, 'calls')
    await page.getByRole('button', { name: 'Revisar call de Marina Alves', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'Marina Alves', exact: true })
    await expect(review).toBeVisible(); await textContrast(review.getByRole('heading', { name: 'Marina Alves', exact: true }))
    await textContrast(review.getByLabel('Objeção principal', { exact: true }))
    await noDocumentOverflow(page); await capture(page, testInfo, 'call-review')
    await review.getByRole('button', { name: 'Fechar revisão', exact: true }).click()
    await navigate(page, 'Performance'); await noDocumentOverflow(page)
    await capture(page, testInfo, 'performance')
    await navigate(page, 'Dashboard')
    await page.getByRole('button', { name: 'Novo lead', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'Uma nova oportunidade', exact: true })
    await expect(form).toBeVisible(); await textContrast(form.getByLabel('Nome do lead', { exact: false }))
    await capture(page, testInfo, 'lead-form'); await form.getByRole('button', { name: 'Fechar formulário', exact: true }).click()
    await page.locator('.cloud-context-bar').getByRole('button', { name: 'Administrar', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Equipe', exact: true })).toBeVisible(); await expectTheme(page, theme)
    await noDocumentOverflow(page); for (const badge of await page.locator('.ad-status-active').all()) await textContrast(badge)
    await capture(page, testInfo, 'admin-team')
    await page.getByRole('button', { name: 'Convidar pessoa', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Convide alguém para a equipe' })).toBeVisible()
    await capture(page, testInfo, 'admin-invitation-modal')
    await page.getByRole('dialog').getByRole('button', { name: 'Fechar formulário', exact: true }).click()
    await page.getByRole('tab', { name: 'Plano', exact: true }).click(); await capture(page, testInfo, 'admin-plan')
    await page.getByRole('tab', { name: 'Empresa', exact: true }).click(); await capture(page, testInfo, 'admin-company')
    await page.getByRole('button', { name: 'Excluir empresa', exact: true }).click()
    const danger = page.getByRole('dialog', { name: 'Excluir esta empresa?', exact: true })
    await expect(danger).toBeVisible(); await textContrast(danger.getByRole('heading', { name: 'Excluir esta empresa?', exact: true }))
    await capture(page, testInfo, 'admin-danger-modal'); await danger.getByRole('button', { name: 'Cancelar', exact: true }).click()
    await page.locator('.cloud-context-bar').getByRole('button', { name: 'Minha conta', exact: true }).click()
    await expectTheme(page, theme); await noDocumentOverflow(page); await capture(page, testInfo, 'account')
    expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([])
  })

  test(`visual ${theme} platform customer administration`, async ({ page }, testInfo) => {
    const state = await mockPresentation(page, { platform: true, storedTheme: theme })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Clientes da plataforma' })).toBeVisible()
    await expectTheme(page, theme); await noDocumentOverflow(page)
    await capture(page, testInfo, 'platform-clients')
    expect(state.requests.filter(request => request.path === '/rest/v1/leads')).toEqual([])
    expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([])
  })
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 820, height: 1180 }, { width: 390, height: 844 }]) {
  test(`responsive internal pages ${viewport.width}x${viewport.height} in both themes contain horizontal overflow`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    const state = await mockPresentation(page)
    await openCRM(page)
    const companyLabel = page.locator('.cloud-context-bar > span')
    await expect(companyLabel).toBeVisible()
    expect(await companyLabel.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const front = document.elementFromPoint(rect.left + Math.min(10, rect.width / 2), rect.top + rect.height / 2)
      return front === element || element.contains(front)
    })).toBe(true)
    for (const theme of ['light', 'dark'] as const) {
      await page.getByLabel('Tema da interface').selectOption(theme); await expectTheme(page, theme)
      for (const screen of ['Dashboard', 'Calls', 'Performance', 'Pipeline'] as const) {
        await navigate(page, screen); await noDocumentOverflow(page)
      }
      await navigate(page, 'Dashboard'); await capture(page, testInfo, `dashboard-${theme}`)
      await page.locator('.cloud-context-bar').getByRole('button', { name: 'Administrar', exact: true }).click()
      await expect(page.getByRole('tab', { name: 'Equipe', exact: true })).toBeVisible(); await noDocumentOverflow(page)
      await page.getByRole('tab', { name: 'Plano', exact: true }).click(); await noDocumentOverflow(page)
      await page.getByRole('tab', { name: 'Empresa', exact: true }).click(); await noDocumentOverflow(page)
      await capture(page, testInfo, `admin-${theme}`)
      await page.locator('.cloud-context-bar').getByRole('button', { name: 'Voltar ao CRM', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible()
    }
    expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([])
  })
}
