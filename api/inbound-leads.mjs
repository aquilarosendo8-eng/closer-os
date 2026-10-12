import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createClient as supabaseClient } from '@supabase/supabase-js'

export const config = { maxDuration: 30 }

const BODY_LIMIT = 65536
const MAX_DEPTH = 6
const MAX_NODES = 10000
const TOKEN = /^[a-f0-9]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FORBIDDEN_PROPERTIES = new Set(['__proto__', 'constructor', 'prototype'])
const ERRORS = Object.freeze({
  INVALID_CREDENTIALS: [401, 'A credencial da integração é inválida ou está indisponível.'],
  INVALID_BODY: [400, 'Envie um objeto válido com os campos do formulário.'],
  BODY_TOO_LARGE: [413, 'O formulário excede o limite de 64 KB.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'Use application/json ou application/x-www-form-urlencoded.'],
  UNSUPPORTED_ENCODING: [415, 'Envie o formulário sem compressão de conteúdo.'],
  BODY_TOO_DEEP: [400, 'A estrutura do formulário excede a profundidade permitida.'],
  UNSAFE_PROPERTY: [400, 'O formulário contém uma propriedade não permitida.'],
  WORKSPACE_UNAVAILABLE: [403, 'A empresa não está disponível para receber leads.'],
  STAGE_UNAVAILABLE: [409, 'A etapa configurada não está disponível para receber leads.'],
  OWNER_UNAVAILABLE: [409, 'O responsável configurado não está disponível para receber leads.'],
  NAME_REQUIRED: [422, 'Informe o nome no campo configurado para esta integração.'],
  FIELD_INVALID: [422, 'Revise os tipos e os limites dos campos mapeados.'],
  TICKET_INVALID: [422, 'Informe um ticket numérico válido, maior ou igual a zero.'],
  RATE_LIMITED: [429, 'O limite de recebimentos foi atingido. Aguarde antes de tentar novamente.'],
  SERVICE_UNAVAILABLE: [503, 'O recebimento de leads está temporariamente indisponível. Tente novamente em alguns instantes.'],
})

class RequestError extends Error {
  constructor(code, status = ERRORS[code]?.[0] || 503) { super(code); this.code = code; this.status = status }
}
class TransportError extends RequestError {}
const failTransport = code => { throw new TransportError(code) }
const header = (request, name) => request.headers?.[name]
const first = (env, ...names) => names.map(name => env[name]).find(Boolean) || ''

function credential(request) {
  const tokens = []
  const authorization = header(request, 'authorization')
  if (authorization !== undefined) {
    if (typeof authorization !== 'string') throw new RequestError('INVALID_CREDENTIALS')
    const match = authorization.match(/^Bearer ([a-f0-9]{64})$/i)
    if (!match || !TOKEN.test(match[1])) throw new RequestError('INVALID_CREDENTIALS')
    tokens.push(match[1])
  }
  const custom = header(request, 'x-high-closer-token')
  if (custom !== undefined) {
    if (typeof custom !== 'string' || !TOKEN.test(custom)) throw new RequestError('INVALID_CREDENTIALS')
    tokens.push(custom)
  }
  let values = []
  if (typeof request.url === 'string') {
    let url
    try { url = new URL(request.url, 'https://inbound.invalid') } catch { throw new RequestError('INVALID_CREDENTIALS') }
    values = url.searchParams.getAll('token')
    if (values.length > 1) throw new RequestError('INVALID_CREDENTIALS')
  }
  if (values.length) tokens.push(values[0])
  const query = request.query?.token
  if (query !== undefined) {
    if (typeof query !== 'string') throw new RequestError('INVALID_CREDENTIALS')
    tokens.push(query)
  }
  if (!tokens.length || tokens.some(token => !TOKEN.test(token))) throw new RequestError('INVALID_CREDENTIALS')
  const expected = Buffer.from(tokens[0], 'utf8')
  if (tokens.some(token => !timingSafeEqual(expected, Buffer.from(token, 'utf8')))) throw new RequestError('INVALID_CREDENTIALS')
  return createHash('sha256').update(tokens[0], 'utf8').digest('hex')
}

function checkStructure(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) failTransport('INVALID_BODY')
  const seen = new WeakSet(), stack = [{ value: body, depth: 0 }]
  let nodes = 0, bytes = 0
  const add = amount => { bytes += amount; if (bytes > BODY_LIMIT) failTransport('BODY_TOO_LARGE') }
  while (stack.length) {
    const { value, depth } = stack.pop()
    if (++nodes > MAX_NODES) failTransport('INVALID_BODY')
    if (typeof value === 'string') {
      if (value.includes('\u0000') || !value.isWellFormed()) failTransport('INVALID_BODY')
      if (Buffer.byteLength(value, 'utf8') > BODY_LIMIT) failTransport('BODY_TOO_LARGE')
      add(Buffer.byteLength(JSON.stringify(value), 'utf8'))
    } else if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) {
      add(Buffer.byteLength(JSON.stringify(value), 'utf8'))
    } else if (typeof value === 'object') {
      if (depth > MAX_DEPTH) failTransport('BODY_TOO_DEEP')
      if (seen.has(value)) failTransport('INVALID_BODY')
      seen.add(value)
      const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
      if (!array && prototype !== Object.prototype && prototype !== null) failTransport('UNSAFE_PROPERTY')
      if (Object.getOwnPropertySymbols(value).length) failTransport('INVALID_BODY')
      const keys = Object.keys(value)
      if (nodes + keys.length > MAX_NODES) failTransport('INVALID_BODY')
      add(2 + Math.max(keys.length - 1, 0))
      for (const key of keys) {
        if (FORBIDDEN_PROPERTIES.has(key)) failTransport('UNSAFE_PROPERTY')
        if (key.includes('\u0000') || !key.isWellFormed()) failTransport('INVALID_BODY')
        const property = Object.getOwnPropertyDescriptor(value, key)
        if (!property || !Object.hasOwn(property, 'value')) failTransport('UNSAFE_PROPERTY')
        if (!array) {
          if (Buffer.byteLength(key, 'utf8') > BODY_LIMIT) failTransport('BODY_TOO_LARGE')
          add(Buffer.byteLength(JSON.stringify(key), 'utf8') + 1)
        }
        stack.push({ value: property.value, depth: depth + 1 })
      }
    } else failTransport('INVALID_BODY')
  }
  return body
}

async function streamedBody(request) {
  if (typeof request[Symbol.asyncIterator] !== 'function') failTransport('INVALID_BODY')
  const iterator = typeof request.iterator === 'function' ? request.iterator({ destroyOnReturn: false }) : request[Symbol.asyncIterator]()
  const chunks = [], deadline = Date.now() + 10000
  let size = 0, complete = false
  try {
    while (true) {
      let timer
      const timeout = Math.max(1, deadline - Date.now())
      let item
      try {
        item = await Promise.race([iterator.next(), new Promise((_, reject) => { timer = setTimeout(() => reject(new TransportError('INVALID_BODY')), timeout) })])
      } finally { clearTimeout(timer) }
      if (item.done) { complete = true; return Buffer.concat(chunks) }
      if (typeof item.value !== 'string' && !Buffer.isBuffer(item.value) && !(item.value instanceof Uint8Array)) failTransport('INVALID_BODY')
      const chunk = Buffer.isBuffer(item.value) ? item.value : Buffer.from(item.value)
      size += chunk.length
      if (size > BODY_LIMIT) failTransport('BODY_TOO_LARGE')
      chunks.push(chunk)
    }
  } finally {
    if (!complete) {
      try { Promise.resolve(iterator.return?.()).catch(() => {}) } catch {}
      // Node's iterator above does not destroy the response socket. Discard the
      // remaining input instead of accumulating a rejected request in memory.
      try { request.resume?.() } catch {}
    }
  }
}

async function parsedBody(request) {
  const encoding = header(request, 'content-encoding')
  if (encoding !== undefined && (typeof encoding !== 'string' || encoding.trim().toLowerCase() !== 'identity')) failTransport('UNSUPPORTED_ENCODING')
  const typeValue = header(request, 'content-type')
  if (typeof typeValue !== 'string') failTransport('UNSUPPORTED_MEDIA_TYPE')
  const [mediaType, ...parameters] = typeValue.toLowerCase().split(';').map(value => value.trim())
  if (!['application/json', 'application/x-www-form-urlencoded'].includes(mediaType)
    || parameters.some(value => /^charset\s*=/.test(value) && !/^charset\s*=\s*(?:utf-8|"utf-8")$/.test(value))) failTransport('UNSUPPORTED_MEDIA_TYPE')
  const declaredSize = header(request, 'content-length')
  if (declaredSize !== undefined) {
    if (typeof declaredSize !== 'string' || !/^\d+$/.test(declaredSize)) failTransport('INVALID_BODY')
    if (Number(declaredSize) > BODY_LIMIT) failTransport('BODY_TOO_LARGE')
  }
  let body = request.body
  if (body === undefined) body = await streamedBody(request)
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    if (body.byteLength > BODY_LIMIT) failTransport('BODY_TOO_LARGE')
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(body) } catch { failTransport('INVALID_BODY') }
  }
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > BODY_LIMIT) failTransport('BODY_TOO_LARGE')
    if (mediaType === 'application/json') {
      try { body = JSON.parse(body) } catch { failTransport('INVALID_BODY') }
    } else {
      try { decodeURIComponent(body.replace(/\+/g, ' ')) } catch { failTransport('INVALID_BODY') }
      const form = Object.create(null)
      for (const [key, value] of new URLSearchParams(body)) {
        if (FORBIDDEN_PROPERTIES.has(key)) failTransport('UNSAFE_PROPERTY')
        if (Object.hasOwn(form, key)) failTransport('INVALID_BODY')
        form[key] = value
      }
      body = form
    }
  }
  return checkStructure(body)
}

function serverConfiguration(env) {
  const url = first(env, 'SUPABASE_URL', 'VITE_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL')
  const key = first(env, 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY')
  let project, role
  try { project = new URL(url) } catch { throw new RequestError('SERVICE_UNAVAILABLE') }
  if (!key.startsWith('sb_secret_')) {
    try { role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role } catch {}
  }
  if (project.protocol !== 'https:' || !project.hostname.endsWith('.supabase.co') || project.username || project.password
    || project.pathname !== '/' || project.search || project.hash || !(key.startsWith('sb_secret_') || role === 'service_role')) throw new RequestError('SERVICE_UNAVAILABLE')
  return { url: project.origin, key }
}

/** Tests inject the SDK factory; production always uses the official server SDK. */
export function createInboundLeadsHandler({ env = process.env, createClient = supabaseClient } = {}) {
  return async function inboundLeads(request, response) {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Referrer-Policy', 'no-referrer')
    const requestId = randomUUID()
    try {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST')
        throw new RequestError('METHOD_NOT_ALLOWED', 405)
      }
      const tokenHash = credential(request)
      const configuration = serverConfiguration(env)
      let payload, transportError = null
      try { payload = await parsedBody(request) }
      catch (error) {
        if (!(error instanceof TransportError)) throw error
        payload = {}; transportError = error.code
      }
      const client = createClient(configuration.url, configuration.key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: (resource, init) => fetch(resource, { ...init, signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }) },
      })
      // One server-only transaction authenticates, counts persistent quotas,
      // resolves flat mappings/configuration, deduplicates and writes the lead,
      // timeline and safe log. No external workspace/stage/owner is authoritative.
      const result = await client.rpc('receive_inbound_lead', {
        p_token_hash: tokenHash, p_request_id: requestId, p_payload: payload, p_transport_error: transportError,
      })
      if (result.error) throw new RequestError('SERVICE_UNAVAILABLE')
      const data = result.data
      if (!data || data.request_id !== requestId) throw new RequestError('SERVICE_UNAVAILABLE')
      if (['created', 'duplicate'].includes(data.status)) {
        const status = data.status === 'created' ? 201 : 200
        const validId = typeof data.lead_id === 'string' && (data.status === 'created' ? UUID.test(data.lead_id)
          : data.lead_id.length >= 1 && data.lead_id.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(data.lead_id))
        if (transportError || data.http_status !== status || !validId) throw new RequestError('SERVICE_UNAVAILABLE')
        return response.status(status).json({ status: data.status, leadId: data.lead_id, requestId })
      }
      const error = typeof data.error_code === 'string' && Object.hasOwn(ERRORS, data.error_code) ? ERRORS[data.error_code] : null
      if (!['rejected', 'error'].includes(data.status) || !error || data.http_status !== error[0]) throw new RequestError('SERVICE_UNAVAILABLE')
      if (data.error_code === 'RATE_LIMITED') {
        if (!Number.isInteger(data.retry_after) || data.retry_after < 1 || data.retry_after > 86400) throw new RequestError('SERVICE_UNAVAILABLE')
        response.setHeader('Retry-After', String(data.retry_after))
      }
      return response.status(error[0]).json({ status: data.status, requestId, error: { code: data.error_code, message: error[1] } })
    } catch (cause) {
      const error = cause instanceof RequestError ? cause : new RequestError('SERVICE_UNAVAILABLE')
      const message = error.code === 'METHOD_NOT_ALLOWED' ? 'Use POST para enviar os campos do formulário.' : ERRORS[error.code]?.[1] || ERRORS.SERVICE_UNAVAILABLE[1]
      return response.status(error.status).json({ status: error.status >= 500 ? 'error' : 'rejected', requestId, error: { code: error.code, message } })
    }
  }
}

export default createInboundLeadsHandler()
