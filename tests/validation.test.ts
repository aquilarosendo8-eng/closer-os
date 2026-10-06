import { describe, expect, it } from 'vitest'
import { createDemoLeads, defaultSettings } from '../src/lib/data'
import { validLead, validSettings } from '../src/lib/validation'

describe('backup validation', () => {
  it('accepts the complete demo and zero call ratings', () => {
    expect(createDemoLeads().every(validLead)).toBe(true)
    expect(validLead({ ...createDemoLeads()[0], callScore: 0 })).toBe(true)
  })
  it('rejects partial leads before they can corrupt browser storage', () => {
    expect(validLead({ id: 'one', name: 'Alice', status: 'Fechado', ticket: 15000 })).toBe(false)
    expect(validLead({ ...createDemoLeads()[0], callSummary: null })).toBe(false)
  })
  it('rejects invalid financial values, dates and enum values', () => {
    const lead = createDemoLeads()[0]
    expect(validLead({ ...lead, ticket: '15000' })).toBe(false)
    expect(validLead({ ...lead, ticket: -1 })).toBe(false)
    expect(validLead({ ...lead, callScore: 11 })).toBe(false)
    expect(validLead({ ...lead, callDate: 'invalid date' })).toBe(false)
    expect(validLead({ ...lead, status: 'Unknown' })).toBe(false)
  })
  it('rejects settings that would produce invalid revenue projections', () => {
    expect(validSettings(defaultSettings)).toBe(true)
    expect(validSettings({ ...defaultSettings, commissionRate: 101 })).toBe(false)
    expect(validSettings({ ...defaultSettings, revenueGoal: 0 })).toBe(false)
    expect(validSettings({ ...defaultSettings, name: '   ' })).toBe(false)
  })
})
