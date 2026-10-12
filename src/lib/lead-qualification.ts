/** Read-only presentation of existing notes. Never changes the stored lead. */
export type QualificationKey = 'revenue' | 'about' | 'instagram' | 'investment' | 'minimum'
export interface QualificationItem { key: QualificationKey; label: string; value: string }
const labels: Record<string, { key: QualificationKey; label: string }> = {
  'faturamento mensal': { key: 'revenue', label: 'Faturamento mensal' },
  'sobre a empresa': { key: 'about', label: 'Sobre a empresa' },
  instagram: { key: 'instagram', label: 'Instagram' },
  'faixa de investimento': { key: 'investment', label: 'Faixa de investimento' },
  'investimento minimo': { key: 'minimum', label: 'Investimento mínimo' },
}
const normalize = (label: string) => label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
const labelPattern = 'Faturamento mensal|Sobre a empresa|Instagram|Faixa de investimento|Investimento m[ií]nimo'

export function presentLeadNotes(notes: string): { items: QualificationItem[]; generalNotes: string } {
  const items: QualificationItem[] = [], general: string[] = []
  // Recognize explicit labels, including compact form summaries separated by
  // pipes/semicolons or subsequent labels. URLs and arbitrary colons are text.
  const header = new RegExp(`^[ \\t]*(?:[-•][ \\t]+)?(?:${labelPattern})[ \\t]*:`, 'i')
  const lines = notes.replace(/\r\n?/g, '\n').split('\n').flatMap(line => header.test(line)
    ? line.replace(new RegExp(`[ \\t]*[;|][ \\t]*(?=(?:${labelPattern})[ \\t]*:)`, 'gi'), '\n')
      .replace(new RegExp(`([ \\t]+)(?=(?:${labelPattern})[ \\t]*:)`, 'gi'), '\n').split('\n')
    : [line])
  let description: QualificationItem | null = null
  for (const line of lines) {
    const match = line.match(new RegExp(`^[ \\t]*(?:[-•][ \\t]+)?(${labelPattern})[ \\t]*:[ \\t]*(.*)$`, 'i'))
    if (match && match[2].trim()) {
      const field = labels[normalize(match[1])]
      const item = { ...field, value: match[2].trim() }
      items.push(item); description = item.key === 'about' ? item : null
    } else if (description && line.trim() && !/^[^:]{1,80}:/.test(line)) {
      description.value += `\n${line}`
    } else {
      description = null; general.push(line)
    }
  }
  return items.length ? { items, generalNotes: general.join('\n').trim() } : { items: [], generalNotes: notes }
}

export function instagramProfileUrl(value: string): string | null {
  const handle = value.match(/^@([A-Za-z0-9._]{1,30})$/)
  if (handle) return `https://www.instagram.com/${handle[1]}/`
  try {
    const url = new URL(/^(?:www\.)?instagram\.com\//i.test(value) ? `https://${value}` : value)
    if (url.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(url.hostname) || url.username || url.password || !/^\/[A-Za-z0-9._]{1,30}\/?$/.test(url.pathname) || url.search || url.hash) return null
    return url.href
  } catch { return null }
}
