import { expect, type Page } from '@playwright/test'
import { createFeatureState, memberIds, mountFeatures, workspaceA, workspaceB, type FeatureState, type FixtureRole } from './features'
import type { Lead } from '../../src/types'
import { createHash } from 'node:crypto'

type ImportRow = { rowNumber: number; rowKey: string; stageId: string; ownerId: string; lead: Lead; sourceId?: string }
type ImportStatus = 'new' | 'duplicate' | 'conflict' | 'error'
type ContextEntry = { id: string; rowKey: string; sourceHash: string | null; emailHash: string | null; phoneHash: string | null }
type PreviewContext = { workspaceId: string; entries: ContextEntry[] }
type Request = { rpc: string; body: { p_workspace_id?: string; p_records?: ImportRow[]; p_source_namespace?: string | null; p_context?: PreviewContext | null }; authenticated: boolean }
export interface SmartImportState {
  feature: FeatureState; requests: Request[]; importedRows: ImportRow[]; savedKeys: Set<string>
  previewStatuses: Record<number, { status: ImportStatus; code?: string }>
  failPreview: boolean; failImportBatch: number | null; batchCalls: number; importGate: Promise<void> | null
  previewGate: Promise<void> | null; malformedPreview: boolean; malformedImport: boolean; malformedContext: boolean
  legacyRows: Lead[]; unexpected: string[]
}
export function createSmartImportState(): SmartImportState {
  return { feature: createFeatureState(), requests: [], importedRows: [], savedKeys: new Set(), previewStatuses: {},
    failPreview: false, failImportBatch: null, batchCalls: 0, importGate: null, previewGate: null,
    malformedPreview: false, malformedImport: false, malformedContext: false, legacyRows: [], unexpected: [] }
}
export function holdSmartPreview(state: SmartImportState): () => void {
  let release!: () => void
  state.previewGate = new Promise<void>(resolve => { release = resolve })
  return () => { state.previewGate = null; release() }
}
export function holdSmartImport(state: SmartImportState): () => void {
  let release!: () => void
  state.importGate = new Promise<void>(resolve => { release = resolve })
  return () => { state.importGate = null; release() }
}

// Browser fixture only: it models SDK contracts, progress and failure messages.
// Real transactionality, RLS, concurrency and workspace isolation are proven by
// the independent PostgreSQL suite, never by these simulated HTTP responses.
export async function mountSmartImport(page: Page, role: FixtureRole = 'admin', options: { state?: SmartImportState; theme?: 'light' | 'dark'; twoWorkspaces?: boolean } = {}) {
  const state = options.state || createSmartImportState()
  await mountFeatures(page, role, { state: state.feature, theme: options.theme, twoWorkspaces: options.twoWorkspaces })
  await page.route('https://test.supabase.co/auth/v1/logout*', route => route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } }))
  await page.route('https://test.supabase.co/rest/v1/leads*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (request.method() !== 'GET') { await route.fallback(); return }
    state.feature.requests.push({ path: url.pathname, method: request.method(), query: url.search, body: null })
    const workspace = url.searchParams.get('workspace_id')?.replace(/^eq\./, '')
    if (![workspaceA, ...(options.twoWorkspaces ? [workspaceB] : [])].includes(workspace || '')) {
      state.unexpected.push('Unscoped lead refresh'); await route.fulfill({ status: 403, contentType: 'application/json', body: '{"message":"Empresa inválida."}' }); return
    }
    const range = request.headers().range?.match(/^(\d+)-(\d+)$/)
    const offset = Number(url.searchParams.get('offset') || range?.[1] || 0)
    const limit = Number(url.searchParams.get('limit') || (range ? Number(range[2]) - offset + 1 : 1000))
    const rows = state.feature.leads.filter(row => row.workspace_id === workspace && (role !== 'closer' || row.owner_id === memberIds.closer))
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(rows.slice(offset, offset + limit)) })
  })
  await page.route('https://test.supabase.co/rest/v1/rpc/*', async route => {
    const request = route.request(), rpc = new URL(request.url()).pathname.split('/').at(-1)!
    if (!['preview_import_leads', 'import_external_leads', 'import_leads'].includes(rpc)) { await route.fallback(); return }
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } }); return }
    const body = request.postDataJSON() as Request['body'] & { p_leads?: Lead[] }
    state.requests.push({ rpc, body, authenticated: /^Bearer .+/.test(request.headers().authorization || '') })
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(value) })
    if (body.p_workspace_id !== workspaceA || !['admin', 'manager'].includes(role) && rpc !== 'import_leads') {
      state.unexpected.push(`Forbidden import request from ${role}`); await json({ code: '42501', message: 'Você não tem permissão para importar nesta empresa.' }, 403); return
    }
    if (rpc === 'import_leads') {
      const records = body.p_leads || [], existing = new Set(state.feature.leads.map(row => row.id))
      const added = records.filter(lead => !existing.has(lead.id))
      state.legacyRows.push(...added)
      for (const data of added) state.feature.leads.push({ id: data.id, workspace_id: workspaceA, owner_id: memberIds[role], stage_id: state.feature.stages[workspaceA].find(stage => stage.name === data.status)?.id || state.feature.stages[workspaceA][0].id, data })
      await json({ imported: added.length, skipped: records.length - added.length }); return
    }
    const records = body.p_records || []
    if (records.length > 500) { state.unexpected.push('Oversized frontend batch'); await json({ code: '22023', message: 'Lote excede o limite.' }, 400); return }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const emailHash = (value: string) => value.trim() ? hash(value.trim().toLowerCase()) : null
    const phoneHash = (value: string) => value.replace(/\D/g, '') ? hash(value.replace(/\D/g, '')) : null
    const sourceHash = (row: ImportRow) => row.sourceId && body.p_source_namespace ? hash(`${body.p_source_namespace}:${row.sourceId}`) : null
    const identity = (id: string) => hash(`${workspaceA}:${id}`)
    const classify = (row: ImportRow, context: ContextEntry[] = []) => {
      const override = state.previewStatuses[row.rowNumber]
      if (override) return { ...override, id: identity(row.rowKey) }
      if (state.savedKeys.has(row.rowKey)) return { status: 'duplicate' as const, code: 'ALREADY_IMPORTED', id: identity(row.lead.id) }
      const matches = new Set<string>(), email = emailHash(row.lead.email), phone = phoneHash(row.lead.phone), source = sourceHash(row)
      for (const existing of state.feature.leads.filter(lead => lead.workspace_id === workspaceA)) {
        if (email && email === emailHash(existing.data.email) || phone && phone === phoneHash(existing.data.phone)) matches.add(identity(existing.id))
      }
      for (const candidate of context) {
        if (candidate.rowKey === row.rowKey || email && email === candidate.emailHash || phone && phone === candidate.phoneHash || source && source === candidate.sourceHash) matches.add(candidate.id)
      }
      if (matches.size > 1) return { status: 'conflict' as const, code: 'IDENTITY_CONFLICT', id: identity(row.lead.id) }
      if (matches.size === 1) return { status: 'duplicate' as const, code: 'EXISTING_IDENTITY', id: [...matches][0] }
      return { status: 'new' as const, id: identity(row.lead.id) }
    }
    if (rpc === 'preview_import_leads') {
      if (state.previewGate) await state.previewGate
      if (state.failPreview) { await json({ message: 'A conferência no banco está indisponível. Tente novamente.' }, 503); return }
      const entries = structuredClone(body.p_context?.entries || [])
      const results = records.map(row => {
        const classification = classify(row, entries)
        if (classification.status === 'new' || classification.status === 'duplicate') entries.push({ id: classification.id, rowKey: row.rowKey,
          sourceHash: sourceHash(row), emailHash: classification.status === 'new' ? emailHash(row.lead.email) : null,
          phoneHash: classification.status === 'new' ? phoneHash(row.lead.phone) : null })
        return { rowNumber: row.rowNumber, status: classification.status, ...('code' in classification ? { code: classification.code } : {}) }
      })
      await json({ new: results.filter(row => row.status === 'new').length, duplicate: results.filter(row => row.status === 'duplicate').length,
        conflict: results.filter(row => row.status === 'conflict').length, error: results.filter(row => row.status === 'error').length,
        results: state.malformedPreview ? results.slice(1) : results,
        context: { workspaceId: state.malformedContext ? workspaceB : workspaceA, entries } }); return
    }
    state.batchCalls++
    if (state.importGate) await state.importGate
    if (state.failImportBatch === state.batchCalls) { await json({ code: 'PGRST000', message: 'O banco está temporariamente indisponível. Tente novamente.' }, 503); return }
    const results = records.map(row => {
      const classification = classify(row)
      if (classification.status === 'duplicate' || classification.status === 'conflict') return { rowNumber: row.rowNumber, status: classification.status, ...('code' in classification ? { code: classification.code } : {}) }
      state.savedKeys.add(row.rowKey); state.importedRows.push(structuredClone(row))
      state.feature.leads.push({ id: row.lead.id, workspace_id: workspaceA, owner_id: row.ownerId, stage_id: row.stageId, data: structuredClone(row.lead) })
      return { rowNumber: row.rowNumber, status: 'imported' as const }
    })
    await json({ imported: results.filter(row => row.status === 'imported').length + (state.malformedImport ? 1 : 0), skipped: results.filter(row => row.status === 'duplicate').length,
      conflicts: results.filter(row => row.status === 'conflict').length, results })
  })
  return state
}
export async function openSmartImport(page: Page) {
  const menu = page.getByRole('button', { name: 'Abrir menu', exact: true })
  if (await menu.isVisible() && !await page.locator('.sidebar').evaluate(element => element.classList.contains('open'))) await menu.click()
  await page.getByRole('button', { name: 'Configurações', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Seu workspace', exact: true })
  await settings.getByRole('button', { name: 'Importar leads', exact: true }).click()
  const wizard = page.getByRole('dialog', { name: 'Importar leads', exact: true })
  await expect(wizard).toBeVisible()
  return wizard
}
export const csvUpload = (text: string, name = 'migracao.csv') => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8') })
