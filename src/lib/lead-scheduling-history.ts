import type { Lead } from '../types'

type SchedulingHistory = Pick<Lead, 'callDate' | 'firstScheduledAt' | 'hasBeenScheduled'>

/** Neither a pipeline label nor attendance alone proves that an appointment was booked. */
export function hasSchedulingEvidence(lead: SchedulingHistory): boolean {
  return lead.hasBeenScheduled === true || validSchedulingTimestamp(lead.firstScheduledAt) || validSchedulingTimestamp(lead.callDate)
}

export function validSchedulingTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(new Date(value).getTime())
}

/**
 * Apply only to a real manual save/transition, never to historical import normalization.
 * Existing call dates prove booking without revealing when it was first arranged.
 * Keep that evidence separately instead of inventing a historical booking timestamp.
 */
export function preserveFirstScheduling(next: Lead, previous?: Lead, now = Date.now()): Lead {
  const knownFirst = validSchedulingTimestamp(previous?.firstScheduledAt) ? previous.firstScheduledAt
    : validSchedulingTimestamp(next.firstScheduledAt) ? next.firstScheduledAt : undefined
  const historicalEvidence = Boolean(previous && hasSchedulingEvidence(previous)) || hasSchedulingEvidence({ ...next, callDate: '' })
  const currentlyScheduled = validSchedulingTimestamp(next.callDate)
  if (!knownFirst && !historicalEvidence && !currentlyScheduled) return next
  return {
    ...next,
    hasBeenScheduled: true,
    ...(knownFirst ? { firstScheduledAt: knownFirst }
      : !historicalEvidence && currentlyScheduled ? { firstScheduledAt: new Date(now).toISOString() } : {}),
  }
}
