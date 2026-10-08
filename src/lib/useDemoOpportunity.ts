import { useMemo, useRef, useState } from 'react'
import type { Lead } from '../types'
import type { Activity, ActivityInput, LeadCall, OpportunityDetailsService, OpportunityEvent } from './opportunity-types'
import { validActivityInput } from './opportunity'
import { getLeadStageName, getLeadStageType } from './pipeline'

type State = { activities: Activity[]; events: Record<string,OpportunityEvent[]> }
const empty = (): State => ({activities:[],events:{}})
/** Isolated browser demonstration. This hook never calls Auth or writes to a cloud workspace. */
export function useDemoOpportunity(enabled:boolean,storageKey:string,leads:Lead[],userName:string) {
  const [state,setState]=useState<State>(()=>{
    if(!enabled) return empty()
    try {
      const parsed=JSON.parse(localStorage.getItem(storageKey)||'null')
      return parsed && Array.isArray(parsed.activities) && parsed.activities.every((a:Activity)=>a.workspaceId==='demo' && a.createdBy==='demo-user' && ['pending','completed','cancelled'].includes(a.status) && validActivityInput(a)) && parsed.events && typeof parsed.events==='object' ? parsed : empty()
    }catch{return empty()}
  })
  const current=useRef(state);current.current=state
  const currentLeads=useRef(leads);currentLeads.current=leads
  const actorName=useRef(userName);actorName.current=userName
  const sequence=useRef(Date.now())
  const baseEvents=(lead:Lead):OpportunityEvent[]=>[{id:'1',workspaceId:'demo',leadId:lead.id,actorId:'demo-user',actorName:actorName.current,eventType:'lead.created',metadata:{demonstration:true},createdAt:lead.createdAt}]
  const event=(leadId:string,eventType:string,metadata:Record<string,unknown>):OpportunityEvent=>({id:String(++sequence.current),workspaceId:'demo',leadId,actorId:'demo-user',actorName:actorName.current,eventType,metadata,createdAt:new Date().toISOString()})
  const commit=(next:State)=>{
    if(!enabled) throw new Error('Esta operação está disponível somente na demonstração local.')
    localStorage.setItem(storageKey,JSON.stringify(next));current.current=next;setState(next)
  }
  const append=(next:State,e:OpportunityEvent)=>{
    const lead=currentLeads.current.find(l=>l.id===e.leadId)
    next.events={...next.events,[e.leadId]:[...(next.events[e.leadId] || (lead ? baseEvents(lead) : [])),e]}
  }
  const snapshot=(lead:Lead):LeadCall=>({id:lead.callDate||'undated',callDate:lead.callDate,attendance:lead.attendance,callScore:lead.callScore,callSummary:lead.callSummary,objection:lead.objection,pain:lead.pain,urgency:lead.urgency,financialCapacity:lead.financialCapacity,decisionMaker:lead.decisionMaker,closerError:lead.closerError,recordingUrl:lead.recordingUrl||'',nextStep:lead.nextStep||'',leadershipReview:lead.leadershipReview,recordedAt:new Date().toISOString(),legacy:true})
  const detailsService=useMemo<OpportunityDetailsService>(()=>({
    async listActivities(id){return current.current.activities.filter(a=>a.leadId===id)},
    async listEvents(id,beforeId){
      const lead=currentLeads.current.find(l=>l.id===id)
      if(!lead) throw new Error('Oportunidade não encontrada.')
      const rows=[...(current.current.events[id]||baseEvents(lead))].reverse().filter(e=>e.eventType!=='call.snapshot' && (!beforeId || BigInt(e.id)<BigInt(beforeId)))
      return {items:rows.slice(0,30),nextCursor:rows.length>30 ? rows[29].id : null}
    },
    async listCalls(id,offset=0){
      const lead=currentLeads.current.find(l=>l.id===id)
      if(!lead) throw new Error('Oportunidade não encontrada.')
      const calls=new Map<string,LeadCall>()
      for(const e of current.current.events[id]||[]){const c=e.metadata.demoCall as LeadCall|undefined;if(c)calls.set(c.callDate||'undated',c)}
      if(lead.callDate || lead.attendance!=='Pendente' || lead.callScore!==null)calls.set(lead.callDate||'undated',snapshot(lead))
      const items=[...calls.values()].sort((a,b)=>(new Date(b.callDate).getTime()||0)-(new Date(a.callDate).getTime()||0))
      return {items:items.slice(offset,offset+20),callCount:items.length,nextOffset:offset+20<items.length ? offset+20 : null,ownerId:'demo-user',ownerName:actorName.current,lastEventAt:current.current.events[id]?.filter(e=>e.eventType!=='call.snapshot').at(-1)?.createdAt||lead.createdAt}
    },
  }),[enabled,storageKey])
  const onSaveActivity=async(input:ActivityInput,id?:string):Promise<Activity>=>{
    if(!validActivityInput(input) || input.assignedTo!=='demo-user' || !currentLeads.current.some(l=>l.id===input.leadId)) throw new Error('Revise a oportunidade e os dados da atividade.')
    const previous=id ? current.current.activities.find(a=>a.id===id && a.leadId===input.leadId) : undefined
    if(id && (!previous || previous.status!=='pending')) throw new Error('Somente atividades pendentes podem ser editadas.')
    const now=new Date().toISOString()
    const result:Activity={...input,title:input.title.trim(),description:input.description.trim(),id:id||crypto.randomUUID(),workspaceId:'demo',assignedName:actorName.current,createdBy:'demo-user',createdByName:actorName.current,status:'pending',completedAt:null,createdAt:previous?.createdAt||now,updatedAt:now}
    const next={...current.current,activities:[...current.current.activities.filter(a=>a.id!==result.id),result]}
    append(next,event(result.leadId,previous?'activity.updated':'activity.created',{title:result.title,due_at:result.dueAt,type:result.type}));commit(next);return result
  }
  const onSetActivityStatus=async(id:string,status:'completed'|'cancelled'):Promise<Activity>=>{
    const previous=current.current.activities.find(a=>a.id===id)
    if(!previous || !['completed','cancelled'].includes(status) || previous.status!=='pending') throw new Error('Selecione uma atividade pendente.')
    const now=new Date().toISOString(),result={...previous,status,updatedAt:now,completedAt:status==='completed'?now:null}
    const next={...current.current,activities:current.current.activities.map(a=>a.id===id?result:a)}
    append(next,event(result.leadId,`activity.${status}`,{title:result.title,due_at:result.dueAt}));commit(next);return result
  }
  const recordLeadChange=(previous:Lead|undefined,nextLead:Lead)=>{
    if(!enabled)return
    const next={...current.current}
    if(!previous)append(next,event(nextLead.id,'lead.created',{}))
    else {
      if(previous.stageId!==nextLead.stageId || previous.status!==nextLead.status)append(next,event(nextLead.id,'lead.stage_changed',{from_stage_name:getLeadStageName(previous),to_stage_name:getLeadStageName(nextLead)}))
      if(previous.ticket!==nextLead.ticket)append(next,event(nextLead.id,'lead.ticket_changed',{previous_ticket:previous.ticket,ticket:nextLead.ticket}))
      const oldType=getLeadStageType(previous),newType=getLeadStageType(nextLead)
      if(oldType!==newType && newType==='WON')append(next,event(nextLead.id,'lead.won',{closed_value:nextLead.closedValue}))
      if(oldType!==newType && newType==='LOST')append(next,event(nextLead.id,'lead.lost',{loss_reason:nextLead.lossReason,loss_comment:nextLead.lossComment}))
      if(oldType!=='NORMAL' && newType==='NORMAL')append(next,event(nextLead.id,'lead.reopened',{}))
      const oldCall=snapshot(previous),newCall=snapshot(nextLead)
      if(JSON.stringify({...oldCall,recordedAt:''})!==JSON.stringify({...newCall,recordedAt:''})) {
        if(previous.callDate || previous.attendance!=='Pendente' || previous.callScore!==null)append(next,event(nextLead.id,'call.snapshot',{demoCall:oldCall}))
        if(nextLead.callDate || nextLead.attendance!=='Pendente' || nextLead.callScore!==null)append(next,event(nextLead.id,previous.callDate!==nextLead.callDate?'call.recorded':'call.updated',{demoCall:newCall,call:{callScore:nextLead.callScore,attendance:nextLead.attendance}}))
      }
      if(previous.recordingUrl!==nextLead.recordingUrl && nextLead.recordingUrl)append(next,event(nextLead.id,'call.recording_added',{}))
      if(previous.leadershipReview?.reviewedAt!==nextLead.leadershipReview?.reviewedAt && nextLead.leadershipReview)append(next,event(nextLead.id,'call.reviewed',{score:nextLead.leadershipReview.score}))
    }
    if(next.events!==current.current.events)commit(next)
  }
  return {activities:state.activities.filter(a=>a.status==='pending'),detailsService,onSaveActivity,onSetActivityStatus,recordLeadChange}
}
