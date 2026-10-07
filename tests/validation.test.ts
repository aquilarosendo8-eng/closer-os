import { describe, expect, it } from 'vitest'
import { createDemoLeads, defaultSettings } from '../src/lib/data'
import { normalizeRecordingUrl, validLead, validLeadershipReview, validPipelineStages, validRecordingUrl, validReviewInput, validSettings } from '../src/lib/validation'
import { defaultPipelineStages, getLeadStageName, getLeadStageType, isLost, isWon, leadInStage, normalizeLegacyLead, stageLead, transitionLead } from '../src/lib/pipeline'

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
  it('accepts HTTPS recording services and rejects credentials, control characters and dangerous schemes', () => {
    for (const url of ['', 'https://meet.google.com/abc-defg-hij', 'https://zoom.us/rec/share/meeting', 'https://drive.google.com/file/d/example/view', 'https://loom.com/share/example?start=30', 'https://example.com/Gravação%20da%20call?name=Call%20comercial']) {
      expect(validRecordingUrl(url)).toBe(true)
    }
    for (const url of ['http://example.com/video', 'javascript:alert(1)', 'https:example.com', 'https://user:password@example.com/video', 'https://example.com/\nvideo', 'https://example.com/%0avideo', 'https://example.com/%5Cvideo', 'https://example.com\\video', 'https://', ' https://example.com', null]) {
      expect(validRecordingUrl(url)).toBe(false)
    }
  })
  it('validates optional new lead fields without requiring them in existing backups', () => {
    const lead = createDemoLeads()[0]
    expect(validLead(lead)).toBe(true)
    expect(validLead({ ...lead, stageId: 'stage-id', stageType: 'WON', stageName: 'Contrato assinado', recordingUrl: 'https://fathom.video/share/example', nextStep: 'Agendar onboarding', lossReason: 'Outro', lossComment: 'Comentário' })).toBe(true)
    expect(validLead({ ...lead, recordingUrl: 'javascript:alert(1)' })).toBe(false)
    expect(validLead({ ...lead, lossReason: 'Motivo inexistente' })).toBe(false)
    expect(validLead({ ...lead, stageType: 'UNKNOWN' })).toBe(false)
    expect(validLead({ ...lead, leadershipReview: { feedback: 'Bom diagnóstico', score: 11, reviewedBy: 'manager', reviewerName: 'João', reviewedAt: new Date().toISOString() } })).toBe(false)
  })
  it('canonicalizes valid recording URLs for storage without erasing invalid inputs', () => {
    expect(normalizeRecordingUrl('HTTPS://EXAMPLE.COM:443/meeting')).toBe('https://example.com/meeting')
    const international = new URL(normalizeRecordingUrl('https://münich.example/Gravação%20da%20call'))
    expect(international.hostname).toBe('xn--mnich-kva.example')
    expect(international.pathname).toBe('/Grava%C3%A7%C3%A3o%20da%20call')
    expect(normalizeRecordingUrl('https://example.com./video')).toBe('https://example.com./video')
    expect(normalizeRecordingUrl('')).toBe('')
    expect(() => normalizeRecordingUrl('javascript:alert(1)')).toThrow('HTTPS')
    expect(() => normalizeRecordingUrl('https://user:password@example.com/video')).toThrow('HTTPS')
  })
  it('accepts a leadership score of zero and requires server review metadata for saved reviews', () => {
    const input = { feedback: 'Aprofunde a dor antes da proposta.', score: 0 }
    expect(validReviewInput(input)).toBe(true)
    expect(validLeadershipReview(input)).toBe(false)
    expect(validLeadershipReview({ ...input, reviewedBy: 'manager-id', reviewerName: 'João', reviewedAt: '2026-10-07T17:32:00Z' })).toBe(true)
    expect(validLeadershipReview({ ...input, reviewedBy: '', reviewerName: 'Usuário removido', reviewedAt: '2026-10-07T17:32:00Z' })).toBe(true)
    expect(validReviewInput({ feedback: ' ', score: 7 })).toBe(false)
    expect(validReviewInput({ ...input, score: 4.5 })).toBe(false)
    expect(validReviewInput({ ...input, score: '7' })).toBe(false)
  })
})

describe('stage compatibility and configuration', () => {
  it('keeps all existing leads in their corresponding default stage without changing their data', () => {
    const originals = createDemoLeads()
    const stages = defaultPipelineStages()
    expect(validPipelineStages(stages)).toBe(true)
    for (const original of originals) {
      const migrated = normalizeLegacyLead(original, stages)
      expect(migrated.id).toBe(original.id)
      expect(migrated.closedValue).toBe(original.closedValue)
      expect(migrated.notes).toBe(original.notes)
      expect(stages.find(stage => leadInStage(migrated, stage))?.name).toBe(original.status)
    }
  })
  it('derives victory and loss from type after terminal stages are renamed', () => {
    const lead = createDemoLeads()[0]
    const won = { ...defaultPipelineStages()[5], name: 'Contrato assinado' }
    const lost = { ...defaultPipelineStages()[6], name: 'Sem negócio' }
    const win = stageLead(lead, won)
    const loss = transitionLead(win, lost, undefined, 'Timing', 'Retomar no próximo trimestre.')
    expect(isWon(win)).toBe(true)
    expect(getLeadStageName(win)).toBe('Contrato assinado')
    expect(isLost(loss)).toBe(true)
    expect(loss.lossReason).toBe('Timing')
    expect(loss.lossComment).toBe('Retomar no próximo trimestre.')
    expect(loss.closedValue).toBe(0)
    expect(getLeadStageType({ ...win, status: 'Lead novo' })).toBe('WON')
    expect(getLeadStageType({ ...loss, status: 'Fechado' })).toBe('LOST')
  })
  it('matches configured normal columns by ID and preserves a renamed stage through normalization', () => {
    const stage = { ...defaultPipelineStages()[1], name: 'Diagnóstico profundo' }
    const lead = stageLead(createDemoLeads()[0], stage)
    expect(leadInStage(lead, stage)).toBe(true)
    expect(lead.status).toBe('Follow-up')
    expect(normalizeLegacyLead(lead, [stage]).stageName).toBe('Diagnóstico profundo')
    expect(lead.closedValue).toBe(0)
  })
  it('rejects duplicate IDs, missing terminal types and invalid colors', () => {
    const stages = defaultPipelineStages()
    expect(validPipelineStages(stages.filter(stage => stage.type !== 'LOST'))).toBe(false)
    expect(validPipelineStages([...stages, { ...stages[0], position: 7 }])).toBe(false)
    expect(validPipelineStages(stages.map((stage, i) => i === 0 ? { ...stage, color: 'url(javascript:bad)' } : stage))).toBe(false)
    expect(validPipelineStages(stages.map((stage, i) => i === 0 ? { ...stage, name: 'Nova\netapa' } : stage))).toBe(false)
    expect(validPipelineStages(stages.filter(stage => stage.type !== 'NORMAL'))).toBe(true)
  })
})
