#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { getCACertificates } from 'node:tls'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'

const { values } = parseArgs({ options: {
  'env-file': { type: 'string' }, 'owner-email': { type: 'string' }, 'app-url': { type: 'string' },
  'check-only': { type: 'boolean', default: false }, 'invite-owner': { type: 'boolean', default: false },
} })
if (values['env-file']) process.loadEnvFile(values['env-file'])
const env = process.env
const first = (...names) => names.map(name => env[name]).find(Boolean) || ''
const url = first('SUPABASE_URL', 'VITE_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL')
const key = first('SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY')
const secret = first('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY')
const databaseUrl = first('SUPABASE_DB_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING', 'DATABASE_URL')
const ownerEmail = (values['owner-email'] || env.CLOSER_OWNER_EMAIL || '').trim().toLowerCase()
const appUrl = values['app-url'] || env.CLOSER_APP_URL || ''
const projectRef = env.SUPABASE_PROJECT_REF || (url && new URL(url).hostname.split('.')[0])
let database

function fail(message) { throw new Error(message) }
function safeError(error) {
  let message = error instanceof Error && error.message ? error.message : 'Falha na operação de configuração.'
  if (error instanceof AggregateError) message += ` Códigos de conexão: ${error.errors.map(item => item.code || item.name).join(', ')}.`
  else if (error?.code) message += ` Código: ${error.code}.`
  for (const value of [secret, key, databaseUrl, env.SUPABASE_ACCESS_TOKEN, env.POSTGRES_PASSWORD].filter(Boolean)) message = message.replaceAll(value, '[redacted]')
  return message.replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[database connection redacted]')
}
function publicKey(value) {
  if (value.startsWith('sb_publishable_')) return true
  try { return JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString()).role === 'anon' } catch { return false }
}
const sqlString = value => `'${value.replaceAll("'", "''")}'`

/** Use the environment's authorized egress proxy, then let pg verify server TLS. */
async function proxySocket(host, port) {
  const proxy = new URL(env.HTTPS_PROXY || env.HTTP_PROXY)
  return new Promise((resolve, reject) => {
    const transport = proxy.protocol === 'https:' ? https : http
    const headers = { Host: `${host}:${port}` }
    if (proxy.username) headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`
    const request = transport.request({ hostname: proxy.hostname, port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80), method: 'CONNECT', path: `${host}:${port}`, headers, timeout: 20000 })
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) { socket.destroy(); reject(new Error(`O proxy recusou a conexão de banco (HTTP ${response.statusCode}).`)); return }
      socket.pause()
      if (head.length) socket.unshift(head)
      // The proxy already connected the socket; pg still expects a connect event.
      socket.connect = () => { queueMicrotask(() => { socket.emit('connect'); socket.resume() }); return socket }
      resolve(socket)
    })
    request.once('timeout', () => request.destroy(new Error('O proxy excedeu o tempo de conexão ao banco.')))
    request.once('error', reject)
    request.end()
  })
}

async function openDatabase() {
  if (databaseUrl) {
    const parsed = new URL(databaseUrl)
    const local = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
    if (!local && !parsed.hostname.endsWith('.supabase.co') && !parsed.hostname.endsWith('.supabase.com')) fail('A conexão de banco não aponta para um host Supabase reconhecido. Configure SUPABASE_DB_URL para o projeto correto.')
    // pg treats sslmode in a connection string as an override; set strict TLS explicitly.
    for (const option of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'pgbouncer']) parsed.searchParams.delete(option)
    // Supabase Postgres uses its documented CA. Extend trusted roots and keep
    // chain AND hostname verification enabled, including when using the pooler.
    const certificate = local ? '' : await readFile(env.CLOSER_DB_CA_FILE || new URL('./certs/supabase-root-2021.crt', import.meta.url), 'utf8')
    const ssl = local ? false : { rejectUnauthorized: true, ca: [...getCACertificates('default'), certificate] }
    const stream = !local && (env.HTTPS_PROXY || env.HTTP_PROXY) ? await proxySocket(parsed.hostname, Number(parsed.port || 5432)) : undefined
    const client = new pg.Client({ connectionString: parsed.toString(), ssl, stream, ...(env.CLOSER_DB_SSL_NEGOTIATION === 'direct' ? { sslnegotiation: 'direct' } : {}), connectionTimeoutMillis: 20000, query_timeout: 30000 })
    await client.connect(); database = client
    return async query => { const result = await client.query(query); return (Array.isArray(result) ? result.at(-1) : result).rows }
  }
  if (env.SUPABASE_ACCESS_TOKEN && projectRef) return async query => {
    const response = await fetch(`https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/database/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }), signal: AbortSignal.timeout(30000),
    })
    if (!response.ok) fail(`A API de administração recusou a operação SQL (HTTP ${response.status}).`)
    const result = await response.json()
    return Array.isArray(result) ? result : result.result || result.data || []
  }
  fail('Falta uma conexão de banco: SUPABASE_DB_URL/POSTGRES_URL ou SUPABASE_ACCESS_TOKEN. Forneça a credencial nas configurações seguras, nunca pelo chat.')
}

async function main() {
  if (!url || !publicKey(key)) fail('Configure a URL e a chave pública do Supabase. Chaves administrativas nunca podem entrar no frontend.')
  if (!secret && !values['check-only']) fail('Falta SUPABASE_SERVICE_ROLE_KEY ou SUPABASE_SECRET_KEY para configurar o administrador.')
  const client = createClient(url, values['check-only'] ? key : secret, { auth: { persistSession: false, autoRefreshToken: false } })
  const settings = await fetch(new URL('/auth/v1/settings', url), { headers: { apikey: key }, signal: AbortSignal.timeout(20000) })
  if (!settings.ok) fail(`A autenticação não respondeu corretamente (HTTP ${settings.status}).`)
  console.log('Supabase Auth: conexão HTTPS verificada.')
  const query = await openDatabase()
  const schema = await query("select to_regclass('private.schema_migrations') is not null as tracked, to_regclass('public.workspaces') is not null as installed")
  const version = '202610070001_closer_os'
  const migration = await readFile(new URL('../supabase/migrations/202610070001_closer_os.sql', import.meta.url), 'utf8')
  const checksum = createHash('sha256').update(migration).digest('hex')
  if (schema[0]?.tracked) {
    const recorded = await query(`select checksum from private.schema_migrations where version=${sqlString(version)}`)
    if (recorded[0]?.checksum !== checksum) fail('A migração instalada diverge deste código. Prepare uma nova migração; o script não sobrescreve o banco.')
    console.log('Schema: versão e checksum conferidos; nenhuma migração repetida.')
  } else if (values['check-only']) fail('O schema do Closer OS ainda não foi instalado por este procedimento.')
  else {
    if (schema[0]?.installed) fail('Já existe uma tabela workspaces sem registro de migração. Revise o projeto antes de prosseguir; nenhuma tabela foi sobrescrita.')
    const tracking = `create table private.schema_migrations(version text primary key, checksum text not null, applied_at timestamptz not null default now());\ninsert into private.schema_migrations(version,checksum) values(${sqlString(version)},${sqlString(checksum)});`
    await query(migration.replace(/commit;\s*$/i, `${tracking}\ncommit;`))
    console.log('Schema: migração instalada em transação, com controle de versão.')
  }
  const checks = await query("select tablename, rowsecurity from pg_tables where schemaname='public' and tablename in ('profiles','platform_admins','workspaces','memberships','leads','subscriptions','invitations','workspace_settings','audit_logs','policy_acceptances','bootstrap_settings')")
  if (checks.length !== 11 || checks.some(row => !row.rowsecurity)) fail('As tabelas esperadas ou as regras RLS não estão completas.')
  console.log('Autorização: 11 tabelas com RLS ativada.')
  if (values['check-only']) { console.log('Verificação concluída, sem alteração de contas ou dados.'); return }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) fail('Informe --owner-email ou CLOSER_OWNER_EMAIL para preparar o acesso do dono.')
  const destination = new URL(appUrl)
  if (destination.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(destination.hostname)) fail('A URL de acesso deve usar HTTPS.')
  await query(`update public.bootstrap_settings set allowed_emails=array[${sqlString(ownerEmail)}] where enabled and not exists(select 1 from public.platform_admins);`)
  console.log('Bootstrap: e-mail do dono autorizado no banco; não existe autoatribuição pública de administrador.')
  if (values['invite-owner']) {
    destination.searchParams.set('flow', 'activate')
    const result = await client.auth.admin.inviteUserByEmail(ownerEmail, { redirectTo: destination.toString(), data: { display_name: 'Administrador do Closer OS' } })
    if (result.error) fail(`O convite do dono não foi enviado: ${result.error.message}`)
    console.log('Convite de ativação enviado ao e-mail do dono. A senha será definida pelo destinatário.')
  }
  console.log('Provisionamento concluído. Configure as URLs permitidas e a entrega de e-mails do Supabase Auth antes de liberar clientes.')
}

try { await main() } catch (error) { console.error(safeError(error)); process.exitCode = 1 }
finally { if (database) await database.end() }
