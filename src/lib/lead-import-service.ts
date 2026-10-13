import { requireSupabase } from './supabase'
import { validLead } from './validation'
import { IMPORT_LIMITS, type ImportBackendRow, type ImportPreview, type ImportPreviewContext, type ImportProgress, type ImportRecord, type ImportResult } from './lead-import-types'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SHA256 = /^[a-f0-9]{64}$/
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const uncertain = () => new Error('Não foi possível confirmar o resultado no banco. Revise a prévia e repita a operação com o mesmo arquivo; os registros já importados serão preservados.')
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export class LeadImportInterruptedError extends Error implements ImportProgress {
  imported: number; skipped: number; conflicts: number; processed: number; total: number
  constructor(progress: ImportProgress, cancelled = false) {
    super(`${cancelled ? 'Importação interrompida.' : 'Não foi possível confirmar o lote atual no banco.'} ${progress.imported} leads novos confirmados nos lotes anteriores; ${progress.skipped} duplicados ignorados e ${progress.conflicts} conflitos. Repita com o mesmo arquivo para continuar com segurança. O lote atual pode ter sido concluído sem confirmação da conexão.`)
    this.name = 'LeadImportInterruptedError'
    this.imported = progress.imported; this.skipped = progress.skipped; this.conflicts = progress.conflicts; this.processed = progress.processed; this.total = progress.total
  }
}

function checkedRecords(workspaceId: string, records: ImportRecord[], namespace?: string): void {
  if (!UUID.test(workspaceId)) throw new Error('Selecione a empresa de destino da importação.')
  if (!Array.isArray(records) || records.length > IMPORT_LIMITS.rows) throw new Error('Importe até 10.000 leads por arquivo.')
  if (namespace !== undefined && (!namespace.trim() || namespace.length > 120 || /[\u0000-\u001f\u007f-\u009f]/u.test(namespace))) throw new Error('Informe um sistema/conta de origem válido para usar identificadores externos.')
  const rows = new Set<number>(), keys = new Set<string>()
  for (const record of records) {
    if (!record || !Number.isSafeInteger(record.rowNumber) || record.rowNumber <= 0 || record.rowNumber > 100000 || rows.has(record.rowNumber) || !SHA256.test(record.rowKey) || keys.has(record.rowKey)
      || !UUID.test(record.ownerId) || !UUID.test(record.stageId) || !validLead(record.lead) || record.lead.id !== `import-${record.rowKey}` || record.lead.stageId !== record.stageId
      || record.lead.leadershipReview !== undefined || record.lead.callScore !== null || record.lead.closerError !== '' || record.lead.callSummary !== '' || (record.lead.recordingUrl !== undefined && record.lead.recordingUrl !== '')
      || (record.sourceId !== undefined && (!namespace || typeof record.sourceId !== 'string' || !record.sourceId.trim() || record.sourceId.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(record.sourceId)))) throw new Error('Revise os registros, etapas e responsáveis antes de importar.')
    rows.add(record.rowNumber); keys.add(record.rowKey)
  }
}

/** Bound both record count and actual UTF-8 transport size; never preload existing customer leads. */
export function importBatches(records: ImportRecord[]): ImportRecord[][] {
  const batches: ImportRecord[][] = []; let batch: ImportRecord[] = [], bytes = 2
  const encoder = new TextEncoder()
  for (const record of records) {
    const size = encoder.encode(JSON.stringify(record)).byteLength + 1
    if (size + 2 > IMPORT_LIMITS.batchBytes) throw new Error(`Linha ${record.rowNumber}: o registro é grande demais para um lote seguro. Reduza as observações.`)
    if (batch.length && (batch.length >= IMPORT_LIMITS.batchRows || bytes + size > IMPORT_LIMITS.batchBytes)) { batches.push(batch); batch = []; bytes = 2 }
    batch.push(record); bytes += size
  }
  if (batch.length) batches.push(batch)
  return batches
}

function backendRows(value: unknown, records: ImportRecord[], imported = false): ImportBackendRow[] {
  if (!Array.isArray(value) || value.length !== records.length) throw uncertain()
  const expected = new Set(records.map(record => record.rowNumber)), found = new Set<number>()
  return value.map(row => {
    if (!object(row) || !Number.isSafeInteger(row.rowNumber) || !expected.has(row.rowNumber as number) || found.has(row.rowNumber as number)
      || !(imported ? ['imported', 'duplicate', 'conflict'] : ['new', 'duplicate', 'conflict', 'error']).includes(String(row.status))
      || (row.code !== undefined && (typeof row.code !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(row.code)))) throw uncertain()
    found.add(row.rowNumber as number)
    return { rowNumber: row.rowNumber as number, status: row.status === 'imported' ? 'new' : row.status as ImportBackendRow['status'], ...(row.code ? { code: row.code as string } : {}) }
  })
}

function previewContext(value: unknown, workspaceId: string): ImportPreviewContext {
  if (!object(value) || Object.keys(value).some(key => !['workspaceId', 'entries'].includes(key)) || value.workspaceId !== workspaceId
    || !Array.isArray(value.entries) || value.entries.length > IMPORT_LIMITS.rows || new TextEncoder().encode(JSON.stringify(value)).byteLength > 4 * 1024 * 1024) throw uncertain()
  const rows = new Set<string>()
  const entries = value.entries.map(entry => {
    if (!object(entry) || Object.keys(entry).some(key => !['id', 'rowKey', 'sourceHash', 'emailHash', 'phoneHash'].includes(key))
      || typeof entry.id !== 'string' || !SHA256.test(entry.id) || typeof entry.rowKey !== 'string' || !SHA256.test(entry.rowKey) || rows.has(entry.rowKey)
      || ['sourceHash', 'emailHash', 'phoneHash'].some(key => entry[key] !== null && (typeof entry[key] !== 'string' || !SHA256.test(entry[key] as string)))) throw uncertain()
    rows.add(entry.rowKey)
    return { id: entry.id, rowKey: entry.rowKey, sourceHash: entry.sourceHash as string | null, emailHash: entry.emailHash as string | null, phoneHash: entry.phoneHash as string | null }
  })
  return { workspaceId, entries }
}

export const leadImportService = {
  async preview(workspaceId: string, records: ImportRecord[], namespace?: string, onProgress?: (progress: ImportProgress) => void, signal?: AbortSignal): Promise<ImportPreview> {
    checkedRecords(workspaceId, records, namespace)
    const result: ImportPreview = { results: [], newCount: 0, duplicateCount: 0, conflictCount: 0, errorCount: 0 }
    let context: ImportPreviewContext | null = null
    for (const batch of importBatches(records)) {
      if (signal?.aborted) throw new Error('Prévia cancelada. Selecione a empresa e revise novamente antes de importar.')
      try {
        let query = requireSupabase().rpc('preview_import_leads', { p_workspace_id: workspaceId, p_records: batch, p_source_namespace: namespace?.trim() || null, p_context: context })
        if (signal) query = query.abortSignal(signal)
        const { data, error } = await query
        if (error || !object(data)) throw uncertain()
        const rows = backendRows(data.results, batch)
        if (['new', 'duplicate', 'conflict', 'error'].some(status => !count(data[status]) || rows.filter(row => row.status === status).length !== data[status])) throw uncertain()
        context = previewContext(data.context, workspaceId)
        result.results.push(...rows)
        for (const row of rows) {
          if (row.status === 'new') result.newCount++
          else if (row.status === 'duplicate') result.duplicateCount++
          else if (row.status === 'conflict') result.conflictCount++
          else result.errorCount++
        }
        onProgress?.({ processed: result.results.length, total: records.length, imported: 0, skipped: result.duplicateCount, conflicts: result.conflictCount })
      } catch { throw new Error('Não foi possível validar a prévia no banco. Confira seu acesso, conexão e os mapeamentos e tente novamente.') }
    }
    return result
  },
  async import(workspaceId: string, records: ImportRecord[], namespace?: string, onProgress?: (progress: ImportProgress) => void, signal?: AbortSignal): Promise<ImportResult> {
    checkedRecords(workspaceId, records, namespace)
    const progress: ImportProgress = { processed: 0, total: records.length, imported: 0, skipped: 0, conflicts: 0 }
    for (const batch of importBatches(records)) {
      if (signal?.aborted) throw new LeadImportInterruptedError(progress, true)
      try {
        let query = requireSupabase().rpc('import_external_leads', { p_workspace_id: workspaceId, p_records: batch, p_source_namespace: namespace?.trim() || null })
        if (signal) query = query.abortSignal(signal)
        const { data, error } = await query
        if (error || !object(data) || !count(data.imported) || !count(data.skipped) || !count(data.conflicts) || data.imported + data.skipped + data.conflicts !== batch.length) throw uncertain()
        const rows = backendRows(data.results, batch, true)
        if (rows.filter(row => row.status === 'new').length !== data.imported || rows.filter(row => row.status === 'duplicate').length !== data.skipped || rows.filter(row => row.status === 'conflict').length !== data.conflicts) throw uncertain()
        progress.imported += data.imported; progress.skipped += data.skipped; progress.conflicts += data.conflicts; progress.processed += batch.length
        onProgress?.({ ...progress })
      } catch { throw new LeadImportInterruptedError(progress, Boolean(signal?.aborted)) }
    }
    return { ...progress }
  },
}
