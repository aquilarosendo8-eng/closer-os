import { describe, expect, it } from 'vitest'
import { isPublicSupabaseKey } from '../src/lib/supabase'
import { subscriptionAllowsAccess } from '../src/lib/access'
import type { Subscription } from '../src/lib/access-types'

const now = new Date('2026-10-06T12:00:00Z')
const plan = (changes: Partial<Subscription> = {}): Subscription => ({ plan: 'individual', status: 'active', seatLimit: 1, currentPeriodEnd: '2026-11-06T12:00:00Z', ...changes })
describe('access status fails closed', () => {
  it('permits a paid period or a valid trial, and an explicit active perpetual license', () => {
    expect(subscriptionAllowsAccess(plan(), now)).toBe(true)
    expect(subscriptionAllowsAccess(plan({ status: 'trial' }), now)).toBe(true)
    expect(subscriptionAllowsAccess(plan({ currentPeriodEnd: null }), now)).toBe(true)
  })
  it('blocks unpaid, suspended and cancelled plans even with a future expiration', () => {
    for (const status of ['past_due', 'suspended', 'cancelled'] as const) expect(subscriptionAllowsAccess(plan({ status }), now)).toBe(false)
  })
  it('blocks expiration at the exact boundary, invalid dates, and trials without an expiration', () => {
    expect(subscriptionAllowsAccess(plan({ currentPeriodEnd: now.toISOString() }), now)).toBe(false)
    expect(subscriptionAllowsAccess(plan({ currentPeriodEnd: 'invalid' }), now)).toBe(false)
    expect(subscriptionAllowsAccess(plan({ status: 'trial', currentPeriodEnd: null }), now)).toBe(false)
  })
})
describe('public client keys', () => {
  const jwt = (role: string) => `header.${btoa(JSON.stringify({ role }))}.signature`
  it('accepts provider publishable and anon keys', () => {
    expect(isPublicSupabaseKey('sb_publishable_test')).toBe(true)
    expect(isPublicSupabaseKey(jwt('anon'))).toBe(true)
  })
  it('rejects administrative keys, other roles and malformed credentials', () => {
    for (const key of ['sb_secret_test', jwt('service_role'), jwt('authenticated'), '', 'malformed']) expect(isPublicSupabaseKey(key)).toBe(false)
  })
})
