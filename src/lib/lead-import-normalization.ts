import { LOSS_REASONS, STATUSES, type Lead } from '../types'
import { validLead } from './validation'
import { IMPORT_LIMITS, type ColumnMapping, type ImportCell, type ImportField, type ImportOptions, type ImportRecord, type ParsedImportFile, type PreparedImport } from './lead-import-types'

export const IMPORT_FIELDS: { value: ImportField; label: string }[] = [
  ['name', 'Nome'], ['company', 'Empresa'], ['email', 'E-mail'], ['phone', 'Telefone'], ['source', 'Origem'], ['ticket', 'Ticket estimado'], ['stage', 'Etapa do pipeline'], ['owner', 'Responsável'], ['callDate', 'Data e horário da call'], ['attendance', 'Comparecimento'], ['objection', 'Objeção'], ['notes', 'Observações'], ['pain', 'Dor principal'], ['urgency', 'Urgência'], ['financialCapacity', 'Capacidade financeira'], ['decisionMaker', 'Poder de decisão'], ['closedValue', 'Valor de fechamento'], ['lossReason', 'Motivo de perda'], ['lossComment', 'Detalhes da perda'], ['createdAt', 'Data de criação'], ['closedAt', 'Data de fechamento'], ['lastContactAt', 'Data do último contato'], ['sourceId', 'Identificador confiável de origem'],
].map(([value, label]) => ({ value: value as ImportField, label }))
const key = (text: string) => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').trim()
const aliases: Partial<Record<ImportField, string[]>> = {
  name: ['Nome', 'Name', 'Contact Name', 'Nome do contato', 'Nome completo', 'Lead name'], company: ['Empresa', 'Company', 'Organization', 'Organização', 'Company name'], email: ['Email', 'E-mail', 'Email address'], phone: ['Telefone', 'Phone', 'Celular', 'Mobile', 'Phone number'], source: ['Origem', 'Source', 'Lead source'], ticket: ['Ticket', 'Ticket estimado', 'Valor', 'Value', 'Deal Value', 'Valor do negócio'], stage: ['Etapa', 'Stage', 'Status', 'Etapa do pipeline', 'Deal stage'], owner: ['Responsável', 'Owner', 'Assigned to', 'Vendedor responsável', 'Lead owner'], callDate: ['Data da call', 'Data da reunião', 'Call date', 'Meeting date', 'Data e horário da call'], attendance: ['Comparecimento', 'Attendance'], objection: ['Objeções', 'Objeção', 'Objection'], notes: ['Observações', 'Notas', 'Notes', 'Description'], pain: ['Dor principal', 'Pain', 'Pain point'], urgency: ['Urgência', 'Urgency'], financialCapacity: ['Capacidade financeira', 'Financial capacity'], decisionMaker: ['Poder de decisão', 'Decisor', 'Decision maker'], closedValue: ['Valor de fechamento', 'Valor fechado', 'Closed value'], lossReason: ['Motivo de perda', 'Loss reason', 'Lost reason'], lossComment: ['Detalhes da perda', 'Loss comment'], createdAt: ['Data de criação', 'Created at', 'Creation date'], closedAt: ['Data de fechamento', 'Closed at', 'Close date'], lastContactAt: ['Data do último contato', 'Último contato', 'Last contact at'],
}
/** Exact normalized aliases are suggestions; generic IDs and ambiguous “Date” are never presumed. */
export function suggestColumnMappings(headers: string[]): ColumnMapping {
  const result: ColumnMapping = {}, used = new Set<ImportField>()
  headers.forEach((header, index) => {
    const matches = IMPORT_FIELDS.filter(field => aliases[field.value]?.some(alias => key(alias) === key(header)))
    const field = matches.length === 1 ? matches[0].value : undefined
    result[index] = field && !used.has(field) ? field : 'ignore'
    if (field) used.add(field)
  })
  return result
}
export function importCellText(value: ImportCell | undefined): string {
  return value === null || value === undefined ? '' : value instanceof Date ? value.toISOString().replace(/Z$/, '') : String(value).trim()
}

export function parseImportMoney(value: ImportCell, format: 'br' | 'international' | 'auto' = 'br'): number {
  if (value === null || value === '') return 0
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > 1e12) throw new Error('valor financeiro deve estar entre zero e 1 trilhão.')
    return value
  }
  if (typeof value !== 'string') throw new Error('valor financeiro inválido.')
  const text = value.trim().replace(/^(?:R\$|US\$|USD|BRL|\$)\s*/i, '').replace(/[\u00a0 ]/g, '')
  if (!text) return 0
  let number: number
  if (format === 'auto') {
    if (/^\d+$/.test(text)) number = Number(text)
    else if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(text) || /^\d+,\d{1,2}$/.test(text)) number = Number(text.replace(/\./g, '').replace(',', '.'))
    else if (/^\d{1,3}(?:,\d{3})+\.\d{1,2}$/.test(text) || /^\d+\.\d{1,2}$/.test(text)) number = Number(text.replace(/,/g, ''))
    else throw new Error('valor financeiro ambíguo. Escolha o formato brasileiro ou internacional.')
  } else if (format === 'br') {
    if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(text)) throw new Error('valor financeiro inválido no formato brasileiro. Exemplo: 1.234,56.')
    number = Number(text.replace(/\./g, '').replace(',', '.'))
  } else {
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) throw new Error('valor financeiro inválido no formato internacional. Exemplo: 1,234.56.')
    number = Number(text.replace(/,/g, ''))
  }
  if (!Number.isFinite(number) || number < 0 || number > 1e12) throw new Error('valor financeiro deve estar entre zero e 1 trilhão.')
  return number
}

const validParts = (year: number, month: number, day: number, hour: number, minute: number, second: number) => {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return year >= 1900 && year <= 9999 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59
}
/** Resolve a wall time in the selected IANA zone, rejecting DST gaps rather than shifting a meeting. */
function zonedTimestamp(parts: number[], timeZone: string): string {
  const [year, month, day, hour, minute, second, millis] = parts
  if (!validParts(year, month, day, hour, minute, second)) throw new Error('data ou horário inválido.')
  let formatter: Intl.DateTimeFormat
  try { formatter = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }) } catch { throw new Error('fuso horário inválido. Selecione um fuso válido.') }
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, millis)
  const observed = (timestamp: number) => {
    const map = Object.fromEntries(formatter.formatToParts(timestamp).map(part => [part.type, part.value]))
    return Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), Number(map.hour), Number(map.minute), Number(map.second), millis)
  }
  let utc = wall
  for (let index = 0; index < 4; index++) { const difference = wall - observed(utc); if (difference === 0) break; utc += difference }
  if (observed(utc) !== wall) throw new Error('esse horário não existe no fuso escolhido. Confira a data e o horário.')
  // DST overlaps have two possible instants; demand an ISO offset to avoid choosing silently.
  for (const offset of [-7200000, -3600000, -1800000, 1800000, 3600000, 7200000]) if (observed(utc + offset) === wall) throw new Error('horário ambíguo no fuso escolhido. Use uma data ISO com offset, por exemplo -03:00.')
  return new Date(utc).toISOString()
}

export function parseImportDate(value: ImportCell, timeZone: string, requireTime = false, format: 'br' | 'iso' = 'br'): string {
  if (value === null || (typeof value === 'string' && !value.trim())) return ''
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('data inválida na planilha.')
    // Excel Date values represent a wall clock; UTC components carry that local calendar faithfully.
    return zonedTimestamp([value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate(), value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds(), value.getUTCMilliseconds()], timeZone)
  }
  if (typeof value === 'number') throw new Error('data numérica sem formato de data no Excel. Formate a célula como data/hora ou use texto ISO.')
  if (typeof value !== 'string') throw new Error('data inválida.')
  const text = value.trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(text)
  const br = format === 'br' ? /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text) : null
  if (!iso && !br) throw new Error('data inválida. Use DD/MM/AAAA HH:mm ou uma data ISO.')
  const match = iso || br!
  const parts = iso ? [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0), Number((match[7] || '').padEnd(3, '0'))] : [Number(match[3]), Number(match[2]), Number(match[1]), Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0), 0]
  if (requireTime && !match[4]) throw new Error('data da call sem horário. Informe também HH:mm para preservar o agendamento.')
  if (!validParts(...parts.slice(0, 6) as [number, number, number, number, number, number])) throw new Error('data ou horário inválido.')
  if (iso?.[8]) {
    const zone = iso[8]
    if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 14 || Number(zone.slice(4, 6)) > 59 || (Number(zone.slice(1, 3)) === 14 && Number(zone.slice(4, 6)) !== 0))) throw new Error('offset de fuso horário inválido.')
    const date = new Date(text.replace(' ', 'T'))
    if (!Number.isFinite(date.getTime())) throw new Error('data inválida.')
    return date.toISOString()
  }
  return zonedTimestamp(parts, timeZone)
}

function choice<T extends string>(value: string, values: readonly T[], fallback: T, synonyms: Record<string, T> = {}): T {
  if (!value) return fallback
  const selected = values.find(item => key(item) === key(value)) || synonyms[key(value)]
  if (!selected) throw new Error('valor não reconhecido. Revise o campo no arquivo.')
  return selected
}
const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), value => value.toString(16).padStart(2, '0')).join('')

export async function buildImportRows(parsed: ParsedImportFile, mapping: ColumnMapping, options: ImportOptions): Promise<PreparedImport> {
  if (!mapping || !options || parsed.rows.length > IMPORT_LIMITS.rows) throw new Error('Revise o arquivo e a configuração de importação.')
  // Validate once even when every source date already carries an ISO offset:
  // the same zone is used to render the preview and must never crash that screen.
  try { new Intl.DateTimeFormat('pt-BR', { timeZone: options.timeZone }).format(0) } catch { throw new Error('Fuso horário inválido. Selecione um fuso válido antes de conferir os registros.') }
  const targets = Object.values(mapping).filter(value => value !== 'ignore' && value !== 'notes-extra')
  if (new Set(targets).size !== targets.length) throw new Error('Relacione cada campo do HIGH CLOSER a somente uma coluna.')
  if (!targets.includes('name')) throw new Error('Relacione uma coluna ao campo Nome antes de continuar.')
  if (targets.some(value => !IMPORT_FIELDS.some(field => field.value === value))) throw new Error('O mapeamento contém um campo não permitido.')
  const namespace = options.sourceNamespace?.trim()
  if (targets.includes('sourceId') && (!namespace || namespace.length > 120 || /[\u0000-\u001f\u007f-\u009f]/u.test(namespace))) throw new Error('Para usar um identificador de origem, informe o sistema/conta de origem confiável ou ignore essa coluna.')
  const result: PreparedImport = { records: [], rows: [], errors: [], duplicates: 0, conflicts: 0, total: parsed.rows.length, missingEssential: 0, unmappedStages: 0, unmappedOwners: 0 }
  const references = new Map<string, Set<number>>()
  for (let index = 0; index < parsed.rows.length; index++) {
    if (index % 100 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
    const row = parsed.rows[index], values: Partial<Record<ImportField, ImportCell>> = {}, notes: string[] = []
    for (let column = 0; column < parsed.headers.length; column++) {
      const target = mapping[column] || 'ignore', value = row.values[column] ?? null
      if (target === 'notes-extra') { const text = importCellText(value); if (text) notes.push(`${parsed.headers[column]}: ${text}`) }
      else if (target !== 'ignore') values[target] = value
    }
    const errors: string[] = []
    const fail = (field: ImportField, message: string) => { errors.push(message); result.errors.push({ rowNumber: row.rowNumber, field, message: `Linha ${row.rowNumber}: ${message}` }) }
    const text = (field: ImportField) => importCellText(values[field])
    const parse = <T,>(field: ImportField, fallback: T, fn: () => T): T => { try { return fn() } catch (cause) { fail(field, `${IMPORT_FIELDS.find(item => item.value === field)!.label.toLocaleLowerCase('pt-BR')}: ${(cause as Error).message}`); return fallback } }
    const name = text('name')
    if (!name) { fail('name', 'nome não informado.'); result.missingEssential++ }
    else if (name.length > 200) fail('name', 'nome deve ter até 200 caracteres.')
    const email = text('email').toLowerCase()
    if (email && (!/^[^\s@<>"\\]+@[^\s@<>"\\]+\.[^\s@<>"\\]+$/u.test(email) || email.length > 254)) fail('email', 'e-mail inválido.')
    const rawPhone = text('phone'), digits = rawPhone.replace(/\D/g, '')
    if (rawPhone && (!/^[\d+(). /-]+$/.test(rawPhone) || digits.length < 5 || digits.length > 32 || (typeof values.phone === 'number' && !Number.isSafeInteger(values.phone)))) fail('phone', 'telefone inválido. Use texto com 5 a 32 dígitos para preservar o número.')
    const phone = rawPhone.startsWith('+') ? `+${digits}` : digits
    const sourceStage = text('stage'), sourceOwner = text('owner')
    const selectedStage = sourceStage ? Object.hasOwn(options.stageMap, sourceStage) ? options.stageMap[sourceStage] || options.defaultStageId : '' : options.defaultStageId
    const stage = options.stages.find(stage => stage.id === selectedStage && stage.active)
    if (!stage) { fail('stage', 'etapa não encontrada. Relacione a etapa ou escolha uma etapa padrão.'); result.unmappedStages++ }
    const selectedOwner = sourceOwner ? Object.hasOwn(options.ownerMap, sourceOwner) ? options.ownerMap[sourceOwner] || options.defaultOwnerId : '' : options.defaultOwnerId
    const member = options.members.find(member => member.userId === selectedOwner && member.active !== false && member.role !== 'viewer')
    if (!member) { fail('owner', 'responsável não encontrado. Escolha um membro ativo com permissão de edição.'); result.unmappedOwners++ }
    const mergedNotes = [text('notes'), ...notes].filter(Boolean).join('\n\n')
    if (mergedNotes.length > IMPORT_LIMITS.cellCharacters) fail('notes', 'observações combinadas ultrapassam 10.000 caracteres. Revise as colunas adicionais.')
    const attendance = parse('attendance', 'Pendente' as Lead['attendance'], () => choice(text('attendance'), ['Pendente', 'Compareceu', 'Não compareceu'] as const, 'Pendente', { pending: 'Pendente', attended: 'Compareceu', 'no show': 'Não compareceu', 'nao compareceu': 'Não compareceu' }))
    const closedValue = parse('closedValue', 0, () => parseImportMoney(values.closedValue ?? null, options.numericFormat))
    const closedAt = parse('closedAt', '', () => parseImportDate(values.closedAt ?? null, options.timeZone, false, options.dateFormat))
    const lossReason = parse('lossReason', '', () => text('lossReason') ? choice(text('lossReason'), LOSS_REASONS, 'Outro') : '')
    if (stage?.type === 'WON' && (closedValue <= 0 || !closedAt || attendance !== 'Compareceu')) fail('stage', 'uma oportunidade ganha exige valor de fechamento positivo, data de fechamento e comparecimento informado como Compareceu.')
    if (stage?.type === 'LOST' && !lossReason) fail('lossReason', 'uma oportunidade perdida exige um motivo de perda válido.')
    if (stage?.type !== 'WON' && (closedValue > 0 || closedAt)) fail('stage', 'há dados de fechamento em uma etapa que não é de vitória. Revise o mapeamento da etapa.')
    const sourceId = text('sourceId')
    if (typeof values.sourceId === 'number' && !Number.isSafeInteger(values.sourceId)) fail('sourceId', 'identificador numérico de origem perdeu precisão ou não é inteiro. Formate essa coluna como texto no arquivo original.')
    if (sourceId.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(sourceId)) fail('sourceId', 'identificador de origem inválido ou maior que 200 caracteres.')
    const rowKey = await hash(JSON.stringify([parsed.fileHash, parsed.sheetName, row.rowNumber]))
    const status = stage?.type === 'WON' ? 'Fechado' : stage?.type === 'LOST' ? 'Perdido' : STATUSES.find(status => status === stage?.name && status !== 'Fechado' && status !== 'Perdido') || 'Lead novo'
    const lead: Lead = {
      id: `import-${rowKey}`, name, company: text('company'), email, phone, source: text('source'), ticket: parse('ticket', 0, () => parseImportMoney(values.ticket ?? null, options.numericFormat)),
      createdAt: parse('createdAt', '', () => parseImportDate(values.createdAt ?? null, options.timeZone, false, options.dateFormat)), callDate: parse('callDate', '', () => parseImportDate(values.callDate ?? null, options.timeZone, true, options.dateFormat)), attendance, objection: text('objection'), status,
      closedValue, closedAt, lastContactAt: parse('lastContactAt', '', () => parseImportDate(values.lastContactAt ?? null, options.timeZone, false, options.dateFormat)), notes: mergedNotes, pain: text('pain'),
      urgency: parse('urgency', 'Média' as Lead['urgency'], () => choice(text('urgency'), ['Baixa', 'Média', 'Alta'] as const, 'Média', { low: 'Baixa', medium: 'Média', high: 'Alta' })),
      financialCapacity: parse('financialCapacity', 'Não avaliada' as Lead['financialCapacity'], () => choice(text('financialCapacity'), ['Não avaliada', 'Baixa', 'Média', 'Alta'] as const, 'Não avaliada', { low: 'Baixa', medium: 'Média', high: 'Alta', 'not assessed': 'Não avaliada' })),
      decisionMaker: parse('decisionMaker', false, () => choice(text('decisionMaker'), ['true', 'false'] as const, 'false', { sim: 'true', yes: 'true', '1': 'true', nao: 'false', no: 'false', '0': 'false' }) === 'true'), callScore: null, closerError: '', callSummary: '', stageId: stage?.id, stageType: stage?.type, stageName: stage?.name, lossReason, lossComment: text('lossComment'),
    }
    if (lead.lossComment && lead.lossComment.length > 4000) fail('lossComment', 'detalhes da perda devem ter até 4.000 caracteres.')
    if (!errors.length && !validLead(lead)) fail('name', 'os dados não atendem às validações do HIGH CLOSER.')
    const prepared = { rowNumber: row.rowNumber, lead, ownerId: member?.userId, stageId: stage?.id, status: 'valid' as 'valid' | 'duplicate' | 'conflict' | 'error', errors }
    if (errors.length) prepared.status = 'error'
    else {
      const identifiers = [email && `email:${email}`, digits && `phone:${digits}`, sourceId && namespace && `source:${sourceId}`].filter(Boolean) as string[]
      const matches = new Set(identifiers.flatMap(identifier => [...references.get(identifier) || []]))
      if (matches.size > 1) { prepared.status = 'conflict'; result.conflicts++ }
      else if (matches.size === 1) { prepared.status = 'duplicate'; result.duplicates++ }
      else {
        for (const identifier of identifiers) { const refs = references.get(identifier) || new Set<number>(); refs.add(row.rowNumber); references.set(identifier, refs) }
      }
      // Local matches are hints, not authority: an earlier row can itself match
      // an existing lead and be ignored without merging its new phone/e-mail.
      // Send every structurally valid row so the tenant-scoped backend can decide.
      result.records.push({ rowNumber: row.rowNumber, rowKey, ownerId: member!.userId, stageId: stage!.id, lead, ...(sourceId ? { sourceId } : {}) } satisfies ImportRecord)
    }
    result.rows.push(prepared)
  }
  return result
}
