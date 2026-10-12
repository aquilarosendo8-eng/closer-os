import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInboundLeadsHandler } from '../api/inbound-leads.mjs'

const TOKEN = '0123456789abcdef'.repeat(4)
const OTHER_TOKEN = 'fedcba9876543210'.repeat(4)
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex')
const SECRET_KEY = 'sb_secret_private_inbound_UNIT'
const LEAD_ID = '6b920001-1000-4000-8000-000000000001'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BODY_LIMIT = 64 * 1024
const env = { SUPABASE_URL: 'https://unit.supabase.co', SUPABASE_SECRET_KEY: SECRET_KEY }

type RpcInput = { p_token_hash: string; p_request_id: string; p_payload: Record<string, unknown>; p_transport_error: string | null }
const transportStatus = (code: string) => code === 'BODY_TOO_LARGE' ? 413 : ['UNSUPPORTED_MEDIA_TYPE', 'UNSUPPORTED_ENCODING'].includes(code) ? 415 : 400

function fixture(environment: Record<string, string> = env) {
  const rpc = vi.fn(async (_name: string, args: RpcInput) => ({
    data: args.p_transport_error
      ? { status: 'rejected', request_id: args.p_request_id, http_status: transportStatus(args.p_transport_error), error_code: args.p_transport_error }
      : { status: 'created', request_id: args.p_request_id, http_status: 201, lead_id: LEAD_ID },
    error: null,
  }))
  const createClient = vi.fn((_url: string, _key: string, _options: unknown) => ({ rpc }))
  const handler = createInboundLeadsHandler({ env: { ...environment }, createClient })
  return { rpc, createClient, handler }
}

function request(changes: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    url: `/api/inbound-leads?token=${TOKEN}`,
    headers: { 'content-type': 'application/json' } as Record<string, unknown>,
    body: { name: 'João Silva', email: 'joao@example.com', ticket: 15000 },
    ...changes,
  }
}

async function invoke(handler: ReturnType<typeof createInboundLeadsHandler>, req = request()) {
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as any,
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = String(value); return this },
    status(status: number) { this.statusCode = status; return this },
    json(body: unknown) { this.body = body; return this },
    end() { return this },
  }
  await handler(req, response)
  return response
}

function publicResponse(response: Awaited<ReturnType<typeof invoke>>) {
  const serialized = JSON.stringify(response.body)
  for (const value of [TOKEN, OTHER_TOKEN, TOKEN_HASH, SECRET_KEY]) expect(serialized).not.toContain(value)
  expect(response.body.requestId).toMatch(UUID)
  expect(response.headers['cache-control']).toContain('no-store')
  expect(serialized).not.toContain('provider_private_detail')
}

function expectTransport(f: ReturnType<typeof fixture>, code: string) {
  expect(f.rpc).toHaveBeenCalledTimes(1)
  expect(f.rpc).toHaveBeenCalledWith('receive_inbound_lead', {
    p_token_hash: TOKEN_HASH,
    p_request_id: expect.stringMatching(UUID),
    p_payload: {},
    p_transport_error: code,
  })
}

function jsonAtBytes(bytes: number) {
  const base = JSON.stringify({ name: 'Lead válido', padding: '' })
  return JSON.stringify({ name: 'Lead válido', padding: 'x'.repeat(bytes - Buffer.byteLength(base)) })
}

function nested(depth: number) {
  const body: Record<string, unknown> = { name: 'Lead válido' }
  let cursor = body
  for (let index = 0; index < depth; index += 1) {
    cursor.extra = {}
    cursor = cursor.extra as Record<string, unknown>
  }
  cursor.unmapped = 'Dado sem mapeamento'
  return body
}

afterEach(() => vi.restoreAllMocks())

describe('inbound webhook credential and method guards', () => {
  it.each(['GET', 'PUT', 'DELETE', 'OPTIONS'])('rejects %s before using server credentials', async method => {
    const f = fixture()
    const response = await invoke(f.handler, request({ method }))
    expect(response.statusCode).toBe(405)
    expect(response.headers.allow).toBe('POST')
    expect(f.createClient).not.toHaveBeenCalled()
    publicResponse(response)
  })

  it.each([
    ['query URL', { url: `/api/inbound-leads?token=${TOKEN}` }],
    ['parsed query', { url: '/api/inbound-leads', query: { token: TOKEN } }],
    ['Bearer', { url: '/api/inbound-leads', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` } }],
    ['custom header', { url: '/api/inbound-leads', headers: { 'content-type': 'application/json', 'x-high-closer-token': TOKEN } }],
  ])('authenticates the %s transport with only a SHA-256 digest sent to the RPC', async (_label, changes) => {
    const f = fixture()
    const response = await invoke(f.handler, request(changes))
    expect(response.statusCode).toBe(201)
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith('receive_inbound_lead', {
      p_token_hash: TOKEN_HASH,
      p_request_id: expect.stringMatching(UUID),
      p_payload: request().body,
      p_transport_error: null,
    })
    publicResponse(response)
  })

  it('accepts identical credentials across supported transports without making duplicate RPC calls', async () => {
    const f = fixture()
    const response = await invoke(f.handler, request({
      query: { token: TOKEN },
      headers: { ...request().headers, authorization: `Bearer ${TOKEN}`, 'x-high-closer-token': TOKEN },
    }))
    expect(response.statusCode).toBe(201)
    expect(f.rpc).toHaveBeenCalledTimes(1)
    publicResponse(response)
  })

  it.each([
    '',
    TOKEN.slice(1),
    `${TOKEN}0`,
    TOKEN.toUpperCase(),
    'z'.repeat(64),
    ` ${TOKEN}`,
    `${TOKEN}\n`,
    'header.payload.signature',
  ])('rejects malformed credential %# before making a service client', async token => {
    const f = fixture()
    const response = await invoke(f.handler, request({ url: '/api/inbound-leads', query: { token } }))
    expect(response.statusCode).toBe(401)
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS')
    expect(f.createClient).not.toHaveBeenCalled()
    publicResponse(response)
  })

  it('does not authenticate a credential provided only inside the external payload', async () => {
    const f = fixture()
    const response = await invoke(f.handler, request({ url: '/api/inbound-leads', body: { ...request().body, token: TOKEN } }))
    expect(response.statusCode).toBe(401)
    expect(f.createClient).not.toHaveBeenCalled()
    publicResponse(response)
  })

  it.each([
    { headers: { 'content-type': 'application/json', authorization: `Bearer ${OTHER_TOKEN}` } },
    { headers: { 'content-type': 'application/json', 'x-high-closer-token': OTHER_TOKEN } },
    { query: { token: OTHER_TOKEN } },
    { url: `/api/inbound-leads?token=${TOKEN}&token=${OTHER_TOKEN}` },
    { url: `/api/inbound-leads?token=${TOKEN}&token=${TOKEN}` },
    { url: '/api/inbound-leads', query: { token: [TOKEN, TOKEN] } },
  ])('rejects conflicting or ambiguous credential inputs %#', async changes => {
    const f = fixture()
    const response = await invoke(f.handler, request(changes))
    expect(response.statusCode).toBe(401)
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS')
    expect(f.createClient).not.toHaveBeenCalled()
    publicResponse(response)
  })

  it('accepts external webhooks without Origin and without a logged-in user session', async () => {
    const f = fixture()
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(201)
    expect(f.createClient).toHaveBeenCalledTimes(1)
    expect(f.createClient.mock.calls[0][1]).toBe(SECRET_KEY)
    const options = f.createClient.mock.calls[0][2] as any
    expect(options.auth).toMatchObject({ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false })
    expect(options.global?.headers?.Authorization).toBeUndefined()
    expect(typeof options.global.fetch).toBe('function')
    publicResponse(response)
  })

  it('does not restrict webhook origin or trust forwarded host as tenant context', async () => {
    const f = fixture()
    const response = await invoke(f.handler, request({ headers: {
      ...request().headers, origin: 'https://form.example.org', host: 'foreign.example.org', 'x-forwarded-host': 'foreign.example.org',
    } }))
    expect(response.statusCode).toBe(201)
    expect(Object.keys(f.rpc.mock.calls[0][1]).sort()).toEqual(['p_payload', 'p_request_id', 'p_token_hash', 'p_transport_error'])
    publicResponse(response)
  })
})

describe('inbound JSON and form decoding', () => {
  it.each([
    ['preparsed object', { body: request().body }],
    ['JSON text', { body: JSON.stringify(request().body) }],
    ['JSON buffer', { body: Buffer.from(JSON.stringify(request().body)) }],
    ['charset content type', { headers: { 'content-type': 'application/json; charset=utf-8' } }],
  ])('accepts %s without transforming the external field values', async (_label, changes) => {
    const f = fixture()
    const response = await invoke(f.handler, request(changes))
    expect(response.statusCode).toBe(201)
    expect(f.rpc.mock.calls[0][1].p_payload).toEqual(request().body)
    expect(f.rpc.mock.calls[0][1].p_transport_error).toBeNull()
    publicResponse(response)
  })

  it('decodes a URL-encoded form, preserving numeric strings for configured mapping', async () => {
    const f = fixture()
    const response = await invoke(f.handler, request({
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: 'full_name=Jo%C3%A3o+Silva&whatsapp=%2B55+%2877%29+99999-9999&ticket=15000.50&extra=ignorado',
    }))
    expect(response.statusCode).toBe(201)
    expect(f.rpc.mock.calls[0][1].p_payload).toEqual({ full_name: 'João Silva', whatsapp: '+55 (77) 99999-9999', ticket: '15000.50', extra: 'ignorado' })
    publicResponse(response)
  })

  it.each(['name=Lead&extra=%GG', 'name=Lead&extra=%C3%28'])('rejects malformed form percent/UTF-8 encoding %#', async body => {
    const f = fixture()
    const response = await invoke(f.handler, request({ headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }))
    expect(response.statusCode).toBe(400)
    expectTransport(f, 'INVALID_BODY')
    publicResponse(response)
  })

  it('preserves unmapped nested fields as data while reserving tenant context for the database', async () => {
    const f = fixture()
    const payload = {
      ...request().body,
      workspaceId: 'foreign-workspace', stage_id: 'foreign-stage', ownerId: 'foreign-user',
      status: 'Fechado', closedValue: 999999, createdAt: '2000-01-01T00:00:00Z',
      request_id: 'caller-controlled-request-id', metadata: { campaign: 'Site', tags: ['form', 'site'] },
    }
    const response = await invoke(f.handler, request({ body: payload, headers: { ...request().headers, 'x-request-id': 'caller-controlled-request-id' } }))
    expect(response.statusCode).toBe(201)
    expect(f.rpc).toHaveBeenCalledExactlyOnceWith('receive_inbound_lead', {
      p_token_hash: TOKEN_HASH, p_request_id: expect.stringMatching(UUID), p_payload: payload, p_transport_error: null,
    })
    expect(response.body.requestId).not.toBe(payload.request_id)
    publicResponse(response)
  })

  it.each(['{broken', '', 'null', '[]', '42', 'true', '"plain text"'])('reports malformed JSON/root %# through the rate-limited RPC', async body => {
    const f = fixture()
    const response = await invoke(f.handler, request({ body }))
    expect(response.statusCode).toBe(400)
    expectTransport(f, 'INVALID_BODY')
    publicResponse(response)
  })

  it.each([null, [], 5, true])('rejects an unsupported preparsed root %#', async body => {
    const f = fixture()
    const response = await invoke(f.handler, request({ body }))
    expect(response.statusCode).toBe(400)
    expectTransport(f, 'INVALID_BODY')
    publicResponse(response)
  })

  it.each([undefined, 'text/plain', 'multipart/form-data; boundary=abc'])('accounts for unsupported content type %s with the same authenticated RPC', async contentType => {
    const f = fixture()
    const response = await invoke(f.handler, request({ headers: contentType ? { 'content-type': contentType } : {} }))
    expect(response.statusCode).toBe(415)
    expectTransport(f, 'UNSUPPORTED_MEDIA_TYPE')
    publicResponse(response)
  })

  it.each(['gzip', 'br'])('rejects %s encoded requests instead of bypassing decoded body limits', async encoding => {
    const f = fixture()
    const response = await invoke(f.handler, request({ headers: { ...request().headers, 'content-encoding': encoding } }))
    expect(response.statusCode).toBe(415)
    expectTransport(f, 'UNSUPPORTED_ENCODING')
    publicResponse(response)
  })

  it('accepts identity content encoding', async () => {
    const f = fixture()
    const response = await invoke(f.handler, request({ headers: { ...request().headers, 'content-encoding': 'identity' } }))
    expect(response.statusCode).toBe(201)
    publicResponse(response)
  })

  it('lets the database validate an absent mapped name rather than constructing an incomplete lead', async () => {
    const f = fixture()
    f.rpc.mockImplementationOnce(async (_name, args) => ({ data: { status: 'rejected', request_id: args.p_request_id, http_status: 422, error_code: 'NAME_REQUIRED' }, error: null }))
    const response = await invoke(f.handler, request({ body: { email: 'lead@example.org' } }))
    expect(response.statusCode).toBe(422)
    expect(response.body.error.code).toBe('NAME_REQUIRED')
    expect(f.rpc.mock.calls[0][1]).toMatchObject({ p_payload: { email: 'lead@example.org' }, p_transport_error: null })
    publicResponse(response)
  })
})

describe('inbound body size, depth and prototype safety', () => {
  it('accepts exactly 64 KiB of JSON body', async () => {
    const f = fixture()
    const body = jsonAtBytes(BODY_LIMIT)
    expect(Buffer.byteLength(body)).toBe(BODY_LIMIT)
    const response = await invoke(f.handler, request({ body }))
    expect(response.statusCode).toBe(201)
    expect(f.rpc.mock.calls[0][1].p_transport_error).toBeNull()
    publicResponse(response)
  })

  it.each([
    ['raw JSON', { body: jsonAtBytes(BODY_LIMIT + 1) }],
    ['preparsed object', { body: JSON.parse(jsonAtBytes(BODY_LIMIT + 1)) }],
    ['raw buffer', { body: Buffer.from(jsonAtBytes(BODY_LIMIT + 1)) }],
    ['declared length', { headers: { ...request().headers, 'content-length': String(BODY_LIMIT + 1) } }],
    ['URL-encoded form', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `name=Lead&padding=${'x'.repeat(BODY_LIMIT)}` }],
  ])('rejects an oversized %s through one authenticated RPC', async (_label, changes) => {
    const f = fixture()
    const response = await invoke(f.handler, request(changes))
    expect(response.statusCode).toBe(413)
    expectTransport(f, 'BODY_TOO_LARGE')
    publicResponse(response)
  })

  it('counts UTF-8 bytes rather than JavaScript characters', async () => {
    const f = fixture()
    const body = JSON.stringify({ name: 'Lead', notes: 'é'.repeat(33000) })
    expect(body.length).toBeLessThan(BODY_LIMIT)
    expect(Buffer.byteLength(body)).toBeGreaterThan(BODY_LIMIT)
    const response = await invoke(f.handler, request({ body }))
    expect(response.statusCode).toBe(413)
    expectTransport(f, 'BODY_TOO_LARGE')
    publicResponse(response)
  })

  it('parses streamed JSON without a preparsed body', async () => {
    const f = fixture()
    const text = JSON.stringify(request().body)
    const response = await invoke(f.handler, request({ body: undefined, async *[Symbol.asyncIterator]() {
      yield Buffer.from(text.slice(0, 10)); yield Buffer.from(text.slice(10))
    } }))
    expect(response.statusCode).toBe(201)
    expect(f.rpc.mock.calls[0][1].p_payload).toEqual(request().body)
    publicResponse(response)
  })

  it('stops consuming a chunked stream once its byte limit is exceeded', async () => {
    const f = fixture()
    let chunksConsumed = 0
    let iteratorClosed = false
    const response = await invoke(f.handler, request({ body: undefined, async *[Symbol.asyncIterator]() {
      try {
        chunksConsumed += 1; yield Buffer.alloc(BODY_LIMIT + 1, 'x')
        chunksConsumed += 1; yield Buffer.alloc(BODY_LIMIT, 'x')
      } finally { iteratorClosed = true }
    } }))
    expect(response.statusCode).toBe(413)
    expect(chunksConsumed).toBe(1)
    expect(iteratorClosed).toBe(true)
    expectTransport(f, 'BODY_TOO_LARGE')
    publicResponse(response)
  })

  it('rejects an oversized Node Readable without destroying its response socket', async () => {
    const f = fixture()
    const stream = Readable.from([Buffer.alloc(BODY_LIMIT + 1, 'x'), Buffer.alloc(BODY_LIMIT, 'x')], { autoDestroy: false })
    const iterator = vi.spyOn(stream, 'iterator')
    Object.assign(stream, request({ body: undefined }))
    try {
      const response = await invoke(f.handler, stream as any)
      expect(response.statusCode).toBe(413)
      expect(iterator).toHaveBeenCalledExactlyOnceWith({ destroyOnReturn: false })
      expect(stream.destroyed).toBe(false)
      expectTransport(f, 'BODY_TOO_LARGE')
      publicResponse(response)
    } finally { stream.destroy() }
  })

  it('allows objects nested to depth six with root at depth zero', async () => {
    const f = fixture()
    const response = await invoke(f.handler, request({ body: nested(6) }))
    expect(response.statusCode).toBe(201)
    expect(f.rpc.mock.calls[0][1].p_transport_error).toBeNull()
    publicResponse(response)
  })

  it.each([7, 1000])('rejects depth %i, including unmapped fields, without exposing parser details', async depth => {
    const f = fixture()
    const response = await invoke(f.handler, request({ body: JSON.stringify(nested(depth)) }))
    expect(response.statusCode).toBe(400)
    expectTransport(f, 'BODY_TOO_DEEP')
    publicResponse(response)
  })

  it.each([
    '{"name":"Lead","__proto__":{"polluted":"attacker"}}',
    '{"name":"Lead","extra":{"constructor":{"prototype":{"polluted":"attacker"}}}}',
    '{"name":"Lead","extra":{"prototype":{"polluted":"attacker"}}}',
  ])('rejects unsafe object keys at any depth %#', async body => {
    const f = fixture()
    const before = (Object.prototype as any).polluted
    const response = await invoke(f.handler, request({ body }))
    expect(response.statusCode).toBe(400)
    expectTransport(f, 'UNSAFE_PROPERTY')
    expect((Object.prototype as any).polluted).toBe(before)
    publicResponse(response)
  })

  it('does not invoke an accessor while examining a preparsed payload', async () => {
    const f = fixture()
    const accessor = vi.fn(() => { throw new Error('Accessor must not run') })
    const body = Object.defineProperty({ name: 'Lead' }, 'extra', { enumerable: true, get: accessor })
    const response = await invoke(f.handler, request({ body }))
    expect(response.statusCode).toBe(400)
    expectTransport(f, 'UNSAFE_PROPERTY')
    expect(accessor).not.toHaveBeenCalled()
    publicResponse(response)
  })

  it('rejects a custom object prototype rather than reading inherited field values', async () => {
    const f = fixture()
    const body = Object.assign(Object.create({ name: 'Inherited attacker name' }), { email: 'lead@example.org' })
    const response = await invoke(f.handler, request({ body }))
    expect(response.statusCode).toBe(400)
    expectTransport(f, 'UNSAFE_PROPERTY')
    publicResponse(response)
  })

  it.each([NaN, Infinity, -Infinity])('rejects a non-finite preparsed numeric field (%s) before JSON serialization', async value => {
    const f = fixture()
    const response = await invoke(f.handler, request({ body: { name: 'Lead', extra: value } }))
    expect(response.statusCode).toBe(400)
    expectTransport(f, 'INVALID_BODY')
    publicResponse(response)
  })

  it('rejects invalid UTF-8 bytes instead of silently replacing characters', async () => {
    const f = fixture()
    const response = await invoke(f.handler, request({ body: Buffer.from([0xc3, 0x28]) }))
    expect(response.statusCode).toBe(400)
    expectTransport(f, 'INVALID_BODY')
    publicResponse(response)
  })

  it.each([
    ['escaped JSON value', JSON.stringify({ name: 'Lead', extra: '\ud800' })],
    ['escaped JSON key', JSON.stringify({ name: 'Lead', ['\udc00']: 'value' })],
    ['preparsed string value', { name: 'Lead', extra: '\ud800' }],
    ['preparsed property key', { name: 'Lead', ['\udc00']: 'value' }],
  ])('rejects an isolated UTF-16 surrogate in %s before forwarding JSONB', async (_label, body) => {
    const f = fixture()
    const response = await invoke(f.handler, request({ body }))
    expect(response.statusCode).toBe(400)
    expectTransport(f, 'INVALID_BODY')
    publicResponse(response)
  })

  it('accepts paired emoji surrogates in JSON keys and values as valid Unicode data', async () => {
    const f = fixture()
    const payload = { name: 'Lead 😀', ['😀']: 'Texto válido 😀' }
    const response = await invoke(f.handler, request({ body: JSON.stringify(payload) }))
    expect(response.statusCode).toBe(201)
    expect(f.rpc.mock.calls[0][1]).toMatchObject({ p_payload: payload, p_transport_error: null })
    publicResponse(response)
  })

  it('rejects unsafe keys in URL-encoded input without prototype mutation', async () => {
    const f = fixture()
    const before = (Object.prototype as any).polluted
    const response = await invoke(f.handler, request({ headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=Lead&__proto__=attacker' }))
    expect(response.statusCode).toBe(400)
    expectTransport(f, 'UNSAFE_PROPERTY')
    expect((Object.prototype as any).polluted).toBe(before)
    publicResponse(response)
  })

  it.each([
    { name: 'Lead\u0000inválido' },
    { name: 'Lead', ignored: { text: 'Conteúdo\u0000inválido' } },
    { name: 'Lead', ['campo\u0000inválido']: 'valor' },
  ])('rejects NUL in any string or property %# before forwarding it to PostgreSQL JSONB', async body => {
    const f = fixture()
    const response = await invoke(f.handler, request({ body }))
    expect(response.statusCode).toBe(400)
    expectTransport(f, 'INVALID_BODY')
    publicResponse(response)
  })
})

describe('inbound database result and provider failure boundaries', () => {
  it('returns only the public creation DTO despite additional private database fields', async () => {
    const f = fixture()
    f.rpc.mockImplementationOnce(async (_name, args) => ({ data: {
      status: 'created', request_id: args.p_request_id, http_status: 201, lead_id: LEAD_ID,
      workspace_id: 'private_workspace', token: TOKEN, token_hash: TOKEN_HASH, service_key: SECRET_KEY, payload: request().body,
    }, error: null }))
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(201)
    expect(response.body).toEqual({ status: 'created', requestId: f.rpc.mock.calls[0][1].p_request_id, leadId: LEAD_ID })
    publicResponse(response)
  })

  it('returns duplicate without treating it as a creation or exposing lead contact data', async () => {
    const f = fixture()
    f.rpc.mockImplementationOnce(async (_name, args) => ({ data: { status: 'duplicate', request_id: args.p_request_id, http_status: 200, lead_id: LEAD_ID, email: 'private_client@example.org' }, error: null }))
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({ status: 'duplicate', requestId: f.rpc.mock.calls[0][1].p_request_id, leadId: LEAD_ID })
    expect(JSON.stringify(response.body)).not.toContain('private_client@example.org')
    publicResponse(response)
  })

  it('preserves a legacy text lead identifier when an inbound contact matches an existing imported lead', async () => {
    const f = fixture()
    f.rpc.mockImplementationOnce(async (_name, args) => ({ data: { status: 'duplicate', request_id: args.p_request_id, http_status: 200, lead_id: 'legacy-import-123' }, error: null }))
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({ status: 'duplicate', requestId: f.rpc.mock.calls[0][1].p_request_id, leadId: 'legacy-import-123' })
    publicResponse(response)
  })

  it.each([
    ['INVALID_CREDENTIALS', 401], ['WORKSPACE_UNAVAILABLE', 403], ['STAGE_UNAVAILABLE', 409],
    ['OWNER_UNAVAILABLE', 409], ['NAME_REQUIRED', 422], ['FIELD_INVALID', 422],
    ['TICKET_INVALID', 422], ['RATE_LIMITED', 429], ['SERVICE_UNAVAILABLE', 503],
  ])('maps database %s to a fixed safe public error and status %i', async (code, httpStatus) => {
    const f = fixture()
    f.rpc.mockImplementationOnce(async (_name, args) => ({ data: {
      status: 'rejected', request_id: args.p_request_id, error_code: code, http_status: httpStatus,
      ...(code === 'RATE_LIMITED' ? { retry_after: 60 } : {}),
      message: `provider_private_detail ${SECRET_KEY} ${TOKEN}`, workspace_id: 'private_workspace', payload: request().body,
    }, error: null }))
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(httpStatus)
    expect(response.body).toEqual({ status: 'rejected', requestId: f.rpc.mock.calls[0][1].p_request_id, error: { code, message: expect.any(String) } })
    publicResponse(response)
  })

  it('sets the retry interval supplied by the persistent rate limiter', async () => {
    const f = fixture()
    f.rpc.mockImplementationOnce(async (_name, args) => ({ data: { status: 'rejected', request_id: args.p_request_id, error_code: 'RATE_LIMITED', http_status: 429, retry_after: 17 }, error: null }))
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(429)
    expect(response.headers['retry-after']).toBe('17')
    publicResponse(response)
  })

  it.each([-5, 90000, 1.5, 'untrusted-header-value'])('never emits an invalid Retry-After header (%s)', async retryAfter => {
    const f = fixture()
    f.rpc.mockImplementationOnce(async (_name, args) => ({ data: { status: 'rejected', request_id: args.p_request_id, error_code: 'RATE_LIMITED', http_status: 429, retry_after: retryAfter }, error: null }))
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(503)
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE')
    expect(response.headers['retry-after']).toBeUndefined()
    publicResponse(response)
  })

  it.each([
    { status: 'created', http_status: 201, lead_id: 'invalid-lead-id' },
    { status: 'created', http_status: 201, lead_id: LEAD_ID, request_id: 'different-request-id' },
    { status: 'unexpected-state' },
    { status: 'rejected', error_code: 'PRIVATE_UNKNOWN_ERROR', http_status: 500 },
    { status: 'rejected', error_code: 'NAME_REQUIRED', http_status: 302 },
    { status: 'rejected', error_code: 'constructor' },
    { status: 'error', error_code: '__proto__' },
  ])('fails closed on a malformed or unknown database DTO %#', async changes => {
    const f = fixture()
    f.rpc.mockImplementationOnce(async (_name, args) => ({ data: { request_id: args.p_request_id, ...changes }, error: null }))
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(503)
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE')
    publicResponse(response)
  })

  it('fails closed if the database reports success for a transport-invalid payload', async () => {
    const f = fixture()
    f.rpc.mockImplementationOnce(async (_name, args) => ({ data: { status: 'created', request_id: args.p_request_id, http_status: 201, lead_id: LEAD_ID }, error: null }))
    const response = await invoke(f.handler, request({ body: 'null' }))
    expect(response.statusCode).toBe(503)
    expectTransport(f, 'INVALID_BODY')
    publicResponse(response)
  })

  it('redacts a provider error response and does not expose or log credentials', async () => {
    const f = fixture()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    f.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: `provider_private_detail ${SECRET_KEY} ${TOKEN}` } } as any)
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(503)
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE')
    expect(log).not.toHaveBeenCalled(); expect(warning).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled()
    publicResponse(response)
  })

  it('returns a fixed unavailable error after a thrown network failure', async () => {
    const f = fixture()
    f.rpc.mockRejectedValueOnce(new Error(`provider_private_detail ${SECRET_KEY} ${TOKEN}`))
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(503)
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE')
    publicResponse(response)
  })
})

describe('inbound server configuration and bounded SDK transport', () => {
  it.each([
    { SUPABASE_URL: '', SUPABASE_SECRET_KEY: SECRET_KEY },
    { SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SECRET_KEY: '' },
    { SUPABASE_URL: 'http://unit.supabase.co', SUPABASE_SECRET_KEY: SECRET_KEY },
    { SUPABASE_URL: 'https://untrusted.example.org', SUPABASE_SECRET_KEY: SECRET_KEY },
    { SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SECRET_KEY: 'sb_publishable_public_UNIT' },
  ])('rejects incomplete or unsafe server configuration %# before creating an SDK client', async config => {
    const f = fixture(config)
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(503)
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE')
    expect(f.createClient).not.toHaveBeenCalled()
    publicResponse(response)
  })

  it('accepts the protected service-role key fallback without a browser publishable key', async () => {
    const f = fixture({ SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY })
    const response = await invoke(f.handler)
    expect(response.statusCode).toBe(201)
    expect(f.createClient.mock.calls[0][1]).toBe(SECRET_KEY)
    publicResponse(response)
  })

  it('keeps SDK requests bounded and propagates external cancellation without sending real network requests', async () => {
    const f = fixture()
    await invoke(f.handler)
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    const options = f.createClient.mock.calls[0][2] as any
    const controller = new AbortController()
    await options.global.fetch('https://unit.supabase.co/rest/v1/rpc/receive_inbound_lead', { method: 'POST', signal: controller.signal })
    expect(fetch).toHaveBeenCalledTimes(1)
    const merged = fetch.mock.calls[0][1]?.signal
    expect(merged).toBeInstanceOf(AbortSignal)
    expect(merged).not.toBe(controller.signal)
    expect(merged?.aborted).toBe(false)
    controller.abort()
    expect(merged?.aborted).toBe(true)
  })
})
