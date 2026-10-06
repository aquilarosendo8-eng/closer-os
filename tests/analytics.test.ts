import { describe, expect, it } from 'vitest'
import type { Lead } from '../src/types'
import { getMetrics, getMonthlyPerformance, getPeriodLeads, isStale, topObjections, weeklyEvolution } from '../src/lib/analytics'
import { createDemoLeads } from '../src/lib/data'

const now = new Date(2026, 9, 6, 12)
const base = createDemoLeads(now)[0]
const lead = (overrides: Partial<Lead> = {}): Lead => ({ ...base, status: 'Lead novo', attendance: 'Pendente', closedValue: 0, closedAt: '', callDate: '', callScore: null, ...overrides })

describe('conversion metrics', () => {
  it('uses completed calls for show rate and attended calls for close rate', () => {
    const metrics = getMetrics([
      lead({ status: 'Fechado', attendance: 'Pendente', closedValue: 20_000 }),
      lead({ status: 'Perdido', attendance: 'Compareceu' }),
      lead({ status: 'Follow-up', attendance: 'Compareceu' }),
      lead({ status: 'Perdido', attendance: 'Não compareceu' }),
      lead({ status: 'Call agendada' }),
      lead(),
    ])
    expect(metrics.attended).toBe(3)
    expect(metrics.showRate).toBe(75)
    expect(metrics.closeRate).toBeCloseTo(100 / 3)
    expect(metrics.qualified).toBe(4)
    expect(metrics.revenue).toBe(20_000)
    expect(metrics.averageTicket).toBe(20_000)
  })

  it('does not divide by zero or count open proposed tickets as revenue', () => {
    expect(getMetrics([])).toMatchObject({ revenue: 0, closed: 0, closeRate: 0, showRate: 0, averageTicket: 0 })
    expect(getMetrics([lead({ status: 'Follow-up', ticket: 50_000, closedValue: 50_000 })]).revenue).toBe(0)
  })

  it('provides a fresh demonstration month with consistent revenue', () => {
    const demo = createDemoLeads(now)
    const metrics = getMetrics(getPeriodLeads(demo, 'month', now))
    expect(demo).toHaveLength(38)
    expect(new Set(demo.map(item => item.id)).size).toBe(38)
    expect(metrics).toMatchObject({ revenue: 148_000, closed: 8, attended: 14, averageTicket: 18_500 })
    expect(metrics.showRate).toBeCloseTo(14 / 17 * 100)
  })
})

describe('periods and stale follow-up', () => {
  it('filters on closure date and includes the entire current month', () => {
    const current = lead({ status: 'Fechado', closedAt: new Date(2026, 9, 1).toISOString(), callDate: new Date(2026, 8, 29).toISOString() })
    const upcoming = lead({ callDate: new Date(2026, 9, 31, 23, 59).toISOString() })
    const nextMonth = lead({ callDate: new Date(2026, 10, 1).toISOString() })
    const previous = lead({ callDate: new Date(2026, 8, 30, 23, 59).toISOString() })
    expect(getPeriodLeads([current, upcoming, nextMonth, previous], 'month', now)).toEqual([current, upcoming])
    expect(getPeriodLeads([current, previous], 'quarter', now)).toEqual([current, previous])
  })

  it('handles a rolling three-month period across the year boundary', () => {
    const january = new Date(2027, 0, 6)
    const november = lead({ createdAt: new Date(2026, 10, 1).toISOString() })
    const october = lead({ createdAt: new Date(2026, 9, 31).toISOString() })
    expect(getPeriodLeads([november, october], 'quarter', january)).toEqual([november])
  })

  it('turns red strictly after five elapsed days and excludes final stages', () => {
    const fiveDays = new Date(now.getTime() - 5 * 86_400_000).toISOString()
    const sixDays = new Date(now.getTime() - 6 * 86_400_000).toISOString()
    expect(isStale(lead({ lastContactAt: fiveDays }), now)).toBe(false)
    expect(isStale(lead({ lastContactAt: sixDays }), now)).toBe(true)
    expect(isStale(lead({ status: 'Fechado', lastContactAt: sixDays }), now)).toBe(false)
    expect(isStale(lead({ status: 'Perdido', lastContactAt: sixDays }), now)).toBe(false)
    expect(isStale(lead({ lastContactAt: '', createdAt: sixDays }), now)).toBe(true)
  })
})

describe('performance aggregates', () => {
  it('provides six months and uses each month’s actual denominator', () => {
    const records = [
      lead({ status: 'Fechado', closedAt: new Date(2026, 8, 30).toISOString(), closedValue: 18_000 }),
      lead({ status: 'Follow-up', attendance: 'Compareceu', callDate: new Date(2026, 8, 15).toISOString() }),
      lead({ status: 'Fechado', closedAt: new Date(2026, 9, 1).toISOString(), closedValue: 24_000 }),
    ]
    const months = getMonthlyPerformance(records, now)
    expect(months).toHaveLength(6)
    expect(months[4]).toMatchObject({ month: 'Set', revenue: 18_000, closeRate: 50, qualified: 2, closed: 1 })
    expect(months[5]).toMatchObject({ month: 'Out', revenue: 24_000, closeRate: 100, closed: 1 })
    expect(months[0].revenue).toBe(0)
  })

  it('combines capitalization variants and excludes empty objections', () => {
    expect(topObjections([
      lead({ objection: 'Investimento' }), lead({ objection: ' investimento ' }),
      lead({ objection: 'Tempo' }), lead({ objection: '' }), lead({ objection: 'Sem objeção' }),
    ])).toEqual([{ name: 'Investimento', count: 2 }, { name: 'Tempo', count: 1 }])
  })

  it('counts attended meetings and averages rated calls, preserving zero scores', () => {
    const monday = new Date(2026, 9, 5, 10).toISOString()
    const records = [
      lead({ callDate: monday, attendance: 'Compareceu', callScore: 0 }),
      lead({ callDate: monday, status: 'Fechado', callScore: 10 }),
      lead({ callDate: monday, attendance: 'Compareceu', callScore: null }),
      lead({ callDate: monday, attendance: 'Pendente', callScore: 9 }),
    ]
    expect(weeklyEvolution(records, now).at(-1)).toEqual({ week: '05/10', score: 5, calls: 3, closed: 1 })
  })
})
