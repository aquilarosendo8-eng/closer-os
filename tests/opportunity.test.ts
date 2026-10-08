import { describe, expect, it } from 'vitest'
import type { Activity, ActivityInput, OpportunityEvent } from '../src/lib/opportunity-types'
import { activityBucket, activityDateFields, activityDateToIso, eventPresentation, formatActivityDate, nextActivity, operationalCounts, overdueActivityLabel, validActivityInput } from '../src/lib/opportunity'
import { createDemoLeads } from '../src/lib/data'

const now = new Date('2026-10-09T01:00:00Z') // Still October 8 in Brazil.
const activity = (patch: Partial<Activity> = {}): Activity => ({ id:'task-1', workspaceId:'company-a', leadId:'lead-a', assignedTo:'closer-a', assignedName:'João', createdBy:'admin-a', createdByName:'Ana', type:'follow_up', title:'Validar decisão do sócio', description:'', dueAt:'2026-10-09T02:00:00Z', status:'pending', completedAt:null, createdAt:'2026-10-08T12:00:00Z', updatedAt:'2026-10-08T12:00:00Z', ...patch })
const event = (eventType:string, metadata:Record<string,unknown> = {}): OpportunityEvent => ({ id:'10',workspaceId:'company-a',leadId:'lead-a',actorId:'admin-a',actorName:'Ana',eventType,metadata,createdAt:now.toISOString() })

describe('operational dates and overdue activities', () => {
  it('uses Brazil day and midnight regardless of the browser timezone', () => {
    expect(activityDateFields(now)).toEqual({date:'2026-10-08',time:'22:00'})
    expect(activityDateToIso('2026-10-09','00:00')).toBe('2026-10-09T03:00:00.000Z')
    expect(formatActivityDate('2026-10-09T03:00:00Z',now)).toBe('Amanhã, 00:00')
    expect(activityBucket(activity(),now)).toBe('today')
    expect(activityBucket(activity({dueAt:'2026-10-09T03:00:00Z'}),now)).toBe('upcoming')
  })
  it.each([['2026-02-30','14:00'],['2026-10-08','24:00'],['2026-13-01','10:00'],['2026-10-08','10:60'],['2026-10-8','10:00']])('rejects invalid date or rollover %s %s',(date,time)=>{
    expect(()=>activityDateToIso(date,time)).toThrow('válidos')
  })
  it('marks only pending past tasks as overdue, including earlier today', () => {
    const past=activity({dueAt:'2026-10-09T00:59:59Z'})
    expect(activityBucket(past,now)).toBe('overdue')
    expect(activityBucket(activity({dueAt:now.toISOString()}),now)).toBe('today')
    expect(overdueActivityLabel(past,now)).toBe('Follow-up atrasado')
    expect(overdueActivityLabel(activity({dueAt:'2026-10-07T01:00:00Z'}),now)).toBe('Follow-up atrasado há 2 dias')
    expect(overdueActivityLabel(activity(),now)).toBe('')
    expect(overdueActivityLabel({...past,status:'completed'},now)).toBe('')
    expect(activityBucket({...past,status:'completed'},now)).toBe('completed')
    expect(activityBucket({...past,status:'cancelled'},now)).toBe('cancelled')
  })
  it('derives next action from pending tasks on the exact lead and leaves input order intact', () => {
    const rows=[activity(),activity({id:'done',status:'completed',dueAt:'2026-10-07T01:00:00Z'}),activity({id:'other',leadId:'lead-b',dueAt:'2026-10-06T01:00:00Z'}),activity({id:'late',dueAt:'2026-10-08T01:00:00Z'})]
    expect(nextActivity(rows,'lead-a')?.id).toBe('late')
    expect(nextActivity(rows,'missing')).toBeUndefined()
    expect(rows.map(a=>a.id)).toEqual(['task-1','done','other','late'])
  })
  it('counts disjoint operational buckets and calls on the Brazil day without changing revenue metrics', () => {
    const lead=createDemoLeads(now)[0]
    const rows=[activity(),activity({id:'late',dueAt:'2026-10-08T20:00:00Z'}),activity({id:'future',dueAt:'2026-10-09T03:00:00Z'}),activity({id:'done',status:'completed'}),activity({id:'cancelled',status:'cancelled'})]
    expect(operationalCounts(rows,[{...lead,callDate:'2026-10-09T02:59:59Z'},{...lead,id:'next-day',callDate:'2026-10-09T03:00:00Z'},{...lead,id:'invalid',callDate:''}],now)).toEqual({overdue:1,today:1,upcoming:1,callsToday:1})
  })
})

describe('task form and readable commercial history', () => {
  it('requires title, lead, assignee, known type and a finite zoned due date', () => {
    expect(validActivityInput(activity())).toBe(true)
    for(const patch of [{title:'  '},{title:'x'.repeat(181)},{title:'Título\nforjado'},{leadId:''},{assignedTo:''},{description:'x'.repeat(4001)},{dueAt:'2026-10-08T14:00:00'},{dueAt:'invalid'},{type:'automation'}]) expect(validActivityInput({...activity(),...patch} as ActivityInput)).toBe(false)
  })
  it('formats stage changes, owner names, money and loss reason without exposing technical IDs', () => {
    expect(eventPresentation(event('lead.stage_changed',{from_stage_name:'Qualificação',to_stage_name:'Proposta',to_stage_id:'secret-id'}))).toEqual({title:'Etapa atualizada',detail:'Qualificação → Proposta'})
    expect(eventPresentation(event('lead.owner_changed',{to_owner_name:'João Silva',to_owner_id:'secret-id'}))).toEqual({title:'Responsável alterado',detail:'João Silva'})
    expect(eventPresentation(event('lead.won',{closed_value:18000})).detail).toContain('18.000')
    expect(eventPresentation(event('lead.lost',{loss_reason:'Investimento',loss_comment:'Retomar próximo trimestre'})).detail).toBe('Investimento · Retomar próximo trimestre')
    expect(eventPresentation(event('lead.reopened'))).toEqual({title:'Oportunidade reaberta',detail:''})
  })
  it('preserves zero call/review scores and ignores arbitrary metadata', () => {
    expect(eventPresentation(event('call.updated',{call:{callScore:0,attendance:'Compareceu'}}))).toEqual({title:'Pós-call atualizado',detail:'Nota 0/10'})
    expect(eventPresentation(event('call.reviewed',{score:0})).detail).toBe('Nota da liderança: 0/10')
    expect(eventPresentation(event('unknown',{service_role:'must-never-render',error:'technical-dump'}))).toEqual({title:'Oportunidade atualizada',detail:''})
  })
})
