import { afterEach, describe, expect, it, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { parseImportCsv, parseLeadImportBuffer, readLeadImportFile, validateImportWorkbook } from '../src/lib/lead-import-reader'
import { buildImportRows, parseImportDate, parseImportMoney, suggestColumnMappings } from '../src/lib/lead-import-normalization'
import type { ImportOptions } from '../src/lib/lead-import-types'
import type { Stage } from '../src/types'
import { buildImportWorkbook } from './helpers/import-workbook'

const stageId = '40000000-0000-4000-8000-000000000004', ownerId = '30000000-0000-4000-8000-000000000003'
const stages: Stage[] = [{ id: stageId, pipelineId: '20000000-0000-4000-8000-000000000002', name: 'Diagnóstico executivo', type: 'NORMAL', active: true, color: '#336699', position: 0 }, { id: '40000000-0000-4000-8000-000000000005', pipelineId: '20000000-0000-4000-8000-000000000002', name: 'Contrato assinado', type: 'WON', active: true, color: '#336699', position: 1 }, { id: '40000000-0000-4000-8000-000000000006', pipelineId: '20000000-0000-4000-8000-000000000002', name: 'Sem fit', type: 'LOST', active: true, color: '#336699', position: 2 }]
const options: ImportOptions = { stages, members: [{ userId: ownerId, displayName: 'Ana', role: 'manager', active: true }], defaultStageId: stageId, defaultOwnerId: ownerId, stageMap: {}, ownerMap: {}, timeZone: 'America/Bahia', numericFormat: 'br' }
const buffer = (text: string) => new TextEncoder().encode(text).buffer
const prepared = (csv: string, config: Partial<ImportOptions> = {}) => { const file = parseImportCsv(csv, 'leads.csv', 'a'.repeat(64)); return buildImportRows(file, suggestColumnMappings(file.headers), { ...options, ...config }) }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('consolidated local file reader', () => {
  it('reads UTF-8 BOM, semicolons, quotes, literal formulas, embedded commas and newlines without splitting cells', () => {
    const file = parseImportCsv('\uFEFFNome;Empresa;Observações\r\n"Ana; Maria";"Corp, SA";"Linha 1\nLinha 2 ""citada"""\r\nJoão;Outra;=HYPERLINK(""https://example.com"")')
    expect(file.headers).toEqual(['Nome', 'Empresa', 'Observações'])
    expect(file.rows[0]).toEqual({ rowNumber: 2, values: ['Ana; Maria', 'Corp, SA', 'Linha 1\nLinha 2 "citada"'] })
    expect(file.rows[1].rowNumber).toBe(4)
    expect(file.rows[1].values[2]).toContain('HYPERLINK')
  })
  it('reads comma-separated CSV, ignores truly empty rows and preserves empty cells', () => {
    const file = parseImportCsv('Name,Email,Company\n\nAna,,Acme\n,,\nBruno,bruno@example.com,')
    expect(file.rows).toEqual([{ rowNumber: 3, values: ['Ana', '', 'Acme'] }, { rowNumber: 5, values: ['Bruno', 'bruno@example.com', ''] }])
  })
  it.each(['', 'Nome\n', 'Nome;Nome\nA;B', ';Email\nA;b@example.com', 'Nome;Observações\nAna;"unterminated', 'Nome\n\u0000binary'])('rejects empty, ambiguous headers and malformed files without partial table (%j)', text => {
    expect(() => parseImportCsv(text)).toThrow()
  })
  it('rejects rows with extra fields rather than losing values', () => { expect(() => parseImportCsv('Nome;Empresa\nAna;Acme;important')).toThrow('mais valores') })
  it('supports Excel CSV separator declarations', () => { expect(parseImportCsv('sep=;\r\nNome;Empresa\r\nAna;Acme').rows[0]).toEqual({ rowNumber: 3, values: ['Ana', 'Acme'] }) })
  it('rejects non-UTF-8 and old XLS explicitly', async () => {
    await expect(parseLeadImportBuffer(new Uint8Array([0xff, 0xfe, 0x41]).buffer, 'leads.csv')).rejects.toThrow('UTF-8')
    await expect(parseLeadImportBuffer(buffer('anything'), 'leads.xls')).rejects.toThrow('.xls')
  })
  it('caps total file, row, column and cell volume before import', async () => {
    await expect(parseLeadImportBuffer(new ArrayBuffer(10 * 1024 * 1024 + 1), 'leads.csv')).rejects.toThrow('10 MB')
    expect(() => parseImportCsv('Nome\n' + Array(10001).fill('Ana').join('\n'))).toThrow('10.000')
    expect(() => parseImportCsv(Array.from({ length: 101 }, (_, i) => `campo${i}`).join(';') + '\nAna')).toThrow('100 colunas')
    expect(() => parseImportCsv('Nome\n' + 'a'.repeat(10001))).toThrow('10.000 caracteres')
  })
  it('rejects a fake XLSX archive, entity expansion, sparse row allocation and oversized columns', () => {
    expect(() => validateImportWorkbook(new Uint8Array([0x50, 0x4b, 1]))).toThrow('XLSX')
    const zip = (text: string) => zipSync({ 'xl/workbook.xml': strToU8('<workbook/>'), 'xl/worksheets/sheet1.xml': strToU8(text) })
    expect(() => validateImportWorkbook(zip('<!DOCTYPE x><worksheet/>'))).toThrow('XML')
    expect(() => validateImportWorkbook(zip('<worksheet><row r="1000000"><c r="A1000000"/></row></worksheet>'))).toThrow('10.000')
    expect(() => validateImportWorkbook(zip('<worksheet><c r="XFD2"/></worksheet>'))).toThrow('100 colunas')
    expect(() => validateImportWorkbook(zip("<worksheet><row r='1000000'><c r='A1000000'/></row></worksheet>"))).toThrow('10.000')
    expect(() => validateImportWorkbook(zip("<worksheet><c r='A&#49;000000'/></worksheet>"))).toThrow('10.000')
    expect(() => validateImportWorkbook(zip("<worksheet><c r='&#x58;FD2'/></worksheet>"))).toThrow('100 colunas')
  })
  it.each([false, true])('reads actual OOXML sheets and preserves Excel money, dates and blanks (1904 epoch %s)', async date1904 => {
    const original = new Date('2026-10-12T17:30:00.000Z')
    const subsecond = new Date('2026-10-12T17:30:12.999Z')
    const workbook = buildImportWorkbook({ date1904, sheets: [{ name: 'Arquivo antigo', rows: [['Nome'], ['Antigo']] }, { name: 'Leads & clientes', rows: [['Nome', 'Data da call', 'Ticket', 'Empresa'], ['Ana', original, 12345.67, null], ['Bruno', subsecond, 0, 'Corp']] }] })
    const bytes = Uint8Array.from(workbook).buffer
    const first = await parseLeadImportBuffer(bytes, 'leads.xlsx')
    expect(first.sheets).toEqual(['Arquivo antigo', 'Leads & clientes'])
    expect(first.sheetName).toBe('Arquivo antigo')
    const selected = await parseLeadImportBuffer(bytes, 'leads.xlsx', 'Leads & clientes')
    expect(selected.rows[0].values).toEqual(['Ana', original, 12345.67, null])
    expect(selected.rows[1].values[1]).toEqual(subsecond)
    await expect(parseLeadImportBuffer(bytes, 'leads.xlsx', 'Outra aba')).rejects.toThrow('aba')
    const result = await buildImportRows(selected, suggestColumnMappings(selected.headers), options)
    expect(result.records[0].lead).toMatchObject({ callDate: '2026-10-12T20:30:00.000Z', ticket: 12345.67, attendance: 'Pendente', company: '' })
    expect(result.records[1].lead.callDate).toBe('2026-10-12T20:30:12.999Z')
  })
  it('bounds actual inflated ZIP content even when the compressed file is tiny', () => {
    const archive = zipSync({ 'xl/workbook.xml': strToU8('<workbook/>'), 'xl/worksheets/sheet1.xml': strToU8(' '.repeat(16 * 1024 * 1024 + 1)) })
    expect(archive.length).toBeLessThan(100000)
    expect(() => validateImportWorkbook(archive)).toThrow('expandida')
  })
})

describe('private disposable browser reader', () => {
  function browserWorker() {
    const workers: TestWorker[] = []
    class TestWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null
      onerror: (() => void) | null = null
      postMessage = vi.fn()
      terminate = vi.fn()
      constructor() { workers.push(this) }
    }
    vi.stubGlobal('Worker', TestWorker)
    return workers
  }
  it('transfers the local buffer into a disposable worker and terminates it after a result', async () => {
    const workers = browserWorker(), file = new File(['Nome\nAna'], 'private.csv')
    const pending = readLeadImportFile(file)
    await vi.waitFor(() => expect(workers).toHaveLength(1))
    const worker = workers[0], args = worker.postMessage.mock.calls[0]
    expect(args[0]).toMatchObject({ fileName: 'private.csv' })
    expect(args[1]).toEqual([args[0].buffer])
    const parsed = parseImportCsv('Nome\nAna')
    worker.onmessage?.({ data: { ok: true, result: parsed } })
    expect(await pending).toEqual(parsed)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })
  it('terminates work on an aborted scope and rejects without displaying a late result', async () => {
    const workers = browserWorker(), controller = new AbortController()
    const pending = readLeadImportFile(new File(['Nome\nAna'], 'private.csv'), undefined, controller.signal)
    const failure = expect(pending).rejects.toThrow('cancelada')
    await vi.waitFor(() => expect(workers).toHaveLength(1))
    controller.abort()
    workers[0].onmessage?.({ data: { ok: true, result: parseImportCsv('Nome\nOutra empresa') } })
    await failure
    expect(workers[0].terminate).toHaveBeenCalledTimes(1)
  })
  it('bounds worker reading at 30 seconds and terminates the worker', async () => {
    vi.useFakeTimers()
    const workers = browserWorker()
    const pending = readLeadImportFile(new File(['Nome\nAna'], 'private.csv'))
    const failure = expect(pending).rejects.toThrow('demorou demais')
    await vi.advanceTimersByTimeAsync(0)
    expect(workers).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30000)
    await failure
    expect(workers[0].terminate).toHaveBeenCalledTimes(1)
  })
  it('does not construct a worker when the operation was already cancelled', async () => {
    const workers = browserWorker(), controller = new AbortController(); controller.abort()
    await expect(readLeadImportFile(new File(['Nome\nAna'], 'private.csv'), undefined, controller.signal)).rejects.toThrow('cancelada')
    expect(workers).toHaveLength(0)
  })
})

describe('explicit financial and calendar interpretation', () => {
  it.each([['R$ 15.000,50', 'br', 15000.5], ['15000,5', 'br', 15000.5], [15000.5, 'br', 15000.5], ['1,234.56', 'international', 1234.56], ['1234.56', 'auto', 1234.56], ['1.234,56', 'auto', 1234.56], ['1.234', 'br', 1234], ['1,234', 'international', 1234]])('preserves exact amount %j in %s', (value, format, expected) => {
    expect(parseImportMoney(value, format as 'br' | 'international' | 'auto')).toBe(expected)
  })
  it.each([['1.234', 'auto'], ['1,234', 'auto'], ['15000.50', 'br'], ['15,000.50', 'br'], ['-5', 'br'], ['1e6', 'br'], [Infinity, 'br']])('rejects ambiguous/incompatible monetary value %j in %s', (value, format) => {
    expect(() => parseImportMoney(value, format as 'br' | 'international' | 'auto')).toThrow()
  })
  it('resolves Brazilian wall meeting time in selected IANA zone and retains explicit ISO instant', () => {
    expect(parseImportDate('12/10/2026 14:30', 'America/Bahia', true)).toBe('2026-10-12T17:30:00.000Z')
    expect(parseImportDate('2026-10-12T14:30:12.125-03:00', 'Asia/Tokyo', true)).toBe('2026-10-12T17:30:12.125Z')
    expect(parseImportDate(new Date('2026-10-12T14:30:00Z'), 'America/Bahia', true)).toBe('2026-10-12T17:30:00.000Z')
    expect(parseImportDate('12/10/2026', 'America/Bahia')).toBe('2026-10-12T03:00:00.000Z')
  })
  it.each(['31/02/2026 10:00', '29/02/2025 10:00', '2026-13-01T10:00:00Z', '12/10/2026 25:00', '2026-10-12T10:30:00+99:00'])('rejects invalid calendar/offset %j rather than rolling dates over', text => {
    expect(() => parseImportDate(text, 'America/Bahia', true)).toThrow()
  })
  it('rejects date-only meetings, unstylized Excel numbers and ambiguous/gap DST wall times', () => {
    expect(() => parseImportDate('12/10/2026', 'America/Bahia', true)).toThrow('horário')
    expect(() => parseImportDate(46307, 'America/Bahia', true)).toThrow('formato')
    expect(() => parseImportDate('2026-03-08T02:30', 'America/New_York', true)).toThrow('não existe')
    expect(() => parseImportDate('2026-11-01T01:30', 'America/New_York', true)).toThrow('ambíguo')
  })
  it('treats whitespace-only date cells as missing and rejects invalid destination time zones for ISO-only files', async () => {
    expect(parseImportDate('   ', 'America/Bahia', true)).toBe('')
    await expect(prepared('Nome;Data da call\nAna;2026-10-12T10:00:00Z', { timeZone: 'Invalid/Zone' })).rejects.toThrow('Fuso horário inválido')
  })
})

describe('safe mapping and preservation', () => {
  it('suggests only exact aliases and does not presume close date, date, generic IDs or unknown headings', () => {
    expect(suggestColumnMappings(['Nome do contato', 'Phone', 'E-mail', 'Company', 'Deal Value', 'Assigned To', 'Close Date', 'Date', 'ID', 'Custom field'])).toEqual({ 0: 'name', 1: 'phone', 2: 'email', 3: 'company', 4: 'ticket', 5: 'owner', 6: 'closedAt', 7: 'ignore', 8: 'ignore', 9: 'ignore' })
    expect(suggestColumnMappings(['Nome', 'Contact Name'])).toEqual({ 0: 'name', 1: 'ignore' })
  })
  it('keeps safe defaults without assuming attendance, leadership evaluation or historical contact', async () => {
    const result = await prepared('Nome;Data da call;Ticket\nAna;01/01/2020 10:00;15.000,50')
    expect(result.records).toHaveLength(1)
    expect(result.records[0].lead).toMatchObject({ name: 'Ana', ticket: 15000.5, callDate: '2020-01-01T13:00:00.000Z', createdAt: '', lastContactAt: '', attendance: 'Pendente', urgency: 'Média', financialCapacity: 'Não avaliada', decisionMaker: false, callScore: null, closerError: '', callSummary: '', stageId, stageName: 'Diagnóstico executivo' })
    expect(result.records[0].lead).not.toHaveProperty('leadershipReview')
  })
  it('preserves all valid strategic fields and historical dates', async () => {
    const result = await prepared('Nome;Empresa;E-mail;Telefone;Origem;Ticket;Comparecimento;Objeções;Observações;Dor principal;Urgência;Capacidade financeira;Decisor;Data de criação;Último contato\nAna;Corp; ANA@EXAMPLE.COM ;+55 (71) 98888-7777;Kommo;1.234,56;Compareceu;Caixa;Texto;Dor;Alta;Média;sim;01/01/2024;12/10/2026 14:00')
    expect(result.records[0].lead).toMatchObject({ company: 'Corp', email: 'ana@example.com', phone: '+5571988887777', source: 'Kommo', ticket: 1234.56, attendance: 'Compareceu', objection: 'Caixa', notes: 'Texto', pain: 'Dor', urgency: 'Alta', financialCapacity: 'Média', decisionMaker: true, createdAt: '2024-01-01T03:00:00Z'.replace('00Z', '00.000Z'), lastContactAt: '2026-10-12T17:00:00.000Z' })
  })
  it('requires explicit mapping for unknown source stages/owners and supports intentional default assignment', async () => {
    const file = parseImportCsv('Nome;Etapa;Responsável\nAna;Negotiation;Former seller')
    const mapping = suggestColumnMappings(file.headers)
    const unmapped = await buildImportRows(file, mapping, options)
    expect(unmapped.records).toHaveLength(0)
    expect(unmapped).toMatchObject({ unmappedStages: 1, unmappedOwners: 1 })
    const mapped = await buildImportRows(file, mapping, { ...options, stageMap: { Negotiation: stageId }, ownerMap: { 'Former seller': ownerId } })
    expect(mapped.records[0]).toMatchObject({ ownerId, stageId })
  })
  it('rejects inactive, viewer and unknown member destinations', async () => {
    expect((await prepared('Nome\nAna', { members: [{ userId: ownerId, displayName: 'Viewer', role: 'viewer' }] })).records).toHaveLength(0)
    expect((await prepared('Nome\nAna', { members: [{ userId: ownerId, displayName: 'Former', active: false }] })).records).toHaveLength(0)
  })
  it('keeps unknown columns ignored until the user deliberately appends labeled literal contents', async () => {
    const file = parseImportCsv('Nome;Notas;Custom\nAna;Original;<script>alert(1)</script>')
    const mapping = suggestColumnMappings(file.headers)
    expect((await buildImportRows(file, mapping, options)).records[0].lead.notes).toBe('Original')
    expect((await buildImportRows(file, { ...mapping, 2: 'notes-extra' }, options)).records[0].lead.notes).toBe('Original\n\nCustom: <script>alert(1)</script>')
  })
  it('detects duplicates and conflicting email/phone matches inside the full file', async () => {
    const result = await prepared('Nome;Email;Telefone\nA;a@example.com;11111\nB;b@example.com;22222\nRepeat;A@example.com;11111\nConflict;a@example.com;22222')
    expect(result.records).toHaveLength(4)
    expect(result.rows.map(row => row.status)).toEqual(['valid', 'valid', 'duplicate', 'conflict'])
    expect(result).toMatchObject({ duplicates: 1, conflicts: 1 })
  })
  it('never discards locally matched rows before the backend can classify existing nonmerged contacts', async () => {
    const result = await prepared('Nome;Email;Telefone\nExisting candidate;a@example.com;22222\nIndependent lead;b@example.com;22222')
    expect(result.rows.map(row => row.status)).toEqual(['valid', 'duplicate'])
    expect(result.records.map(record => record.lead.email)).toEqual(['a@example.com', 'b@example.com'])
  })
  it('aligns contact limits with server-side validation', async () => {
    const short = await prepared('Nome;Telefone\nAna;123')
    expect(short.records).toHaveLength(0)
    expect(short.errors[0].message).toContain('5 a 32')
    const long = await prepared(`Nome;Email\nAna;${'a'.repeat(246)}@example.com`)
    expect(long.records).toHaveLength(0)
  })
  it('generates stable retries without depending on email, phone, filename or current clock', async () => {
    const first = await prepared('Nome\nAna\nBruno'), second = await prepared('Nome\nAna\nBruno')
    expect(first.records.map(record => record.rowKey)).toEqual(second.records.map(record => record.rowKey))
    expect(first.records[0].rowKey).not.toBe(first.records[1].rowKey)
    expect(first.records[0].lead.id).toBe(`import-${first.records[0].rowKey}`)
  })
  it('only uses external identifiers after an explicit mapping and source namespace choice', async () => {
    const file = parseImportCsv('Nome;ID\nAna;42'), mapping = { ...suggestColumnMappings(file.headers), 1: 'sourceId' as const }
    await expect(buildImportRows(file, mapping, options)).rejects.toThrow('origem confiável')
    const result = await buildImportRows(file, mapping, { ...options, sourceNamespace: 'kommo-account-123' })
    expect(result.records[0].sourceId).toBe('42')
  })
  it('rejects unsafe numeric Excel identifiers/phones and preserves long text identifiers and safe numeric phones', async () => {
    const file = parseImportCsv('Nome;ID;Telefone\nAna;id;phone'), mapping = { ...suggestColumnMappings(file.headers), 1: 'sourceId' as const }
    file.rows = [
      { rowNumber: 2, values: ['Unsafe ID', Number.MAX_SAFE_INTEGER + 1, '5571988887777'] },
      { rowNumber: 3, values: ['Fractional ID', 12.5, '5571988887778'] },
      { rowNumber: 4, values: ['Unsafe phone', '42', Number.MAX_SAFE_INTEGER + 1] },
      { rowNumber: 5, values: ['Text identity', '00900719925474099212345', 557198888777799] },
    ]
    const result = await buildImportRows(file, mapping, { ...options, sourceNamespace: 'crm-client-a' })
    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toMatchObject({ rowNumber: 5, sourceId: '00900719925474099212345', lead: { phone: '557198888777799' } })
    expect(result.errors.filter(error => error.field === 'sourceId')).toHaveLength(2)
    expect(result.errors.filter(error => error.field === 'phone')).toHaveLength(1)
  })
  it('rejects silent victory/loss fabrication and requires current terminal-stage evidence', async () => {
    const won = stages[1].id, lost = stages[2].id
    expect((await prepared('Nome\nAna', { defaultStageId: won })).records).toHaveLength(0)
    expect((await prepared('Nome;Valor de fechamento;Data de fechamento;Comparecimento\nAna;5.000,50;12/10/2026;Compareceu', { defaultStageId: won })).records[0].lead).toMatchObject({ status: 'Fechado', closedValue: 5000.5, closedAt: '2026-10-12T03:00:00.000Z' })
    expect((await prepared('Nome\nAna', { defaultStageId: lost })).records).toHaveLength(0)
    expect((await prepared('Nome;Motivo de perda\nAna;Timing', { defaultStageId: lost })).records[0].lead.lossReason).toBe('Timing')
  })
  it('returns comprehensible row errors and rejects duplicate mappings', async () => {
    const result = await prepared('Nome;Email;Data da call\n;wrong;31/02/2026 11:00')
    expect(result.errors.map(error => error.message)).toEqual(expect.arrayContaining(['Linha 2: nome não informado.', 'Linha 2: e-mail inválido.']))
    const file = parseImportCsv('Nome;Name\nAna;Another')
    await expect(buildImportRows(file, { 0: 'name', 1: 'name' }, options)).rejects.toThrow('somente uma')
  })
  it('prepares at least 2,000 records with bounded asynchronous yields and deterministic identities', async () => {
    const file = parseImportCsv('Nome;Email\n' + Array.from({ length: 2200 }, (_, index) => `Lead ${index};lead${index}@example.com`).join('\n'), 'large.csv', 'f'.repeat(64))
    const result = await buildImportRows(file, suggestColumnMappings(file.headers), options)
    expect(result.records).toHaveLength(2200)
    expect(new Set(result.records.map(record => record.rowKey)).size).toBe(2200)
    expect(result.errors).toHaveLength(0)
  })
})
