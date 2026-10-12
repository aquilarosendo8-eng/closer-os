import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDemoLeads } from '../src/lib/data'
import { defaultPipelineStages, isSchedulingStage, transitionLead } from '../src/lib/pipeline'
import { callScheduleDate, futureCallDate, isUpcomingCall, localCallDateFields } from '../src/lib/call-scheduling'

const now = new Date(2026, 9, 12, 12, 0)
afterEach(() => vi.useRealTimers())

describe('scheduling stage identification', () => {
  it.each(['Agendado', 'Call agendada', '  AGENDADO  ', ' Call\tAgendada ', 'Agéndado'])('recognizes exactly %s in NORMAL stages', name => {
    expect(isSchedulingStage({ name, type: 'NORMAL' })).toBe(true)
  })
  it.each(['Reagendado', 'Agendados', 'Não agendado', 'Agendado - retorno', 'Call agendada cancelada', 'Call-agendada', 'Pré-call agendada'])('does not confuse %s with a scheduling stage', name => {
    expect(isSchedulingStage({ name, type: 'NORMAL' })).toBe(false)
  })
  it('uses the canonical terminal type even when its name is Agendado', () => {
    expect(isSchedulingStage({ name: 'Agendado', type: 'WON' })).toBe(false)
    expect(isSchedulingStage({ name: 'Call agendada', type: 'LOST' })).toBe(false)
  })
})

describe('schedule dates reuse local CRM dates without calendar normalization', () => {
  it('round-trips a local appointment to its persisted UTC timestamp', () => {
    const iso = callScheduleDate('2026-10-13', '09:35', now.getTime())
    expect(iso).toBe(new Date(2026, 9, 13, 9, 35).toISOString())
    expect(localCallDateFields(iso)).toEqual({ date: '2026-10-13', time: '09:35' })
  })
  it.each([['', '09:30'], ['2026-10-13', ''], ['', '']])('requires both date and time (%s,%s)', (date, time) => {
    expect(() => callScheduleDate(date, time, now.getTime())).toThrow('Informe a data e o horário')
  })
  it.each([['2026-02-30', '09:30'], ['2027-02-29', '09:30'], ['2026-13-01', '09:30'], ['2026-10-13', '25:00'], ['2026-10-13', '09:61'], ['2026-10-13', '9:30'], ['13/10/2026', '09:30']])('rejects an invalid calendar date or time (%s,%s)', (date, time) => {
    expect(() => callScheduleDate(date, time, now.getTime())).toThrow('válidos')
  })
  it('rejects past dates and the exact current instant, even if the day is today', () => {
    expect(() => callScheduleDate('2026-10-12', '11:59', now.getTime())).toThrow('futuros')
    expect(() => callScheduleDate('2026-10-12', '12:00', now.getTime())).toThrow('futuros')
    expect(callScheduleDate('2026-10-12', '12:01', now.getTime())).toBe(new Date(2026, 9, 12, 12, 1).toISOString())
  })
  it('does not prefill invalid or missing legacy dates', () => {
    expect(localCallDateFields('')).toEqual({ date: '', time: '' })
    expect(localCallDateFields('invalid')).toEqual({ date: '', time: '' })
    expect(() => futureCallDate('invalid', now.getTime())).toThrow('futuros')
  })
})

describe('schedule and stage are built together on the original opportunity', () => {
  it('sets the new stage, date and pending attendance while retaining existing call facts', () => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const lead = createDemoLeads(now).find(item => item.attendance === 'Compareceu')!
    const original = structuredClone(lead)
    const stage = { ...defaultPipelineStages()[2], name: 'Agendado' }
    const callDate = new Date(2026, 9, 14, 14, 15).toISOString()
    const next = transitionLead(lead, stage, undefined, undefined, undefined, callDate)
    expect(next).toMatchObject({ id: lead.id, stageId: stage.id, stageName: 'Agendado', callDate, attendance: 'Pendente', callScore: lead.callScore, callSummary: lead.callSummary, closerError: lead.closerError })
    expect(lead).toEqual(original)
  })
  it('rejects a scheduling transition without a valid future date', () => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const lead = createDemoLeads(now)[0], stage = defaultPipelineStages()[2]
    expect(() => transitionLead(lead, stage)).toThrow('futuros')
    expect(() => transitionLead(lead, stage, undefined, undefined, undefined, now.toISOString())).toThrow('futuros')
  })
  it('preserves normal and WON/LOST transitions without requiring scheduling fields', () => {
    const lead = createDemoLeads(now)[0], stages = defaultPipelineStages()
    expect(transitionLead(lead, stages[1]).stageName).toBe('Qualificado')
    expect(transitionLead(lead, stages[5], 25000)).toMatchObject({ stageType: 'WON', closedValue: 25000, attendance: 'Compareceu' })
    expect(transitionLead(lead, stages[6], undefined, 'Timing', 'Retomar depois')).toMatchObject({ stageType: 'LOST', lossReason: 'Timing', lossComment: 'Retomar depois' })
  })
  it('counts only pending calls whose full timestamp is still in the future', () => {
    const callDate = new Date(now.getTime() + 60000).toISOString()
    expect(isUpcomingCall({ attendance: 'Pendente', callDate }, now.getTime())).toBe(true)
    expect(isUpcomingCall({ attendance: 'Compareceu', callDate }, now.getTime())).toBe(false)
    expect(isUpcomingCall({ attendance: 'Não compareceu', callDate }, now.getTime())).toBe(false)
    expect(isUpcomingCall({ attendance: 'Pendente', callDate }, now.getTime() + 60000)).toBe(false)
    expect(isUpcomingCall({ attendance: 'Pendente', callDate: '' }, now.getTime())).toBe(false)
  })
})
