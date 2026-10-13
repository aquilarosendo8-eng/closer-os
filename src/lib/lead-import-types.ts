import type { Lead, Stage } from '../types'

export const IMPORT_LIMITS = { fileBytes: 10 * 1024 * 1024, rows: 10000, columns: 100, cellCharacters: 10000, sheets: 20, expandedBytes: 64 * 1024 * 1024, batchRows: 500, batchBytes: 900 * 1024 } as const
export type ImportCell = string | number | boolean | Date | null
export interface ParsedImportFile {
  fileName: string
  fileHash: string
  format: 'csv' | 'xlsx'
  sheets: string[]
  sheetName: string
  headers: string[]
  rows: { rowNumber: number; values: ImportCell[] }[]
}
export type ImportField = 'name' | 'company' | 'email' | 'phone' | 'source' | 'ticket' | 'stage' | 'owner' | 'callDate' | 'attendance' | 'objection' | 'notes' | 'pain' | 'urgency' | 'financialCapacity' | 'decisionMaker' | 'closedValue' | 'lossReason' | 'lossComment' | 'createdAt' | 'closedAt' | 'lastContactAt' | 'sourceId'
export type ColumnMapping = Record<number, ImportField | 'ignore' | 'notes-extra'>
export interface ImportOptions {
  stages: Stage[]
  members: { userId: string; displayName: string; email?: string; role?: string; active?: boolean }[]
  defaultStageId: string
  defaultOwnerId: string
  stageMap: Record<string, string>
  ownerMap: Record<string, string>
  timeZone: string
  numericFormat?: 'br' | 'international' | 'auto'
  dateFormat?: 'br' | 'iso'
  sourceNamespace?: string
}
export interface ImportRecord { rowNumber: number; rowKey: string; ownerId: string; stageId: string; lead: Lead; sourceId?: string }
export interface ImportRowError { rowNumber: number; field?: ImportField; message: string }
export interface PreparedImportRow { rowNumber: number; lead?: Lead; ownerId?: string; stageId?: string; status: 'valid' | 'duplicate' | 'conflict' | 'error'; errors: string[] }
export interface PreparedImport {
  records: ImportRecord[]
  rows: PreparedImportRow[]
  errors: ImportRowError[]
  duplicates: number
  conflicts: number
  total: number
  missingEssential: number
  unmappedStages: number
  unmappedOwners: number
}
export interface ImportBackendRow { rowNumber: number; status: 'new' | 'duplicate' | 'conflict' | 'error'; code?: string }
/** Read-only virtual preview state contains hashes, never commercial cell values. */
export interface ImportPreviewContext {
  workspaceId: string
  entries: { id: string; rowKey: string; sourceHash: string | null; emailHash: string | null; phoneHash: string | null }[]
}
export interface ImportPreview { results: ImportBackendRow[]; newCount: number; duplicateCount: number; conflictCount: number; errorCount: number }
export interface ImportProgress { processed: number; total: number; imported: number; skipped: number; conflicts: number }
export type ImportResult = ImportProgress
