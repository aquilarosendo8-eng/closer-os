import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createOpportunityService } from '../src/lib/opportunity-service'
import { eventPresentation } from '../src/lib/opportunity'
import type { ActivityInput, OpportunityEvent } from '../src/lib/opportunity-types'

const mock = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../src/lib/supabase', () => ({ requireSupabase: () => ({ rpc: mock.rpc }) }))

const WORKSPACE = '10000000-0000-4000-8000-000000000001'
const FOREIGN_WORKSPACE = '10000000-0000-4000-8000-000000000002'
const USER = '20000000-0000-4000-8000-000000000001'
const ID = '30000000-0000-4000-8000-000000000001'
const LEAD = 'allowed-lead'
const WHEN = '2026-10-08T14:00:00.000Z'
const input: ActivityInput = { leadId: LEAD, assignedTo: USER, type: 'follow_up', title: ' Validar decisão ', description: ' Retomar proposta ', dueAt: WHEN }
const row = (extra: Record<string, unknown> = {}) => ({
  id: ID, workspace_id: WORKSPACE, lead_id: LEAD, assigned_to: USER, assigned_name: 'Closer desta empresa',
  created_by: USER, created_by_name: 'Criador desta empresa', type: 'follow_up', title: 'Validar decisão',
  description: 'Retomar proposta', due_at: WHEN, status: 'pending', completed_at: null, created_at: WHEN, updated_at: WHEN, ...extra,
})
const eventRow = (extra: Record<string, unknown> = {}) => ({ id: '9007199254740993', workspace_id: WORKSPACE, lead_id: LEAD,
  actor_id: USER, actor_name: 'Nome específico da empresa', event_type: 'lead.stage_changed',
  metadata: { from_stage_name: 'Qualificação', to_stage_name: 'Proposta' }, created_at: WHEN, ...extra,
})
const callRow = (extra: Record<string, unknown> = {}) => ({ id: WHEN, call_date: WHEN, attendance: 'Compareceu', call_score: 0,
  call_summary: 'Diagnóstico registrado', objection: 'Caixa', pain: 'Estoque parado', urgency: 'Alta', financial_capacity: 'Média',
  decision_maker: true, closer_error: 'Proposta cedo demais', recording_url: 'https://example.invalid/call%20gravada',
  next_step: 'Validar custo da inércia', recorded_at: WHEN, legacy: false, leadership_review: { feedback: 'Aprofundar diagnóstico',
    score: 0, reviewed_by: USER, reviewer_name: 'Liderança nesta empresa', reviewed_at: WHEN }, ...extra,
})
const success = (data: unknown) => ({ data, error: null })
const activitiesPage = (items: unknown[], nextOffset: number | null = null) => success({ items, next_offset: nextOffset })
const eventsPage = (items: unknown[], nextCursor: string | null = null) => success({ items, next_cursor: nextCursor })
const callsPage = (items: unknown[], extra: Record<string, unknown> = {}) => success({ items, next_offset: null, call_count: items.length,
  owner_id: USER, owner_name: 'Responsável nesta empresa', last_event_at: WHEN, ...extra })
beforeEach(() => mock.rpc.mockReset())

describe('operational activities remain bound to the selected company and lead', () => {
  it('loads every operational page through the public scoped RPC without loading global histories', async () => {
    mock.rpc.mockResolvedValueOnce(activitiesPage(Array.from({ length: 200 }, (_, n) => row({ id: `activity-${n}` })), 200))
      .mockResolvedValueOnce(activitiesPage([row({ id: 'last-activity' })]))
    const result = await createOpportunityService(WORKSPACE).listPending()
    expect(result).toHaveLength(201)
    expect(result.at(-1)?.id).toBe('last-activity')
    expect(mock.rpc.mock.calls).toEqual([
      ['list_lead_activities', { p_workspace_id: WORKSPACE, p_lead_id: null, p_limit: 200, p_offset: 0 }],
      ['list_lead_activities', { p_workspace_id: WORKSPACE, p_lead_id: null, p_limit: 200, p_offset: 200 }],
    ])
  })
  it('loads terminal activity history only for the explicitly opened lead', async () => {
    mock.rpc.mockResolvedValueOnce(activitiesPage([row({ status: 'completed', completed_at: WHEN }), row({ id: 'cancelled', status: 'cancelled' })]))
    const result = await createOpportunityService(WORKSPACE).listActivities(LEAD)
    expect(result.map(activity => activity.status)).toEqual(['completed', 'cancelled'])
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('list_lead_activities', { p_workspace_id: WORKSPACE, p_lead_id: LEAD, p_limit: 200, p_offset: 0 })
  })
  it('rejects an empty detail lead instead of loading operational tasks from the whole workspace', async () => {
    await expect(createOpportunityService(WORKSPACE).listActivities('')).rejects.toThrow()
    expect(mock.rpc).not.toHaveBeenCalled()
  })
  it.each([{ workspace_id: FOREIGN_WORKSPACE }, { lead_id: 'forbidden-lead' }])('rejects an activity from a different detail scope (%j)', async extra => {
    mock.rpc.mockResolvedValueOnce(activitiesPage([row(extra)]))
    await expect(createOpportunityService(WORKSPACE).listActivities(LEAD)).rejects.toThrow()
  })
  it('does not include final activities in the operational response', async () => {
    mock.rpc.mockResolvedValueOnce(activitiesPage([row({ status: 'completed', completed_at: WHEN })]))
    await expect(createOpportunityService(WORKSPACE).listPending()).rejects.toThrow('contexto')
  })
  it.each([0, -1, '200', undefined])('fails instead of repeating a malformed continuation offset %s', async nextOffset => {
    mock.rpc.mockResolvedValueOnce(success({ items: [row()], next_offset: nextOffset }))
    await expect(createOpportunityService(WORKSPACE).listPending()).rejects.toThrow('continuar')
    expect(mock.rpc).toHaveBeenCalledTimes(1)
  })
  it.each([null, [], { items: {}, next_offset: null }])('rejects incomplete activity envelopes (%j)', async page => {
    mock.rpc.mockResolvedValueOnce(success(page))
    await expect(createOpportunityService(WORKSPACE).listPending()).rejects.toThrow()
  })
  it('retains server tenant aliases and nullable deleted-author fields without loading a roster', async () => {
    mock.rpc.mockResolvedValueOnce(activitiesPage([row({ created_by: null, created_by_name: 'Usuário removido' })]))
    await expect(createOpportunityService(WORKSPACE).listPending()).resolves.toMatchObject([{ assignedName: 'Closer desta empresa',
      createdBy: '', createdByName: 'Usuário removido', completedAt: null, workspaceId: WORKSPACE, leadId: LEAD }])
    expect(mock.rpc.mock.calls.map(([name]) => name)).toEqual(['list_lead_activities'])
  })
})

describe('activity mutations preserve server-derived authorship and authorization', () => {
  it('sends editable business fields only, even if caller input contains forged authors and company context', async () => {
    mock.rpc.mockResolvedValueOnce(success(row()))
    const forged = { ...input, p_workspace_id: FOREIGN_WORKSPACE, createdBy: 'forged-author', createdAt: '1970-01-01',
      completedAt: '1970-01-01', status: 'completed', actorId: 'forged-actor' } as ActivityInput
    await createOpportunityService(WORKSPACE).saveActivity(forged)
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('save_activity', { p_workspace_id: WORKSPACE, p_lead_id: LEAD,
      p_title: 'Validar decisão', p_type: 'follow_up', p_due_at: WHEN, p_assigned_to: USER, p_description: 'Retomar proposta', p_activity_id: null })
  })
  it('keeps an existing activity ID while the backend determines immutable fields', async () => {
    mock.rpc.mockResolvedValueOnce(success(row()))
    await expect(createOpportunityService(WORKSPACE).saveActivity(input, ID)).resolves.toMatchObject({ id: ID, createdBy: USER, createdAt: WHEN })
    expect(mock.rpc.mock.calls[0][1]).toMatchObject({ p_activity_id: ID, p_lead_id: LEAD, p_workspace_id: WORKSPACE })
  })
  it.each([{ title: '' }, { title: 'A'.repeat(181) }, { title: 'Título\ncontrole' }, { description: 'A'.repeat(4001) },
    { assignedTo: '' }, { dueAt: 'not-a-date' }, { dueAt: '2026-10-08T14:00:00' }])('rejects invalid activity input before writing (%j)', async extra => {
    await expect(createOpportunityService(WORKSPACE).saveActivity({ ...input, ...extra })).rejects.toThrow('Revise')
    expect(mock.rpc).not.toHaveBeenCalled()
  })
  it.each([{ workspace_id: FOREIGN_WORKSPACE }, { lead_id: 'other-lead' }, { id: 'other-activity' }])('rejects a save acknowledgement for a different selection (%j)', async extra => {
    mock.rpc.mockResolvedValueOnce(success(row(extra)))
    await expect(createOpportunityService(WORKSPACE).saveActivity(input, ID)).rejects.toThrow()
  })
  it.each(['completed', 'cancelled'] as const)('finalizes a selected activity with status %s without client timestamps', async status => {
    mock.rpc.mockResolvedValueOnce(success(row({ status, completed_at: status === 'completed' ? WHEN : null })))
    await expect(createOpportunityService(WORKSPACE).setActivityStatus(ID, status)).resolves.toMatchObject({ id: ID, status })
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('set_activity_status', { p_workspace_id: WORKSPACE, p_activity_id: ID, p_status: status })
  })
  it('does not permit a client reopening path for finalized tasks', async () => {
    await expect(createOpportunityService(WORKSPACE).setActivityStatus(ID, 'pending' as 'completed')).rejects.toThrow('pendente')
    expect(mock.rpc).not.toHaveBeenCalled()
  })
  it.each([{ workspace_id: FOREIGN_WORKSPACE }, { id: 'different-id' }])('rejects a terminal response outside the activity selection (%j)', async extra => {
    mock.rpc.mockResolvedValueOnce(success(row({ status: 'completed', completed_at: WHEN, ...extra })))
    await expect(createOpportunityService(WORKSPACE).setActivityStatus(ID, 'completed')).rejects.toThrow()
  })
  it('requires the server acknowledgement to confirm the requested final status', async () => {
    mock.rpc.mockResolvedValueOnce(success(row({ status: 'pending' })))
    await expect(createOpportunityService(WORKSPACE).setActivityStatus(ID, 'completed')).rejects.toThrow('seleção')
  })
  it('propagates an RLS refusal without retrying through a privileged write route', async () => {
    const error = { code: '42501', message: 'Oportunidade não autorizada.' }
    mock.rpc.mockResolvedValue({ data: null, error })
    const service = createOpportunityService(WORKSPACE)
    await expect(service.saveActivity(input)).rejects.toEqual(error)
    await expect(service.setActivityStatus(ID, 'completed')).rejects.toEqual(error)
    await expect(service.listPending()).rejects.toEqual(error)
    expect(mock.rpc).toHaveBeenCalledTimes(3)
    expect(mock.rpc.mock.calls.map(([name]) => name)).toEqual(['save_activity', 'set_activity_status', 'list_lead_activities'])
  })
})

describe('lazy lead histories maintain their scoped cursors and review associations', () => {
  it('passes bigint cursors as strings without losing precision and keeps server author/date', async () => {
    mock.rpc.mockResolvedValueOnce(eventsPage([eventRow()], '9007199254740992'))
      .mockResolvedValueOnce(eventsPage([eventRow({ id: '9007199254740991' })]))
    const service = createOpportunityService(WORKSPACE), first = await service.listEvents(LEAD)
    const next = await service.listEvents(LEAD, first.nextCursor!)
    expect(first.items[0]).toMatchObject({ id: '9007199254740993', actorId: USER, actorName: 'Nome específico da empresa', createdAt: WHEN })
    expect(next.nextCursor).toBeNull()
    expect(mock.rpc.mock.calls).toEqual([
      ['list_lead_events', { p_workspace_id: WORKSPACE, p_lead_id: LEAD, p_before_id: null, p_limit: 30 }],
      ['list_lead_events', { p_workspace_id: WORKSPACE, p_lead_id: LEAD, p_before_id: '9007199254740992', p_limit: 30 }],
    ])
  })
  it.each([{ workspace_id: FOREIGN_WORKSPACE }, { lead_id: 'forbidden-lead' }, { id: 9007199254740993 }, { created_at: 'invalid' }])('rejects events outside their scoped identity (%j)', async extra => {
    mock.rpc.mockResolvedValueOnce(eventsPage([eventRow(extra)]))
    await expect(createOpportunityService(WORKSPACE).listEvents(LEAD)).rejects.toThrow()
  })
  it('rejects invalid cursors before invoking the server', async () => {
    await expect(createOpportunityService(WORKSPACE).listEvents(LEAD, '1;select secret')).rejects.toThrow('válida')
    await expect(createOpportunityService(WORKSPACE).listEvents('')).rejects.toThrow('válida')
    expect(mock.rpc).not.toHaveBeenCalled()
  })
  it.each([13, 'not-a-cursor', undefined])('rejects malformed event continuation %s', async cursor => {
    mock.rpc.mockResolvedValueOnce(success({ items: [eventRow()], next_cursor: cursor }))
    await expect(createOpportunityService(WORKSPACE).listEvents(LEAD)).rejects.toThrow('histórico')
  })
  it('preserves zero scores and independently captured historical review metadata', async () => {
    mock.rpc.mockResolvedValueOnce(callsPage([callRow()]))
    const result = await createOpportunityService(WORKSPACE).listCalls(LEAD)
    expect(result).toMatchObject({ callCount: 1, ownerId: USER, ownerName: 'Responsável nesta empresa', lastEventAt: WHEN,
      items: [{ callDate: WHEN, callScore: 0, callSummary: 'Diagnóstico registrado', recordingUrl: 'https://example.invalid/call%20gravada',
        leadershipReview: { score: 0, feedback: 'Aprofundar diagnóstico', reviewedBy: USER, reviewerName: 'Liderança nesta empresa', reviewedAt: WHEN } }] })
  })
  it('preserves legacy/undated calls and removed reviewer identities without applying another review', async () => {
    const removedReview = { ...(callRow().leadership_review as Record<string, unknown>), reviewed_by: null, reviewer_name: 'Usuário removido' }
    mock.rpc.mockResolvedValueOnce(callsPage([callRow({ leadership_review: removedReview, legacy: true }),
      callRow({ id: 'undated', call_date: null, call_score: null, leadership_review: null })]))
    const result = await createOpportunityService(WORKSPACE).listCalls(LEAD)
    expect(result.items[0]).toMatchObject({ legacy: true, leadershipReview: { reviewedBy: '', reviewerName: 'Usuário removido' } })
    expect(result.items[1]).toMatchObject({ id: 'undated', callDate: '', callScore: null })
    expect(result.items[1].leadershipReview).toBeUndefined()
  })
  it('paginates calls independently of events and provides lead owner even when no calls exist', async () => {
    mock.rpc.mockResolvedValueOnce(callsPage([callRow()], { next_offset: 20, call_count: 21 }))
      .mockResolvedValueOnce(callsPage([callRow({ id: 'another-date' })], { call_count: 21 }))
      .mockResolvedValueOnce(callsPage([]))
    const service = createOpportunityService(WORKSPACE), first = await service.listCalls(LEAD)
    expect((await service.listCalls(LEAD, first.nextOffset!)).nextOffset).toBeNull()
    expect(await service.listCalls('lead-without-call')).toMatchObject({ items: [], callCount: 0, ownerId: USER, ownerName: 'Responsável nesta empresa' })
    expect(mock.rpc.mock.calls).toEqual([
      ['list_lead_call_history', { p_workspace_id: WORKSPACE, p_lead_id: LEAD, p_limit: 20, p_offset: 0 }],
      ['list_lead_call_history', { p_workspace_id: WORKSPACE, p_lead_id: LEAD, p_limit: 20, p_offset: 20 }],
      ['list_lead_call_history', { p_workspace_id: WORKSPACE, p_lead_id: 'lead-without-call', p_limit: 20, p_offset: 0 }],
    ])
  })
  it.each([{ call_score: 11 }, { call_score: 1.5 }, { attendance: 'invalid' },
    { leadership_review: { feedback: 'Feedback', score: 11, reviewed_by: USER, reviewer_name: 'Liderança', reviewed_at: WHEN } },
    { leadership_review: { feedback: 'Feedback', score: 8, reviewed_by: USER, reviewer_name: 'Liderança', reviewed_at: '' } }])('rejects malformed call/review records (%j)', async extra => {
    mock.rpc.mockResolvedValueOnce(callsPage([callRow(extra)]))
    await expect(createOpportunityService(WORKSPACE).listCalls(LEAD)).rejects.toThrow()
  })
  it('propagates forbidden lead detail responses without querying broader workspace histories', async () => {
    const error = { code: '42501', message: 'Oportunidade não autorizada.' }
    mock.rpc.mockResolvedValue({ data: null, error })
    const service = createOpportunityService(WORKSPACE)
    await expect(service.listEvents('forbidden-lead')).rejects.toEqual(error)
    await expect(service.listCalls('forbidden-lead')).rejects.toEqual(error)
    await expect(service.listActivities('forbidden-lead')).rejects.toEqual(error)
    expect(mock.rpc.mock.calls.map(([name]) => name)).toEqual(['list_lead_events', 'list_lead_call_history', 'list_lead_activities'])
  })
})

describe('commercial timeline presentation matches migration006 metadata', () => {
  const present = (eventType: string, metadata: Record<string, unknown>) => eventPresentation({ id: '1', workspaceId: WORKSPACE, leadId: LEAD,
    actorId: USER, actorName: 'Closer', eventType, metadata, createdAt: WHEN } as OpportunityEvent)
  it('shows canonical stage/owner changes and before/after ticket without rendering arbitrary metadata', () => {
    expect(present('lead.stage_changed', { from_stage_name: 'Qualificação', to_stage_name: 'Proposta', secret: 'debug-data' })).toEqual({ title: 'Etapa atualizada', detail: 'Qualificação → Proposta' })
    expect(present('lead.owner_changed', { to_owner_name: 'João nesta empresa' })).toEqual({ title: 'Responsável alterado', detail: 'João nesta empresa' })
    const ticket = present('lead.ticket_changed', { previous_ticket: 10000, ticket: 20000 })
    expect(ticket.title).toBe('Ticket atualizado')
    expect(ticket.detail).toContain('10.000')
    expect(ticket.detail).toContain('20.000')
  })
  it('displays zero seller/leadership scores from canonical call snapshots and review events', () => {
    expect(present('call.recorded', { call: { callScore: 0, attendance: 'Compareceu' } })).toEqual({ title: 'Call registrada', detail: 'Nota 0/10' })
    expect(present('call.updated', { call: { callScore: null, attendance: 'Não compareceu' } }).detail).toBe('Não compareceu')
    expect(present('call.reviewed', { score: 0 })).toEqual({ title: 'Revisão da liderança', detail: 'Nota da liderança: 0/10' })
  })
  it('keeps WON/LOST commercial details and reopening labels independent of technical logs', () => {
    expect(present('lead.won', { closed_value: 18000 }).detail).toContain('18.000')
    expect(present('lead.lost', { loss_reason: 'Sumiu', loss_comment: 'Sem retorno' })).toEqual({ title: 'Oportunidade perdida', detail: 'Sumiu · Sem retorno' })
    expect(present('lead.reopened', {}).title).toBe('Oportunidade reaberta')
    expect(present('activity.completed', { title: 'Validar decisão' })).toEqual({ title: 'Atividade concluída', detail: 'Validar decisão' })
  })
})
