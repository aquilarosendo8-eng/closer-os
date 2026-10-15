import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Lead } from '../src/types'
import { createOpportunityState, memberIds, mountOpportunity, navigateOpportunity, workspaceA, workspaceB } from './fixtures/opportunity'

// These adapters exercise Auth/REST/UI contracts. The unchanged PostgreSQL RLS
// suite supplies the independent proof of actual tenant and ownership limits.
type RecordSpec = {
  createdMonth?: number
  callMonth?: number
  firstScheduledAt?: string
  status?: Lead['status']
  attendance?: Lead['attendance']
  ownerId?: string
  workspaceId?: string
  imported?: boolean
}
const booked: RecordSpec = { callMonth: 10 }
const unscheduled: RecordSpec = {}
const booking = (page: Page) => page.getByRole('group', { name: 'Taxa de agendamento', exact: true })
const stat = (page: Page, label: string) => page.locator('.stat-card').filter({ has: page.getByText(label, { exact: true }) }).locator('.stat-value')
const date = (month: number) => `2026-${String(month).padStart(2, '0')}-05T15:00:00.000Z`

function metricState(records: RecordSpec[]) {
  const state = createOpportunityState(), template = state.leads[0]
  state.leads = records.map((record, index) => {
    const workspaceId = record.workspaceId || workspaceA
    const status = record.status || 'Lead novo'
    const stage = state.stages[workspaceId].find(item => item.name === status)!
    const id = `60000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
    return {
      ...structuredClone(template), id, workspace_id: workspaceId, owner_id: record.ownerId || memberIds.closer, stage_id: stage.id,
      data: { ...structuredClone(template.data), id, name: `Lead recebido ${index + 1}`, status,
        attendance: record.attendance || 'Pendente', createdAt: date(record.createdMonth || 10),
        callDate: record.callMonth ? date(record.callMonth) : '', lastContactAt: date(record.createdMonth || 10),
        closedValue: status === 'Fechado' ? 18000 : 0, closedAt: status === 'Fechado' ? date(record.callMonth || 10) : '',
        ...(record.firstScheduledAt ? { firstScheduledAt: record.firstScheduledAt } : {}),
        ...(record.imported ? { importMetadata: { createdAtSource: 'provided' as const, lastContactAtSource: 'provided' as const, importedAt: '2026-10-08T15:00:00.000Z' } } : {}),
      },
    }
  })
  state.activities = []; state.events = []; state.calls = {}; state.reviews[workspaceA] = []; state.reviews[workspaceB] = []
  return state
}

function clean(state: ReturnType<typeof metricState>) { expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]) }

async function expectBooking(page: Page, value: string, scheduled: number, received: number) {
  await expect(booking(page).locator('.booking-value')).toHaveText(value)
  await expect(booking(page).locator('.booking-count')).toHaveText(`${scheduled} de ${received} leads recebidos`)
}

test('counts unique scheduling evidence across the funnel while preserving the existing activity metrics', async ({ page }) => {
  const state = await mountOpportunity(page, 'admin', { state: metricState([
    unscheduled,
    { firstScheduledAt: date(10), status: 'Follow-up' },
    { ...booked, attendance: 'Compareceu', status: 'Compareceu' },
    { ...booked, attendance: 'Não compareceu', status: 'Follow-up' },
    { ...booked, status: 'Fechado' },
    { firstScheduledAt: date(10), status: 'Perdido' },
    { callMonth: 11, firstScheduledAt: date(10), status: 'Call agendada' },
    { ...booked, imported: true },
    { status: 'Call agendada' },
  ]) })
  await expectBooking(page, '77,8%', 7, 9)
  await expect(page.locator('.metrics-grid > .stat-card')).toHaveCount(4)
  await expect(stat(page, 'Taxa de comparecimento')).toHaveText('66,7%')
  await expect(page.getByRole('group', { name: 'Taxa de no-show', exact: true }).locator('.no-show-value')).toHaveText('33,3%')
  await expect(stat(page, 'Taxa de fechamento')).toHaveText('50%')
  await expect(stat(page, 'Faturamento')).toHaveText(/R\$\s*18\.000/)
  await expect(stat(page, 'Ticket médio')).toHaveText(/R\$\s*18\.000/)
  clean(state)
})

test('uses received cohorts even when meetings or closing occur in another month; quarter and all retain their own denominators', async ({ page }) => {
  const state = await mountOpportunity(page, 'admin', { state: metricState([
    { callMonth: 11 }, { callMonth: 9 }, unscheduled,
    { createdMonth: 9, ...booked }, { createdMonth: 9, ...booked, status: 'Fechado' }, { createdMonth: 9, firstScheduledAt: date(10) },
    { createdMonth: 8 }, { createdMonth: 7, ...booked },
  ]) })
  await expectBooking(page, '66,7%', 2, 3)
  await expect(booking(page).locator('.trend')).toHaveText('33,3 p.p.')
  await expect(booking(page).locator('.trend')).toHaveClass(/negative/)
  await page.getByLabel('Período do dashboard').selectOption('quarter')
  await expectBooking(page, '71,4%', 5, 7)
  await expect(booking(page).locator('.trend')).toHaveClass(/neutral/)
  await expect(booking(page).locator('.trend')).toHaveText('—')
  await page.getByLabel('Período do dashboard').selectOption('all')
  await expectBooking(page, '75%', 6, 8)
  await expect(booking(page).locator('.trend')).toHaveClass(/neutral/)
  await page.getByLabel('Período do dashboard').selectOption('month')
  await expectBooking(page, '66,7%', 2, 3)
  clean(state)
})

for (const example of [
  { name: 'no received leads remain unknown even if older calls happen this month', records: [{ createdMonth: 9, ...booked }], value: '—', received: 0, scheduled: 0 },
  { name: 'received but unscheduled leads have a measured zero', records: [unscheduled, unscheduled], value: '0%', received: 2, scheduled: 0 },
  { name: 'all received leads with existing call dates reach a measured hundred', records: [booked, booked], value: '100%', received: 2, scheduled: 2 },
]) {
  test(example.name, async ({ page }) => {
    const state = await mountOpportunity(page, 'admin', { state: metricState(example.records) })
    await expectBooking(page, example.value, example.scheduled, example.received)
    await expect(booking(page).locator('.trend')).toHaveClass(/neutral/)
    clean(state)
  })
}

for (const example of [
  { name: 'increase is good', current: [booked, booked, booked, unscheduled], prior: [booked, unscheduled], value: '75%', change: '25 p.p.', tone: 'positive', accessible: 'Aumento de 25 pontos percentuais em relação ao mês anterior', arrow: 'lucide-arrow-up-right' },
  { name: 'reduction is bad', current: [booked, unscheduled], prior: [booked, booked, booked, unscheduled], value: '50%', change: '25 p.p.', tone: 'negative', accessible: 'Redução de 25 pontos percentuais em relação ao mês anterior', arrow: 'lucide-arrow-down-right' },
  { name: 'previous measured zero remains a valid comparison', current: [booked], prior: [unscheduled], value: '100%', change: '100 p.p.', tone: 'positive', accessible: 'Aumento de 100 pontos percentuais em relação ao mês anterior', arrow: 'lucide-arrow-up-right' },
  { name: 'equal rates stay neutral', current: [booked, unscheduled], prior: [booked, unscheduled], value: '50%', change: '—', tone: 'neutral', accessible: 'Sem alteração em relação ao mês anterior', arrow: null },
  { name: 'no previous cohort stays neutral', current: [booked], prior: [], value: '100%', change: '—', tone: 'neutral', accessible: 'Sem comparação com o mês anterior', arrow: null },
]) {
  test(`comparison: ${example.name}`, async ({ page }) => {
    const state = await mountOpportunity(page, 'admin', { state: metricState([...example.current, ...example.prior.map(item => ({ ...item, createdMonth: 9 }))]) })
    await expect(booking(page).locator('.booking-value')).toHaveText(example.value)
    const trend = booking(page).locator('.trend')
    await expect(trend).toHaveText(example.change)
    await expect(trend).toHaveClass(new RegExp(example.tone))
    await expect(trend).toHaveAccessibleName(example.accessible)
    if (example.arrow) await expect(trend.locator(`.${example.arrow}`)).toBeVisible()
    else await expect(trend.locator('svg')).toHaveCount(0)
    clean(state)
  })
}

for (const role of ['admin', 'manager', 'closer', 'viewer', 'sdr'] as const) {
  test(`${role} computes the cohort only from its authorized returned leads without extra workspace reads`, async ({ page }) => {
    const records = [booked, unscheduled,
      { ...booked, ownerId: memberIds.manager }, { ...booked, ownerId: memberIds.manager },
      { workspaceId: workspaceB }, { workspaceId: workspaceB }]
    const state = await mountOpportunity(page, role === 'sdr' ? 'closer' : role, { state: metricState(records) })
    if (role === 'sdr') {
      await page.route('https://test.supabase.co/rest/v1/memberships*', route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify([{ workspace_id: workspaceA, user_id: memberIds.closer, role: 'sdr', is_active: true }]) }))
      await page.reload()
      await expect(page.locator('.sidebar-profile')).toContainText('SDR — Pré-vendas')
    }
    await expectBooking(page, role === 'closer' || role === 'sdr' ? '50%' : '75%', role === 'closer' || role === 'sdr' ? 1 : 3, role === 'closer' || role === 'sdr' ? 2 : 4)
    const reads = state.requests.filter(request => request.path === '/rest/v1/leads' && request.method === 'GET')
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every(request => request.query.includes(workspaceA) && !request.query.includes(workspaceB))).toBe(true)
    clean(state)
  })
}

test('first scheduling, repeated rescheduling, stage changes and removal of the current call date count the lead only once', async ({ page }) => {
  const state = await mountOpportunity(page, 'closer', { state: metricState([unscheduled, unscheduled]) })
  await expectBooking(page, '0%', 0, 2)
  await navigateOpportunity(page, 'Pipeline')
  const select = page.getByLabel('Etapa de Lead recebido 1', { exact: true })
  let firstScheduledAt: string | undefined
  for (const [index, day] of ['16', '18', '22'].entries()) {
    if (index) await select.selectOption({ label: 'Follow-up' })
    await select.selectOption({ label: 'Call agendada' })
    const dialog = page.getByRole('dialog', { name: 'Agendar call', exact: true })
    await dialog.getByLabel('Data da reunião').fill(`2026-10-${day}`)
    await dialog.getByLabel('Horário da reunião').fill('09:30')
    await dialog.getByRole('button', { name: 'Confirmar agendamento', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    const saved = state.leads[0].data as Lead & { firstScheduledAt?: string }
    expect(saved.callDate).toBe(`2026-10-${day}T12:30:00.000Z`)
    if (!index) {
      firstScheduledAt = saved.firstScheduledAt
      expect(firstScheduledAt).toBeTruthy()
      expect(Number.isFinite(Date.parse(firstScheduledAt!))).toBe(true)
    } else expect(saved.firstScheduledAt).toBe(firstScheduledAt)
    await navigateOpportunity(page, 'Dashboard')
    await expectBooking(page, '50%', 1, 2)
    await navigateOpportunity(page, 'Pipeline')
  }
  await select.selectOption({ label: 'Follow-up' })
  await page.locator('.lead-card-main').filter({ has: page.getByRole('heading', { name: 'Lead recebido 1', exact: true }) }).click()
  const detail = page.getByRole('dialog', { name: 'Oportunidade de Lead recebido 1', exact: true })
  await detail.getByRole('button', { name: 'Editar oportunidade', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Lead recebido 1', exact: true })
  await editor.getByLabel('Data da call', { exact: true }).fill('')
  await editor.getByRole('button', { name: 'Salvar alterações', exact: true }).click()
  await expect(editor).not.toBeVisible()
  expect(state.leads[0].data.callDate).toBe('')
  expect((state.leads[0].data as Lead & { firstScheduledAt?: string }).firstScheduledAt).toBe(firstScheduledAt)
  await page.reload()
  await expectBooking(page, '50%', 1, 2)
  clean(state)
})

test('scheduling directly in the lead form and recording a no-show in Calls preserve one booking in its original cohort', async ({ page }) => {
  const state = await mountOpportunity(page, 'closer', { state: metricState([unscheduled, unscheduled]) })
  await navigateOpportunity(page, 'Pipeline')
  await page.locator('.lead-card-main').filter({ has: page.getByRole('heading', { name: 'Lead recebido 1', exact: true }) }).click()
  await page.getByRole('dialog', { name: 'Oportunidade de Lead recebido 1', exact: true }).getByRole('button', { name: 'Editar oportunidade', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Lead recebido 1', exact: true })
  await editor.getByLabel('Data da call', { exact: true }).fill('2026-10-16T09:30')
  await editor.getByRole('button', { name: 'Salvar alterações', exact: true }).click()
  await expect(editor).not.toBeVisible()
  const firstScheduledAt = (state.leads[0].data as Lead & { firstScheduledAt?: string }).firstScheduledAt
  expect(firstScheduledAt).toBeTruthy()
  await navigateOpportunity(page, 'Dashboard')
  await expectBooking(page, '50%', 1, 2)
  await navigateOpportunity(page, 'Calls')
  await page.getByRole('button', { name: 'Revisar call de Lead recebido 1', exact: true }).click()
  const review = page.locator('.cp-review-modal')
  await review.getByRole('combobox', { name: 'Comparecimento', exact: true }).selectOption('Não compareceu')
  await review.getByRole('button', { name: 'Salvar revisão', exact: true }).click()
  await expect(review).not.toBeVisible()
  expect((state.leads[0].data as Lead & { firstScheduledAt?: string }).firstScheduledAt).toBe(firstScheduledAt)
  await navigateOpportunity(page, 'Dashboard')
  await expectBooking(page, '50%', 1, 2)
  await expect(page.getByRole('group', { name: 'Taxa de no-show', exact: true }).locator('.no-show-value')).toHaveText('100%')
  await expect(stat(page, 'Taxa de comparecimento')).toHaveText('0%')
  await page.reload()
  await expectBooking(page, '50%', 1, 2)
  clean(state)
})

for (const theme of ['light', 'dark'] as const) for (const size of [{ width: 1366, height: 900 }, { width: 768, height: 900 }, { width: 390, height: 844 }]) {
  test(`${theme} at ${size.width}px keeps booking near attendance with four original cards, readable contrast and no page overflow`, async ({ page }, info) => {
    await page.setViewportSize(size)
    const state = await mountOpportunity(page, 'admin', { state: metricState([
      booked, booked, booked, unscheduled,
      { createdMonth: 9, ...booked }, { createdMonth: 9 },
    ]), theme })
    await expect(page.locator('.crm-visual')).toHaveAttribute('data-theme', theme)
    await expectBooking(page, '75%', 3, 4)
    await expect(page.locator('.metrics-grid > .stat-card')).toHaveCount(4)
    await expect(booking(page).locator('.trend')).toHaveClass(/positive/)
    await expect(booking(page).getByText('Taxa de agendamento', { exact: true })).toBeVisible()
    const fit = await booking(page).evaluate(element => ({ own: element.scrollWidth <= element.clientWidth + 1, document: document.documentElement.scrollWidth <= innerWidth + 1 }))
    expect(fit).toEqual({ own: true, document: true })
    const contrast = await booking(page).evaluate(element => {
      const luminance = (color: string) => {
        const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
          const channel = value / 255
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
        })
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
      }
      let background: Element | null = element
      while (background && getComputedStyle(background).backgroundColor === 'rgba(0, 0, 0, 0)') background = background.parentElement
      const base = luminance(getComputedStyle(background!).backgroundColor)
      return ['.booking-heading h2', '.booking-value', '.booking-count'].map(selector => {
        const text = luminance(getComputedStyle(element.querySelector(selector)!).color)
        return (Math.max(text, base) + 0.05) / (Math.min(text, base) + 0.05)
      })
    })
    for (const ratio of contrast) expect(ratio, 'Booking text must preserve WCAG AA contrast in both themes').toBeGreaterThanOrEqual(4.5)
    await mkdir(resolve('.playwright/booking-shots'), { recursive: true })
    const path = resolve('.playwright/booking-shots', `${theme}-${size.width}.png`)
    await page.screenshot({ path, fullPage: true, animations: 'disabled' })
    await info.attach(`${theme}-${size.width}`, { path, contentType: 'image/png' })
    clean(state)
  })
}
