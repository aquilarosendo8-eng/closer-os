import { describe, expect, it } from 'vitest'
import { makeLead } from '../src/components/LeadForm'
import { isImportContactReference } from '../src/lib/import-date-reference'
describe('unknown imported contact date', () => {
  it('identifies the technical fallback only while it still equals the server import instant', () => {
    const stamp = '2026-10-13T00:00:00.000Z'
    const lead = { ...makeLead(), lastContactAt: stamp, importMetadata: { createdAtSource: 'import' as const, lastContactAtSource: 'import' as const, importedAt: '2026-10-13T00:00:00+00:00' } }
    expect(isImportContactReference(lead)).toBe(true)
    expect(isImportContactReference({ ...lead, lastContactAt: '2026-10-13T01:00:00.000Z' })).toBe(false)
    expect(isImportContactReference({ ...lead, importMetadata: { ...lead.importMetadata, lastContactAtSource: 'provided' } })).toBe(false)
  })
  it('leaves legacy/manual leads unchanged and rejects invalid provenance', () => {
    expect(isImportContactReference(makeLead())).toBe(false)
    expect(isImportContactReference({ ...makeLead(), importMetadata: { createdAtSource: 'import', lastContactAtSource: 'import', importedAt: 'invalid' } })).toBe(false)
  })
})
