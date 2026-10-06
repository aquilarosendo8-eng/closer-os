import type { Lead, Settings } from '../types'

export const defaultSettings: Settings = { name: 'Aquila Rosendo', commissionRate: 10, revenueGoal: 200_000 }

/** Demonstration records use relative dates so a fresh workspace always has a useful dashboard. */
export function createDemoLeads(now = new Date()): Lead[] {
  const day = now.getDate()
  const year = now.getFullYear()
  const month = now.getMonth()
  const monthLastDay = new Date(year, month + 1, 0).getDate()
  const monthDate = (offset: number, hour = 14) => new Date(year, month, Math.max(1, Math.min(monthLastDay, day + offset)), hour).toISOString()
  const relativeDate = (offset: number, hour = 10) => new Date(year, month, day + offset, hour).toISOString()
  const historicalDate = (monthsAgo: number, historicalDay: number, hour = 14) => new Date(year, month - monthsAgo, historicalDay, hour).toISOString()

  const records: Lead[] = []
  const add = (name: string, company: string, overrides: Partial<Lead> = {}) => {
    const index = records.length
    const slug = name.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '.')
    records.push({
      id: `demo-${String(index + 1).padStart(3, '0')}`,
      name,
      company,
      email: `${slug}@example.com`,
      phone: `(11) 9${String(8000 + index)}-${String(1000 + index)}`,
      ticket: 18_000,
      source: ['Indicação', 'Instagram', 'Tráfego pago', 'LinkedIn'][index % 4],
      createdAt: relativeDate(-12 - index % 7),
      callDate: monthDate(-(index % 5), 10 + index % 7),
      attendance: 'Compareceu',
      objection: 'Investimento',
      status: 'Follow-up',
      closedValue: 0,
      closedAt: '',
      lastContactAt: relativeDate(-1 - index % 3),
      notes: 'Retomar a conversa com uma proposta alinhada aos objetivos do negócio.',
      pain: 'Dificuldade para escalar as vendas com previsibilidade.',
      urgency: 'Alta',
      financialCapacity: 'Alta',
      decisionMaker: true,
      callScore: 7 + index % 4,
      closerError: 'Aprofundar diagnóstico',
      callSummary: 'Lead quer aumentar a previsibilidade de receita. Foram discutidos os desafios atuais e o impacto financeiro da situação. Próxima etapa: validar investimento e prazo de implementação.',
      ...overrides,
    })
  }

  const sales: Array<[string, string, number]> = [
    ['Mariana Costa', 'Studio Costa', 18_000],
    ['Rafael Mendes', 'Mendes & Associados', 24_000],
    ['Camila Oliveira', 'Clínica Lumina', 12_000],
    ['Lucas Ferreira', 'LF Tecnologia', 20_000],
    ['Beatriz Santos', 'Santos Consultoria', 16_000],
    ['Pedro Almeida', 'Almeida Imóveis', 22_000],
    ['Juliana Ribeiro', 'Ribeiro Educação', 18_000],
    ['Bruno Carvalho', 'Carvalho Logística', 18_000],
  ]
  sales.forEach(([name, company, value], index) => add(name, company, {
    status: 'Fechado', ticket: value, closedValue: value, closedAt: monthDate(-index),
    callDate: monthDate(-index), lastContactAt: monthDate(-index),
    objection: ['Investimento', 'Preciso pensar', 'Tempo', 'Confiança'][index % 4],
    callScore: index < 4 ? 9 : 8, closerError: index % 2 ? 'Apresentação antecipada da proposta' : '',
    notes: 'Contrato confirmado. Agendar onboarding e alinhar as próximas etapas.',
  }))

  add('Fernanda Lima', 'Lima Design', { objection: 'Preciso pensar', lastContactAt: relativeDate(-8), callScore: 6, closerError: 'Follow-up sem próximo passo', notes: 'Proposta enviada. Aguardando retorno há mais de uma semana.' })
  add('Diego Rocha', 'Rocha Digital', { objection: 'Investimento', ticket: 24_000, lastContactAt: relativeDate(-7), callScore: 7, closerError: 'Não explorar custo da inércia', notes: 'Demonstrou interesse, mas precisa reorganizar o fluxo de caixa.' })
  add('Isabela Martins', 'Martins Arquitetura', { objection: 'Decisor ausente', decisionMaker: false, urgency: 'Média', callScore: 7, closerError: 'Decisor fora da call' })
  add('Thiago Nunes', 'Nunes Fitness', { objection: 'Tempo', ticket: 15_000, urgency: 'Média', callScore: 6, closerError: 'Aprofundar diagnóstico' })
  add('Amanda Souza', 'Souza Estética', { status: 'Compareceu', objection: 'Investimento', callDate: monthDate(0, 9), callScore: 8, closerError: '' })
  add('Gustavo Pires', 'Pires Engenharia', { status: 'Compareceu', objection: 'Preciso pensar', callDate: monthDate(0, 10), callScore: 7, closerError: 'Apresentação antecipada da proposta' })

  add('Renata Dias', 'Dias Advocacia', { status: 'Perdido', attendance: 'Não compareceu', objection: 'Tempo', callScore: null, closerError: '', urgency: 'Baixa', notes: 'Não compareceu à call e não respondeu à tentativa de reagendamento.' })
  add('Felipe Castro', 'Castro Motors', { status: 'Call agendada', attendance: 'Não compareceu', objection: '', callScore: null, closerError: '', notes: 'Tentar reagendar a reunião.' })
  add('Priscila Alves', 'Alves Eventos', { status: 'Perdido', attendance: 'Não compareceu', objection: 'Investimento', financialCapacity: 'Baixa', callScore: null, closerError: '' })

  add('Gabriel Torres', 'Torres Ventures', { status: 'Call agendada', attendance: 'Pendente', callDate: monthDate(1, 10), ticket: 25_000, objection: '', callScore: null, closerError: '', notes: 'Call de diagnóstico. Confirmar presença antes da reunião.' })
  add('Laura Fernandes', 'Fernandes Saúde', { status: 'Call agendada', attendance: 'Pendente', callDate: monthDate(1, 14), ticket: 18_000, objection: '', callScore: null, closerError: '', notes: 'Interessada em aumentar o número de consultas particulares.' })
  add('Matheus Gomes', 'Gomes Analytics', { status: 'Call agendada', attendance: 'Pendente', callDate: monthDate(2, 11), ticket: 22_000, objection: '', callScore: null, closerError: '' })
  add('Carolina Melo', 'Melo Fashion', { status: 'Call agendada', attendance: 'Pendente', callDate: monthDate(3, 15), ticket: 16_000, objection: '', callScore: null, closerError: '' })

  add('André Barbosa', 'Barbosa Foods', { status: 'Qualificado', attendance: 'Pendente', callDate: '', createdAt: monthDate(-2), objection: '', callScore: null, closerError: '', notes: 'Perfil ideal. Enviar opções de horários para o diagnóstico.' })
  add('Natália Azevedo', 'Azevedo Marketing', { status: 'Qualificado', attendance: 'Pendente', callDate: '', createdAt: monthDate(-1), objection: '', callScore: null, closerError: '' })
  add('Eduardo Freitas', 'Freitas Solar', { status: 'Lead novo', attendance: 'Pendente', callDate: '', createdAt: monthDate(0), objection: '', financialCapacity: 'Não avaliada', urgency: 'Média', callScore: null, closerError: '', notes: 'Lead recebido via formulário. Fazer primeiro contato.' })
  add('Vanessa Lopes', 'Lopes Odontologia', { status: 'Lead novo', attendance: 'Pendente', callDate: '', createdAt: monthDate(0), objection: '', financialCapacity: 'Não avaliada', urgency: 'Média', callScore: null, closerError: '' })

  const history: Array<[string, string, number, number, number]> = [
    ['Ricardo Monteiro', 'Monteiro Serviços', 1, 6, 20_000],
    ['Patrícia Moura', 'Moura Academy', 1, 14, 18_000],
    ['Daniel Teixeira', 'Teixeira Imóveis', 1, 23, 22_000],
    ['Letícia Cardoso', 'Cardoso Studio', 2, 8, 16_000],
    ['Henrique Duarte', 'Duarte Tech', 2, 19, 24_000],
    ['Milena Viana', 'Viana Consultoria', 3, 9, 18_000],
    ['Otávio Moreira', 'Moreira Educação', 3, 22, 16_000],
    ['Débora Farias', 'Farias Arquitetura', 4, 8, 14_000],
    ['Marcelo Reis', 'Reis Tecnologia', 4, 20, 14_000],
    ['Adriana Pinto', 'Pinto Saúde', 5, 10, 12_000],
    ['Vinícius Ramos', 'Ramos Marketing', 5, 23, 10_000],
  ]
  history.forEach(([name, company, monthsAgo, historicalDay, value], index) => add(name, company, {
    createdAt: historicalDate(monthsAgo, Math.max(1, historicalDay - 4)), callDate: historicalDate(monthsAgo, historicalDay),
    status: 'Fechado', closedAt: historicalDate(monthsAgo, historicalDay), closedValue: value, ticket: value,
    lastContactAt: historicalDate(monthsAgo, historicalDay), callScore: index % 2 ? 7 : 6,
    closerError: 'Apresentação antecipada da proposta', objection: index % 2 ? 'Confiança' : 'Investimento',
  }))
  add('Sérgio Batista', 'Batista Gestão', { status: 'Perdido', createdAt: historicalDate(1, 11), callDate: historicalDate(1, 16), lastContactAt: historicalDate(1, 18), objection: 'Investimento', callScore: 5, closerError: 'Não explorar custo da inércia' })
  add('Alice Campos', 'Campos Boutique', { status: 'Perdido', createdAt: historicalDate(2, 14), callDate: historicalDate(2, 20), lastContactAt: historicalDate(2, 20), objection: 'Confiança', callScore: 4, closerError: 'Aprofundar diagnóstico' })
  return records.map(lead => lead.attendance === 'Pendente' ? { ...lead, callSummary: '' } : lead)
}
