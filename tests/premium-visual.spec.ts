import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { createOpportunityState, mountOpportunity, navigateOpportunity, openOpportunity, opportunityLeadIds } from './fixtures/opportunity'

const phase = process.env.HIGH_CLOSER_VISUAL_PHASE === 'before' ? 'before' : 'after'
const directory = `/workspace/closer-os-artifacts/premium-visual/${phase}`
async function capture(page: Page, name: string) {
  await page.evaluate(async () => { await document.fonts.ready })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  await mkdir(directory, { recursive: true })
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true, animations: 'disabled' })
}
for (const theme of ['light', 'dark'] as const) for (const width of [1366, 390]) {
  test(`${theme} ${width}px long contact identity stays inside the opportunity viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    const state = createOpportunityState(), lead = state.leads.find(row => row.id === opportunityLeadIds.ana)!
    lead.data.name = 'Alexandre de Albuquerque e Vasconcelos '.repeat(4).trim()
    lead.data.company = 'Consultoria comercial e desenvolvimento de operações nacionais '.repeat(2).trim()
    lead.data.email = 'responsavel.pelas.operacoes.comerciais.nacionais@empresa-de-consultoria.example.invalid'
    const original = JSON.stringify(lead)
    await mountOpportunity(page, 'viewer', { state, theme })
    const detail = await openOpportunity(page, lead.data.name)
    await expect(detail.getByRole('heading', { name: `Oportunidade de ${lead.data.name}`, exact: true })).toBeVisible()
    const bounds = await detail.boundingBox()
    expect(bounds).not.toBeNull(); expect(bounds!.y).toBeGreaterThanOrEqual(-1)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1)
    await capture(page, `${theme}-${width}-long-contact`)
    expect(JSON.stringify(lead)).toBe(original); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([])
  })
}
for (const theme of ['light', 'dark'] as const) for (const width of [1366, 1440, 820, 390]) {
  test(`${theme} ${width}px consistent workspaces and long opportunity content`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : width === 820 ? 1180 : 900 })
    const state = createOpportunityState()
    const lead = state.leads.find(row => row.id === opportunityLeadIds.ana)!
    const notes = 'Faturamento mensal: R$ 300.000 por mês\nInstagram: https://www.instagram.com/empresa_teste/\nFaixa de investimento: Entre R$ 15.000 e R$ 30.000\nInvestimento mínimo: R$ 15.000\nSobre a empresa: ' + 'Operação nacional com vendas consultivas e participação de dois decisores. '.repeat(6) + '\n\nConfirmar aprovação do sócio e disponibilidade para o próximo encontro.'
    lead.data.notes = notes
    lead.data.email = 'contato.comercial.operacoes.nacionais@empresa-de-consultoria.example.invalid'
    const original = JSON.stringify(state.leads)
    await mountOpportunity(page, 'admin', { state, theme })
    if (phase === 'after') {
      expect(await page.locator('.crm-visual').evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14)
      // Auth/public still consume the original root tokens, not the private override.
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--control-height-touch').trim())).toBe('40px')
    }
    // The shared opportunity fixture does not serve these two Admin reads.
    // Add only their empty, read-only responses; every mutation stays denied.
    for (const name of ['list_invitations', 'list_audit']) await page.route(`**/rest/v1/rpc/${name}`, route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '[]' }))
    const prefix = `${theme}-${width}`
    for (const name of ['Dashboard', 'Pipeline', 'Calls', 'Atividades', 'Performance'] as const) {
      await navigateOpportunity(page, name)
      await capture(page, `${prefix}-${name.toLowerCase()}`)
    }
    const detail = await openOpportunity(page)
    await capture(page, `${prefix}-lead-overview`)
    const qualification = detail.getByRole('region', { name: 'Qualificação do lead' })
    await qualification.scrollIntoViewIfNeeded()
    await expect(qualification.getByText('R$ 300.000 por mês', { exact: true })).toBeVisible()
    await expect(detail.locator('.l360-detail dd').filter({ hasText: lead.data.email })).toHaveText(lead.data.email)
    await capture(page, `${prefix}-qualification`)
    for (const name of ['Calls', 'Timeline']) {
      await detail.getByRole('tab', { name: new RegExp(`^${name}(?:\\s*\\d+)?$`) }).click()
      await capture(page, `${prefix}-lead-${name.toLowerCase()}`)
    }
    await detail.getByRole('button', { name: 'Fechar oportunidade', exact: true }).click()
    await page.locator('.cloud-context-bar').getByRole('button', { name: 'Administrar', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Equipe', exact: true })).toBeVisible()
    await capture(page, `${prefix}-administration`)
    await page.getByRole('button', { name: 'Convidar pessoa', exact: true }).click()
    const invitation = page.getByRole('dialog', { name: 'Convide alguém para a equipe', exact: true })
    await expect(invitation).toBeVisible(); await capture(page, `${prefix}-admin-form`)
    await invitation.getByRole('button', { name: /Fechar/ }).click()
    expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([])
    expect(JSON.stringify(state.leads)).toBe(original)
    expect(state.requests.filter(request => request.method !== 'GET' && request.path === '/rest/v1/leads' || /save_activity|set_activity_status|invite_member|save_pipeline_stages/.test(request.path))).toHaveLength(0)
  })
}
