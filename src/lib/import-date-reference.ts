import type { Lead } from '../types'

/** Missing source dates use an internal reference, never evidence of contact with a customer. */
export function isImportContactReference(lead: Lead): boolean {
  const metadata = lead.importMetadata
  if (!metadata || typeof metadata !== 'object' || metadata.lastContactAtSource !== 'import' || typeof metadata.importedAt !== 'string') return false
  const imported = Date.parse(metadata.importedAt), contact = Date.parse(lead.lastContactAt)
  return Number.isFinite(imported) && imported === contact
}
