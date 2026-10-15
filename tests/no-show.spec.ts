import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Lead } from '../src/types'
import { createOpportunityState, memberIds, mountOpportunity, workspaceA, workspaceB } from './fixtures/opportunity'

type RecordSpec = { attendance: Lead['attendance']; month?: number; won?: boolean; ownerId?: string; workspaceId?: string }
const attended: RecordSpec = { attendance: 'Compareceu' }
const missed: RecordSpec = { attendance: 'Não compareceu' }
const pending: RecordSpec = { attendance: 'Pendente' }
const noShow = (page: Page) => page.getByRole('group', { name: 'Taxa de no-show', exact: true })
const stat = (page: Page, label: string) => page.locator('.stat-card').filter({ has: page.getByText(label, { exact: true }) }).locator('.stat-value')

function metricState(records: RecordSpec[]) {
  const state = createOpportunityState(), template = state.leads[0]
  state.leads = records.map((record, index) => {
    const workspaceId = record.workspaceId || workspaceA
    const stage = state.stages[workspaceId].find(stage => stage.name === (record.won ? 'Fechado' : 'Follow-up'))!
    const id = `50000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
    const date = `2026-${String(record.month || 10).padStart(2, '0')}-05T15:00:00.000Z`
    return { ...structuredClone(template), id, workspace_id: workspaceId, owner_id: record.ownerId || memberIds.closer, stage_id: stage.id,
      data: { ...structuredClone(template.data), id, name: `Lead da métrica ${index + 1}`, status: record.won ? 'Fechado' as const : 'Follow-up' as const,
        attendance: record.attendance, createdAt: date, callDate: date, lastContactAt: date, closedValue: record.won ? 18000 : 0, closedAt: record.won ? date : '' } }
  })
  state.activities = []; state.events = []; state.calls = {}
  return state
}

function clean(state: ReturnType<typeof metricState>) { expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]) }

test('uses the same completed-call base as attendance and preserves closing indicators', async ({ page }) => {
  const state = await mountOpportunity(page, 'admin', { state: metricState([attended, missed, pending, { ...pending, won: true }]) })
  await expect(page.locator('.metrics-grid > .stat-card')).toHaveCount(4)
  await expect(stat(page, 'Taxa de comparecimento')).toHaveText('66,7%')
  await expect(stat(page, 'Taxa de fechamento')).toHaveText('50%')
  await expect(stat(page, 'Faturamento')).toHaveText(/R\$\s*18\.000/)
  await expect(stat(page, 'Ticket médio')).toHaveText(/R\$\s*18\.000/)
  await expect(noShow(page).locator('.no-show-value')).toHaveText('33,3%')
  await expect(noShow(page).getByText('1 falta registrada', { exact: true })).toBeVisible()
  await expect(noShow(page).locator('.trend')).toHaveClass(/neutral/)
  clean(state)
})

test('pending calls have a neutral unknown rate rather than a measured zero', async ({ page }) => {
  const state = await mountOpportunity(page, 'admin', { state: metricState([pending, pending, pending, { ...missed, month: 9 }]) })
  await expect(noShow(page).locator('.no-show-value')).toHaveText('—')
  await expect(noShow(page).getByText('0 faltas registradas', { exact: true })).toBeVisible()
  await expect(noShow(page).locator('.trend')).toHaveClass(/neutral/)
  await expect(noShow(page).locator('.trend')).toHaveAccessibleName('Sem comparação com o mês anterior')
  clean(state)
})

for (const example of [
  { name: 'reduction is green with a downward arrow', current: [attended, attended, attended, missed], prior: [attended, missed], value: '25%', change: '25 p.p.', tone: 'positive', accessible: 'Redução de 25 pontos percentuais em relação ao mês anterior', arrow: 'lucide-arrow-down-right' },
  { name: 'increase is red with an upward arrow', current: [attended, missed], prior: [attended, attended, attended, missed], value: '50%', change: '25 p.p.', tone: 'negative', accessible: 'Aumento de 25 pontos percentuais em relação ao mês anterior', arrow: 'lucide-arrow-up-right' },
  { name: 'measured zero is a valid previous comparison', current: [attended, missed], prior: [attended], value: '50%', change: '50 p.p.', tone: 'negative', accessible: 'Aumento de 50 pontos percentuais em relação ao mês anterior', arrow: 'lucide-arrow-up-right' },
  { name: 'falling to zero remains a measured improvement', current: [attended], prior: [attended, missed], value: '0%', change: '50 p.p.', tone: 'positive', accessible: 'Redução de 50 pontos percentuais em relação ao mês anterior', arrow: 'lucide-arrow-down-right' },
  { name: 'equal rates have a neutral comparison', current: [attended, missed], prior: [attended, missed], value: '50%', change: '—', tone: 'neutral', accessible: 'Sem alteração em relação ao mês anterior', arrow: null },
]) {
  test(`comparison: ${example.name}`, async ({ page }) => {
    const state = await mountOpportunity(page, 'admin', { state: metricState([...example.current, ...example.prior.map(item => ({ ...item, month: 9 }))]) })
    await expect(noShow(page).locator('.no-show-value')).toHaveText(example.value)
    const trend = noShow(page).locator('.trend')
    await expect(trend).toHaveClass(new RegExp(example.tone))
    await expect(trend).toHaveText(example.change)
    await expect(trend).toHaveAccessibleName(example.accessible)
    if (example.arrow) await expect(trend.locator(`.${example.arrow}`)).toBeVisible()
    else await expect(trend.locator('svg')).toHaveCount(0)
    clean(state)
  })
}

test('selected month, rolling quarter and all-time use their own base and never invent previous-period comparisons', async ({ page }) => {
  const records = [attended, attended, missed, pending, pending, pending,
    ...[attended, attended, attended, missed].map(item => ({ ...item, month: 9 })), { ...missed, month: 8 }, { ...missed, month: 7 }]
  const state = await mountOpportunity(page, 'admin', { state: metricState(records) })
  await expect(noShow(page).locator('.no-show-value')).toHaveText('33,3%')
  await expect(noShow(page).locator('.trend')).toHaveText('8,3 p.p.')
  await page.getByLabel('Período do dashboard').selectOption('quarter')
  await expect(noShow(page).locator('.no-show-value')).toHaveText('37,5%')
  await expect(noShow(page).getByText('3 faltas registradas', { exact: true })).toBeVisible()
  await expect(noShow(page).locator('.trend')).toHaveText('—')
  await expect(noShow(page).locator('.trend')).toHaveClass(/neutral/)
  await page.getByLabel('Período do dashboard').selectOption('all')
  await expect(noShow(page).locator('.no-show-value')).toHaveText('44,4%')
  await expect(noShow(page).getByText('4 faltas registradas', { exact: true })).toBeVisible()
  await expect(noShow(page).locator('.trend')).toHaveText('—')
  await page.getByLabel('Período do dashboard').selectOption('month')
  await expect(noShow(page).locator('.no-show-value')).toHaveText('33,3%')
  clean(state)
})

for (const role of ['admin', 'manager', 'closer', 'viewer'] as const) {
  test(`${role} dashboard calculates only the leads returned within its authorized workspace scope`, async ({ page }) => {
    const records = [missed, pending, { ...attended, ownerId: memberIds.manager }, { ...attended, ownerId: memberIds.manager },
      { ...missed, workspaceId: workspaceB }, { ...missed, workspaceId: workspaceB }]
    const state = await mountOpportunity(page, role, { state: metricState(records) })
    await expect(noShow(page).locator('.no-show-value')).toHaveText(role === 'closer' ? '100%' : '33,3%')
    await expect(noShow(page).getByText('1 falta registrada', { exact: true })).toBeVisible()
    await expect(stat(page, 'Taxa de comparecimento')).toHaveText(role === 'closer' ? '0%' : '66,7%')
    clean(state)
  })
}

for (const theme of ['light', 'dark'] as const) for (const size of [{ width: 1366, height: 900 }, { width: 768, height: 900 }, { width: 390, height: 844 }]) {
  test(`${theme} theme at ${size.width}px keeps the linked attendance/no-show metric readable without overflow`, async ({ page }, info) => {
    await page.setViewportSize(size)
    const state = await mountOpportunity(page, 'admin', { state: metricState([attended, attended, attended, missed, { ...attended, month: 9 }, { ...missed, month: 9 }]), theme })
    await expect(page.locator('.crm-visual')).toHaveAttribute('data-theme', theme)
    await expect(noShow(page).locator('.no-show-value')).toHaveText('25%')
    await expect(noShow(page).locator('.trend')).toHaveClass(/positive/)
    const card = page.locator('.stat-card').filter({ has: noShow(page) })
    await expect(card.getByText('Taxa de comparecimento', { exact: true })).toBeVisible()
    await expect(noShow(page).getByText('Taxa de no-show', { exact: true })).toBeVisible()
    const fits = await noShow(page).evaluate(element => ({ own: element.scrollWidth <= element.clientWidth + 1, document: document.documentElement.scrollWidth <= innerWidth + 1 }))
    expect(fits).toEqual({ own: true, document: true })
    const contrast = await noShow(page).evaluate(element => {
      const luminance = (color: string) => {
        const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
          const channel = value / 255
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
        })
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
      }
      const background = luminance(getComputedStyle(element.closest('.stat-card')!).backgroundColor)
      return ['.no-show-label', '.no-show-value', '.no-show-count'].map(selector => {
        const text = luminance(getComputedStyle(element.querySelector(selector)!).color)
        return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05)
      })
    })
    for (const ratio of contrast) expect(ratio, 'No-show text must preserve WCAG AA contrast in both themes').toBeGreaterThanOrEqual(4.5)
    await mkdir(resolve('.playwright/no-show-shots'), { recursive: true })
    const path = resolve('.playwright/no-show-shots', `${theme}-${size.width}.png`)
    await page.screenshot({ path, fullPage: true, animations: 'disabled' })
    await info.attach(`${theme}-${size.width}`, { path, contentType: 'image/png' })
    clean(state)
  })
}
