import type { LeadStatus, StageType } from '../../src/types'

export interface StageRow {
  id: string
  pipeline_id: string
  name: string
  position: number
  color: string
  type: StageType
  active: boolean
  lead_count: number
}

// Deliberately independent of the implementation's demo stages: these fixtures
// represent the database RPC contract with durable, workspace-scoped UUIDs.
const names: LeadStatus[] = ['Lead novo', 'Qualificado', 'Call agendada', 'Compareceu', 'Follow-up', 'Fechado', 'Perdido']
const colors = ['#afa3ce', '#9581c4', '#7194d6', '#d3a064', '#b67fc3', '#4e9e80', '#bf818a']
export function defaultStageRows(workspaceId: string): StageRow[] {
  const suffix = workspaceId.replace(/-/g, '').slice(-8)
  return names.map((name, index) => ({
    id: `10000000-0000-4000-8000-${suffix}${String(index).padStart(4, '0')}`,
    pipeline_id: `20000000-0000-4000-8000-${suffix}0000`,
    name, position: index, color: colors[index],
    type: name === 'Fechado' ? 'WON' : name === 'Perdido' ? 'LOST' : 'NORMAL',
    active: true, lead_count: 0,
  }))
}
export function stageForLegacyStatus(workspaceId: string, status: LeadStatus): StageRow {
  return defaultStageRows(workspaceId).find(stage => stage.name === status)!
}
