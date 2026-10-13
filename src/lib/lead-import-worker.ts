import { parseLeadImportBuffer } from './lead-import-reader'

self.onmessage = async (event: MessageEvent<{ buffer: ArrayBuffer; fileName: string; sheetName?: string }>) => {
  try {
    const result = await parseLeadImportBuffer(event.data.buffer, event.data.fileName, event.data.sheetName)
    self.postMessage({ ok: true, result })
  } catch (cause) {
    // Never echo library exceptions: they can contain lead cells or workbook contents.
    const safe = cause instanceof Error && /^(O arquivo|O CSV|Use uma|A planilha|A aba|Selecione|O formato|Importe até|Linha \d+:|Há cabeçalhos|O cabeçalho|A leitura)/u.test(cause.message)
    self.postMessage({ ok: false, message: safe ? (cause as Error).message : 'Não foi possível ler o arquivo. Exporte novamente como CSV UTF-8 ou XLSX.' })
  }
}
