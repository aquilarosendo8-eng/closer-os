import Papa from 'papaparse'
import readXlsxFile from 'read-excel-file/web-worker'
import { Unzip, UnzipInflate } from 'fflate'
import { IMPORT_LIMITS, type ImportCell, type ParsedImportFile } from './lead-import-types'

export { buildImportRows, suggestColumnMappings, IMPORT_FIELDS, importCellText, parseImportMoney, parseImportDate } from './lead-import-normalization'

export async function importHash(value: string | ArrayBuffer): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
}

function table(headersAndRows: ImportCell[][], fileName: string, fileHash: string, format: ParsedImportFile['format'], sheets: string[], sheetName: string): ParsedImportFile {
  const indexed = headersAndRows.map((values, index) => ({ rowNumber: index + 1, values })).filter(row => row.values.some(value => value !== null && String(value).trim() !== ''))
  if (!indexed.length) throw new Error('O arquivo está vazio. Inclua o cabeçalho e pelo menos um lead.')
  const header = indexed.shift()!
  if (header.values.length > IMPORT_LIMITS.columns) throw new Error('Use uma planilha com até 100 colunas.')
  const headers = header.values.map((value, index) => {
    const label = value === null ? '' : String(value).trim()
    if (!label || label.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(label)) throw new Error(`O cabeçalho da coluna ${index + 1} está vazio ou inválido. Corrija o arquivo.`)
    return label
  })
  if (new Set(headers.map(header => header.toLocaleLowerCase('pt-BR'))).size !== headers.length) throw new Error('Há cabeçalhos repetidos. Dê um nome distinto a cada coluna antes de importar.')
  if (!indexed.length) throw new Error('O arquivo tem somente cabeçalhos. Inclua pelo menos um lead.')
  if (indexed.length > IMPORT_LIMITS.rows) throw new Error('Importe até 10.000 leads por arquivo. Divida a base em arquivos menores.')
  for (const row of indexed) {
    if (row.values.length > headers.length) throw new Error(`Linha ${row.rowNumber}: há mais valores do que colunas no cabeçalho.`)
    for (const value of row.values) {
      if ((typeof value === 'number' && !Number.isFinite(value)) || (value instanceof Date && !Number.isFinite(value.getTime()))) throw new Error(`Linha ${row.rowNumber}: uma célula tem valor inválido.`)
      if (value !== null && String(value).length > IMPORT_LIMITS.cellCharacters) throw new Error(`Linha ${row.rowNumber}: uma célula ultrapassa 10.000 caracteres.`)
      if (typeof value === 'string' && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) throw new Error(`Linha ${row.rowNumber}: uma célula contém caracteres de controle inválidos.`)
    }
    while (row.values.length < headers.length) row.values.push(null)
  }
  return { fileName, fileHash, format, sheets, sheetName, headers, rows: indexed }
}

/** Library-based CSV parsing, with physical line numbers retained even for quoted multiline cells. */
export function parseImportCsv(text: string, fileName = 'leads.csv', fileHash = ''): ParsedImportFile {
  let source = text.replace(/^\uFEFF/u, '')
  if (!source.trim()) throw new Error('O arquivo está vazio. Inclua o cabeçalho e pelo menos um lead.')
  if (source.includes('\u0000')) throw new Error('Use um CSV UTF-8 válido; arquivos binários não são aceitos como CSV.')
  // Excel sometimes writes this declaration before the real header.
  const declaration = /^sep=([;,])\r?\n/i.exec(source)
  if (declaration) source = source.slice(declaration[0].length)
  const parsed = Papa.parse<string[]>(source, { delimiter: declaration?.[1] || '', delimitersToGuess: [',', ';'], skipEmptyLines: false, dynamicTyping: false })
  const actualErrors = parsed.errors.filter(error => error.code !== 'UndetectableDelimiter')
  if (actualErrors.length) throw new Error('O CSV contém aspas ou separadores inválidos. Exporte novamente em UTF-8 e mantenha os campos entre aspas quando necessário.')
  const result = table(parsed.data, fileName, fileHash, 'csv', [], '')
  // Papa's cursor respects embedded newlines; use its streaming callback to retain source line numbers.
  let cursor = 0, physicalLine = declaration ? 2 : 1
  const physical: number[] = []
  Papa.parse<string[]>(source, { delimiter: parsed.meta.delimiter, skipEmptyLines: false, dynamicTyping: false, step: row => {
    if (row.data.some(value => String(value).trim())) physical.push(physicalLine)
    const segment = source.slice(cursor, row.meta.cursor)
    physicalLine += (segment.match(/\r\n|\r|\n/g) || []).length
    cursor = row.meta.cursor
  } })
  result.rows.forEach((row, index) => { row.rowNumber = physical[index + 1] })
  return result
}

const decodeXmlAttribute = (value: string) => value.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/gi, (_, hex: string, decimal: string, entity: string) => {
  if (hex || decimal) {
    const point = Number.parseInt(hex || decimal, hex ? 16 : 10)
    if (!Number.isSafeInteger(point) || point < 1 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw new Error('A planilha contém uma referência XML inválida. Exporte novamente o arquivo.')
    return String.fromCodePoint(point)
  }
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()]
})
const xmlAttributes = (value: string) => Object.fromEntries([...value.matchAll(/([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g)].map(match => [match[1], decodeXmlAttribute(match[3])]))
interface WorkbookMetadata {
  workbook: string
  relationships: string
  numericCells: Map<string, Map<string, number>>
}

/** Verify actual expanded bytes before the XLSX reader sees the archive, including forged ZIP sizes. */
export function validateImportWorkbook(bytes: Uint8Array): WorkbookMetadata {
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('O arquivo não é uma planilha XLSX válida. Exporte novamente no formato .xlsx.')
  let total = 0, entries = 0, workbook = false, failure: Error | undefined
  const metadata: WorkbookMetadata = { workbook: '', relationships: '', numericCells: new Map() }
  const zip = new Unzip(file => {
    entries++
    if (entries > 1000 || (file.originalSize !== undefined && file.originalSize > 16 * 1024 * 1024)) { failure = new Error('A planilha expandida é grande demais. Divida a base em arquivos menores.'); return }
    const chunks: Uint8Array[] = []; let size = 0
    const xml = /\.(?:xml|rels)$/i.test(file.name)
    if (file.name === 'xl/workbook.xml') workbook = true
    file.ondata = (error, chunk, final) => {
      // fflate catches exceptions from ondata as decompression errors. Retain
      // our safe validation reason and throw only after zip.push returns.
      if (failure) return
      if (error) { failure = new Error('A planilha XLSX está corrompida. Exporte novamente o arquivo.'); return }
      total += chunk.length; size += chunk.length
      if (total > IMPORT_LIMITS.expandedBytes || size > 16 * 1024 * 1024) { file.terminate(); failure = new Error('A planilha expandida é grande demais. Divida a base em arquivos menores.'); return }
      if (xml) chunks.push(chunk)
      if (final && xml) {
        try {
        const contents = new Uint8Array(size); let offset = 0
        for (const part of chunks) { contents.set(part, offset); offset += part.length }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(contents)
        if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('A planilha contém estruturas XML não permitidas. Exporte novamente como uma planilha simples.')
        if (/^xl\/worksheets\//.test(file.name)) {
          // Bound sparse coordinate allocation as well as populated rows.
          for (const match of text.matchAll(/\b(?:r|ref)\s*=\s*(["'])(.*?)\1/g)) {
            const references = decodeXmlAttribute(match[2]).split(':')
            for (const reference of references) {
              const coordinate = /^(?:([A-Z]+))?([1-9]\d*)$/i.exec(reference)
              if (!coordinate) throw new Error('A planilha contém uma referência de célula inválida. Exporte novamente o arquivo.')
              let column = 0
              for (const letter of (coordinate[1] || '').toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64
              if (column > IMPORT_LIMITS.columns || Number(coordinate[2]) > IMPORT_LIMITS.rows + 1) throw new Error('A planilha ultrapassa 10.000 linhas ou 100 colunas. Remova linhas/colunas extras ou divida o arquivo.')
            }
          }
          // Keep only raw numeric cell metadata. The maintained library still
          // parses worksheets, types, styles, relationships and date epochs.
          const cells = new Map<string, number>()
          for (const cell of text.matchAll(/<(?:[\w.-]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c\s*>)/g)) {
            if (!cell[2]) continue
            const attributes = xmlAttributes(cell[1]), raw = /<(?:[\w.-]+:)?v\b[^>]*>([^<]+)<\/(?:[\w.-]+:)?v\s*>/.exec(cell[2])?.[1]
            if (attributes.r && (!attributes.t || attributes.t === 'n') && raw?.trim() && Number.isFinite(Number(raw))) cells.set(attributes.r.toUpperCase(), Number(raw))
          }
          metadata.numericCells.set(file.name, cells)
        }
        if (file.name === 'xl/workbook.xml') metadata.workbook = text
        if (file.name === 'xl/_rels/workbook.xml.rels') metadata.relationships = text
        } catch (cause) { failure = cause instanceof Error && /^(A planilha|Use uma)/u.test(cause.message) ? cause : new Error('A planilha XLSX está corrompida. Exporte novamente o arquivo.') }
      }
    }
    file.start()
  })
  zip.register(UnzipInflate)
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    try { zip.push(bytes.subarray(offset, offset + 32768), offset + 32768 >= bytes.length) } catch { if (!failure) failure = new Error('A planilha XLSX está corrompida. Exporte novamente o arquivo.') }
    if (failure) throw failure
  }
  if (!workbook) throw new Error('O arquivo não contém uma planilha XLSX válida.')
  return metadata
}

/** Correct the library's floored Excel float at millisecond precision, not by
 * rounding every Date to a second (which would discard valid subsecond data). */
function restoreExcelMilliseconds(data: ImportCell[][], sheetName: string, metadata: WorkbookMetadata): void {
  const sheets = [...metadata.workbook.matchAll(/<(?:[\w.-]+:)?sheet\b([^>]*?)\/?\s*>/g)].map(match => xmlAttributes(match[1]))
  const sheet = sheets.find(item => item.name === sheetName)
  const relationId = sheet && Object.entries(sheet).find(([name]) => name.endsWith(':id'))?.[1]
  const relations = [...metadata.relationships.matchAll(/<(?:[\w.-]+:)?Relationship\b([^>]*?)\/?\s*>/g)].map(match => xmlAttributes(match[1]))
  const target = relations.find(item => item.Id === relationId)?.Target
  if (!target) return
  const path = new URL(target, 'https://local.invalid/xl/workbook.xml').pathname.slice(1)
  const raw = metadata.numericCells.get(path)
  if (!raw) return
  const properties = /<(?:[\w.-]+:)?workbookPr\b([^>]*?)\/?\s*>/.exec(metadata.workbook)
  const epoch = properties && xmlAttributes(properties[1]).date1904 === '1' ? 24107 : 25569
  data.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    if (!(value instanceof Date)) return
    let column = ''
    for (let current = columnIndex + 1; current > 0; current = Math.floor((current - 1) / 26)) column = String.fromCharCode(65 + (current - 1) % 26) + column
    const serial = raw.get(`${column}${rowIndex + 1}`)
    if (serial === undefined) return
    const timestamp = (serial - epoch) * 86400000
    // Check our metadata matches the library interpretation before correcting.
    if (Math.floor(timestamp) === value.getTime()) row[columnIndex] = new Date(Math.round(timestamp))
  }))
}

/** Called inside our own disposable worker. No file is uploaded or retained. */
export async function parseLeadImportBuffer(buffer: ArrayBuffer, fileName: string, sheetName?: string): Promise<ParsedImportFile> {
  if (buffer.byteLength > IMPORT_LIMITS.fileBytes) throw new Error('O arquivo deve ter no máximo 10 MB.')
  const extension = fileName.split('.').pop()?.toLowerCase()
  if (!['csv', 'xlsx'].includes(extension || '')) throw new Error(extension === 'xls' ? 'O formato .xls não é aceito. Salve a planilha como .xlsx ou CSV UTF-8.' : 'Selecione um arquivo CSV ou XLSX. Backups JSON usam a opção de restauração existente.')
  const hash = await importHash(buffer)
  if (extension === 'csv') {
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer) } catch { throw new Error('O CSV não está em UTF-8. Exporte novamente usando CSV UTF-8.') }
    return parseImportCsv(text, fileName, hash)
  }
  const metadata = validateImportWorkbook(new Uint8Array(buffer))
  const sheets = await readXlsxFile(buffer)
  if (!sheets.length || sheets.length > IMPORT_LIMITS.sheets) throw new Error('Use uma planilha com 1 a 20 abas.')
  const selected = sheetName ? sheets.find(sheet => sheet.sheet === sheetName) : sheets[0]
  if (!selected) throw new Error('A aba selecionada não existe nesta planilha. Selecione outra aba.')
  restoreExcelMilliseconds(selected.data as unknown as ImportCell[][], selected.sheet, metadata)
  return table(selected.data as unknown as ImportCell[][], fileName, hash, 'xlsx', sheets.map(sheet => sheet.sheet), selected.sheet)
}

export async function readLeadImportFile(file: File, sheetName?: string, signal?: AbortSignal): Promise<ParsedImportFile> {
  if (file.size > IMPORT_LIMITS.fileBytes) throw new Error('O arquivo deve ter no máximo 10 MB.')
  if (signal?.aborted) throw new Error('Leitura cancelada.')
  const buffer = await file.arrayBuffer()
  if (signal?.aborted) throw new Error('Leitura cancelada.')
  // Native browser workers prevent large local files from blocking the authenticated UI.
  if (typeof Worker === 'undefined') return parseLeadImportBuffer(buffer, file.name, sheetName)
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./lead-import-worker.ts', import.meta.url), { type: 'module' })
    let settled = false
    const finish = (error?: Error, result?: ParsedImportFile) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.terminate()
      if (error) reject(error); else resolve(result!)
    }
    const abort = () => finish(new Error('Leitura cancelada.'))
    const timer = setTimeout(() => finish(new Error('A leitura demorou demais. Divida a planilha em arquivos menores e tente novamente.')), 30000)
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = event => event.data?.ok ? finish(undefined, event.data.result) : finish(new Error(typeof event.data?.message === 'string' ? event.data.message : 'Não foi possível ler o arquivo.'))
    worker.onerror = () => finish(new Error('Não foi possível ler o arquivo. Exporte novamente como CSV UTF-8 ou XLSX.'))
    worker.postMessage({ buffer, fileName: file.name, sheetName }, [buffer])
  })
}
