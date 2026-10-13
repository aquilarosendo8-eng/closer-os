import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import { buildImportWorkbook } from './helpers/import-workbook'
import { createSmartImportState, csvUpload, holdSmartImport, holdSmartPreview, mountSmartImport, openSmartImport } from './fixtures/smart-import'
import { memberIds, workspaceA, workspaceB } from './fixtures/features'
import { mountMaster, openMasterCompany } from './fixtures/master-admin'

async function upload(wizard: Locator, text: string, name = 'migracao.csv') {
  await wizard.getByLabel('Selecionar arquivo CSV, Excel ou JSON').setInputFiles(csvUpload(text, name))
  await wizard.getByRole('button', { name: 'Continuar', exact: true }).click()
  await expect(wizard.getByLabel('Campo para Nome', { exact: true })).toBeVisible()
}
async function configure(wizard: Locator) {
  await wizard.getByRole('button', { name: 'Continuar', exact: true }).click()
  await expect(wizard.getByLabel('Etapa padrão', { exact: true })).toBeVisible()
  await wizard.getByLabel('Etapa padrão', { exact: true }).selectOption({ label: 'Lead novo' })
  await wizard.getByLabel('Responsável padrão', { exact: true }).selectOption(memberIds.closer)
  // The user explicitly chooses defaults for every source value, then tests
  // that need individual assignments override the selected destinations.
  for (const control of await wizard.getByLabel(/^Etapa para /).all()) await control.selectOption('')
  for (const control of await wizard.getByLabel(/^Responsável para /).all()) await control.selectOption('')
}
async function validate(wizard: Locator) {
  await wizard.getByRole('button', { name: 'Validar registros', exact: true }).click()
  await expect(wizard.getByRole('button', { name: 'Ir para confirmação', exact: true })).toBeVisible()
}
async function confirm(wizard: Locator) {
  await wizard.getByRole('button', { name: 'Ir para confirmação', exact: true }).click()
  await wizard.getByLabel('Confirmo a importação para esta empresa e pipeline.', { exact: true }).check()
  await wizard.getByRole('button', { name: 'Importar registros válidos', exact: true }).click()
}
async function accessiblePage(page: Page, wizard: Locator) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  const bounds = await wizard.boundingBox()
  expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(-1)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
  expect(bounds!.y).toBeGreaterThanOrEqual(-1)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1)
}

test('CSV semicolon, UTF-8 BOM, quoted commas and multiline notes preserve business data', async ({ page }) => {
  const state = await mountSmartImport(page), original = JSON.stringify(state.feature.leads)
  const wizard = await openSmartImport(page)
  await upload(wizard, '\uFEFFNome;Empresa;E-mail;Telefone;Ticket;Data da call;Comparecimento;Observações\r\n"Maria, Silva";"Aurora; Consultoria";maria@example.invalid;+55 11 99999-4401;"R$ 12.345,67";12/10/2026 17:30;Pendente;"Linha inicial, com aspas ""preservadas""\nSegunda linha"\r\n')
  await expect(wizard.getByLabel('Campo para E-mail', { exact: true })).toHaveValue('email')
  await expect(wizard.getByLabel('Campo para Ticket', { exact: true })).toHaveValue('ticket')
  await configure(wizard); await validate(wizard); await confirm(wizard)
  await expect.poll(() => state.importedRows.length).toBe(1)
  const imported = state.importedRows[0]
  expect(imported.lead.name).toBe('Maria, Silva'); expect(imported.lead.company).toBe('Aurora; Consultoria')
  expect(imported.lead.ticket).toBe(12345.67); expect(imported.lead.callDate).toBe('2026-10-12T20:30:00.000Z')
  expect(imported.lead.attendance).toBe('Pendente'); expect(imported.lead.callScore).toBeNull()
  expect(imported.lead.notes).toBe('Linha inicial, com aspas "preservadas"\nSegunda linha')
  expect(JSON.stringify(state.feature.leads.slice(0, 4))).toBe(original)
  expect(state.requests.every(request => request.authenticated && request.body.p_workspace_id === workspaceA)).toBe(true)
  expect(state.unexpected).toEqual([]); expect(state.feature.unexpected).toEqual([]); expect(state.feature.errors).toEqual([])
})

test('manual mapping only adds unknown columns to notes after explicit selection', async ({ page }) => {
  const state = await mountSmartImport(page), wizard = await openSmartImport(page)
  await upload(wizard, 'Nome,Campo desconhecido,Código legado,Não importar\nLead manual,"Contexto estratégico",ID-77,SEGREDOIGNORADO\n')
  await expect(wizard.getByLabel('Campo para Campo desconhecido', { exact: true })).toHaveValue('ignore')
  await wizard.getByLabel('Campo para Campo desconhecido', { exact: true }).selectOption('notes-extra')
  await wizard.getByLabel('Campo para Código legado', { exact: true }).selectOption('company')
  await configure(wizard); await validate(wizard); await confirm(wizard)
  await expect.poll(() => state.importedRows.length).toBe(1)
  expect(state.importedRows[0].lead.company).toBe('ID-77')
  expect(state.importedRows[0].lead.notes).toContain('Campo desconhecido: Contexto estratégico')
  expect(state.importedRows[0].lead.notes).not.toContain('SEGREDOIGNORADO')
})

test('custom source stages and different responsible members use actual company identifiers', async ({ page }) => {
  const state = createSmartImportState()
  const custom = state.feature.stages[workspaceA].find(stage => stage.name === 'Follow-up')!
  custom.name = 'Diagnóstico executivo'
  await mountSmartImport(page, 'manager', { state })
  const wizard = await openSmartImport(page)
  await upload(wizard, 'Nome,E-mail,Etapa,Responsável\nPrimeiro,first@example.invalid,Em negociação,Antigo vendedor\nSegundo,second@example.invalid,Qualificado,Marcos Gestor\n')
  await configure(wizard)
  await wizard.getByLabel('Etapa para Em negociação', { exact: true }).selectOption(custom.id)
  await wizard.getByLabel('Responsável para Antigo vendedor', { exact: true }).selectOption(memberIds.closer)
  await wizard.getByLabel('Responsável para Marcos Gestor', { exact: true }).selectOption(memberIds.manager)
  await expect(wizard.getByLabel('Responsável padrão').locator('option').filter({ hasText: 'Vera Consulta' })).toHaveCount(0)
  await validate(wizard); await confirm(wizard)
  await expect.poll(() => state.importedRows.length).toBe(2)
  expect(state.importedRows[0].stageId).toBe(custom.id); expect(state.importedRows[0].ownerId).toBe(memberIds.closer)
  expect(state.importedRows[1].ownerId).toBe(memberIds.manager)
  expect(state.requests.filter(request => request.rpc === 'import_external_leads')).toHaveLength(1)
})

test('file duplicates, database duplicates, conflicting identities and invalid rows are reported before confirmation', async ({ page }) => {
  const state = createSmartImportState()
  state.previewStatuses[4] = { status: 'duplicate', code: 'EXISTING_EMAIL' }
  state.previewStatuses[5] = { status: 'conflict', code: 'IDENTITY_CONFLICT' }
  await mountSmartImport(page, 'admin', { state }); const wizard = await openSmartImport(page)
  await upload(wizard, 'Nome,E-mail,Telefone,Data da call\nVálido,valid@example.invalid,+5511999991010,\nRepetido,valid@example.invalid,+5511999991010,\nJá existe,existing@example.invalid,+5511999992020,\nConflito,conflict@example.invalid,+5511999993030,\n,missing@example.invalid,,\nData inválida,date@example.invalid,,31/02/2026 10:00\n')
  await configure(wizard); await validate(wizard)
  await expect(wizard).toContainText(/duplicad/i); await expect(wizard).toContainText(/conflit/i)
  await expect(wizard).toContainText(/Linha 6/); await expect(wizard).toContainText(/Linha 7/)
  await expect(wizard).toContainText(/nome/i); await expect(wizard).toContainText(/data/i)
  await confirm(wizard); await expect.poll(() => state.importedRows.length).toBe(1)
  expect(state.importedRows[0].lead.name).toBe('Válido')
  expect(state.importedRows.every(row => row.lead.email !== 'existing@example.invalid' && row.lead.email !== 'conflict@example.invalid')).toBe(true)
})

test('2001 rows preview in safe batches without reloading the existing lead base and show at most 20 preview records', async ({ page }) => {
  const state = await mountSmartImport(page), initialReads = state.feature.requests.filter(request => request.path === '/rest/v1/leads' && request.method === 'GET').length
  const wizard = await openSmartImport(page)
  await upload(wizard, 'Nome,E-mail,Ticket\n' + Array.from({ length: 2001 }, (_, index) => `Lead migração ${index + 1},migracao-${index + 1}@example.invalid,1000`).join('\n'))
  await configure(wizard); await validate(wizard)
  await expect(wizard).toContainText('2.001')
  const previewTable = wizard.getByRole('table').first()
  expect(await previewTable.getByRole('row').count()).toBeLessThanOrEqual(21)
  expect(state.feature.requests.filter(request => request.path === '/rest/v1/leads' && request.method === 'GET')).toHaveLength(initialReads)
  expect(state.requests.filter(request => request.rpc === 'preview_import_leads').every(request => request.body.p_records!.length <= 500)).toBe(true)
  const release = holdSmartImport(state)
  await confirm(wizard)
  await expect(wizard.getByRole('button', { name: /Importando|Importar registros válidos/ })).toBeDisabled()
  expect(state.importedRows).toHaveLength(0)
  await expect(wizard.getByRole('progressbar')).toBeVisible()
  release(); await expect.poll(() => state.importedRows.length, { timeout: 30_000 }).toBe(2001)
  await expect(wizard).toContainText('Importação confirmada no banco')
  await wizard.getByRole('button', { name: 'Concluir', exact: true }).click()
  await expect(page.locator('.nav-count')).toHaveText('2003')
  await page.getByRole('dialog', { name: 'Seu workspace', exact: true }).getByRole('button', { name: 'Fechar configurações', exact: true }).click()
  await page.getByLabel('Buscar leads', { exact: true }).fill('Lead migração 2001')
  await expect(page.locator('.search-results').getByText('Lead migração 2001', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.locator('.nav-count')).toHaveText('2003')
  await page.getByLabel('Buscar leads', { exact: true }).fill('Lead migração 2001')
  await expect(page.locator('.search-results').getByText('Lead migração 2001', { exact: true })).toBeVisible()
  expect(state.requests.filter(request => request.rpc === 'import_external_leads')).toHaveLength(5)
  expect(new Set(state.importedRows.map(row => row.rowKey)).size).toBe(2001)
  expect(state.feature.errors).toEqual([])
})

test('later batch failure reports committed counts and retry preserves already imported rows', async ({ page }) => {
  const state = createSmartImportState(); state.failImportBatch = 2
  await mountSmartImport(page, 'admin', { state }); const wizard = await openSmartImport(page)
  await upload(wizard, 'Nome,E-mail\n' + Array.from({ length: 1100 }, (_, index) => `Retomada ${index + 1},retry-${index + 1}@example.invalid`).join('\n'))
  await configure(wizard); await validate(wizard); await confirm(wizard)
  await expect(wizard.getByRole('alert')).toContainText(/interrompida/)
  await expect(wizard).toContainText('500 leads confirmados no banco')
  expect(state.importedRows).toHaveLength(500)
  const previouslySaved = JSON.stringify(state.importedRows)
  state.failImportBatch = null
  await wizard.getByRole('button', { name: /Tentar novamente|Retomar importação/ }).click()
  await expect.poll(() => state.importedRows.length, { timeout: 30_000 }).toBe(1100)
  expect(JSON.stringify(state.importedRows.slice(0, 500))).toBe(previouslySaved)
  expect(new Set(state.importedRows.map(row => row.rowKey)).size).toBe(1100)
  await expect(wizard).toContainText(/ignorad|duplicad/i)
})

test('failed database validation allows retry and blocks any import without confirmed preview', async ({ page }) => {
  const state = createSmartImportState(); state.failPreview = true
  await mountSmartImport(page, 'admin', { state }); const wizard = await openSmartImport(page)
  await upload(wizard, 'Nome,E-mail\nValidação,validation@example.invalid\n'); await configure(wizard)
  await wizard.getByRole('button', { name: 'Validar registros', exact: true }).click()
  await expect(wizard.getByRole('alert')).toBeVisible()
  expect(state.requests.filter(request => request.rpc === 'import_external_leads')).toHaveLength(0)
  state.failPreview = false
  await wizard.getByRole('button', { name: /Validar registros|Tentar novamente/ }).click()
  await expect(wizard.getByRole('button', { name: 'Ir para confirmação', exact: true })).toBeVisible()
  await confirm(wizard); await expect.poll(() => state.importedRows.length).toBe(1)
})

for (const acrossBatch of [false, true]) test(`backend classification avoids merging an ignored row's alternative phone ${acrossBatch ? 'across 500-row batches' : 'within one batch'}`, async ({ page }) => {
  const state = createSmartImportState(), original = state.feature.leads[0]
  original.data.email = 'original@example.invalid'; original.data.phone = '+5511999991001'
  const preserved = structuredClone(original)
  await mountSmartImport(page, 'admin', { state }); const wizard = await openSmartImport(page)
  const filler = acrossBatch ? Array.from({ length: 499 }, (_, index) => `Intermediário ${index},filler-${index}@example.invalid,`).join('\n') + '\n' : ''
  await upload(wizard, `Nome,E-mail,Telefone\nIgnorar sem mesclar,original@example.invalid,+5511999991002\n${filler}Contato realmente novo,new-contact@example.invalid,+5511999991002\n`)
  await configure(wizard); await validate(wizard)
  const previews = state.requests.filter(request => request.rpc === 'preview_import_leads')
  expect(previews).toHaveLength(acrossBatch ? 2 : 1)
  if (acrossBatch) {
    const context = previews[1].body.p_context!
    expect(context.workspaceId).toBe(workspaceA); expect(context.entries).toHaveLength(500)
    expect(context.entries[0].emailHash).toBeNull(); expect(context.entries[0].phoneHash).toBeNull()
    expect(JSON.stringify(context)).not.toContain('original@example.invalid'); expect(JSON.stringify(context)).not.toContain('5511999991002')
  }
  await confirm(wizard)
  await expect(wizard).toContainText('Importação confirmada no banco')
  expect(state.importedRows).toHaveLength(acrossBatch ? 500 : 1)
  expect(state.importedRows.at(-1)?.lead.name).toBe('Contato realmente novo')
  expect(state.feature.leads.find(row => row.id === original.id)).toEqual(preserved)
  expect(state.unexpected).toEqual([])
})

test('unrecognized source stage and seller require an explicit mapping without silently using defaults', async ({ page }) => {
  const state = await mountSmartImport(page), wizard = await openSmartImport(page)
  await upload(wizard, 'Nome,E-mail,Etapa,Responsável\nMapear antes de migrar,mapping@example.invalid,Etapa desconhecida,Vendedor antigo\n')
  await wizard.getByRole('button', { name: 'Continuar', exact: true }).click()
  await wizard.getByLabel('Etapa padrão', { exact: true }).selectOption({ label: 'Lead novo' })
  await wizard.getByLabel('Responsável padrão', { exact: true }).selectOption(memberIds.closer)
  await expect(wizard.getByLabel('Etapa para Etapa desconhecida', { exact: true })).toHaveValue('__unmapped__')
  await expect(wizard.getByLabel('Responsável para Vendedor antigo', { exact: true })).toHaveValue('__unmapped__')
  await validate(wizard)
  await expect(wizard).toContainText('etapa não encontrada'); await expect(wizard).toContainText('responsável não encontrado')
  await expect(wizard.getByRole('button', { name: 'Ir para confirmação', exact: true })).toBeDisabled()
  expect(state.requests.filter(request => request.rpc === 'import_external_leads')).toHaveLength(0)
  await wizard.getByRole('button', { name: 'Voltar', exact: true }).click()
  await wizard.getByLabel('Etapa para Etapa desconhecida', { exact: true }).selectOption('')
  await wizard.getByLabel('Responsável para Vendedor antigo', { exact: true }).selectOption('')
  await validate(wizard); await confirm(wizard)
  await expect.poll(() => state.importedRows.length).toBe(1)
  expect(state.importedRows[0].lead.name).toBe('Mapear antes de migrar')
})

for (const malformed of ['rows', 'context'] as const) test(`inconsistent ${malformed} from preview fails safely without enabling import`, async ({ page }) => {
  const state = createSmartImportState()
  if (malformed === 'rows') state.malformedPreview = true; else state.malformedContext = true
  await mountSmartImport(page, 'admin', { state }); const wizard = await openSmartImport(page)
  await upload(wizard, 'Nome,E-mail\nNão confirmar,invalid-reply@example.invalid\n'); await configure(wizard)
  await wizard.getByRole('button', { name: 'Validar registros', exact: true }).click()
  await expect(wizard.getByRole('alert')).toContainText(/validar.*banco/i)
  await expect(wizard.getByRole('button', { name: 'Ir para confirmação', exact: true })).toHaveCount(0)
  expect(state.importedRows).toHaveLength(0)
  expect(state.requests.filter(request => request.rpc === 'import_external_leads')).toHaveLength(0)
})

test('unconfirmed commit response reports uncertainty and retry never creates the saved row again', async ({ page }) => {
  const state = createSmartImportState(); state.malformedImport = true
  await mountSmartImport(page, 'admin', { state }); const wizard = await openSmartImport(page)
  await upload(wizard, 'Nome,E-mail\nConfirmação incerta,uncertain@example.invalid\n'); await configure(wizard); await validate(wizard); await confirm(wizard)
  await expect(wizard.getByRole('alert')).toContainText(/interrompida/i)
  await expect(wizard).toContainText('0 leads confirmados no banco')
  await expect(wizard.getByText('Importação confirmada no banco', { exact: true })).toHaveCount(0)
  expect(state.importedRows).toHaveLength(1)
  state.malformedImport = false
  await wizard.getByRole('button', { name: /Tentar novamente/ }).click()
  await expect(wizard).toContainText('Importação confirmada no banco')
  expect(state.importedRows).toHaveLength(1)
  expect(state.requests.filter(request => request.rpc === 'import_external_leads')).toHaveLength(2)
})

test('malformed legacy JSON is rejected without changing existing leads or calling either importer', async ({ page }) => {
  const state = await mountSmartImport(page), original = structuredClone(state.feature.leads), wizard = await openSmartImport(page)
  await wizard.getByLabel('Selecionar arquivo CSV, Excel ou JSON').setInputFiles({ name: 'quebrado.json', mimeType: 'application/json', buffer: Buffer.from('{"leads": [quebrado') })
  await wizard.getByLabel('Confirmo a importação para esta empresa e pipeline.', { exact: true }).check()
  await wizard.getByRole('button', { name: 'Importar backup JSON', exact: true }).click()
  await expect(wizard.getByRole('alert')).toBeVisible()
  expect(state.feature.leads).toEqual(original); expect(state.requests).toHaveLength(0)
})

test('a second confirmation click and Escape cannot duplicate or hide an in-flight first commit', async ({ page }) => {
  const state = await mountSmartImport(page), wizard = await openSmartImport(page)
  await upload(wizard, 'Nome,E-mail\nClique protegido,one-commit@example.invalid\n'); await configure(wizard); await validate(wizard)
  const release = holdSmartImport(state)
  try {
    await confirm(wizard); await expect.poll(() => state.batchCalls).toBe(1)
    await wizard.getByRole('button', { name: 'Importar registros válidos', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click() })
    await page.keyboard.press('Escape'); await expect(wizard).toBeVisible()
    expect(state.batchCalls).toBe(1); expect(state.importedRows).toHaveLength(0)
    release(); await expect(wizard).toContainText('Importação confirmada no banco')
    expect(state.importedRows).toHaveLength(1)
  } finally { release() }
})

for (const scopeChange of ['workspace', 'logout'] as const) test(`late preview after ${scopeChange} cannot restore prior-company data or enable a write`, async ({ page }) => {
  const state = createSmartImportState(), release = holdSmartPreview(state)
  try {
    await mountSmartImport(page, 'admin', { state, twoWorkspaces: true }); const wizard = await openSmartImport(page)
    await upload(wizard, 'Nome,E-mail\nArquivo privado da empresa A,scope-a@example.invalid\n'); await configure(wizard)
    await wizard.getByRole('button', { name: 'Validar registros', exact: true }).click()
    await expect.poll(() => state.requests.filter(request => request.rpc === 'preview_import_leads').length).toBe(1)
    if (scopeChange === 'workspace') {
      await page.getByLabel('Selecionar empresa', { exact: true }).selectOption(workspaceB, { force: true })
      await expect(page.locator('.workspace-selector')).toContainText('Segunda Empresa')
    } else {
      await page.evaluate(async () => {
        const modulePath = '/src/lib/supabase.ts'
        const auth = await import(modulePath)
        const { error } = await auth.requireSupabase().auth.signOut({ scope: 'local' })
        if (error) throw error
      })
      await expect(page.getByRole('button', { name: 'Entrar no meu workspace', exact: true })).toBeVisible()
    }
    await expect(wizard).toHaveCount(0)
    release()
    await expect(page.getByRole('dialog', { name: 'Importar leads', exact: true })).toHaveCount(0)
    await expect(page.getByText('Arquivo privado da empresa A', { exact: true })).toHaveCount(0)
    expect(state.requests.filter(request => request.rpc === 'import_external_leads')).toHaveLength(0)
    expect(state.importedRows).toHaveLength(0)
    if (scopeChange === 'workspace') {
      const fresh = await openSmartImport(page)
      await expect(fresh).toContainText('Segunda Empresa')
      await expect(fresh.getByRole('button', { name: 'Continuar', exact: true })).toBeDisabled()
      await expect(fresh.getByText('Arquivo privado da empresa A', { exact: true })).toHaveCount(0)
    }
    expect(state.feature.errors).toEqual([])
  } finally { release() }
})

for (const scopeChange of ['workspace', 'logout'] as const) test(`${scopeChange} during a pending commit stops later batches and keeps prior-company results out of the UI`, async ({ page }) => {
  const state = createSmartImportState(), release = holdSmartImport(state)
  try {
    await mountSmartImport(page, 'admin', { state, twoWorkspaces: true }); const wizard = await openSmartImport(page)
    await upload(wizard, 'Nome,E-mail\n' + Array.from({ length: 600 }, (_, index) => `Arquivo empresa A ${index + 1},cancel-${index}@example.invalid`).join('\n'))
    await configure(wizard); await validate(wizard); await confirm(wizard)
    await expect.poll(() => state.batchCalls).toBe(1)
    if (scopeChange === 'workspace') {
      await page.getByLabel('Selecionar empresa', { exact: true }).selectOption(workspaceB, { force: true })
      await expect(page.locator('.workspace-selector')).toContainText('Segunda Empresa')
    } else {
      await page.evaluate(async () => {
        const modulePath = '/src/lib/supabase.ts'
        const auth = await import(modulePath)
        const { error } = await auth.requireSupabase().auth.signOut({ scope: 'local' })
        if (error) throw error
      })
      await expect(page.getByRole('button', { name: 'Entrar no meu workspace', exact: true })).toBeVisible()
    }
    await expect(wizard).toHaveCount(0)
    // Cancellation cannot undo a server commit already accepted. The fixture
    // confirms that first batch while the aborted client must stop batch two.
    release(); await expect.poll(() => state.importedRows.length).toBe(500)
    await expect(page.getByText('Importação confirmada no banco', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Arquivo empresa A 1', { exact: true })).toHaveCount(0)
    await expect.poll(() => state.batchCalls).toBe(1)
    expect(state.requests.filter(request => request.rpc === 'import_external_leads')).toHaveLength(1)
    expect(state.importedRows.every(row => row.lead.name.startsWith('Arquivo empresa A'))).toBe(true)
    expect(state.feature.errors).toEqual([])
  } finally { release() }
})

for (const file of [{ name: 'vazio.csv', text: '' }, { name: 'quebrado.xlsx', text: 'não é Excel' }, { name: 'antigo.xls', text: 'legado' }]) {
  test(`invalid or unsupported file ${file.name} is rejected with a clear error`, async ({ page }) => {
    const state = await mountSmartImport(page), wizard = await openSmartImport(page)
    await wizard.getByLabel('Selecionar arquivo CSV, Excel ou JSON').setInputFiles(csvUpload(file.text, file.name))
    await expect(wizard.getByRole('alert')).toBeVisible()
    expect(state.requests).toHaveLength(0); expect(state.importedRows).toHaveLength(0)
  })
}

test('XLSX allows selecting the correct worksheet and preserves numeric money, Excel datetime and blank cells', async ({ page }) => {
  const state = await mountSmartImport(page), wizard = await openSmartImport(page)
  await wizard.getByLabel('Selecionar arquivo CSV, Excel ou JSON').setInputFiles({ name: 'abas.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: buildImportWorkbook({ sheets: [{ name: 'Arquivo antigo', rows: [['Nome'], ['Não importar desta aba']] }, { name: 'Leads clientes', rows: [['Nome', 'E-mail', 'Ticket', 'Data da call', 'Empresa'], ['Lead Excel', 'excel@example.invalid', 12345.67, new Date('2026-10-12T17:30:00.000Z'), null]] }] }) })
  await wizard.getByLabel(/Aba da planilha/).selectOption('Leads clientes')
  await wizard.getByRole('button', { name: 'Continuar', exact: true }).click()
  await configure(wizard); await validate(wizard); await confirm(wizard)
  await expect.poll(() => state.importedRows.length).toBe(1)
  expect(state.importedRows[0].lead.name).toBe('Lead Excel'); expect(state.importedRows[0].lead.company).toBe('')
  expect(state.importedRows[0].lead.ticket).toBe(12345.67); expect(state.importedRows[0].lead.callDate).toBe('2026-10-12T20:30:00.000Z')
  expect(state.importedRows[0].lead.attendance).toBe('Pendente')
})

test('HIGH CLOSER legacy JSON backup path preserves existing IDs and does not use external import RPCs', async ({ page }) => {
  const state = await mountSmartImport(page), existing = structuredClone(state.feature.leads[0].data)
  const fresh = { ...existing, id: '90000000-0000-4000-8000-000000000001', name: 'Backup JSON preservado' }
  const wizard = await openSmartImport(page)
  await wizard.getByLabel('Selecionar arquivo CSV, Excel ou JSON').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 1, leads: [{ ...existing, name: 'NÃO SOBRESCREVER' }, fresh] })) })
  await expect(wizard).toContainText(/backup|JSON/i)
  await wizard.getByLabel('Confirmo a importação para esta empresa e pipeline.', { exact: true }).check()
  await wizard.getByRole('button', { name: /Importar backup JSON|Importar backup/ }).click()
  await expect.poll(() => state.legacyRows.length).toBe(1)
  expect(state.feature.leads.find(lead => lead.id === existing.id)!.data).toEqual(existing)
  expect(state.legacyRows[0].name).toBe('Backup JSON preservado')
  expect(state.requests.filter(request => request.rpc !== 'import_leads')).toHaveLength(0)
})

test('direct legacy JSON action restores 2001 valid leads in original 1000-row RPC batches', async ({ page }) => {
  const state = await mountSmartImport(page), template = structuredClone(state.feature.leads[0].data)
  const leads = Array.from({ length: 2001 }, (_, index) => ({ ...template,
    id: `91000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, name: `Backup grande ${index + 1}` }))
  await page.getByRole('button', { name: 'Configurações', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Seu workspace', exact: true })
  const chosen = page.waitForEvent('filechooser')
  await settings.getByRole('button', { name: 'Importar backup JSON', exact: true }).click()
  await (await chosen).setFiles({ name: 'backup-grande.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 1, leads })) })
  await expect.poll(() => state.legacyRows.length, { timeout: 30_000 }).toBe(2001)
  await expect(page.locator('.nav-count')).toHaveText('2003')
  expect(state.requests.map(request => request.rpc)).toEqual(['import_leads', 'import_leads', 'import_leads'])
  expect(new Set(state.legacyRows.map(lead => lead.id)).size).toBe(2001)
  expect(state.feature.errors).toEqual([])
})

for (const role of ['closer', 'viewer'] as const) test(`${role} cannot start an external CRM import and retains its previous JSON permissions`, async ({ page }) => {
  const state = await mountSmartImport(page, role)
  await page.getByRole('button', { name: 'Configurações', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Seu workspace', exact: true })
  const trigger = settings.getByRole('button', { name: 'Importar leads', exact: true })
  if (role === 'closer') {
    await expect(trigger).toBeVisible()
    const selected = page.waitForEvent('filechooser')
    await trigger.click()
    expect((await selected).isMultiple()).toBe(false)
    await expect(page.getByRole('dialog', { name: 'Importar leads', exact: true })).toHaveCount(0)
    await expect(settings.locator('input[type="file"]')).toHaveAttribute('accept', 'application/json,.json')
  } else await expect(trigger).toHaveCount(0)
  expect(state.requests).toHaveLength(0)
})

test('Master without company membership has no import or customer CRM access', async ({ page }) => {
  const state = await mountMaster(page)
  await openMasterCompany(page)
  await expect(page.getByRole('button', { name: /Importar leads|Importar CSV|Exportar backup/ })).toHaveCount(0)
  expect(state.unexpected).toEqual([])
  expect(state.requests.some(request => /import_external_leads|preview_import_leads|\/leads/.test(request.path))).toBe(false)
})

for (const theme of ['light', 'dark'] as const) for (const width of [1366, 390]) test(`${theme} ${width}px wizard stays legible and responsive across all five steps`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
  const state = await mountSmartImport(page, 'admin', { theme }), wizard = await openSmartImport(page)
  const directory = '/workspace/closer-os-artifacts/smart-import-visual'
  await mkdir(directory, { recursive: true })
  const capture = (step: string) => wizard.screenshot({ path: `${directory}/${theme}-${width}-${step}.png`, animations: 'disabled' })
  await accessiblePage(page, wizard)
  await expect(page.locator('.crm-visual')).toHaveAttribute('data-theme', theme)
  await capture('01-arquivo')
  await expect(wizard.getByRole('link', { name: 'Baixar modelo CSV', exact: true })).toHaveAttribute('href', /modelo-importacao-leads\.csv/)
  await upload(wizard, 'Nome,E-mail,Empresa\nCliente visual,visual@example.invalid,Empresa de consultoria comercial\n'); await accessiblePage(page, wizard); await capture('02-campos')
  await configure(wizard); await accessiblePage(page, wizard); await capture('03-destinos')
  await validate(wizard); await accessiblePage(page, wizard); await capture('04-previa')
  await wizard.getByRole('button', { name: 'Ir para confirmação', exact: true }).click(); await accessiblePage(page, wizard); await capture('05-confirmacao')
  await expect(wizard.getByRole('button', { name: 'Importar registros válidos', exact: true })).toBeDisabled()
  await wizard.getByLabel('Confirmo a importação para esta empresa e pipeline.', { exact: true }).check()
  await wizard.getByRole('button', { name: 'Importar registros válidos', exact: true }).click()
  await expect.poll(() => state.importedRows.length).toBe(1)
  await expect(wizard).toContainText('Importação confirmada no banco')
  await capture('06-resultado')
  await accessiblePage(page, wizard)
  expect(state.feature.errors).toEqual([])
})

test('downloadable CSV template has Portuguese headers and imports using safe pending defaults', async ({ page }) => {
  const state = await mountSmartImport(page), wizard = await openSmartImport(page)
  const template = await readFile(new URL('../public/modelo-importacao-leads.csv', import.meta.url), 'utf8')
  await upload(wizard, template, 'modelo-importacao-leads.csv'); await configure(wizard); await validate(wizard); await confirm(wizard)
  await expect.poll(() => state.importedRows.length).toBe(1)
  expect(state.importedRows[0].lead.attendance).toBe('Pendente'); expect(state.importedRows[0].lead.closedValue).toBe(0)
  expect(state.importedRows[0].lead.callDate).toBe(''); expect(state.importedRows[0].lead.callScore).toBeNull()
})
