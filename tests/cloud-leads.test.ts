import { beforeEach, describe, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ pages: [] as Array<{ data: unknown[] | null; error: unknown }>, ranges: [] as number[][], workspaces: [] as string[] }))
vi.mock('../src/lib/supabase', () => ({ requireSupabase: () => ({ from: (table: string) => {
  if (table !== 'leads') throw new Error('Unexpected table')
  const query = { select: () => query, eq: (column: string, workspace: string) => { if (column !== 'workspace_id') throw new Error('Unexpected filter'); fake.workspaces.push(workspace); return query }, order: () => query,
    range: (first: number, last: number) => { fake.ranges.push([first, last]); return Promise.resolve(fake.pages.shift() || { data: [], error: null }) } }
  return query
} }) }))
import { listCloudLeadRows } from '../src/lib/cloud-leads'
const rows = (start: number, count: number) => Array.from({ length: count }, (_, index) => ({ id: `lead-${start + index}`, owner_id: 'owner', stage_id: 'stage', data: { index: start + index } }))
beforeEach(() => { fake.pages = []; fake.ranges = []; fake.workspaces = [] })
describe('CRM hydration after large imports', () => {
  it('loads all 2,001 records in bounded tenant-filtered pages rather than stopping at the REST default', async () => {
    fake.pages = [0, 500, 1000, 1500].map(start => ({ data: rows(start, 500), error: null }))
    fake.pages.push({ data: rows(2000, 1), error: null })
    const result = await listCloudLeadRows('company-a')
    expect(result).toHaveLength(2001)
    expect(new Set(result.map(row => row.id)).size).toBe(2001)
    expect(fake.ranges).toEqual([[0,499],[500,999],[1000,1499],[1500,1999],[2000,2499]])
    expect(fake.workspaces).toEqual(Array(5).fill('company-a'))
  })
  it('stops after a short page and propagates a later permission failure without returning an incomplete successful base', async () => {
    fake.pages = [{ data: rows(0, 20), error: null }]
    expect(await listCloudLeadRows('company-a')).toHaveLength(20)
    fake.pages = [{ data: rows(0, 500), error: null }, { data: null, error: new Error('Acesso revogado') }]
    await expect(listCloudLeadRows('company-a')).rejects.toThrow('Acesso revogado')
  })
  it('rejects a repeated full page instead of looping forever or inflating the dashboard count', async () => {
    fake.pages = [{ data: rows(0, 500), error: null }, { data: rows(0, 500), error: null }]
    await expect(listCloudLeadRows('company-a')).rejects.toThrow('alterada durante o carregamento')
  })
})
