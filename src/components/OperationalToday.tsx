import { ArrowRight, CalendarDays, Check, Clock3, LoaderCircle } from 'lucide-react'
import { useRef, useState } from 'react'
import type { ActivityViewProps } from '../lib/opportunity-types'
import { ACTIVITY_TYPE_LABELS } from '../lib/opportunity-types'
import { activityBucket, formatActivityDate, operationalCounts } from '../lib/opportunity'
import './opportunity-integration.css'

export default function OperationalToday(props:ActivityViewProps & {onAll:()=>void;now:Date}) {
  const {activities,leads,onAll,now}=props
  const [pending,setPending]=useState(''),[message,setMessage]=useState(''),[error,setError]=useState('')
  const busy=useRef(false)
  const counts=operationalCounts(activities,leads,now)
  const upcoming=[...activities].filter(a=>a.status==='pending').sort((a,b)=>new Date(a.dueAt).getTime()-new Date(b.dueAt).getTime()).slice(0,4)
  const complete=async(id:string)=>{
    const activity=activities.find(a=>a.id===id && a.status==='pending')
    if(busy.current || !activity || !props.canEdit || !(props.canManage || props.leadOwners?.[activity.leadId]===props.userId))return
    busy.current=true
    setPending(id);setError('');setMessage('')
    try{await props.onSetActivityStatus(id,'completed');setMessage('Atividade concluída.')}
    catch(cause){setError(cause instanceof Error ? cause.message : 'Não foi possível concluir a atividade. Tente novamente.')}
    finally{busy.current=false;setPending('')}
  }
  return <section className="panel op-today" aria-labelledby="op-today-title"><div className="panel-header"><div><h2 id="op-today-title">Sua rotina hoje</h2><p>As próximas ações da sua operação · Horário de Brasília</p></div><button className="text-button" onClick={onAll}>Ver atividades <ArrowRight size={14}/></button></div>
    <div className="op-today-counts">{[['Atrasadas',counts.overdue],['Para hoje',counts.today],['Calls de hoje',counts.callsToday],['Próximas',counts.upcoming]].map(([label,count])=><div key={label}><span>{label}</span><strong>{count}</strong></div>)}</div>
    {props.error && <div className="op-inline-error" role="alert">Não foi possível carregar as atividades. <button className="text-button" onClick={props.onRetry}>Tentar novamente</button></div>}
    {error && <p className="op-inline-error" role="alert">{error}</p>}{message && <p className="op-inline-success" role="status">{message}</p>}
    <div className="op-today-list">{upcoming.map(a=>{
      const lead=leads.find(l=>l.id===a.leadId),overdue=activityBucket(a,now)==='overdue'
      const editable=props.canEdit && (props.canManage || props.leadOwners?.[a.leadId]===props.userId)
      return <div className={`op-today-item ${overdue?'is-overdue':''}`} key={a.id}><span className="op-today-icon">{overdue?<Clock3 size={16}/>:<CalendarDays size={16}/>}</span><button className="op-today-lead" onClick={()=>lead&&props.onOpenLead?.(lead)}><strong>{a.title}</strong><span>{ACTIVITY_TYPE_LABELS[a.type]} · {lead?.name||'Oportunidade'} · {formatActivityDate(a.dueAt,now)}</span></button>{editable && <button className="icon-button" aria-label={`Concluir atividade ${a.title}`} disabled={!!pending} onClick={()=>void complete(a.id)}>{pending===a.id?<LoaderCircle size={16}/>:<Check size={16}/>}</button>}</div>
    })}{!upcoming.length && !props.error && <p className="op-today-empty">{props.loading?'Carregando atividades…':'Nenhuma atividade pendente. Abra uma oportunidade para planejar a próxima ação.'}</p>}</div>
  </section>
}
