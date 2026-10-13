import { beforeEach, describe, expect, it, vi } from 'vitest'
import { importBatches, LeadImportInterruptedError, leadImportService } from '../src/lib/lead-import-service'
import { IMPORT_LIMITS, type ImportProgress, type ImportRecord } from '../src/lib/lead-import-types'
import type { Lead } from '../src/types'

const mock = vi.hoisted(() => ({ rpc: vi.fn(), aborts: [] as AbortSignal[] }))
vi.mock('../src/lib/supabase', () => ({ requireSupabase: () => ({ rpc: mock.rpc }) }))
const workspace = '10000000-0000-4000-8000-000000000001', otherWorkspace = '10000000-0000-4000-8000-000000000002'
const owner = '30000000-0000-4000-8000-000000000003', stage = '40000000-0000-4000-8000-000000000004'
const hash = (value: number) => value.toString(16).padStart(64, '0')
function record(index: number, patch: Partial<Lead> = {}): ImportRecord {
  const rowKey = hash(index + 1)
  return { rowNumber: index + 2, rowKey, ownerId: owner, stageId: stage, lead: {
    id: `import-${rowKey}`, name: `Lead ${index}`, company: '', email: `lead${index}@example.invalid`, phone: '', ticket: 0, source: '', createdAt: '', callDate: '', attendance: 'Pendente', objection: '', status: 'Lead novo', closedValue: 0, closedAt: '', lastContactAt: '', notes: '', pain: '', urgency: 'Média', financialCapacity: 'Não avaliada', decisionMaker: false, callScore: null, closerError: '', callSummary: '', stageId: stage, stageType: 'NORMAL', stageName: 'Diagnóstico', lossReason: '', lossComment: '', ...patch,
  } }
}
const records = (count: number) => Array.from({ length: count }, (_, index) => record(index))
const context = (rows: ImportRecord[], workspaceId = workspace) => ({ workspaceId, entries: rows.map(row => ({ id: row.rowKey, rowKey: row.rowKey, sourceHash: null, emailHash: row.rowKey, phoneHash: null })) })
const preview = (rows: ImportRecord[], statuses = rows.map(() => 'new'), previous: ImportRecord[] = []) => ({
  new: statuses.filter(status => status === 'new').length, duplicate: statuses.filter(status => status === 'duplicate').length,
  conflict: statuses.filter(status => status === 'conflict').length, error: statuses.filter(status => status === 'error').length,
  results: rows.map((row, index) => ({ rowNumber: row.rowNumber, status: statuses[index] })), context: context([...previous, ...rows]),
})
const imported = (rows: ImportRecord[], statuses = rows.map(() => 'imported')) => ({
  imported: statuses.filter(status => status === 'imported').length, skipped: statuses.filter(status => status === 'duplicate').length,
  conflicts: statuses.filter(status => status === 'conflict').length, results: rows.map((row, index) => ({ rowNumber: row.rowNumber, status: statuses[index] })),
})
function query(value: { data: unknown; error: unknown }) {
  const promise = Promise.resolve(value)
  return Object.assign(promise, { abortSignal(signal: AbortSignal) { mock.aborts.push(signal); return promise } })
}
beforeEach(() => { mock.rpc.mockReset(); mock.aborts.length = 0 })

describe('bounded tenant import adapter', () => {
  it('previews 2,001 records in five row-bounded batches, continuing only opaque tenant preview context', async () => {
    const input = records(2001), calls: ImportRecord[] = [], updates: ImportProgress[] = []
    mock.rpc.mockImplementation((name, args) => {
      expect(name).toBe('preview_import_leads')
      const prior = [...calls]; calls.push(...args.p_records)
      return query({ data: preview(args.p_records, undefined, prior), error: null })
    })
    const result = await leadImportService.preview(workspace, input, undefined, update => updates.push(update))
    expect(result).toMatchObject({ newCount: 2001, duplicateCount: 0, conflictCount: 0, errorCount: 0 })
    expect(mock.rpc).toHaveBeenCalledTimes(5)
    expect(mock.rpc.mock.calls.map(([, args]) => args.p_records.length)).toEqual([500, 500, 500, 500, 1])
    expect(mock.rpc.mock.calls[0][1]).toEqual({ p_workspace_id: workspace, p_records: input.slice(0, 500), p_source_namespace: null, p_context: null })
    expect(mock.rpc.mock.calls[1][1].p_context).toEqual(context(input.slice(0, 500)))
    expect(JSON.stringify(mock.rpc.mock.calls[1][1].p_context)).not.toContain('example.invalid')
    expect(updates.map(update => update.processed)).toEqual([500, 1000, 1500, 2000, 2001])
  })
  it('bounds batches by UTF-8 bytes as well as rows for multibyte observations', () => {
    const input = records(500).map(row => ({ ...row, lead: { ...row.lead, notes: 'á'.repeat(10000) } }))
    const batches = importBatches(input)
    expect(batches.length).toBeGreaterThan(1)
    for (const batch of batches) expect(new TextEncoder().encode(JSON.stringify(batch)).byteLength).toBeLessThanOrEqual(IMPORT_LIMITS.batchBytes)
    expect(batches.flat()).toEqual(input)
  })
  it('rejects an individually oversized record before transmitting a request', async () => {
    await expect(leadImportService.import(workspace, [record(0, { notes: 'á'.repeat(500000) })])).rejects.toThrow('grande demais')
    expect(mock.rpc).not.toHaveBeenCalled()
  })
  it('keeps the selected workspace, explicit source namespace and all valid input records', async () => {
    const input = [record(0), { ...record(1), sourceId: '42' }]
    mock.rpc.mockReturnValue(query({ data: imported(input, ['duplicate', 'imported']), error: null }))
    const result = await leadImportService.import(workspace, input, '  pipedrive-client-a  ')
    expect(result).toMatchObject({ imported: 1, skipped: 1, conflicts: 0, total: 2, processed: 2 })
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('import_external_leads', { p_workspace_id: workspace, p_records: input, p_source_namespace: 'pipedrive-client-a' })
  })
  it.each(['bad-workspace', '', '10000000-0000-4000-8000'])('rejects invalid workspace %j without any request', async value => {
    await expect(leadImportService.import(value, [record(0)])).rejects.toThrow('empresa')
    expect(mock.rpc).not.toHaveBeenCalled()
  })
  it.each([
    () => [record(0), record(0)],
    () => [{ ...record(0), rowNumber: 100001 }],
    () => [{ ...record(0), rowKey: 'unsafe' }],
    () => [{ ...record(0), ownerId: 'master' }],
    () => [record(0, { stageId: otherWorkspace })],
    () => [record(0, { callScore: 10 })],
    () => [record(0, { closerError: 'fabricated' })],
    () => [record(0, { recordingUrl: 'https://example.invalid/recording' })],
    () => [record(0, { leadershipReview: { score: 10, feedback: 'fabricated', reviewedBy: owner, reviewerName: 'Manager', reviewedAt: '2026-10-12T10:00:00Z' } })],
    () => [{ ...record(0), sourceId: '42' }],
  ])('rejects invalid identities, protected data and unnamespaced IDs before a request (%#)', async input => {
    await expect(leadImportService.preview(workspace, input())).rejects.toThrow('Revise')
    expect(mock.rpc).not.toHaveBeenCalled()
  })
  it('does not query the server for an empty validated set', async () => {
    expect(await leadImportService.preview(workspace, [])).toEqual({ results: [], newCount: 0, duplicateCount: 0, conflictCount: 0, errorCount: 0 })
    expect(await leadImportService.import(workspace, [])).toEqual({ processed: 0, total: 0, imported: 0, skipped: 0, conflicts: 0 })
    expect(mock.rpc).not.toHaveBeenCalled()
  })
})

describe('confirmation, interruption and safe repetition', () => {
  it('returns only confirmed per-row statuses and count totals without provider commercial fields', async () => {
    const input = records(4), response = preview(input, ['new', 'duplicate', 'conflict', 'error'])
    response.results[3] = { ...response.results[3], code: 'OWNER_INVALID', email: 'private@example.invalid' } as typeof response.results[number]
    mock.rpc.mockReturnValue(query({ data: response, error: null }))
    const result = await leadImportService.preview(workspace, input)
    expect(result).toMatchObject({ newCount: 1, duplicateCount: 1, conflictCount: 1, errorCount: 1 })
    expect(result.results[3]).toEqual({ rowNumber: input[3].rowNumber, status: 'error', code: 'OWNER_INVALID' })
    expect(JSON.stringify(result)).not.toContain('private@example.invalid')
  })
  it.each([
    () => ({ ...preview([record(0)]), results: [] }),
    () => ({ ...preview([record(0)]), results: [{ rowNumber: 999, status: 'new' }] }),
    () => ({ ...preview([record(0)]), new: 2 }),
    () => ({ ...preview([record(0)]), new: '1' }),
    () => ({ ...preview([record(0)]), context: context([record(0)], otherWorkspace) }),
    () => ({ ...preview([record(0)]), context: { ...context([record(0)]), email: 'private@example.invalid' } }),
    () => ({ ...preview([record(0)]), context: { workspaceId: workspace, entries: [{ ...context([record(0)]).entries[0], emailHash: 'raw@example.invalid' }] } }),
    () => ({ ...preview([record(0)]), context: { workspaceId: workspace, entries: [...context([record(0)]).entries, ...context([record(0)]).entries] } }),
    () => ({ ...preview([record(0)]), context: undefined }),
  ])('fails closed on malformed or cross-tenant preview response (%#)', async response => {
    mock.rpc.mockReturnValue(query({ data: response(), error: null }))
    await expect(leadImportService.preview(workspace, [record(0)])).rejects.toThrow('validar a prévia')
    expect(mock.rpc).toHaveBeenCalledTimes(1)
  })
  it.each([
    () => ({ ...imported([record(0)]), results: [] }),
    () => ({ ...imported([record(0)]), imported: 2 }),
    () => ({ ...imported([record(0)]), results: [{ rowNumber: 2, status: 'duplicate' }] }),
    () => ({ ...imported([record(0)]), results: [{ rowNumber: 2, status: 'new' }] }),
    () => ({ ...imported([record(0)]), skipped: -1 }),
  ])('never reports successful writes from inconsistent import confirmations (%#)', async response => {
    mock.rpc.mockReturnValue(query({ data: response(), error: null }))
    const failure = await leadImportService.import(workspace, [record(0)]).catch(error => error)
    expect(failure).toBeInstanceOf(LeadImportInterruptedError)
    expect(failure).toMatchObject({ imported: 0, processed: 0, total: 1 })
  })
  it('reports earlier committed batches and safely retries a write whose network confirmation was lost', async () => {
    const input = records(1001), persisted = new Set<string>(), updates: ImportProgress[] = []
    let loseConfirmation = true
    mock.rpc.mockImplementation((name, args) => {
      expect(name).toBe('import_external_leads')
      const batch = args.p_records as ImportRecord[]
      const statuses = batch.map(row => persisted.has(row.rowKey) ? 'duplicate' : 'imported')
      batch.forEach(row => persisted.add(row.rowKey))
      if (loseConfirmation && persisted.size === 1000) { loseConfirmation = false; return query({ data: null, error: { message: 'network private@example.invalid' } }) }
      return query({ data: imported(batch, statuses), error: null })
    })
    const failure = await leadImportService.import(workspace, input, undefined, progress => updates.push(progress)).catch(error => error)
    expect(failure).toBeInstanceOf(LeadImportInterruptedError)
    expect(failure).toMatchObject({ imported: 500, skipped: 0, processed: 500, total: 1001 })
    expect(failure.message).not.toContain('private@example.invalid')
    expect(updates).toEqual([{ processed: 500, total: 1001, imported: 500, skipped: 0, conflicts: 0 }])
    const retry = await leadImportService.import(workspace, input)
    expect(retry).toMatchObject({ imported: 1, skipped: 1000, processed: 1001, total: 1001 })
    expect(persisted.size).toBe(1001)
  })
  it('cancels before any import request and preserves confirmed counts when cancelled between batches', async () => {
    const before = new AbortController(); before.abort()
    await expect(leadImportService.import(workspace, [record(0)], undefined, undefined, before.signal)).rejects.toMatchObject({ imported: 0, processed: 0 })
    expect(mock.rpc).not.toHaveBeenCalled()
    const between = new AbortController()
    mock.rpc.mockImplementation((_, args) => query({ data: imported(args.p_records), error: null }))
    const failure = await leadImportService.import(workspace, records(501), undefined, () => between.abort(), between.signal).catch(error => error)
    expect(failure).toBeInstanceOf(LeadImportInterruptedError)
    expect(failure).toMatchObject({ imported: 500, processed: 500, total: 501 })
    expect(mock.rpc).toHaveBeenCalledTimes(1)
    expect(mock.aborts).toEqual([between.signal])
  })
  it('leaves each published progress value immutable for accurate earlier-batch reporting', async () => {
    const updates: ImportProgress[] = []
    mock.rpc.mockImplementation((_, args) => query({ data: imported(args.p_records), error: null }))
    await leadImportService.import(workspace, records(501), undefined, progress => updates.push(progress))
    expect(updates.map(value => value.imported)).toEqual([500, 501])
    expect(updates[0]).not.toBe(updates[1])
  })
  it('passes an active abort signal to scoped preview requests', async () => {
    const controller = new AbortController(), input = [record(0)]
    mock.rpc.mockReturnValue(query({ data: preview(input), error: null }))
    await leadImportService.preview(workspace, input, undefined, undefined, controller.signal)
    expect(mock.aborts).toEqual([controller.signal])
  })
})
