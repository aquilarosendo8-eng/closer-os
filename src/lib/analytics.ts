import type { Lead } from '../types'

const moneyFormatter = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0, maximumFractionDigits: 2 })
const qualifiedStatuses = new Set<Lead['status']>(['Qualificado', 'Call agendada', 'Compareceu', 'Follow-up', 'Fechado'])

export function money(value: number): string {
  return moneyFormatter.format(Number.isFinite(value) ? value : 0)
}

export function compactMoney(value: number): string {
  const safeValue = Number.isFinite(value) ? value : 0
  if (Math.abs(safeValue) >= 1_000_000) return `R$ ${(safeValue / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`
  if (Math.abs(safeValue) >= 1_000) return `R$ ${(safeValue / 1_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`
  return money(safeValue)
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return words.length ? `${words[0][0]}${words.length > 1 ? words.at(-1)![0] : words[0][1] || ''}`.toUpperCase() : '?'
}

function dateOf(value: string): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Closed revenue follows its closing date; other activity follows the meeting or creation date. */
function activityDate(lead: Lead): Date | null {
  return (lead.status === 'Fechado' ? dateOf(lead.closedAt) : null) || dateOf(lead.callDate) || dateOf(lead.createdAt)
}

export function isStale(lead: Lead, now = new Date()): boolean {
  if (lead.status === 'Fechado' || lead.status === 'Perdido') return false
  const contact = dateOf(lead.lastContactAt) || dateOf(lead.createdAt)
  return !!contact && now.getTime() - contact.getTime() > 5 * 24 * 60 * 60 * 1000
}

export function getMetrics(leads: Lead[]) {
  const closedLeads = leads.filter(lead => lead.status === 'Fechado')
  const attended = leads.filter(lead => lead.attendance === 'Compareceu' || lead.status === 'Fechado').length
  const missed = leads.filter(lead => lead.attendance === 'Não compareceu' && lead.status !== 'Fechado').length
  const revenue = closedLeads.reduce((total, lead) => total + (Number.isFinite(lead.closedValue) ? lead.closedValue : 0), 0)
  const closed = closedLeads.length
  return {
    revenue,
    closed,
    attended,
    scheduled: leads.filter(lead => !!dateOf(lead.callDate)).length,
    qualified: leads.filter(lead => qualifiedStatuses.has(lead.status) || lead.attendance === 'Compareceu').length,
    showRate: attended + missed ? attended / (attended + missed) * 100 : 0,
    closeRate: attended ? closed / attended * 100 : 0,
    averageTicket: closed ? revenue / closed : 0,
  }
}

export function getPeriodLeads(leads: Lead[], period: 'month' | 'quarter' | 'all', now = new Date()): Lead[] {
  if (period === 'all') return leads
  const firstMonth = period === 'quarter' ? now.getMonth() - 2 : now.getMonth()
  const start = new Date(now.getFullYear(), firstMonth, 1)
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  return leads.filter(lead => {
    const date = activityDate(lead)
    return !!date && date >= start && date < end
  })
}

export function getMonthlyPerformance(leads: Lead[], now = new Date()) {
  return Array.from({ length: 6 }, (_, index) => {
    const start = new Date(now.getFullYear(), now.getMonth() - 5 + index, 1)
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1)
    const monthlyLeads = leads.filter(lead => {
      const date = activityDate(lead)
      return !!date && date >= start && date < end
    })
    const metrics = getMetrics(monthlyLeads)
    const label = start.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')
    return { month: label[0].toUpperCase() + label.slice(1), revenue: metrics.revenue, closeRate: metrics.closeRate, qualified: metrics.qualified, closed: metrics.closed }
  })
}

export function topObjections(leads: Lead[]) {
  const counts = new Map<string, { name: string; count: number }>()
  for (const lead of leads) {
    const name = lead.objection.trim()
    if (!name || ['nenhuma', 'sem objeção', 'não avaliada'].includes(name.toLocaleLowerCase('pt-BR'))) continue
    const key = name.toLocaleLowerCase('pt-BR')
    const entry = counts.get(key)
    if (entry) entry.count++
    else counts.set(key, { name, count: 1 })
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'pt-BR'))
}

export function weeklyEvolution(leads: Lead[], now = new Date()) {
  const currentMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  currentMonday.setDate(currentMonday.getDate() - (currentMonday.getDay() + 6) % 7)
  return Array.from({ length: 6 }, (_, index) => {
    const start = new Date(currentMonday)
    start.setDate(start.getDate() - (5 - index) * 7)
    const end = new Date(start)
    end.setDate(end.getDate() + 7)
    const weeklyCalls = leads.filter(lead => {
      const date = dateOf(lead.callDate)
      return !!date && date >= start && date < end && (lead.attendance === 'Compareceu' || lead.status === 'Fechado')
    })
    const scores = weeklyCalls.map(lead => lead.callScore).filter((score): score is number => score !== null && Number.isFinite(score))
    return {
      week: start.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
      score: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length * 10) / 10 : 0,
      calls: weeklyCalls.length,
      closed: weeklyCalls.filter(lead => lead.status === 'Fechado').length,
    }
  })
}
