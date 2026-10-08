import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceAccess } from './access-types'
import type { Activity, ActivityInput } from './opportunity-types'
import { createOpportunityService } from './opportunity-service'
import { readableError } from './supabase'

const accessDenied = (cause: unknown) => {
  if (!cause || typeof cause !== 'object') return false
  const error = cause as { code?: string; status?: number }
  return error.code === '42501' || ['PGRST301','PGRST302','PGRST303'].includes(error.code || '') || error.status === 401 || error.status === 403
}
/** Operational tasks load independently of the CRM; histories belong to an opened lead. */
export function useOpportunityData(access: WorkspaceAccess | null) {
  const scope = `${access?.workspace.id || ''}:${access?.membership.userId || ''}:${access?.membership.role || ''}`
  const currentScope = useRef(scope); currentScope.current = scope
  const sequence = useRef(0)
  const inFlight = useRef<{ scope: string; promise: Promise<void> } | null>(null)
  const [state,setState] = useState<{scope:string;activities:Activity[];loading:boolean;error:string}>({scope:'',activities:[],loading:false,error:''})
  const service = useMemo(()=>access ? createOpportunityService(access.workspace.id) : null,[scope])
  const refresh = useCallback((): Promise<void> => {
    if (!service || currentScope.current !== scope) return Promise.resolve()
    if (inFlight.current?.scope === scope) return inFlight.current.promise
    const request = ++sequence.current, requestedScope = scope
    const promise = (async () => {
      try {
        const activities = await service.listPending()
        if (currentScope.current===requestedScope && request===sequence.current) setState({scope:requestedScope,activities,loading:false,error:''})
      } catch(cause) {
        if (currentScope.current===requestedScope && request===sequence.current) setState(old=>({scope:requestedScope,activities:!accessDenied(cause) && old.scope===requestedScope ? old.activities : [],loading:false,error:readableError(cause)}))
      } finally {
        if (request === sequence.current) inFlight.current = null
      }
    })()
    inFlight.current = {scope, promise}
    return promise
  },[scope,service])
  useEffect(()=>{
    currentScope.current = scope; sequence.current++; inFlight.current = null
    setState({scope,activities:[],loading:!!service,error:''})
    if (!service) return
    void refresh()
    const timer = window.setInterval(()=>{if(!document.hidden) void refresh()},30000)
    return ()=>{ clearInterval(timer); sequence.current++; inFlight.current = null; if(currentScope.current===scope) currentScope.current='' }
  },[scope,service,refresh])
  const assertScope = () => {
    if(currentScope.current!==scope) throw new Error('A empresa ou conta mudou. Abra a oportunidade novamente.')
  }
  const mergeSaved = (result:Activity) => {
    sequence.current++; inFlight.current = null
    setState(old=>({scope,activities:[...(old.scope===scope ? old.activities : []).filter(a=>a.id!==result.id),...(result.status==='pending' ? [result] : [])],loading:false,error:''}))
  }
  const onSaveActivity = useCallback(async(input:ActivityInput,activityId?:string)=>{
    if(!service) throw new Error('Selecione uma empresa para continuar.')
    assertScope()
    const result=await service.saveActivity(input,activityId)
    assertScope(); mergeSaved(result); await refresh(); assertScope(); return result
  },[service,scope,refresh])
  const onSetActivityStatus = useCallback(async(id:string,status:'completed'|'cancelled')=>{
    if(!service) throw new Error('Selecione uma empresa para continuar.')
    assertScope()
    const result=await service.setActivityStatus(id,status)
    assertScope(); mergeSaved(result); await refresh(); assertScope(); return result
  },[service,scope,refresh])
  const displayed=state.scope===scope ? state : {activities:[],loading:!!service,error:''}
  return {...displayed,detailsService:service,onSaveActivity,onSetActivityStatus,refresh}
}
