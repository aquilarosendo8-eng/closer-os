import { describe, expect, it } from 'vitest'
import type { Lead } from '../src/types'
import { getBookingMetrics, getMetrics, getPeriodLeads, getReceivedPeriodLeads } from '../src/lib/analytics'
import { createDemoLeads } from '../src/lib/data'

const now = new Date(2026, 9, 15, 12)
const timestamp = (month: number, day = 5) => new Date(2026, month - 1, day, 12).toISOString()
const base = createDemoLeads(now)[0]
let sequence = 0
const lead = (overrides: Partial<Lead> = {}): Lead => ({
  ...base, id: `booking-${++sequence}`, status: 'Lead novo', stageType: 'NORMAL', attendance: 'Pendente',
  createdAt: timestamp(10), callDate: '', closedAt: '', closedValue: 0, ...overrides,
})

describe('received-cohort scheduling conversion', () => {
  it('distinguishes no received leads from a real zero conversion rate', () => {
    expect(getBookingMetrics([], 'month', now)).toEqual({ received: 0, scheduled: 0, rate: null, previousRate: null })
    expect(getBookingMetrics([lead()], 'month', now)).toEqual({ received: 1, scheduled: 0, rate: 0, previousRate: null })
  })

  it.each([
    ['pending', { status: 'Call agendada', attendance: 'Pendente' }],
    ['attended', { status: 'Compareceu', attendance: 'Compareceu' }],
    ['no-show', { status: 'Follow-up', attendance: 'Não compareceu' }],
    ['won', { status: 'Fechado', stageType: 'WON', closedValue: 18000 }],
    ['lost', { status: 'Perdido', stageType: 'LOST' }],
    ['reopened', { status: 'Lead novo', stageType: 'NORMAL' }],
  ] as [string, Partial<Lead>][])('counts a previously scheduled %s lead once independently of pipeline position', (_name, changes) => {
    const booked = lead({ callDate: timestamp(10), firstScheduledAt: timestamp(9), hasBeenScheduled: true, ...changes })
    expect(getBookingMetrics([booked, lead()], 'month', now)).toMatchObject({ received: 2, scheduled: 1, rate: 50 })
  })

  it('does not infer scheduling from stage, attendance or a sale without date evidence', () => {
    expect(getBookingMetrics([
      lead({ status: 'Call agendada' }), lead({ attendance: 'Compareceu' }),
      lead({ status: 'Fechado', stageType: 'WON', closedValue: 18000 }), lead({ callDate: 'invalid' }),
    ], 'month', now)).toMatchObject({ received: 4, scheduled: 0, rate: 0 })
  })

  it('counts valid old and imported call dates without creating a historical first-booking timestamp', () => {
    const imported = lead({ callDate: timestamp(11), importMetadata: { createdAtSource: 'provided', lastContactAtSource: 'import', importedAt: timestamp(10) } })
    const original = structuredClone(imported)
    expect(getBookingMetrics([imported], 'month', now)).toMatchObject({ received: 1, scheduled: 1, rate: 100 })
    expect(imported).toEqual(original)
    expect(imported.firstScheduledAt).toBeUndefined()
  })

  it('retains known scheduling after callDate was cleared or replaced by several reschedules', () => {
    expect(getBookingMetrics([
      lead({ callDate: '', firstScheduledAt: timestamp(9) }),
      lead({ callDate: '', hasBeenScheduled: true }),
      lead({ callDate: timestamp(12), firstScheduledAt: timestamp(10), hasBeenScheduled: true }),
    ], 'month', now)).toMatchObject({ received: 3, scheduled: 3, rate: 100 })
  })

  it('does not count duplicate representations of the same lead twice', () => {
    const item = lead({ callDate: timestamp(10) })
    expect(getBookingMetrics([item, structuredClone(item), lead()], 'month', now)).toMatchObject({ received: 2, scheduled: 1, rate: 50 })
  })

  it('uses creation cohorts when call and closing dates fall in different periods', () => {
    const receivedThisMonth = lead({ callDate: timestamp(11) })
    const receivedLastMonth = lead({ createdAt: timestamp(9), callDate: timestamp(10) })
    const closedThisMonth = lead({ createdAt: timestamp(9), callDate: timestamp(9), closedAt: timestamp(10), status: 'Fechado', stageType: 'WON', closedValue: 20000 })
    const records = [receivedThisMonth, receivedLastMonth, closedThisMonth, lead()]
    expect(getReceivedPeriodLeads(records, 'month', now)).toEqual([receivedThisMonth, records[3]])
    expect(getPeriodLeads(records, 'month', now)).toEqual([receivedLastMonth, closedThisMonth, records[3]])
    expect(getBookingMetrics(records, 'month', now)).toEqual({ received: 2, scheduled: 1, rate: 50, previousRate: 100 })
  })

  it('accumulates later bookings in the original cohort without moving or duplicating received leads', () => {
    const received = lead({ createdAt: timestamp(9) })
    expect(getBookingMetrics([received], 'month', now)).toMatchObject({ received: 0, scheduled: 0, previousRate: 0 })
    const scheduledLater = { ...received, firstScheduledAt: timestamp(10), callDate: timestamp(11) }
    expect(getBookingMetrics([scheduledLater], 'month', now)).toMatchObject({ received: 0, scheduled: 0, previousRate: 100 })
    expect(getBookingMetrics([scheduledLater], 'quarter', now)).toMatchObject({ received: 1, scheduled: 1, rate: 100, previousRate: null })
  })

  it('uses a rolling received quarter and a separate all-time base', () => {
    const records = [lead(), lead({ createdAt: timestamp(9), callDate: timestamp(11) }), lead({ createdAt: timestamp(8) }), lead({ createdAt: timestamp(7), hasBeenScheduled: true })]
    expect(getBookingMetrics(records, 'month', now)).toEqual({ received: 1, scheduled: 0, rate: 0, previousRate: 100 })
    expect(getBookingMetrics(records, 'quarter', now)).toMatchObject({ received: 3, scheduled: 1, previousRate: null })
    expect(getBookingMetrics(records, 'quarter', now).rate).toBeCloseTo(100 / 3)
    expect(getBookingMetrics(records, 'all', now)).toEqual({ received: 4, scheduled: 2, rate: 50, previousRate: null })
  })

  it('keeps unknown legacy entry dates out of dated cohorts and includes them in all-time totals', () => {
    const records = [lead({ createdAt: '', callDate: timestamp(10) }), lead({ createdAt: 'invalid' }), lead()]
    expect(getBookingMetrics(records, 'month', now)).toMatchObject({ received: 1, scheduled: 0, rate: 0 })
    expect(getBookingMetrics(records, 'all', now)).toMatchObject({ received: 3, scheduled: 1 })
  })

  it('includes the start and excludes the next month and handles the year boundary', () => {
    const january = new Date(2027, 0, 15)
    const start = lead({ createdAt: new Date(2027, 0, 1).toISOString(), hasBeenScheduled: true })
    const end = lead({ createdAt: new Date(2027, 1, 1).toISOString() })
    const december = lead({ createdAt: new Date(2026, 11, 31, 23, 59).toISOString() })
    const november = lead({ createdAt: new Date(2026, 10, 1).toISOString() })
    expect(getReceivedPeriodLeads([start, end, december, november], 'month', january)).toEqual([start])
    expect(getBookingMetrics([start, end, december, november], 'month', january)).toMatchObject({ received: 1, scheduled: 1, previousRate: 0 })
    expect(getReceivedPeriodLeads([start, end, december, november], 'quarter', january)).toEqual([start, december, november])
  })

  it('only calculates from the permission-scoped collection supplied by the existing data layer', () => {
    const own = [lead({ hasBeenScheduled: true }), lead()]
    const otherOwner = [lead(), lead()]
    expect(getBookingMetrics(own, 'month', now)).toMatchObject({ received: 2, scheduled: 1, rate: 50 })
    expect(getBookingMetrics([...own, ...otherOwner], 'month', now)).toMatchObject({ received: 4, scheduled: 1, rate: 25 })
  })

  it('leaves existing show, no-show, closing, revenue and ticket formulas unchanged', () => {
    const records = [
      lead({ attendance: 'Compareceu', callDate: timestamp(10) }),
      lead({ attendance: 'Não compareceu', callDate: timestamp(10) }),
      lead({ status: 'Fechado', stageType: 'WON', closedValue: 18000, attendance: 'Pendente', callDate: timestamp(10) }),
      lead({ status: 'Call agendada', callDate: timestamp(10) }), lead(),
    ]
    const before = getMetrics(records)
    getBookingMetrics(records, 'month', now)
    const withHistory = records.map(item => ({ ...item, hasBeenScheduled: true, firstScheduledAt: timestamp(10) }))
    expect(getMetrics(withHistory)).toEqual(before)
    expect(before).toMatchObject({ attended: 2, missed: 1, closed: 1, closeRate: 50, revenue: 18000, averageTicket: 18000 })
    expect(before.showRate).toBeCloseTo(200 / 3)
    expect(before.noShowRate).toBeCloseTo(100 / 3)
  })
})
