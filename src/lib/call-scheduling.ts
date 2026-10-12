import type { Lead } from '../types'

/** Match the application's existing datetime-local fields: dates use the browser's timezone. */
export function localCallDateFields(value: string): { date: string; time: string } {
  const parsed = new Date(value)
  if (!value || !Number.isFinite(parsed.getTime())) return { date: '', time: '' }
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000).toISOString()
  return { date: local.slice(0, 10), time: local.slice(11, 16) }
}

export function futureCallDate(value: string, now = Date.now()): string {
  const parsed = new Date(value)
  if (!value || !Number.isFinite(parsed.getTime()) || parsed.getTime() <= now) {
    throw new Error('Escolha uma data e um horário futuros para a reunião.')
  }
  return parsed.toISOString()
}

/** Reject nonexistent calendar dates and local times (including a daylight-saving gap). */
export function callScheduleDate(date: string, time: string, now = Date.now()): string {
  if (!date || !time) throw new Error('Informe a data e o horário da reunião.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error('Informe uma data e um horário válidos para a reunião.')
  }
  const value = `${date}T${time}:00`
  const parsed = new Date(value)
  const roundTrip = localCallDateFields(value)
  if (!Number.isFinite(parsed.getTime()) || roundTrip.date !== date || roundTrip.time !== time) {
    throw new Error('Informe uma data e um horário válidos para a reunião.')
  }
  return futureCallDate(parsed.toISOString(), now)
}

export function isUpcomingCall(lead: Pick<Lead, 'attendance' | 'callDate'>, now = Date.now()): boolean {
  return lead.attendance === 'Pendente' && new Date(lead.callDate).getTime() > now
}
