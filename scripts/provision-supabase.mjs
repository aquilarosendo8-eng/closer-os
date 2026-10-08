#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises'
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
  // Serialize concurrent builders on the persistent PostgreSQL connection.
  // The lock is released automatically when that connection closes.
  if (database) await query("select pg_advisory_lock(hashtext('closer_os_schema_migrations'))")
  const schema = await query("select to_regclass('private.schema_migrations') is not null as tracked, to_regclass('public.workspaces') is not null as installed")
  const directory = new URL('../supabase/migrations/', import.meta.url)
  const filenames = (await readdir(directory)).filter(name => /^\d{12}_[a-z0-9_]+\.sql$/.test(name)).sort()
  if (filenames[0] !== '202610070001_closer_os.sql') fail('A migração inicial do Closer OS não foi encontrada.')
  const migrations = await Promise.all(filenames.map(async filename => {
    const migration = await readFile(new URL(filename, directory), 'utf8')
    return { version: filename.slice(0, -4), migration, checksum: createHash('sha256').update(migration).digest('hex') }
  }))
  let tracked = Boolean(schema[0]?.tracked)
  if (!tracked) {
    if (values['check-only']) fail('O schema do Closer OS ainda não foi instalado por este procedimento.')
    if (schema[0]?.installed) fail('Já existe uma tabela workspaces sem registro de migração. Revise o projeto antes de prosseguir; nenhuma tabela foi sobrescrita.')
  }
  const recorded = tracked ? await query('select version, checksum from private.schema_migrations') : []
  const versions = new Set(migrations.map(row => row.version))
  if (recorded.some(row => !versions.has(row.version))) fail('O banco contém uma migração ausente deste checkout. Revise a versão antes de publicar.')
  if (tracked && !recorded.some(row => row.version === '202610070001_closer_os')) fail('O registro da migração inicial está ausente. Revise o banco antes de publicar.')
  // Validate every applied checksum before installing any pending migration.
  let pendingSeen = false
  for (const { version, checksum } of migrations) {
    const existing = recorded.find(row => row.version === version)
    if (existing) {
      if (existing.checksum !== checksum) fail('A migração instalada diverge deste código. Prepare uma nova migração; o script não sobrescreve o banco.')
      if (pendingSeen) fail('O registro de migrações possui uma lacuna. Revise o banco antes de publicar.')
    } else pendingSeen = true
  }
  let applied = 0
  for (const { version, migration, checksum } of migrations) {
    if (recorded.some(row => row.version === version)) continue
    if (values['check-only']) fail(`Existe uma migração pendente: ${version}. A verificação não altera o banco.`)
    if (!/commit;\s*$/i.test(migration)) fail(`A migração ${version} precisa terminar com COMMIT para registrar seu checksum na mesma transação.`)
    const table = tracked ? '' : 'create table private.schema_migrations(version text primary key, checksum text not null, applied_at timestamptz not null default now());\n'
    const tracking = `${table}insert into private.schema_migrations(version,checksum) values(${sqlString(version)},${sqlString(checksum)});`
    await query(migration.replace(/commit;\s*$/i, `${tracking}\ncommit;`))
    tracked = true; applied += 1
    console.log(`Schema: ${version} instalada em transação, com controle de versão.`)
  }
  console.log(`Schema: ${filenames.length} versões e checksums conferidos; ${applied} migrações aplicadas.`)
  const expectedTables = ['profiles','platform_admins','workspaces','memberships','leads','subscriptions','invitations','workspace_settings','audit_logs','policy_acceptances','bootstrap_settings','pipelines','pipeline_stages','call_reviews','activities','lead_events']
  const checks = await query(`select tablename, rowsecurity from pg_tables where schemaname='public' and tablename in (${expectedTables.map(sqlString).join(',')})`)
  if (checks.length !== expectedTables.length || checks.some(row => !row.rowsecurity)) fail('As tabelas esperadas ou as regras RLS não estão completas.')
  const stageColumn = await query("select is_nullable from information_schema.columns where table_schema='public' and table_name='leads' and column_name='stage_id'")
  if (stageColumn.length !== 1 || stageColumn[0].is_nullable !== 'NO') fail('O vínculo obrigatório entre leads e etapas do pipeline não está completo.')
  const historyAccess = await query("select has_table_privilege('authenticated','public.activities','INSERT,UPDATE,DELETE') as task_write, has_table_privilege('authenticated','public.lead_events','INSERT,UPDATE,DELETE') as event_write, to_regprocedure('public.save_activity(uuid,text,text,text,timestamp with time zone,uuid,text,uuid)') is not null as activity_rpc, to_regprocedure('public.list_lead_call_history(uuid,text,integer,integer)') is not null as calls_rpc")
  if (historyAccess.length !== 1 || historyAccess[0].task_write || historyAccess[0].event_write || !historyAccess[0].activity_rpc || !historyAccess[0].calls_rpc) fail('Atividades e histórico precisam das funções autorizadas e não podem permitir escrita direta do cliente.')
  console.log(`Autorização: ${expectedTables.length} tabelas com RLS ativada e leads vinculados a etapas.`)
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
