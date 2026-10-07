import { useMemo } from 'react'
import { ArrowDownRight, ArrowUpRight, CircleCheck, Flag, Lightbulb, MessageCircleWarning, Sparkles, Target, TrendingUp } from 'lucide-react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Lead } from '../types'
import './calls-performance.css'

interface PerformanceProps { leads: Lead[] }
const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
const percent = (value: number) => `${Math.round(value)}%`
function groupValues(leads: Lead[], getValue: (lead: Lead) => string) {
  const grouped = new Map<string, { name: string; count: number; lost: number; won: number }>()
  leads.forEach(lead => {
    const value = getValue(lead).trim()
    if (!value) return
    const key = normalize(value)
    const current = grouped.get(key) ?? { name: value, count: 0, lost: 0, won: 0 }
    current.count += 1
    if (lead.status === 'Perdido') current.lost += 1
    if (lead.status === 'Fechado') current.won += 1
    grouped.set(key, current)
  })
  return [...grouped.values()].sort((a, b) => b.count - a.count)
}
function monday(value: Date) {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - (date.getDay() + 6) % 7)
  return date
}
function weekEvolution(leads: Lead[]) {
  const end = monday(new Date())
  return Array.from({ length: 8 }, (_, index) => {
    const start = new Date(end)
    start.setDate(start.getDate() - (7 - index) * 7)
    const finish = new Date(start)
    finish.setDate(finish.getDate() + 7)
    const calls = leads.filter(lead => lead.attendance === 'Compareceu' && lead.callDate && new Date(lead.callDate).getTime() >= start.getTime() && new Date(lead.callDate).getTime() < finish.getTime())
    const scored = calls.filter(lead => lead.callScore !== null)
    return {
      week: new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(start),
      score: scored.length ? Number((scored.reduce((sum, lead) => sum + (lead.callScore ?? 0), 0) / scored.length).toFixed(1)) : null,
      calls: calls.length,
      evaluated: scored.length,
    }
  })
}

export function Performance({ leads }: PerformanceProps) {
  const stats = useMemo(() => {
    const attended = leads.filter(lead => lead.attendance === 'Compareceu')
    const scored = attended.filter(lead => lead.callScore !== null)
    const average = scored.length ? scored.reduce((sum, lead) => sum + (lead.callScore ?? 0), 0) / scored.length : null
    const wins = leads.filter(lead => lead.status === 'Fechado')
    const errors = groupValues(attended, lead => lead.closerError)
    const objections = groupValues(leads, lead => ['nenhuma', 'sem objecao', 'nao avaliada'].includes(normalize(lead.objection)) ? '' : lead.objection)
    const origins = groupValues(leads, lead => lead.source || 'Não informada')
    const qualifiedStatuses = new Set<Lead['status']>(['Qualificado', 'Call agendada', 'Compareceu', 'Follow-up', 'Fechado'])
    const qualified = leads.filter(lead => qualifiedStatuses.has(lead.status) || lead.attendance === 'Compareceu')
    const urgency = ['Alta', 'Média', 'Baixa'].map(value => {
      const group = qualified.filter(lead => lead.urgency === value)
      const won = group.filter(lead => lead.status === 'Fechado').length
      return { name: value, qualified: group.length, won, rate: group.length ? won / group.length * 100 : 0 }
    })
    const evolution = weekEvolution(leads)
    const evaluatedWeeks = evolution.filter(week => week.score !== null)
    const current = evaluatedWeeks.at(-1)
    const previous = evaluatedWeeks.at(-2)
    const difference = current && previous ? (current.score ?? 0) - (previous.score ?? 0) : null
    const originsWithWins = origins.filter(origin => origin.won > 0).sort((a, b) => b.won / b.count - a.won / a.count || b.won - a.won)
    return { attended, scored, average, wins, errors, objections, origins, urgency, evolution, difference, bestOrigin: originsWithWins[0] }
  }, [leads])
  const average = stats.average === null ? '—' : stats.average.toFixed(1).replace('.', ',')
  const mainError = stats.errors[0]
  const mainObjection = stats.objections[0]
  const totalObjections = stats.objections.reduce((sum, objection) => sum + objection.count, 0)

  return <div className="cp-page">
    <div className="metrics-grid cp-performance-metrics">
      <div className="stat-card"><span className="stat-label">Nota média das calls</span><div className="cp-stat-row"><strong className="stat-value">{average}<small>{stats.average !== null ? ' / 10' : ''}</small></strong><span className="cp-stat-icon cp-amber"><Sparkles size={20}/></span></div><span className="muted cp-stat-caption">{stats.scored.length} calls avaliadas</span></div>
      <div className="stat-card"><span className="stat-label">Calls com aprendizado</span><div className="cp-stat-row"><strong className="stat-value">{stats.attended.filter(lead => lead.closerError.trim()).length}</strong><span className="cp-stat-icon cp-blue"><Lightbulb size={20}/></span></div><span className="muted cp-stat-caption">De {stats.attended.length} calls realizadas</span></div>
      <div className="stat-card"><span className="stat-label">Conversão de leads</span><div className="cp-stat-row"><strong className="stat-value">{percent(leads.length ? stats.wins.length / leads.length * 100 : 0)}</strong><span className="cp-stat-icon"><Target size={20}/></span></div><span className="muted cp-stat-caption">{stats.wins.length} fechados de {leads.length} leads</span></div>
    </div>
    <div className="cp-performance-top">
      <section className="panel cp-evolution-panel"><div className="panel-header"><div><h2 className="panel-title">Uma call melhor a cada semana</h2><p className="muted">Nota média · últimas 8 semanas</p></div>{stats.difference !== null && <span className={`cp-trend ${stats.difference < 0 ? 'negative' : ''}`}>{stats.difference < 0 ? <ArrowDownRight size={16}/> : <ArrowUpRight size={16}/>} {stats.difference >= 0 ? '+' : ''}{stats.difference.toFixed(1).replace('.', ',')} pontos</span>}</div>{stats.evolution.some(week => week.score !== null) ? <><div className="cp-weekly-chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={stats.evolution} margin={{ top: 14, right: 20, left: -23, bottom: 5 }}><defs><linearGradient id="cpScoreGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--color-chart-primary, #8659d0)" stopOpacity={0.24}/><stop offset="100%" stopColor="var(--color-chart-primary, #8659d0)" stopOpacity={0.015}/></linearGradient></defs><CartesianGrid strokeDasharray="4 5" stroke="var(--color-chart-grid, #e9edf2)" vertical={false}/><XAxis dataKey="week" axisLine={false} tickLine={false} tick={{ fill: 'var(--color-chart-axis, #9094a1)', fontSize: 11 }} tickMargin={12}/><YAxis domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} axisLine={false} tickLine={false} tick={{ fill: 'var(--color-chart-axis, #9094a1)', fontSize: 11 }}/><Tooltip content={({ active, payload, label }) => { if (!active || !payload?.length) return null; const item = payload[0].payload as { score: number | null; evaluated: number; calls: number }; return <div className="cp-chart-tooltip"><strong>Semana de {label}</strong><span>Nota média: {item.score?.toFixed(1).replace('.', ',') ?? 'Sem avaliação'}</span><span>{item.evaluated} avaliadas · {item.calls} realizadas</span></div> }}/><Area type="monotone" dataKey="score" name="Nota média" stroke="var(--color-chart-primary, #8659d0)" strokeWidth={3} fill="url(#cpScoreGradient)" connectNulls={false} dot={{ fill: 'var(--color-chart-primary, #8659d0)', stroke: 'var(--color-surface, #fff)', strokeWidth: 2, r: 4 }} activeDot={{ r: 6 }}/></AreaChart></ResponsiveContainer></div><p className="cp-chart-note">Semanas sem avaliação ficam sem nota. A comparação considera as duas últimas semanas avaliadas.</p></> : <div className="empty-state cp-chart-empty"><TrendingUp size={30}/><h3>Sua evolução começa na próxima revisão</h3><p>Avalie uma call realizada para acompanhar a evolução semanal da sua nota.</p></div>}</section>
      <section className="panel cp-focus-panel"><span className="eyebrow"><Flag size={14}/> FOCO DA SEMANA</span><h2>Um ajuste.<br/>Mais resultado.</h2>{mainError ? <><span className="cp-focus-label">Seu erro mais registrado</span><p className="cp-focus-error">“{mainError.name}”</p><div className="cp-focus-action"><CircleCheck size={18}/><p>Antes da próxima call, escolha uma ação para evitar esse padrão. Depois, registre se conseguiu aplicá-la.</p></div><span className="cp-focus-count">Registrado em {mainError.count} {mainError.count === 1 ? 'call' : 'calls'}</span></> : <><p className="cp-focus-error">A melhor próxima ação é observar.</p><div className="cp-focus-action"><CircleCheck size={18}/><p>Registre o que poderia ter feito melhor na sua próxima call. Seus padrões vão aparecer aqui.</p></div></>}</section>
    </div>
    <div className="cp-two-panels">
      <section className="panel cp-ranked-panel"><div className="panel-header"><div><h2 className="panel-title">Erros que merecem atenção</h2><p className="muted">Os aprendizados mais registrados nas calls</p></div><span className="cp-panel-icon"><Lightbulb size={19}/></span></div>{stats.errors.length ? <div className="cp-ranking">{stats.errors.slice(0, 5).map((error, index) => <div className="cp-error-row" key={error.name}><span className="cp-rank-number">{String(index + 1).padStart(2, '0')}</span><div><strong>{error.name}</strong><div className="cp-mini-track"><span style={{ width: `${error.count / stats.errors[0].count * 100}%` }}/></div></div><span className="cp-rank-count">{error.count}<small>{error.count === 1 ? 'call' : 'calls'}</small></span></div>)}</div> : <div className="empty-state cp-small-empty"><Lightbulb size={26}/><p>Registre onde você errou ao revisar uma call.</p></div>}<p className="cp-panel-note">Registros com a mesma descrição são agrupados.</p></section>
      <section className="panel cp-ranked-panel"><div className="panel-header"><div><h2 className="panel-title">Principais objeções</h2><p className="muted">O que aparece antes do próximo “sim”</p></div><span className="cp-panel-icon"><MessageCircleWarning size={19}/></span></div>{stats.objections.length ? <div className="cp-ranking">{stats.objections.slice(0, 5).map((objection, index) => <div className="cp-objection-row" key={objection.name}><div className="cp-objection-header"><strong><span className={`cp-objection-dot cp-dot-${index}`}/>{objection.name}</strong><span>{objection.count}<small> · {percent(totalObjections ? objection.count / totalObjections * 100 : 0)}</small></span></div><div className="cp-objection-track"><span className={`cp-bar-${index}`} style={{ width: `${objection.count / stats.objections[0].count * 100}%` }}/></div><div className="cp-objection-outcomes"><span>{objection.lost} {objection.lost === 1 ? 'perdido' : 'perdidos'}</span><span>{objection.won} {objection.won === 1 ? 'fechado' : 'fechados'}</span></div></div>)}</div> : <div className="empty-state cp-small-empty"><MessageCircleWarning size={26}/><p>Registre as objeções dos leads para encontrar seus padrões.</p></div>}{mainObjection && <p className="cp-panel-note">Use os resultados das calls para preparar respostas à objeção “{mainObjection.name}”.</p>}</section>
    </div>
    <div className="cp-two-panels cp-bottom-panels">
      <section className="panel"><div className="panel-header"><div><h2 className="panel-title">Conversão por origem</h2><p className="muted">Onde chegam os leads que fecham</p></div></div>{stats.origins.length ? <div className="cp-table-scroll"><table className="data-table cp-origin-table"><thead><tr><th>Origem</th><th>Leads</th><th>Fechados</th><th>Conversão</th></tr></thead><tbody>{stats.origins.map(origin => <tr key={origin.name}><td><strong>{origin.name}</strong></td><td>{origin.count}</td><td>{origin.won}</td><td><div className="cp-conversion"><span>{percent(origin.count ? origin.won / origin.count * 100 : 0)}</span><div><i style={{ width: `${origin.count ? origin.won / origin.count * 100 : 0}%` }}/></div></div></td></tr>)}</tbody></table></div> : <div className="empty-state cp-small-empty"><Target size={26}/><p>A conversão por origem aparece quando você cadastrar leads.</p></div>}{stats.bestOrigin && <div className="cp-origin-insight"><ArrowUpRight size={16}/><p><strong>{stats.bestOrigin.name}</strong> tem a maior conversão atual. Considere também o tamanho da amostra: {stats.bestOrigin.count} leads.</p></div>}</section>
      <section className="panel"><div className="panel-header"><div><h2 className="panel-title">Conversão por urgência</h2><p className="muted">Fechados entre leads que avançaram no pipeline</p></div></div><div className="cp-urgency-list">{stats.urgency.map(item => <div className="cp-urgency-row" key={item.name}><div><span className={`cp-urgency-icon ${item.name === 'Alta' ? 'high' : item.name === 'Média' ? 'medium' : 'low'}`}><Target size={17}/></span><div><strong>Urgência {item.name.toLowerCase()}</strong><small>{item.won} {item.won === 1 ? 'fechado' : 'fechados'} de {item.qualified} leads</small></div></div><strong>{percent(item.rate)}</strong></div>)}</div><p className="cp-panel-note">Inclui leads qualificados ou que avançaram na venda. Leads perdidos entram quando há comparecimento registrado.</p></section>
    </div>
  </div>
}

export default Performance
