import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Lead } from '../src/types'
import { createFeatureState, mountFeatures, navigateFeatures, workspaceA, type FeatureState } from './fixtures/features'

const column = (page: Page, name: string) => page.locator('.kanban-column').filter({ has: page.getByRole('heading', { name, exact: true }) })
const cards = (page: Page, name: string) => column(page, name).locator('.kanban-cards')
const leadCard = (page: Page, name: string) => page.locator('.lead-card').filter({ has: page.getByRole('heading', { name, exact: true }) })
const writes = (state: FeatureState) => state.requests.filter(request => request.path === '/rest/v1/leads' && request.method === 'PATCH')
const scrollTop = (list: Locator) => list.evaluate(element => element.scrollTop)
const bounds = async (locator: Locator) => { const box = await locator.boundingBox(); expect(box).not.toBeNull(); return box! }
function clean(state: FeatureState) { expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]) }

function longPipeline() {
  const state = createFeatureState(), template = state.leads[0]
  const orderedNames = ['Lead novo', 'Follow-up', 'Compareceu', 'Qualificado', 'Call agendada', 'Fechado', 'Perdido']
  state.stages[workspaceA].forEach(stage => { stage.position = orderedNames.indexOf(stage.name) })
  const sourceLeads = (status: Lead['status'], count: number, prefix: string, source: string) => Array.from({ length: count }, (_, index) => {
    const id = `40000000-0000-4000-8000-${String(state.stages[workspaceA].find(stage => stage.name === status)!.position * 100 + index).padStart(12, '0')}`
    return { ...structuredClone(template), id, stage_id: state.stages[workspaceA].find(stage => stage.name === status)!.id,
      data: { ...structuredClone(template.data), id, name: `${prefix} ${String(index + 1).padStart(2, '0')}`, company: 'Empresa de teste Kanban',
        status, source, ticket: 10000, callDate: '', attendance: 'Pendente' as const, lastContactAt: new Date().toISOString(),
        closedValue: 0, closedAt: '', notes: 'Dados fictícios para validar somente a interface.' } }
  })
  state.leads = [...sourceLeads('Lead novo', 1, 'Novo lead', 'Outbound'), ...sourceLeads('Follow-up', 60, 'Follow-up', 'Instagram'),
    ...sourceLeads('Compareceu', 24, 'Destino', 'Indicação'), ...state.leads.filter(row => row.workspace_id !== workspaceA)]
  return state
}

async function setup(page: Page, theme: 'light' | 'dark' = 'light', size = { width: 1366, height: 900 }) {
  await page.setViewportSize(size)
  const state = await mountFeatures(page, 'admin', { state: longPipeline(), theme })
  await navigateFeatures(page, 'Pipeline')
  await expect(column(page, 'Follow-up').locator('.lead-card')).toHaveCount(60)
  await expect(column(page, 'Follow-up').locator('.kanban-column-header > span')).toHaveText('60')
  return state
}

async function wheelAt(page: Page, list: Locator, deltaY: number, deltaX = 0) {
  const box = await bounds(list)
  await page.mouse.move(box.x + box.width - 5, box.y + Math.min(80, box.height / 2))
  await page.mouse.wheel(deltaX, deltaY)
}

async function stableFrame(page: Page) {
  return page.evaluate(() => ({
    pageY: window.scrollY,
    boardY: document.querySelector('.kanban-board')!.getBoundingClientRect().y,
    columns: [...document.querySelectorAll('.kanban-column')].map(element => ({
      name: element.querySelector('h2')!.textContent,
      headerY: element.querySelector('.kanban-column-header')!.getBoundingClientRect().y,
      totalY: element.querySelector('.kanban-column-total')!.getBoundingClientRect().y,
      scroll: element.querySelector('.kanban-cards')!.scrollTop,
    })),
  }))
}

async function shot(page: Page, info: TestInfo, name: string) {
  const directory = resolve('.playwright/kanban-shots'); await mkdir(directory, { recursive: true })
  const path = resolve(directory, `${name}.png`)
  await page.screenshot({ path, animations: 'disabled' }); await info.attach(name, { path, contentType: 'image/png' })
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: wheel scrolls only the long column while its header, count and total remain fixed`, async ({ page }, info) => {
    const state = await setup(page, theme), list = cards(page, 'Follow-up'), before = await stableFrame(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(page.viewportSize()!.height + 1)
    await wheelAt(page, list, 620)
    await expect.poll(() => scrollTop(list)).toBeGreaterThan(300)
    const after = await stableFrame(page)
    expect(after.pageY).toBe(before.pageY); expect(after.boardY).toBe(before.boardY)
    for (const item of after.columns) {
      const original = before.columns.find(previous => previous.name === item.name)!
      expect(item.headerY).toBe(original.headerY); expect(item.totalY).toBe(original.totalY)
      if (item.name !== 'Follow-up') expect(item.scroll).toBe(original.scroll)
    }
    await expect(column(page, 'Follow-up').locator('.kanban-column-header > span')).toHaveText('60')
    await expect(column(page, 'Follow-up').locator('.kanban-column-total')).toHaveText(/R\$\s*600\.000/)
    await shot(page, info, `${theme}-desktop-scrolled`); expect(writes(state)).toHaveLength(0); clean(state)
  })

  test(`${theme}: top and bottom wheel boundaries never transfer vertical scroll to the page`, async ({ page }) => {
    const state = await setup(page, theme), list = cards(page, 'Follow-up')
    // Give the parent genuine room to scroll: containment must work even if a
    // browser zoom/extension adds more content below the viewport-sized board.
    await page.evaluate(() => { const spacer = document.createElement('div'); spacer.style.height = '800px'; document.body.append(spacer) })
    await list.evaluate(element => { element.scrollTop = element.scrollHeight })
    const bottom = await scrollTop(list), before = await stableFrame(page)
    for (let index = 0; index < 3; index++) await wheelAt(page, list, 800)
    await page.waitForTimeout(180)
    expect(await scrollTop(list)).toBe(bottom); expect(await stableFrame(page)).toEqual(before)
    await list.evaluate(element => { element.scrollTop = 0 })
    await page.evaluate(() => window.scrollTo(0, 35))
    const top = await stableFrame(page)
    for (let index = 0; index < 3; index++) await wheelAt(page, list, -800)
    await page.waitForTimeout(180)
    expect(await scrollTop(list)).toBe(0); expect(await stableFrame(page)).toEqual(top)
    expect(writes(state)).toHaveLength(0); clean(state)
  })

  test(`${theme}: empty and one-card columns have no unnecessary vertical overflow`, async ({ page }) => {
    const state = await setup(page, theme)
    for (const name of ['Lead novo', 'Qualificado']) {
      const list = cards(page, name)
      const metrics = await list.evaluate(element => ({ client: element.clientHeight, scroll: element.scrollHeight }))
      expect(metrics.scroll).toBeLessThanOrEqual(metrics.client + 1)
      const before = await stableFrame(page)
      await list.scrollIntoViewIfNeeded(); await wheelAt(page, list, 450)
      await page.waitForTimeout(120)
      expect(await scrollTop(list)).toBe(0)
      expect((await stableFrame(page)).pageY).toBe(before.pageY)
    }
    await expect(column(page, 'Qualificado').locator('.kanban-empty')).toBeVisible()
    clean(state)
  })

  test(`${theme}: trackpad horizontal deltas pass through cards to the whole board`, async ({ page }) => {
    const state = await setup(page, theme), list = cards(page, 'Follow-up'), board = page.locator('.kanban-board')
    expect(await board.evaluate(element => element.scrollWidth)).toBeGreaterThan(await board.evaluate(element => element.clientWidth))
    await wheelAt(page, list, 0, 500)
    await expect.poll(() => board.evaluate(element => element.scrollLeft)).toBeGreaterThan(200)
    expect(await scrollTop(list)).toBe(0)
    expect(await page.evaluate(() => scrollY)).toBe(0)
    await expect(column(page, 'Fechado')).toBeVisible(); clean(state)
  })
}

test('small notebook viewport adapts column height and keeps the last card reachable after resizing', async ({ page }, info) => {
  const state = await setup(page, 'dark', { width: 1024, height: 600 })
  const list = cards(page, 'Follow-up'), firstBox = await bounds(column(page, 'Follow-up'))
  expect(firstBox.y + firstBox.height).toBeLessThanOrEqual(601)
  await list.evaluate(element => { element.scrollTop = element.scrollHeight })
  const last = leadCard(page, 'Follow-up 60'); await expect(last).toBeVisible()
  const lastBox = await bounds(last); expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(601)
  await page.setViewportSize({ width: 1024, height: 768 })
  await expect.poll(async () => (await bounds(column(page, 'Follow-up'))).height).toBeGreaterThan(firstBox.height)
  const finalBox = await bounds(column(page, 'Follow-up')); expect(finalBox.y + finalBox.height).toBeLessThanOrEqual(769)
  await shot(page, info, 'dark-small-notebook'); clean(state)
})

test('native drag from a long scrolled source into a partially scrolled destination moves exactly one lead', async ({ page }) => {
  const state = await setup(page), sourceList = cards(page, 'Follow-up'), destinationList = cards(page, 'Compareceu')
  await sourceList.evaluate(element => { element.scrollTop = 1400 })
  await destinationList.evaluate(element => { element.scrollTop = 700 })
  const sourceName = await sourceList.locator('.lead-card').evaluateAll(elements => {
    const list = elements[0].parentElement!.getBoundingClientRect()
    return elements.find(element => { const box = element.getBoundingClientRect(); return box.y >= list.y && box.bottom <= list.bottom })!.querySelector('h3')!.textContent!
  })
  const target = destinationList.locator('.lead-card').filter({ has: page.getByRole('heading', { name: 'Destino 05', exact: true }) })
  await target.scrollIntoViewIfNeeded()
  const destinationBefore = await scrollTop(destinationList), targetBefore = await bounds(target)
  const original = structuredClone(state.leads), originalScrollY = await page.evaluate(() => scrollY)
  await leadCard(page, sourceName).dragTo(target, { sourcePosition: { x: 20, y: 22 }, targetPosition: { x: 15, y: 30 } })
  await expect.poll(() => writes(state).length).toBe(1)
  const expectedStage = state.stages[workspaceA].find(stage => stage.name === 'Compareceu')!.id
  expect(state.leads.find(row => row.data.name === sourceName)?.stage_id).toBe(expectedStage)
  expect(state.leads.filter(row => row.data.name !== sourceName)).toEqual(original.filter(row => row.data.name !== sourceName))
  await expect(column(page, 'Follow-up').locator('.kanban-column-header > span')).toHaveText('59')
  await expect(column(page, 'Compareceu').locator('.kanban-column-header > span')).toHaveText('25')
  // Inserting the moved card before the destination's visible cards may cause
  // native scroll anchoring to adjust scrollTop. Keep the viewed card stable.
  expect(await scrollTop(destinationList)).toBeGreaterThanOrEqual(destinationBefore)
  expect(Math.abs((await bounds(target)).y - targetBefore.y)).toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => scrollY)).toBe(originalScrollY)
  await expect(page.locator('.lead-card.dragging')).toHaveCount(0); clean(state)
})

test('after scrolling the final card opens Lead 360 and its existing editor saves the selected lead', async ({ page }) => {
  const state = await setup(page, 'dark'), list = cards(page, 'Follow-up')
  await list.evaluate(element => { element.scrollTop = element.scrollHeight })
  await leadCard(page, 'Follow-up 60').locator('.lead-card-main').click()
  const detail = page.getByRole('dialog', { name: 'Oportunidade de Follow-up 60', exact: true })
  await expect(detail).toBeVisible(); await expect(detail.locator('.l360-company')).toHaveText('Empresa de teste Kanban')
  await detail.getByRole('button', { name: 'Editar oportunidade', exact: true }).click()
  const edit = page.getByRole('dialog', { name: 'Follow-up 60', exact: true })
  await expect(edit.getByLabel('Nome do lead')).toHaveValue('Follow-up 60')
  await edit.getByLabel('Observações').fill('Anotação depois de percorrer a coluna.')
  await edit.getByRole('button', { name: 'Salvar alterações', exact: true }).click()
  await expect(edit).not.toBeVisible()
  expect(state.leads.find(row => row.data.name === 'Follow-up 60')?.data.notes).toBe('Anotação depois de percorrer a coluna.')
  expect(writes(state)).toHaveLength(1); clean(state)
})

test('after scrolling stage dropdowns still open the scheduling, WON and LOST confirmations', async ({ page }) => {
  const state = await setup(page), list = cards(page, 'Follow-up')
  await list.evaluate(element => { element.scrollTop = element.scrollHeight })
  const stage = page.getByLabel('Etapa de Follow-up 60')
  for (const item of [
    { label: 'Call agendada', title: 'Agendar call' },
    { label: 'Fechado', title: 'Confirmar fechamento' },
    { label: 'Perdido', title: 'Por que esta oportunidade foi perdida?' },
  ]) {
    await stage.selectOption({ label: item.label })
    const dialog = page.getByRole('dialog', { name: item.title, exact: true })
    await expect(dialog).toBeVisible(); await expect(dialog.locator('.pf-transition-lead')).toContainText('Follow-up 60')
    await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click()
    await expect(dialog).not.toBeVisible(); await expect(stage.locator('option:checked')).toHaveText('Follow-up')
  }
  expect(writes(state)).toHaveLength(0); clean(state)
})

test('search, source filtering and table view keep the existing opportunity data and edit controls', async ({ page }) => {
  const state = await setup(page), before = structuredClone(state.leads)
  await cards(page, 'Follow-up').evaluate(element => { element.scrollTop = 1500 })
  await page.getByLabel('Buscar no pipeline').fill('Follow-up 60')
  await expect(page.locator('.kanban-board .lead-card')).toHaveCount(1)
  await expect(column(page, 'Follow-up').locator('.kanban-column-header > span')).toHaveText('1')
  await page.getByLabel('Visualização em lista').click()
  await expect(page.locator('.data-table tbody tr')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Editar Follow-up 60', exact: true })).toBeVisible()
  await page.getByLabel('Buscar no pipeline').fill('')
  await page.getByLabel('Filtrar por origem').selectOption('Indicação')
  await expect(page.locator('.data-table tbody tr')).toHaveCount(24)
  await page.getByLabel('Visualização em colunas').click()
  await expect(column(page, 'Compareceu').locator('.lead-card')).toHaveCount(24)
  await expect(column(page, 'Follow-up').locator('.kanban-empty')).toBeVisible()
  expect(state.leads).toEqual(before); expect(writes(state)).toHaveLength(0); clean(state)
})

for (const width of [760, 768]) test(`${width}px notebook toolbar wrapping still leaves a bounded independently scrollable column`, async ({ page }, info) => {
  const state = await setup(page, 'light', { width, height: 768 })
  const board = page.locator('.kanban-board'), list = cards(page, 'Follow-up')
  const boardBox = await bounds(board)
  expect(boardBox.height).toBeGreaterThan(120)
  expect(await list.evaluate(element => element.clientHeight)).toBeGreaterThan(160)
  expect(boardBox.y + boardBox.height).toBeLessThanOrEqual(769)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(769)
  await list.scrollIntoViewIfNeeded(); await wheelAt(page, list, 550)
  await expect.poll(() => scrollTop(list)).toBeGreaterThan(200)
  expect(await page.evaluate(() => scrollY)).toBe(0)
  await shot(page, info, `light-notebook-${width}`); clean(state)
})

for (const width of [760, 768]) test(`${width}px compact notebook preserves readable cards with natural page scrolling`, async ({ page }, info) => {
  const state = await setup(page, 'dark', { width, height: 600 }), list = cards(page, 'Follow-up')
  const metrics = await list.evaluate(element => ({ client: element.clientHeight, scroll: element.scrollHeight, overflow: getComputedStyle(element).overflowY }))
  expect(metrics.client).toBe(metrics.scroll)
  expect(metrics.overflow).not.toBe('auto')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
  await wheelAt(page, list, 420)
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(100)
  expect(await scrollTop(list)).toBe(0)
  await shot(page, info, `dark-compact-notebook-${width}`); clean(state)
})

test('very short desktop windows retain natural page scrolling rather than squeezing the cards', async ({ page }) => {
  const state = await setup(page, 'light', { width: 1366, height: 480 }), list = cards(page, 'Follow-up')
  const metrics = await list.evaluate(element => ({ client: element.clientHeight, scroll: element.scrollHeight }))
  expect(metrics.client).toBe(metrics.scroll)
  await wheelAt(page, list, 500)
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(100)
  expect(await scrollTop(list)).toBe(0)
  clean(state)
})

test.describe('touch layouts preserve natural page scrolling without nested vertical lists', () => {
  test.use({ hasTouch: true, isMobile: true })
  for (const theme of ['light', 'dark'] as const) for (const width of [390, 820]) {
    test(`${theme}: ${width}px touch view scrolls the page vertically and the board horizontally`, async ({ page }, info) => {
      const state = await setup(page, theme, { width, height: width === 390 ? 844 : 1180 })
      const board = page.locator('.kanban-board'), list = cards(page, 'Follow-up')
      const metrics = await list.evaluate(element => ({ client: element.clientHeight, scroll: element.scrollHeight, overflow: getComputedStyle(element).overflowY }))
      expect(metrics.client).toBe(metrics.scroll)
      expect(metrics.overflow).not.toBe('auto')
      const client = await page.context().newCDPSession(page)
      const swipe = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
        await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] })
        for (let step = 1; step <= 10; step++) {
          await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * step / 10, y: from.y + (to.y - from.y) * step / 10 }] })
        }
        await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      }
      const boardBox = await bounds(board), y = Math.min(boardBox.y + 160, page.viewportSize()!.height - 70)
      await swipe({ x: width - 45, y }, { x: 35, y })
      await expect.poll(() => board.evaluate(element => element.scrollLeft)).toBeGreaterThan(100)
      expect(await page.evaluate(() => scrollY)).toBe(0)
      await swipe({ x: Math.min(width - 40, 330), y: y + 90 }, { x: Math.min(width - 40, 330), y: y - 120 })
      await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(60)
      expect(await scrollTop(list)).toBe(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1)
      await shot(page, info, `${theme}-touch-${width}`)
      await client.detach(); expect(writes(state)).toHaveLength(0); clean(state)
    })
  }
})
