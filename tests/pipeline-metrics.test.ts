import { describe, expect, it } from 'vitest'
import type { Lead } from '../src/types'
import { createDemoLeads } from '../src/lib/data'
import { getMetrics, getMonthlyPerformance, getPeriodLeads, isStale, weeklyEvolution } from '../src/lib/analytics'
import { defaultPipelineStages, isLost, isWon, stageLead } from '../src/lib/pipeline'

const now = new Date(2026, 9, 7, 12)
const base = createDemoLeads(now)[0]
const record = (fields: Partial<Lead>): Lead => ({ ...base, ...fields })

describe('metrics follow the canonical stage type', () => {
  it('counts renamed WON stages without depending on the legacy status or name', () => {
    const win = record({ status: 'Lead novo', stageId: 'contract', stageName: 'Contrato assinado', stageType: 'WON', closedValue: 42000, attendance: 'Pendente' })
    const open = record({ status: 'Fechado', stageId: 'proposal', stageName: 'Fechado', stageType: 'NORMAL', closedValue: 90000, attendance: 'Compareceu' })
    expect(getMetrics([win, open])).toMatchObject({ revenue: 42000, closed: 1, attended: 2, closeRate: 50, averageTicket: 42000 })
    expect(isWon(open)).toBe(false)
  })

  it('does not classify an opportunity by a misleading terminal stage name', () => {
    expect(isLost(record({ status: 'Perdido', stageType: 'NORMAL', stageName: 'Perdido' }))).toBe(false)
    expect(isLost(record({ status: 'Follow-up', stageType: 'LOST', stageName: 'Encerrado sem contrato' }))).toBe(true)
    expect(isWon(record({ status: 'Fechado', stageType: 'LOST', stageName: 'Fechado' }))).toBe(false)
  })

  it('keeps all legacy demonstration metrics after mapping to stage IDs', () => {
    const stages = defaultPipelineStages()
    const original = createDemoLeads(now)
    const mapped = original.map(lead => stageLead(lead, stages.find(stage => stage.name === lead.status)!))
    expect(getMetrics(mapped)).toEqual(getMetrics(original))
    expect(getMonthlyPerformance(mapped, now)).toEqual(getMonthlyPerformance(original, now))
  })

  it('uses the closing date for renamed won stages', () => {
    const win = record({ status: 'Follow-up', stageType: 'WON', stageName: 'Pagamento confirmado', closedAt: '2026-10-02T12:00:00Z', callDate: '2026-09-20T12:00:00Z', closedValue: 12300 })
    expect(getPeriodLeads([win], 'month', now)).toEqual([win])
    expect(getMonthlyPerformance([win], now).at(-1)).toMatchObject({ revenue: 12300, closed: 1 })
  })

  it('excludes renamed terminal stages from stale alerts while preserving open leads', () => {
    const common = { lastContactAt: '2026-09-01T12:00:00Z', stageName: 'Personalizado', status: 'Follow-up' as const }
    expect(isStale(record({ ...common, stageType: 'WON' }), now)).toBe(false)
    expect(isStale(record({ ...common, stageType: 'LOST' }), now)).toBe(false)
    expect(isStale(record({ ...common, stageType: 'NORMAL' }), now)).toBe(true)
  })

  it('counts typed won stages in weekly results even with a pending legacy attendance', () => {
    const win = record({ status: 'Lead novo', stageType: 'WON', callDate: '2026-10-06T12:00:00Z', attendance: 'Pendente', callScore: 0 })
    expect(weeklyEvolution([win], now).at(-1)).toMatchObject({ calls: 1, closed: 1, score: 0 })
  })
})
