import { describe, expect, it } from 'vitest'
import { instagramProfileUrl, presentLeadNotes } from '../src/lib/lead-qualification'

describe('read-only qualification presentation', () => {
  it('separates all five labelled fields from free notes without changing the original', () => {
    const notes = 'Contato indicado pelo sócio.\nFaturamento mensal: R$ 300 mil\nSobre a empresa: Loja de móveis\nAtende todo o Brasil.\nInstagram: @empresa\nFaixa de investimento: R$ 10 a 20 mil\nInvestimento mínimo: R$ 10 mil\n\nRetornar na segunda-feira.'
    const result = presentLeadNotes(notes)
    expect(result.items.map(item => item.key)).toEqual(['revenue', 'about', 'instagram', 'investment', 'minimum'])
    expect(result.items[1].value).toBe('Loja de móveis\nAtende todo o Brasil.')
    expect(result.generalNotes).toBe('Contato indicado pelo sócio.\n\nRetornar na segunda-feira.')
    expect(notes).toContain('Faturamento mensal: R$ 300 mil')
  })
  it.each(['Notas livres com https://example.com:443 e horários 10:30.', 'Falamos sobre a empresa: tem três lojas.', '', 'Faturamento mensal:'])('preserves unstructured or empty notes exactly: %s', notes => {
    expect(presentLeadNotes(notes)).toEqual({ items: [], generalNotes: notes })
  })
  it('accepts a compact form summary, case, accents and CRLF', () => {
    expect(presentLeadNotes('FATURAMENTO MENSAL: 300 mil | Instagram: @empresa; Investimento minimo: 10 mil\r\nSobre a empresa: SaaS').items.map(item => item.value)).toEqual(['300 mil', '@empresa', '10 mil', 'SaaS'])
    expect(presentLeadNotes('Faturamento mensal: 300 mil Instagram: @empresa Faixa de investimento: 10 mil').items).toHaveLength(3)
  })
  it('retains unknown fields and duplicate known values rather than overwriting them', () => {
    const result = presentLeadNotes('Instagram: @primeiro\nInstagram: @segundo\nCampo extra: manter\nInvestimento mínimo:\nNotas finais')
    expect(result.items.map(item => item.value)).toEqual(['@primeiro', '@segundo'])
    expect(result.generalNotes).toBe('Campo extra: manter\nInvestimento mínimo:\nNotas finais')
  })
  it('keeps HTML literal and does not interpret arbitrary labels as qualification', () => {
    expect(presentLeadNotes('Sobre a empresa: <img src=x onerror=alert(1)>\nObservações: manter').items[0].value).toBe('<img src=x onerror=alert(1)>')
    expect(presentLeadNotes('Empresa: não é qualificação').items).toEqual([])
  })
  it('only turns explicit safe Instagram profiles into links', () => {
    expect(instagramProfileUrl('@empresa')).toBe('https://www.instagram.com/empresa/')
    expect(instagramProfileUrl('instagram.com/empresa')).toBe('https://instagram.com/empresa')
    for (const input of ['javascript:alert(1)', 'https://instagram.com.evil.com/empresa', 'https://user:password@instagram.com/empresa', 'https://example.com', 'https://instagram.com/empresa?token=secret', 'Texto livre']) expect(instagramProfileUrl(input)).toBeNull()
  })
})
