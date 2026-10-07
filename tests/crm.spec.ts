import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { Lead } from '../src/types'

const fixedNow = new Date('2026-10-06T12:00:00-03:00')

test.beforeEach(async ({ page }) => {
  // Each test receives a fresh browser context; freeze the date to keep demo periods stable.
  await page.clock.install({ time: fixedNow })
  await page.goto('/?demo=1')
  await expect(page.getByRole('heading', { name: 'Visão geral.' })).toBeVisible()
})

function metric(page: Page, label: string) {
  return page.locator('.stat-card').filter({ has: page.getByText(label, { exact: true }) }).locator('.stat-value')
}

async function createLead(page: Page, name: string, status = 'Lead novo') {
  await page.getByRole('button', { name: 'Novo lead', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Uma nova oportunidade' })
  await dialog.getByLabel('Nome do lead').fill(name)
  await dialog.getByLabel('Empresa', { exact: true }).fill('Empresa de teste')
  await dialog.getByLabel('Ticket previsto (R$)').fill('12500')
  await dialog.getByLabel('Status').selectOption(status)
  return dialog
}

test('dashboard presents the seeded revenue, rates and monthly charts', async ({ page }) => {
  await expect(metric(page, 'Faturamento')).toHaveText(/R\$\s*148\.000/)
  await expect(metric(page, 'Taxa de comparecimento')).toHaveText('82,4%')
  await expect(metric(page, 'Taxa de fechamento')).toHaveText('57,1%')
  await expect(metric(page, 'Ticket médio')).toHaveText(/R\$\s*18\.500/)
  await expect(page.getByRole('heading', { name: 'Conversas que viram vendas' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Qualificação que dá resultado' })).toBeVisible()
  await page.getByLabel('Período do dashboard').selectOption('all')
  await expect(metric(page, 'Faturamento')).toHaveText(/R\$\s*332\.000/)
})

test('public demo cannot read or overwrite personal records from the previous browser version', async ({ page }) => {
  const originals = await page.evaluate(() => {
    const example = JSON.parse(localStorage.getItem('closer-os-demo-leads-v1')!)[0]
    const leads = JSON.stringify([{ ...example, id: 'legacy-private-lead', name: 'LEAD PESSOAL CONFIDENCIAL' }])
    const settings = JSON.stringify({ name: 'PERFIL PESSOAL CONFIDENCIAL', commissionRate: 25, revenueGoal: 900000 })
    localStorage.setItem('closer-os-leads-v1', leads)
    localStorage.setItem('closer-os-settings-v1', settings)
    return { leads, settings }
  })
  await page.addInitScript(() => {
    const read = Storage.prototype.getItem
    ;(window as unknown as { legacyReads: string[] }).legacyReads = []
    Storage.prototype.getItem = function (name: string) {
      if (name === 'closer-os-leads-v1' || name === 'closer-os-settings-v1') (window as unknown as { legacyReads: string[] }).legacyReads.push(name)
      return read.call(this, name)
    }
  })
  await page.reload()
  await expect(metric(page, 'Faturamento')).toHaveText(/R\$\s*148\.000/)
  await page.getByRole('button', { name: 'Configurações', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Seu workspace' })
  await expect(settings.getByLabel('Seu nome', { exact: true })).toHaveValue('Aquila Rosendo')
  await settings.getByLabel('Seu nome', { exact: true }).fill('Perfil da demonstração')
  await settings.getByRole('button', { name: 'Salvar configurações' }).click()
  const dialog = await createLead(page, 'Lead exclusivo da demonstração')
  await dialog.getByRole('button', { name: 'Cadastrar lead' }).click()
  await expect(dialog).not.toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { legacyReads: string[] }).legacyReads)).toEqual([])
  const storage = await page.evaluate(() => ({
    leads: localStorage.getItem('closer-os-leads-v1'),
    settings: localStorage.getItem('closer-os-settings-v1'),
    demoLeads: localStorage.getItem('closer-os-demo-leads-v1'),
    demoSettings: localStorage.getItem('closer-os-demo-settings-v1'),
  }))
  expect(storage.leads).toBe(originals.leads)
  expect(storage.settings).toBe(originals.settings)
  expect(storage.demoLeads).toContain('Lead exclusivo da demonstração')
  expect(storage.demoLeads).not.toContain('LEAD PESSOAL CONFIDENCIAL')
  expect(JSON.parse(storage.demoSettings!).name).toBe('Perfil da demonstração')
})

test('a closed new lead defaults to its ticket, updates revenue and survives reload', async ({ page }) => {
  const dialog = await createLead(page, 'Venda validada E2E', 'Fechado')
  await expect(dialog.getByLabel('Valor fechado (R$)')).toHaveValue('12500')
  await expect(dialog.getByLabel('Comparecimento')).toHaveValue('Compareceu')
  await dialog.getByRole('button', { name: 'Cadastrar lead' }).click()
  await expect(dialog).not.toBeVisible()
  await expect(metric(page, 'Faturamento')).toHaveText(/R\$\s*160\.500/)
  await page.reload()
  await expect(metric(page, 'Faturamento')).toHaveText(/R\$\s*160\.500/)
  await page.getByRole('button', { name: /^Pipeline\s*\d*$/ }).click()
  await page.getByLabel('Buscar no pipeline').fill('Venda validada E2E')
  await expect(page.locator('.lead-card')).toHaveCount(1)
  await expect(page.getByLabel('Etapa de Venda validada E2E')).toHaveValue('Fechado')
})

test('old last contact marks a lead red and a new contact removes the alert', async ({ page }) => {
  const dialog = await createLead(page, 'Follow-up atrasado E2E', 'Qualificado')
  await dialog.getByLabel('Último contato').fill('2026-09-28T10:00')
  await dialog.getByRole('button', { name: 'Cadastrar lead' }).click()
  await page.getByRole('button', { name: /^Pipeline\s*\d*$/ }).click()
  await page.getByLabel('Buscar no pipeline').fill('Follow-up atrasado E2E')
  const card = page.locator('.lead-card')
  await expect(card).toHaveClass(/stale/)
  await expect(card.getByText('Há mais de 5 dias sem contato')).toBeVisible()
  await card.getByRole('button', { name: /Follow-up atrasado E2E/ }).click()
  const edit = page.getByRole('dialog', { name: 'Follow-up atrasado E2E' })
  await edit.getByLabel('Último contato').fill('2026-10-06T11:00')
  await edit.getByRole('button', { name: 'Salvar alterações' }).click()
  await expect(card).not.toHaveClass(/stale/)
  await expect(card.getByText('Há mais de 5 dias sem contato')).toHaveCount(0)
  await page.reload()
  await page.getByRole('button', { name: /^Pipeline\s*\d*$/ }).click()
  await page.getByLabel('Buscar no pipeline').fill('Follow-up atrasado E2E')
  await expect(page.locator('.lead-card')).not.toHaveClass(/stale/)
})

test('call reviews persist a zero rating, mistakes and reviewed diagnosis', async ({ page }) => {
  await page.getByRole('button', { name: 'Calls', exact: true }).click()
  await page.getByLabel('Buscar calls').fill('Mariana Costa')
  await page.getByRole('button', { name: 'Revisar call de Mariana Costa' }).click()
  const dialog = page.getByRole('dialog', { name: 'Mariana Costa' })
  await dialog.getByRole('group', { name: 'Nota da call de 0 a 10' }).getByRole('button', { name: '0', exact: true }).click()
  await dialog.getByLabel('Onde eu errei / o que melhorar').fill('Apresentei o preço antes de confirmar o custo do problema.')
  await dialog.getByLabel('Resumo da conversa').fill('Problema: estoque parado. Está com caixa apertado e precisa agir este mês. Precisa consultar o sócio.')
  await dialog.getByRole('button', { name: 'Leitura assistida' }).click()
  await expect(dialog.getByText('Sugestões para você revisar')).toBeVisible()
  await dialog.getByRole('button', { name: 'Aplicar ao diagnóstico' }).click()
  await expect(dialog.getByLabel('Objeção principal')).toHaveValue('Preço / caixa')
  await expect(dialog.getByLabel('Urgência')).toHaveValue('Alta')
  await expect(dialog.getByLabel('Capacidade financeira')).toHaveValue('Baixa')
  await expect(dialog.getByLabel('O lead tem poder de decisão')).not.toBeChecked()
  await dialog.getByRole('button', { name: 'Salvar revisão' }).click()
  await expect(page.locator('.cp-score')).toHaveText('0/10')
  await page.reload()
  await page.getByRole('button', { name: 'Calls', exact: true }).click()
  await page.getByLabel('Buscar calls').fill('Mariana Costa')
  await page.getByRole('button', { name: 'Revisar call de Mariana Costa' }).click()
  await expect(dialog.getByRole('group', { name: 'Nota da call de 0 a 10' }).getByRole('button', { name: '0', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.getByLabel('Onde eu errei / o que melhorar')).toHaveValue('Apresentei o preço antes de confirmar o custo do problema.')
  await expect(dialog.getByLabel('Objeção principal')).toHaveValue('Preço / caixa')
})

test('removing demo records preserves real leads and keeps them after reload', async ({ page }) => {
  const dialog = await createLead(page, 'Lead real preservado E2E')
  await dialog.getByRole('button', { name: 'Cadastrar lead' }).click()
  await page.getByRole('button', { name: 'Configurações', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Seu workspace' })
  await settings.getByRole('button', { name: 'Remover dados de demonstração' }).click()
  await settings.getByRole('button', { name: 'Sim, remover demonstração' }).click()
  await expect(settings.getByRole('button', { name: 'Remover dados de demonstração' })).toHaveCount(0)
  await settings.getByRole('button', { name: 'Fechar configurações' }).click()
  await expect(metric(page, 'Faturamento')).toHaveText(/R\$\s*0/)
  await page.reload()
  await page.getByRole('button', { name: /^Pipeline\s*\d*$/ }).click()
  await expect(page.locator('.lead-card')).toHaveCount(1)
  await expect(page.getByRole('heading', { name: 'Lead real preservado E2E' })).toBeVisible()
})

test('CSV exports the selected period and backup includes all records', async ({ page }) => {
  const csvPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Exportar relatório' }).click()
  const csv = await csvPromise
  expect(csv.suggestedFilename()).toMatch(/^closer-os-.*\.csv$/)
  const csvContent = await readFile((await csv.path())!, 'utf8')
  expect(csvContent).toContain('"Valor fechado"')
  expect(csvContent).toContain('"Mariana Costa"')
  expect(csvContent).not.toContain('"Ricardo Monteiro"')
  await page.getByRole('button', { name: 'Configurações', exact: true }).click()
  const backupPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Exportar backup' }).click()
  const backup = await backupPromise
  expect(backup.suggestedFilename()).toMatch(/backup.*\.json$/)
  const parsed = JSON.parse(await readFile((await backup.path())!, 'utf8'))
  expect(parsed.version).toBe(1)
  expect(parsed.leads).toHaveLength(38)
  expect(parsed.settings.commissionRate).toBe(10)
})

test('backup imports add new leads, preserve existing IDs and reject incomplete records atomically', async ({ page }) => {
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('closer-os-demo-leads-v1')!) as Lead[])
  const existing = before[0]
  const imported: Lead = {
    ...existing,
    id: 'import-e2e-complete',
    name: 'Lead importado completo E2E',
    status: 'Qualificado',
    attendance: 'Pendente',
    callDate: '',
    closedAt: '',
    closedValue: 0,
    callScore: null,
  }
  await page.getByRole('button', { name: 'Configurações', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Seu workspace' })
  const chooserPromise = page.waitForEvent('filechooser')
  await settings.getByRole('button', { name: 'Importar leads' }).click()
  const chooser = await chooserPromise
  await chooser.setFiles({
    name: 'backup-completo.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: 1, leads: [{ ...existing, name: 'Este nome não deve sobrescrever', closedValue: 1 }, imported] })),
  })
  await expect(page.getByRole('status')).toContainText('1 leads importados. Os leads existentes foram preservados.')
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('closer-os-demo-leads-v1')!) as Lead[])
  expect(after).toHaveLength(before.length + 1)
  expect(after.find(lead => lead.id === existing.id)).toEqual(existing)
  expect(after.filter(lead => lead.id === imported.id)).toEqual([imported])

  const validStorage = await page.evaluate(() => localStorage.getItem('closer-os-demo-leads-v1'))
  await settings.locator('input[type="file"]').setInputFiles({
    name: 'backup-incompleto.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: 1, leads: [{ ...imported, id: 'must-not-be-partially-imported' }, { id: 'incomplete', name: 'Lead incompleto', ticket: 100, status: 'Qualificado' }] })),
  })
  await expect(page.getByRole('status')).toContainText('Não foi possível importar.')
  expect(await page.evaluate(() => localStorage.getItem('closer-os-demo-leads-v1'))).toBe(validStorage)
  await settings.locator('input[type="file"]').setInputFiles({ name: 'backup-malformado.json', mimeType: 'application/json', buffer: Buffer.from('{') })
  await expect(page.getByRole('status')).toContainText('Não foi possível importar.')
  expect(await page.evaluate(() => localStorage.getItem('closer-os-demo-leads-v1'))).toBe(validStorage)

  await settings.getByRole('button', { name: 'Fechar configurações' }).click()
  await page.reload()
  await page.getByRole('button', { name: /^Pipeline\s*\d*$/ }).click()
  await page.getByLabel('Buscar no pipeline').fill(imported.name)
  await expect(page.locator('.lead-card')).toHaveCount(1)
  await expect(page.getByLabel(`Etapa de ${imported.name}`)).toHaveValue('Qualificado')
})

test('pipeline stage add opens and saves the selected status', async ({ page }) => {
  await page.getByRole('button', { name: /^Pipeline\s*\d*$/ }).click()
  await page.getByRole('button', { name: 'Adicionar lead em Compareceu', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Uma nova oportunidade' })
  await expect(dialog.getByLabel('Status')).toHaveValue('Compareceu')
  await expect(dialog.getByLabel('Comparecimento')).toHaveValue('Compareceu')
  await dialog.getByLabel('Nome do lead').fill('Lead pela etapa E2E')
  await dialog.getByRole('button', { name: 'Cadastrar lead' }).click()
  await page.getByLabel('Buscar no pipeline').fill('Lead pela etapa E2E')
  await expect(page.locator('.lead-card')).toHaveCount(1)
  await expect(page.getByLabel('Etapa de Lead pela etapa E2E')).toHaveValue('Compareceu')
})

test('mobile Calls keeps the page width and allows reviewing a horizontally scrolled row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Abrir menu' }).click()
  await page.getByRole('button', { name: 'Calls', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  const table = page.locator('.cp-table-scroll')
  expect(await table.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
  await page.getByLabel('Buscar calls').fill('Mariana Costa')
  await page.getByRole('button', { name: 'Revisar call de Mariana Costa' }).click()
  await expect(page.getByRole('dialog', { name: 'Mariana Costa' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
})
