import { requireSupabase } from './supabase'

export interface CloudLeadRow { id: string; owner_id: string; stage_id: string; data: unknown }

/** CRM hydration only. Import duplicate checks use their own authorized database RPC. */
export async function listCloudLeadRows(workspaceId: string): Promise<CloudLeadRow[]> {
  const rows: CloudLeadRow[] = []
  const client = requireSupabase()
  const seen = new Set<string>()
  for (let offset = 0; ; offset += 500) {
    const result = await client.from('leads').select('id,owner_id,data,stage_id')
      .eq('workspace_id', workspaceId).order('created_at', { ascending: false }).order('id', { ascending: false })
      .range(offset, offset + 499)
    if (result.error) throw result.error
    if (!Array.isArray(result.data)) throw new Error('Não foi possível confirmar os registros da empresa.')
    let fresh = 0
    for (const row of result.data) {
      if (seen.has(row.id)) continue
      seen.add(row.id); rows.push(row); fresh += 1
    }
    if (result.data.length < 500) return rows
    if (fresh === 0) throw new Error('A lista de oportunidades foi alterada durante o carregamento. Atualize para tentar novamente.')
  }
}
