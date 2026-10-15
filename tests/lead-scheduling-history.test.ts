import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Lead } from '../src/types'
import { createDemoLeads } from '../src/lib/data'
import { hasSchedulingEvidence, preserveFirstScheduling } from '../src/lib/lead-scheduling-history'
import { defaultPipelineStages, transitionLead } from '../src/lib/pipeline'
import { validLead } from '../src/lib/validation'

const now = new Date('2026-10-15T12:00:00Z')
const firstAppointment = '2026-10-20T14:00:00Z'
function lead(patch: Partial<Lead> = {}): Lead {
  return { ...createDemoLeads(now)[0], id: 'booking-test', status: 'Lead novo', stageId: undefined, stageType: undefined,
    stageName: undefined, closedValue: 0, closedAt: '', attendance: 'Pendente', callDate: '', ...patch }
}
afterEach(() => vi.useRealTimers())

describe('first scheduling persistence', () => {
  it('does not invent a booking for a received lead or an ordinary update', () => {
    const received = lead()
    expect(preserveFirstScheduling(received)).toBe(received)
    expect(preserveFirstScheduling({ ...received, pain: 'Qualificação inicial' }, received)).not.toHaveProperty('firstScheduledAt')
    expect(hasSchedulingEvidence(received)).toBe(false)
  })

  it('records the first actual save instant, independently from the appointment and lead entry dates', () => {
    const received = lead({ createdAt: '2026-09-20T12:00:00Z' })
    const scheduled = preserveFirstScheduling({ ...received, callDate: firstAppointment }, received, now.getTime())
    expect(scheduled).toMatchObject({ createdAt: received.createdAt, callDate: firstAppointment, firstScheduledAt: now.toISOString(), hasBeenScheduled: true })
    expect(received).not.toHaveProperty('firstScheduledAt')
    expect(hasSchedulingEvidence(scheduled)).toBe(true)
  })

  it('also records a newly created manual lead whose call date is already supplied', () => {
    const scheduled = preserveFirstScheduling(lead({ callDate: firstAppointment }), undefined, now.getTime())
    expect(scheduled.firstScheduledAt).toBe(now.toISOString())
    expect(scheduled.hasBeenScheduled).toBe(true)
  })

  it('preserves the first booking through repeated reschedules, clearing, attendance and stage changes', () => {
    const received = lead()
    const scheduled = preserveFirstScheduling({ ...received, callDate: firstAppointment }, received, now.getTime())
    let updated = scheduled
    for (const patch of [
      { callDate: '2026-10-22T15:00:00Z' }, { callDate: '2026-11-02T09:00:00Z' },
      { attendance: 'Compareceu' as const, status: 'Compareceu' as const },
      { attendance: 'Não compareceu' as const }, { status: 'Follow-up' as const },
      { status: 'Fechado' as const, closedValue: 25000, closedAt: '2026-11-03T10:00:00Z' },
      { status: 'Perdido' as const }, { callDate: '', hasBeenScheduled: false, firstScheduledAt: undefined },
    ]) {
      updated = preserveFirstScheduling({ ...updated, ...patch }, updated, now.getTime() + 86400000)
      expect(updated.firstScheduledAt).toBe(scheduled.firstScheduledAt)
      expect(hasSchedulingEvidence(updated)).toBe(true)
    }
  })

  it('does not replace the persisted first instant when a caller provides a different one', () => {
    const previous = lead({ firstScheduledAt: '2026-10-01T11:00:00Z', hasBeenScheduled: true })
    const updated = preserveFirstScheduling({ ...previous, firstScheduledAt: now.toISOString(), callDate: firstAppointment }, previous)
    expect(updated.firstScheduledAt).toBe(previous.firstScheduledAt)
  })

  it('retains a timestamp provided by a prior scheduling transition or a restored current-format backup', () => {
    const scheduled = lead({ firstScheduledAt: '2026-10-01T11:00:00Z', hasBeenScheduled: true, callDate: '' })
    expect(preserveFirstScheduling(scheduled, lead()).firstScheduledAt).toBe(scheduled.firstScheduledAt)
    const restored = JSON.parse(JSON.stringify(scheduled))
    expect(validLead(restored)).toBe(true)
    expect(hasSchedulingEvidence(restored)).toBe(true)
  })

  it('preserves proof from a legacy appointment without manufacturing when it was first booked', () => {
    const imported = lead({ callDate: '2026-08-02T14:00:00Z' })
    expect(hasSchedulingEvidence(imported)).toBe(true)
    const updated = preserveFirstScheduling({ ...imported, callDate: '' }, imported, now.getTime())
    expect(updated.hasBeenScheduled).toBe(true)
    expect(updated).not.toHaveProperty('firstScheduledAt')
    expect(hasSchedulingEvidence(updated)).toBe(true)
    const rescheduled = preserveFirstScheduling({ ...updated, callDate: firstAppointment }, updated, now.getTime())
    expect(rescheduled).not.toHaveProperty('firstScheduledAt')
    expect(rescheduled.hasBeenScheduled).toBe(true)
  })

  it.each(['Call agendada', 'Compareceu', 'Follow-up', 'Fechado', 'Perdido'] as const)('never infers booking solely from stage/status %s', status => {
    expect(hasSchedulingEvidence(lead({ status, attendance: status === 'Compareceu' ? 'Compareceu' : 'Pendente' }))).toBe(false)
  })

  it('stamps the scheduling transition and preserves it when the opportunity moves afterward', () => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const stages = defaultPipelineStages()
    const booked = transitionLead(lead(), stages[2], undefined, undefined, undefined, firstAppointment)
    expect(booked.firstScheduledAt).toBe(now.toISOString())
    expect(booked.hasBeenScheduled).toBe(true)
    vi.setSystemTime(now.getTime() + 3600000)
    const followUp = transitionLead(booked, stages[4])
    expect(followUp.firstScheduledAt).toBe(booked.firstScheduledAt)
    expect(transitionLead(followUp, stages[5], 25000).firstScheduledAt).toBe(booked.firstScheduledAt)
    expect(transitionLead(followUp, stages[6], undefined, 'Timing').firstScheduledAt).toBe(booked.firstScheduledAt)
  })

  it('keeps legacy scheduling transitions historical instead of setting the first time to today', () => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const oldLead = lead({ callDate: '2026-08-02T14:00:00Z' })
    const rescheduled = transitionLead(oldLead, defaultPipelineStages()[2], undefined, undefined, undefined, firstAppointment)
    expect(rescheduled).not.toHaveProperty('firstScheduledAt')
    expect(rescheduled.hasBeenScheduled).toBe(true)
  })
})

describe('booking history compatibility validation', () => {
  it('keeps old snapshots and current JSON backups valid without migration or mandatory metadata', () => {
    expect(validLead(lead())).toBe(true)
    expect(validLead(lead({ firstScheduledAt: now.toISOString(), hasBeenScheduled: true }))).toBe(true)
    expect(validLead(lead({ hasBeenScheduled: true }))).toBe(true)
    expect(validLead(lead({ hasBeenScheduled: false }))).toBe(true)
  })

  it.each(['', ' ', 'not-a-date', null, 1760533200000, true, {}])('rejects malformed optional booking timestamp %j', value => {
    expect(validLead({ ...lead(), firstScheduledAt: value })).toBe(false)
    expect(hasSchedulingEvidence({ ...lead(), firstScheduledAt: value } as Lead)).toBe(false)
  })

  it.each(['true', 1, null, {}])('rejects non-boolean historical proof %j', value => {
    expect(validLead({ ...lead(), hasBeenScheduled: value })).toBe(false)
    expect(hasSchedulingEvidence({ ...lead(), hasBeenScheduled: value } as Lead)).toBe(false)
  })
})
