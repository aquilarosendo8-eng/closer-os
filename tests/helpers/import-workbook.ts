import { strToU8, zipSync } from 'fflate'

export type WorkbookCell = string | number | boolean | Date | null | { formula: string; cached?: string | number | boolean }
export interface WorkbookFixtureOptions { sheets: { name: string; rows: WorkbookCell[][] }[]; date1904?: boolean }
const escapeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
function column(index: number) {
  let label = ''
  for (let current = index + 1; current > 0; current = Math.floor((current - 1) / 26)) label = String.fromCharCode(65 + (current - 1) % 26) + label
  return label
}

/** Synthetic OOXML test fixture, not an application spreadsheet parser/writer. */
export function buildImportWorkbook({ sheets, date1904 = false }: WorkbookFixtureOptions): Buffer {
  const files: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="${namespace}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="${date1904 ? '1' : '0'}"/><sheets>${sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm"/></numFmts><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>',
  }
  sheets.forEach((sheet, sheetIndex) => {
    files[`xl/worksheets/sheet${sheetIndex + 1}.xml`] = `<?xml version="1.0"?><worksheet xmlns="${namespace}"><sheetData>${sheet.rows.map((row, index) => `<row r="${index + 1}">${row.map((value, cellIndex) => {
      const reference = `${column(cellIndex)}${index + 1}`
      if (value === null) return ''
      if (typeof value === 'string') return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
      if (typeof value === 'boolean') return `<c r="${reference}" t="b"><v>${value ? '1' : '0'}</v></c>`
      if (typeof value === 'number') return `<c r="${reference}"><v>${value}</v></c>`
      if (value instanceof Date) {
        const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
        return `<c r="${reference}" s="1"><v>${(value.getTime() - epoch) / 86400000}</v></c>`
      }
      const type = typeof value.cached === 'string' ? ' t="str"' : typeof value.cached === 'boolean' ? ' t="b"' : ''
      return `<c r="${reference}"${type}><f>${escapeXml(value.formula)}</f>${value.cached === undefined ? '' : `<v>${escapeXml(String(typeof value.cached === 'boolean' ? Number(value.cached) : value.cached))}</v>`}</c>`
    }).join('')}</row>`).join('')}</sheetData></worksheet>`
  })
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)]))))
}
