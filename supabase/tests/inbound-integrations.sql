\set ON_ERROR_STOP on
-- Real PostgreSQL/RLS assertions in the disposable harness database only.
-- Credentials below are synthetic fixtures and never reach an external service.
select test.ok((select relrowsecurity from pg_class where oid='public.inbound_integrations'::regclass),'inbound: integrations enable RLS');
select test.ok((select relrowsecurity from pg_class where oid='public.inbound_integration_logs'::regclass),'inbound: operational logs enable RLS');
select test.ok((select relrowsecurity from pg_class where oid='private.inbound_rate_limits'::regclass),'inbound: persistent rate buckets enable RLS');
select test.ok(has_function_privilege('service_role','public.receive_inbound_lead(text,uuid,jsonb,text)','EXECUTE'),'inbound: service role may invoke transactional receive RPC');
select test.ok(not has_function_privilege('authenticated','public.receive_inbound_lead(text,uuid,jsonb,text)','EXECUTE'),'inbound: signed-in browser cannot invoke service receive RPC');
select test.ok(not has_function_privilege('anon','public.receive_inbound_lead(text,uuid,jsonb,text)','EXECUTE'),'inbound: anonymous browser cannot invoke service receive RPC');
select test.ok(not has_table_privilege('authenticated','public.inbound_integrations','INSERT,UPDATE,DELETE'),'inbound: clients cannot mutate integration rows directly');
select test.ok(not has_table_privilege('authenticated','public.inbound_integration_logs','INSERT,UPDATE,DELETE'),'inbound: clients cannot forge operational logs');
select test.ok(not has_table_privilege('authenticated','private.inbound_rate_limits','SELECT,INSERT,UPDATE,DELETE'),'inbound: browsers cannot read or reset rate buckets');
select test.ok(not has_function_privilege('authenticated','public.purge_inbound_integration_logs(integer)','EXECUTE'),'inbound: browsers cannot purge operational logs');
select test.ok(has_function_privilege('service_role','public.purge_inbound_integration_logs(integer)','EXECUTE'),'inbound: service may perform bounded log retention');
select test.ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  where n.nspname in ('public','private') and a.grantee=0 and a.privilege_type='EXECUTE'),'inbound: migration grants no implicit PUBLIC execution');
select test.ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prosecdef
  and not ('search_path=""'=any(p.proconfig))),'inbound: security definer functions retain empty search path');

insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'inbound-'||n||'@example.test',now(),jsonb_build_object('display_name','Pessoa inbound '||n)
from generate_series(80,85) n;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
insert into test.context values('inbound_ws_a',public.create_workspace('Empresa inbound A')::text),('inbound_ws_b',public.create_workspace('Empresa inbound B')::text);
select public.admin_update_subscription(test.value('inbound_ws_a')::uuid,'team','active',10);
select public.admin_update_subscription(test.value('inbound_ws_b')::uuid,'team','active',10);
reset role;
insert into public.memberships(workspace_id,user_id,role,is_active)
select test.value('inbound_ws_a')::uuid,('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,member_role,active
from (values(80,'admin',true),(81,'closer',true),(82,'manager',true),(83,'viewer',true),(85,'closer',false)) s(n,member_role,active);
insert into public.memberships(workspace_id,user_id,role,is_active)
values(test.value('inbound_ws_b')::uuid,'00000000-0000-0000-0000-000000000084','admin',true);
update public.workspaces set owner_id='00000000-0000-0000-0000-000000000080' where id=test.value('inbound_ws_a')::uuid;
update public.workspaces set owner_id='00000000-0000-0000-0000-000000000084' where id=test.value('inbound_ws_b')::uuid;
insert into test.context select 'inbound_stage_a',id::text from public.pipeline_stages where workspace_id=test.value('inbound_ws_a')::uuid and name='Lead novo';
insert into test.context select 'inbound_stage_b',id::text from public.pipeline_stages where workspace_id=test.value('inbound_ws_b')::uuid and name='Lead novo';
insert into test.context select 'inbound_won_a',id::text from public.pipeline_stages where workspace_id=test.value('inbound_ws_a')::uuid and type='WON';
insert into test.context select 'inbound_lost_a',id::text from public.pipeline_stages where workspace_id=test.value('inbound_ws_a')::uuid and type='LOST';
insert into test.context values('inbound_mapping','{"name":"full_name","email":"email_address","phone":"whatsapp","company":"company_name","ticket":"amount","source":"origin","notes":"message"}');

-- The fixture helper preserves the real caller role and calls the real RPC.
create function test.inbound(p_hash_key text,p_payload jsonb,p_transport_error text default null,p_request_id uuid default gen_random_uuid()) returns jsonb
language sql volatile set search_path=''
as $$ select public.receive_inbound_lead(test.value(p_hash_key),p_request_id,p_payload,p_transport_error); $$;
grant usage on schema test to service_role;
grant select,insert,update on test.context to service_role;
grant insert on test.results to service_role;

set role anon;
select test.denied(format('select public.list_inbound_integrations(%L)',test.value('inbound_ws_a')),'42501','inbound: anonymous cannot list integrations');
select test.denied('select public.receive_inbound_lead(repeat(''0'',64),gen_random_uuid(),''{}'')','42501','inbound: anonymous cannot bypass webhook through RPC');
select test.denied('select * from public.inbound_integration_logs','42501','inbound: anonymous cannot read operational logs');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','',false);
select test.denied(format('select public.list_inbound_integrations(%L)',test.value('inbound_ws_a')),'42501','inbound: missing identity cannot list integrations');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000080',false);
insert into test.context values('inbound_created_integration',public.create_inbound_integration(test.value('inbound_ws_a')::uuid,'  Formulário principal  ','  Formulário Site  ',
  test.value('inbound_stage_a')::uuid,'00000000-0000-0000-0000-000000000081',test.value('inbound_mapping')::jsonb)::text);
insert into test.context values('inbound_int_a',test.value('inbound_created_integration')::jsonb->'integration'->>'id'),
  ('inbound_token_a',test.value('inbound_created_integration')::jsonb->>'token');
select test.ok(length(test.value('inbound_token_a'))=64 and test.value('inbound_token_a') ~ '^[a-f0-9]{64}$','inbound: creation returns a 256-bit random token once');
select test.ok(test.value('inbound_created_integration')::jsonb->'integration'->>'name'='Formulário principal','inbound: creation trims integration name');
select test.ok(test.value('inbound_created_integration')::jsonb->'integration'->>'source'='Formulário Site','inbound: creation trims default source');
select test.ok(not (test.value('inbound_created_integration')::jsonb->'integration' ? 'token_hash'),'inbound: creation DTO does not disclose credential hash');
select test.denied(format('select public.list_inbound_integrations(%L)',test.value('inbound_ws_b')),'42501','inbound: tenant administrator cannot list another company integrations');
select test.denied('select public.receive_inbound_lead(repeat(''0'',64),gen_random_uuid(),''{}'')','42501','inbound: tenant administrator cannot call service ingress RPC');
select test.denied('update public.inbound_integrations set active=false','42501','inbound: administrator cannot bypass RPC through direct table update');
select test.denied('insert into public.inbound_integration_logs(workspace_id,integration_id,request_id,status) values(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),''created'')',
  '42501','inbound: administrator cannot forge a received-entry log');

-- Configuration is tenant scoped and validates the actual editable destination.
select test.denied(format('select public.create_inbound_integration(%L,''A'',''Site'',%L,%L,''{"name":"name"}'')',test.value('inbound_ws_a'),test.value('inbound_stage_a'),
  '00000000-0000-0000-0000-000000000081'),'22023','inbound: one-character integration name is rejected');
select test.denied(format('select public.create_inbound_integration(%L,''Nome'','' '',%L,%L,''{"name":"name"}'')',test.value('inbound_ws_a'),test.value('inbound_stage_a'),
  '00000000-0000-0000-0000-000000000081'),'22023','inbound: blank default source is rejected');
select test.denied(format('select public.create_inbound_integration(%L,''Nome'',''Site'',%L,%L,''{"name":"name"}'')',test.value('inbound_ws_a'),test.value('inbound_stage_b'),
  '00000000-0000-0000-0000-000000000081'),'23514','inbound: foreign stage cannot be configured');
select test.denied(format('select public.create_inbound_integration(%L,''Nome'',''Site'',%L,%L,''{"name":"name"}'')',test.value('inbound_ws_a'),test.value('inbound_won_a'),
  '00000000-0000-0000-0000-000000000081'),'23514','inbound: WON stage cannot be configured');
select test.denied(format('select public.create_inbound_integration(%L,''Nome'',''Site'',%L,%L,''{"name":"name"}'')',test.value('inbound_ws_a'),test.value('inbound_lost_a'),
  '00000000-0000-0000-0000-000000000081'),'23514','inbound: LOST stage cannot be configured');
select test.denied(format('select public.create_inbound_integration(%L,''Nome'',''Site'',%L,%L,''{"name":"name"}'')',test.value('inbound_ws_a'),test.value('inbound_stage_a'),
  '00000000-0000-0000-0000-000000000084'),'23514','inbound: foreign owner cannot be configured');
select test.denied(format('select public.create_inbound_integration(%L,''Nome'',''Site'',%L,%L,''{"name":"name"}'')',test.value('inbound_ws_a'),test.value('inbound_stage_a'),
  '00000000-0000-0000-0000-000000000083'),'23514','inbound: viewer cannot be configured as owner');
select test.denied(format('select public.create_inbound_integration(%L,''Nome'',''Site'',%L,%L,''{"name":"name"}'')',test.value('inbound_ws_a'),test.value('inbound_stage_a'),
  '00000000-0000-0000-0000-000000000085'),'23514','inbound: inactive owner cannot be configured');
select test.denied(format('select public.create_inbound_integration(%L,''Nome'',''Site'',%L,%L,''{}'')',test.value('inbound_ws_a'),test.value('inbound_stage_a'),
  '00000000-0000-0000-0000-000000000081'),'22023','inbound: mapping requires the name property');
select test.denied(format('select public.create_inbound_integration(%L,''Nome'',''Site'',%L,%L,''{"name":"name","workspaceId":"tenant"}'')',test.value('inbound_ws_a'),test.value('inbound_stage_a'),
  '00000000-0000-0000-0000-000000000081'),'22023','inbound: mapping cannot add unsupported protected fields');
select test.denied(format('select public.create_inbound_integration(%L,''Nome'',''Site'',%L,%L,''{"name":"__proto__"}'')',test.value('inbound_ws_a'),test.value('inbound_stage_a'),
  '00000000-0000-0000-0000-000000000081'),'22023','inbound: prototype property cannot be mapped');
select test.denied(format('select public.create_inbound_integration(%L,''Nome'',''Site'',%L,%L,''{"name":{"nested":"name"}}'')',test.value('inbound_ws_a'),test.value('inbound_stage_a'),
  '00000000-0000-0000-0000-000000000081'),'22023','inbound: mapping accepts flat string property names only');
insert into test.context values('inbound_second_created',public.create_inbound_integration(test.value('inbound_ws_a')::uuid,'Segundo formulário','Outra origem',test.value('inbound_stage_a')::uuid,
  '00000000-0000-0000-0000-000000000080','{"name":"name","email":"email","phone":"phone","ticket":"ticket"}')::text);
insert into test.context values('inbound_int_second',test.value('inbound_second_created')::jsonb->'integration'->>'id'),('inbound_token_second',test.value('inbound_second_created')::jsonb->>'token');
select test.ok(test.value('inbound_token_second')<>test.value('inbound_token_a'),'inbound: independent integrations get different random credentials');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000084',false);
insert into test.context values('inbound_b_created',public.create_inbound_integration(test.value('inbound_ws_b')::uuid,'Formulário B','Origem B',test.value('inbound_stage_b')::uuid,
  auth.uid(),'{"name":"name","email":"email","phone":"phone","ticket":"ticket"}')::text);
insert into test.context values('inbound_int_b',test.value('inbound_b_created')::jsonb->'integration'->>'id'),('inbound_token_b',test.value('inbound_b_created')::jsonb->>'token');
reset role;
insert into test.context values('inbound_hash_a',encode(extensions.digest(test.value('inbound_token_a'),'sha256'),'hex')),
  ('inbound_hash_second',encode(extensions.digest(test.value('inbound_token_second'),'sha256'),'hex')),
  ('inbound_hash_b',encode(extensions.digest(test.value('inbound_token_b'),'sha256'),'hex'));
select test.ok((select token_hash=test.value('inbound_hash_a') and token_hash<>test.value('inbound_token_a') from public.inbound_integrations where id=test.value('inbound_int_a')::uuid),
  'inbound: database persists SHA-256 rather than the plaintext token');
select test.ok((select workspace_id=test.value('inbound_ws_a')::uuid and stage_id=test.value('inbound_stage_a')::uuid and owner_id='00000000-0000-0000-0000-000000000081'
  and created_by='00000000-0000-0000-0000-000000000080' from public.inbound_integrations where id=test.value('inbound_int_a')::uuid),
  'inbound: stored configuration binds company stage owner and authenticated creator');

-- No role receives tenant administration merely from a platform/support role.
set role authenticated;
do $$ declare actor uuid; begin
  foreach actor in array array['00000000-0000-0000-0000-000000000081'::uuid,'00000000-0000-0000-0000-000000000082'::uuid,
    '00000000-0000-0000-0000-000000000083'::uuid,'00000000-0000-0000-0000-000000000085'::uuid,'00000000-0000-0000-0000-000000000001'::uuid] loop
    perform set_config('request.jwt.claim.sub',actor::text,false);
    perform test.denied(format('select public.list_inbound_integrations(%L)',test.value('inbound_ws_a')),'42501','inbound: nonadmin list denied for '||actor::text);
    perform test.denied(format('select public.rotate_inbound_integration_token(%L,%L)',test.value('inbound_ws_a'),test.value('inbound_int_a')),'42501','inbound: nonadmin rotation denied for '||actor::text);
    perform test.denied(format('select public.set_inbound_integration_active(%L,%L,false)',test.value('inbound_ws_a'),test.value('inbound_int_a')),'42501','inbound: nonadmin disable denied for '||actor::text);
    perform test.ok((select count(*)=0 from public.inbound_integrations where workspace_id=test.value('inbound_ws_a')::uuid),'inbound: integration RLS hides rows from '||actor::text);
  end loop;
end; $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000080',false);
select test.denied(format('select public.rotate_inbound_integration_token(%L,%L)',test.value('inbound_ws_a'),test.value('inbound_int_b')),'P0002','inbound: rotation cannot target another tenant integration ID');
select test.denied(format('select public.list_inbound_integration_logs(%L,%L)',test.value('inbound_ws_a'),test.value('inbound_int_b')),'P0002','inbound: log listing cannot target another tenant integration ID');
reset role;

insert into test.context values('inbound_unknown_hash',repeat('0',64)),('inbound_main_request',gen_random_uuid()::text);
set role service_role;
-- Even an unexpected subject on a trusted service request must not impersonate
-- a closer. The RPC must restore both request settings after creating the lead.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000080',false);
select set_config('request.jwt.claims','{"role":"service_role","sub":"00000000-0000-0000-0000-000000000080","fixture":"preserve"}',false);
insert into test.context values('inbound_main_result',test.inbound('inbound_hash_a',jsonb_build_object(
  'full_name','  João Silva  ','email_address','  JOAO@EXAMPLE.TEST  ','whatsapp','+44 (20) 7946-0958','company_name','  Empresa XPTO  ',
  'amount','15000.50','message','Observação mapeada','extra_secret','UNMAPPED_SECRET_SHOULD_NOT_PERSIST',
  'workspaceId',test.value('inbound_ws_b'),'ownerId','00000000-0000-0000-0000-000000000084','stageId',test.value('inbound_won_a'),
  'id','EXTERNAL_SPOOFED_ID','createdAt','1970-01-01T00:00:00.000Z','closedValue',999999,'status','Fechado'),null,test.value('inbound_main_request')::uuid)::text);
insert into test.context values('inbound_lead_main',test.value('inbound_main_result')::jsonb->>'lead_id');
select test.ok(test.value('inbound_main_result')::jsonb->>'status'='created' and test.value('inbound_main_result')::jsonb->>'http_status'='201','inbound: valid mapped request creates a real lead with HTTP 201 outcome');
select test.ok(test.value('inbound_main_result')::jsonb->>'request_id'=test.value('inbound_main_request'),'inbound: receive outcome correlates the server request ID');
select test.ok(test.value('inbound_lead_main') ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$','inbound: lead ID is generated rather than taken from external payload');
select test.ok(current_setting('request.jwt.claim.sub')='00000000-0000-0000-0000-000000000080','inbound: receive restores the original request subject');
select test.ok(current_setting('request.jwt.claims')::jsonb='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000080","fixture":"preserve"}'::jsonb,'inbound: receive restores the original complete request claims');
select set_config('request.jwt.claim.sub','',false);
select set_config('request.jwt.claims','{"role":"service_role"}',false);
select test.ok((select workspace_id=test.value('inbound_ws_a')::uuid and owner_id='00000000-0000-0000-0000-000000000081' and stage_id=test.value('inbound_stage_a')::uuid
  from public.leads where id=test.value('inbound_lead_main')),'inbound: external workspace owner and stage spoofing cannot change trusted configuration');
select test.ok((select data->>'name'='João Silva' and data->>'email'='joao@example.test' and data->>'company'='Empresa XPTO' from public.leads where id=test.value('inbound_lead_main')),'inbound: mapped text values are trimmed and email is normalized');
select test.ok((select data->>'source'='Formulário Site' and (data->>'ticket')::numeric=15000.50 from public.leads where id=test.value('inbound_lead_main')),'inbound: omitted mapped source uses configured default and decimal ticket is preserved');
select test.ok((select data->>'notes'='Observação mapeada' and data::text not like '%UNMAPPED_SECRET_SHOULD_NOT_PERSIST%' from public.leads where id=test.value('inbound_lead_main')),'inbound: unmapped payload never leaks into observations or lead data');
select test.ok((select data->>'stageType'='NORMAL' and data->>'status'='Lead novo' and data->>'attendance'='Pendente' and data->'closedValue'='0'::jsonb
  and data->>'closedAt'='' and data->'callScore'='null'::jsonb and data->'decisionMaker'='false'::jsonb from public.leads where id=test.value('inbound_lead_main')),
  'inbound: receiver builds ordinary non-won lead defaults without weakening validation');
select test.ok((select private.valid_lead_data(data) from public.leads where id=test.value('inbound_lead_main')),'inbound: created JSON satisfies the existing complete lead validator');
select test.ok((select created_by is null and updated_by is null and created_at>now()-interval '5 minutes'
  and (data->>'createdAt')::timestamptz>now()-interval '5 minutes' and retention_until>created_at
  from public.leads where id=test.value('inbound_lead_main')),'inbound: automation actor timestamps and retention come from the server');
select test.ok((select count(*)=1 and bool_and(actor_id is null) from public.lead_events where workspace_id=test.value('inbound_ws_a')::uuid
  and lead_id=test.value('inbound_lead_main') and event_type='lead.created'),'inbound: existing normal lead-created event remains intact with automation actor');
select test.ok((select count(*)=1 and bool_and(actor_id is null and metadata=jsonb_build_object('integration_id',test.value('inbound_int_a')::uuid,
  'integration_name','Formulário principal','source','Formulário Site')) from public.lead_events
  where workspace_id=test.value('inbound_ws_a')::uuid and lead_id=test.value('inbound_lead_main') and event_type='lead.inbound_received'),
  'inbound: timeline records integration identity and source without contact payload');
select test.ok((select count(*)=1 and bool_and(status='created' and lead_id=test.value('inbound_lead_main')) from public.inbound_integration_logs
  where integration_id=test.value('inbound_int_a')::uuid and request_id=test.value('inbound_main_request')::uuid),'inbound: created outcome persists one correlated operational log');
insert into test.context values('inbound_main_before_replay',(select to_jsonb(l)::text from public.leads l where id=test.value('inbound_lead_main'))),
  ('inbound_integration_before_replay',(select to_jsonb(i)::text from public.inbound_integrations i where id=test.value('inbound_int_a')::uuid)),
  ('inbound_events_before_replay',(select count(*)::text from public.lead_events where lead_id=test.value('inbound_lead_main')));
select test.ok(test.inbound('inbound_hash_a','{"full_name":"Replay must not overwrite","email_address":"joao@example.test"}',null,test.value('inbound_main_request')::uuid)
  =test.value('inbound_main_result')::jsonb,'inbound: request replay returns its previous committed outcome');
select test.ok((select to_jsonb(l)=test.value('inbound_main_before_replay')::jsonb from public.leads l where id=test.value('inbound_lead_main')),'inbound: replay cannot overwrite the existing lead');
select test.ok((select to_jsonb(i)=test.value('inbound_integration_before_replay')::jsonb from public.inbound_integrations i where id=test.value('inbound_int_a')::uuid),'inbound: replay cannot inflate integration counters or last-received metadata');
select test.ok((select count(*)=test.value('inbound_events_before_replay')::bigint from public.lead_events where lead_id=test.value('inbound_lead_main')),'inbound: replay cannot duplicate timeline events');

-- Invalid mapped values commit rejected operational outcomes, not partial leads.
do $$ declare fixture jsonb; result jsonb; before_count bigint; begin
  select count(*) into before_count from public.leads where workspace_id=test.value('inbound_ws_a')::uuid;
  for fixture in select value from jsonb_array_elements(jsonb_build_array(
    jsonb_build_object('label','missing name','code','NAME_REQUIRED','payload','{}'::jsonb),
    jsonb_build_object('label','blank name','code','NAME_REQUIRED','payload','{"full_name":"  "}'::jsonb),
    jsonb_build_object('label','nonstring name','code','FIELD_INVALID','payload','{"full_name":["Nome"]}'::jsonb),
    jsonb_build_object('label','overlong name','code','FIELD_INVALID','payload',jsonb_build_object('full_name',repeat('n',201))),
    jsonb_build_object('label','nonstring email','code','FIELD_INVALID','payload','{"full_name":"Nome","email_address":{}}'::jsonb),
    jsonb_build_object('label','overlong email','code','FIELD_INVALID','payload',jsonb_build_object('full_name','Nome','email_address',repeat('e',255))),
    jsonb_build_object('label','overlong phone','code','FIELD_INVALID','payload',jsonb_build_object('full_name','Nome','whatsapp',repeat('1',65))),
    jsonb_build_object('label','overlong company','code','FIELD_INVALID','payload',jsonb_build_object('full_name','Nome','company_name',repeat('c',201))),
    jsonb_build_object('label','overlong source','code','FIELD_INVALID','payload',jsonb_build_object('full_name','Nome','origin',repeat('s',121))),
    jsonb_build_object('label','overlong notes','code','FIELD_INVALID','payload',jsonb_build_object('full_name','Nome','message',repeat('m',10001))),
    jsonb_build_object('label','negative ticket','code','TICKET_INVALID','payload','{"full_name":"Nome","amount":-1}'::jsonb),
    jsonb_build_object('label','overlong ticket','code','TICKET_INVALID','payload','{"full_name":"Nome","amount":1000000000001}'::jsonb),
    jsonb_build_object('label','comma ticket','code','TICKET_INVALID','payload','{"full_name":"Nome","amount":"15,50"}'::jsonb),
    jsonb_build_object('label','exponent ticket string','code','TICKET_INVALID','payload','{"full_name":"Nome","amount":"1e3"}'::jsonb),
    jsonb_build_object('label','boolean ticket','code','TICKET_INVALID','payload','{"full_name":"Nome","amount":true}'::jsonb),
    jsonb_build_object('label','object ticket','code','TICKET_INVALID','payload','{"full_name":"Nome","amount":{}}'::jsonb)
  )) loop
    result:=test.inbound('inbound_hash_a',fixture->'payload');
    perform test.ok(result->>'status'='rejected' and result->>'error_code'=fixture->>'code' and result->>'http_status'='422',
      'inbound: rejected mapped input '||(fixture->>'label'));
  end loop;
  perform test.ok((select count(*)=before_count from public.leads where workspace_id=test.value('inbound_ws_a')::uuid),'inbound: invalid mapped inputs create no partial leads');
end; $$;
insert into test.context values('inbound_defaults_result',test.inbound('inbound_hash_a','{"full_name":"Lead sem contato","origin":"Origem recebida"}')::text);
select test.ok(test.value('inbound_defaults_result')::jsonb->>'status'='created','inbound: name-only form works without contact identifiers');
select test.ok((select data->>'email'='' and data->>'phone'='' and data->>'company'='' and data->>'notes'='' and data->'ticket'='0'::jsonb
  and data->>'source'='Origem recebida' from public.leads where id=test.value('inbound_defaults_result')::jsonb->>'lead_id'),'inbound: optional omitted fields use ordinary lead defaults and mapped source wins');
select test.ok(test.inbound('inbound_hash_a','{"full_name":"Lead sem contato"}')->>'status'='created','inbound: contactless leads are not deduplicated merely by name');
insert into test.context values('inbound_max_ticket_result',test.inbound('inbound_hash_second','{"name":"Ticket máximo","ticket":"1000000000000.00"}')::text);
select test.ok(test.value('inbound_max_ticket_result')::jsonb->>'status'='created','inbound: inclusive maximum decimal ticket is accepted');
select test.ok((select (data->>'ticket')::numeric=1000000000000 from public.leads where id=test.value('inbound_max_ticket_result')::jsonb->>'lead_id'),'inbound: maximum ticket remains a numeric JSON value');
select test.ok(test.inbound('inbound_unknown_hash','{"full_name":"Não criar"}')->>'status'='rejected','inbound: unknown credential hash receives opaque rejected outcome');
select test.ok(public.receive_inbound_lead('malformed',gen_random_uuid(),'{}')->>'http_status'='401','inbound: malformed credential receives generic unauthorized HTTP outcome');
reset role;

-- Existing/manual contacts participate in deduplication; their payloads remain unchanged.
insert into public.leads(workspace_id,id,owner_id,data) values
  (test.value('inbound_ws_a')::uuid,'inbound-legacy-email','00000000-0000-0000-0000-000000000080',test.lead('inbound-legacy-email')||'{"email":"  LEGACY.MIXED@Example.TEST  ","phone":"","notes":"Nota manual preservada"}'),
  (test.value('inbound_ws_a')::uuid,'inbound-legacy-phone','00000000-0000-0000-0000-000000000080',test.lead('inbound-legacy-phone')||'{"email":"","phone":"+1 (415) 555-0100","notes":"Contato manual preservado"}'),
  (test.value('inbound_ws_a')::uuid,'inbound-manual-duplicate','00000000-0000-0000-0000-000000000080',test.lead('inbound-manual-duplicate')||'{"email":"joao@example.test","phone":"+442079460958"}'),
  (test.value('inbound_ws_a')::uuid,'inbound-long-legacy','00000000-0000-0000-0000-000000000080',test.lead('inbound-long-legacy')||jsonb_build_object('email',repeat('x',5000),'phone',repeat('1',5000)));
insert into test.context values('inbound_existing_before_dedup',(select jsonb_agg(to_jsonb(l) order by id)::text from public.leads l where workspace_id=test.value('inbound_ws_a')::uuid));
select test.ok((select count(*)=2 from public.leads where workspace_id=test.value('inbound_ws_a')::uuid and lower(btrim(data->>'email'))='joao@example.test'),
  'inbound: existing manual duplicate creation remains allowed');
select test.ok((select length(data->>'email')=5000 and length(data->>'phone')=5000 from public.leads where id='inbound-long-legacy'),
  'inbound: identity indexes do not reject large legacy contact strings');
set role service_role;
select set_config('request.jwt.claim.sub','',false);
insert into test.context values('inbound_duplicate_email',test.inbound('inbound_hash_a','{"full_name":"Não sobrescrever nome","email_address":"  JOAO@EXAMPLE.TEST  ","amount":1,"message":"Não sobrescrever nota"}')::text);
select test.ok(test.value('inbound_duplicate_email')::jsonb->>'status'='duplicate' and test.value('inbound_duplicate_email')::jsonb->>'http_status'='200'
  and test.value('inbound_duplicate_email')::jsonb->>'lead_id'=test.value('inbound_lead_main'),'inbound: normalized email returns the existing same-workspace lead');
insert into test.context values('inbound_duplicate_phone',test.inbound('inbound_hash_a','{"full_name":"Telefone repetido","whatsapp":"+44 20 7946 0958"}')::text);
select test.ok(test.value('inbound_duplicate_phone')::jsonb->>'status'='duplicate' and test.value('inbound_duplicate_phone')::jsonb->>'lead_id'=test.value('inbound_lead_main'),
  'inbound: normalized international phone returns the existing same-workspace lead');
select test.ok(test.inbound('inbound_hash_a','{"full_name":"Contato legado","email_address":"legacy.mixed@example.test"}')->>'lead_id'='inbound-legacy-email',
  'inbound: normalization detects email on pre-existing manual leads');
select test.ok(test.inbound('inbound_hash_a','{"full_name":"Contato legado","whatsapp":"+1 415-555-0100"}')->>'lead_id'='inbound-legacy-phone',
  'inbound: normalization detects phone on pre-existing manual leads');
select test.ok(test.inbound('inbound_hash_second','{"name":"Mesmo contato em outra integração","email":"joao@example.test"}')->>'status'='duplicate',
  'inbound: dedup spans different integrations in the same workspace');
insert into test.context values('inbound_cross_contact',test.inbound('inbound_hash_a','{"full_name":"Contatos cruzados","email_address":"legacy.mixed@example.test","whatsapp":"+1 415 555 0100"}')::text);
select test.ok(test.value('inbound_cross_contact')::jsonb->>'status'='duplicate'
  and test.value('inbound_cross_contact')::jsonb->>'lead_id' in ('inbound-legacy-email','inbound-legacy-phone'),
  'inbound: contacts matching different legacy records do not create or merge another lead');
select test.ok((select jsonb_agg(to_jsonb(l) order by id)=test.value('inbound_existing_before_dedup')::jsonb from public.leads l where workspace_id=test.value('inbound_ws_a')::uuid),
  'inbound: duplicate processing preserves every existing lead byte-for-byte');
select test.ok((select count(*)=1 from public.lead_events where lead_id=test.value('inbound_lead_main') and event_type='lead.inbound_received'),
  'inbound: duplicates never append a second receipt event to an existing lead');
insert into test.context values('inbound_cross_workspace_result',test.inbound('inbound_hash_b','{"name":"João empresa B","email":"JOAO@EXAMPLE.TEST","phone":"+44 20 7946 0958"}')::text);
select test.ok(test.value('inbound_cross_workspace_result')::jsonb->>'status'='created'
  and test.value('inbound_cross_workspace_result')::jsonb->>'lead_id'<>test.value('inbound_lead_main'),'inbound: same email and phone create independently in another workspace');
select test.ok((select workspace_id=test.value('inbound_ws_b')::uuid and owner_id='00000000-0000-0000-0000-000000000084'
  from public.leads where id=test.value('inbound_cross_workspace_result')::jsonb->>'lead_id'),'inbound: cross-workspace copy retains its own trusted owner and workspace');
insert into test.context values('inbound_sql_text_result',test.inbound('inbound_hash_a',jsonb_build_object('full_name','Robert''); DROP TABLE public.leads; --','message','<script>alert("fixture")</script>'))::text);
select test.ok(test.value('inbound_sql_text_result')::jsonb->>'status'='created' and to_regclass('public.leads') is not null,'inbound: SQL-shaped names remain data and cannot change schema');
select test.ok((select data->>'notes'='<script>alert("fixture")</script>' from public.leads where id=test.value('inbound_sql_text_result')::jsonb->>'lead_id'),
  'inbound: markup is stored as a string without SQL evaluation or raw-payload expansion');
reset role;

-- Roster roles continue to determine ordinary lead and timeline visibility.
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000081',false);
select test.ok(exists(select 1 from public.leads where id=test.value('inbound_lead_main')),'inbound: configured closer can read the automatically assigned lead');
select test.ok(not exists(select 1 from public.leads where id='inbound-legacy-email'),'inbound: assigned closer cannot read another owner manual lead');
select test.ok(not exists(select 1 from public.leads where workspace_id=test.value('inbound_ws_b')::uuid),'inbound: closer cannot see another workspace automatic leads');
select test.ok(exists(select 1 from public.lead_events where lead_id=test.value('inbound_lead_main') and event_type='lead.inbound_received'),'inbound: assigned closer sees receipt through existing timeline RLS');
select test.ok(not exists(select 1 from public.inbound_integration_logs where workspace_id=test.value('inbound_ws_a')::uuid),'inbound: closer cannot read integration logs even for own leads');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000083',false);
select test.ok(exists(select 1 from public.leads where id=test.value('inbound_lead_main')),'inbound: viewer retains authorized workspace lead visibility');
select test.ok(not exists(select 1 from public.inbound_integration_logs),'inbound: viewer cannot read integration logs');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select test.ok(not exists(select 1 from public.lead_events where workspace_id=test.value('inbound_ws_a')::uuid),'inbound: platform support role alone gains no inbound timeline access');
select test.ok(not exists(select 1 from public.inbound_integration_logs where workspace_id=test.value('inbound_ws_a')::uuid),'inbound: platform support role alone gains no integration-log access');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000080',false);
insert into test.context values('inbound_export',public.export_workspace(test.value('inbound_ws_a')::uuid)::text);
select test.ok(exists(select 1 from jsonb_array_elements(test.value('inbound_export')::jsonb->'leads') l where l->>'id'=test.value('inbound_lead_main')),
  'inbound: automatic lead participates in the existing workspace export');
select test.ok(exists(select 1 from jsonb_array_elements(test.value('inbound_export')::jsonb->'lead_events') e where e->>'event_type'='lead.inbound_received'),
  'inbound: receipt history participates in the existing event export');
insert into test.context values('inbound_log_page',public.list_inbound_integration_logs(test.value('inbound_ws_a')::uuid,test.value('inbound_int_a')::uuid,null,2)::text);
select test.ok(jsonb_array_length(test.value('inbound_log_page')::jsonb->'items')=2 and test.value('inbound_log_page')::jsonb->>'next_cursor' is not null,
  'inbound: administrator log listing returns bounded cursor pagination');
select test.ok(jsonb_typeof(test.value('inbound_log_page')::jsonb->'items'->0->'id')='string','inbound: log DTO serializes bigint ID without precision loss');
insert into test.context values('inbound_log_page_second',public.list_inbound_integration_logs(test.value('inbound_ws_a')::uuid,test.value('inbound_int_a')::uuid,
  (test.value('inbound_log_page')::jsonb->>'next_cursor')::bigint,2)::text);
select test.ok(not exists(select 1 from jsonb_array_elements(test.value('inbound_log_page')::jsonb->'items') a
  join jsonb_array_elements(test.value('inbound_log_page_second')::jsonb->'items') b on a->>'id'=b->>'id'),'inbound: adjacent operational-log cursor pages do not overlap');
select test.denied('select token_hash from public.inbound_integrations','42501','inbound: even tenant administrator cannot select the stored credential hash');
select test.ok(not exists(select 1 from jsonb_array_elements(public.list_inbound_integrations(test.value('inbound_ws_a')::uuid)) i where i ? 'token' or i ? 'token_hash'),
  'inbound: ordinary list DTO never returns a credential or hash');
select test.denied(format('select public.list_inbound_integration_logs(%L,%L,null,0)',test.value('inbound_ws_a'),test.value('inbound_int_a')),'22023','inbound: zero-sized log page is rejected');
select test.denied(format('select public.list_inbound_integration_logs(%L,%L,-1,30)',test.value('inbound_ws_a'),test.value('inbound_int_a')),'22023','inbound: invalid log cursor is rejected');
insert into test.context values('inbound_update_result',public.update_inbound_integration(test.value('inbound_ws_a')::uuid,test.value('inbound_int_second')::uuid,
  '  Segundo formulário atualizado  ','  Origem atualizada  ',test.value('inbound_stage_a')::uuid,'00000000-0000-0000-0000-000000000080',
  '{"name":"name","email":"email","phone":"phone","ticket":"ticket"}')::text);
select test.ok(test.value('inbound_update_result')::jsonb->>'name'='Segundo formulário atualizado' and test.value('inbound_update_result')::jsonb->>'source'='Origem atualizada',
  'inbound: configuration edit persists trimmed metadata');
select test.ok(not(test.value('inbound_update_result')::jsonb ? 'token') and not(test.value('inbound_update_result')::jsonb ? 'token_hash'),'inbound: configuration edit never rediscloses credential');
insert into test.context values('inbound_literal_created',public.create_inbound_integration(test.value('inbound_ws_a')::uuid,'Propriedades literais','Literal',test.value('inbound_stage_a')::uuid,
  null,'{"name":"contact.name","email":"contact.email"}')::text);
insert into test.context values('inbound_literal_int',test.value('inbound_literal_created')::jsonb->'integration'->>'id'),
  ('inbound_literal_token',test.value('inbound_literal_created')::jsonb->>'token');
select test.ok(test.value('inbound_literal_created')::jsonb->'integration'->>'owner_id'=auth.uid()::text,'inbound: omitted owner safely falls back to the creating active administrator');
reset role;
insert into test.context values('inbound_literal_hash',encode(extensions.digest(test.value('inbound_literal_token'),'sha256'),'hex'));
set role service_role;
insert into test.context values('inbound_literal_result',test.inbound('inbound_literal_hash','{"contact.name":"Nome literal","contact.email":"literal@example.test","contact":{"name":"Não resolver como caminho"}}')::text);
select test.ok(test.value('inbound_literal_result')::jsonb->>'status'='created','inbound: mapping resolves literal dotted property names safely');
select test.ok((select data->>'name'='Nome literal' and data->>'email'='literal@example.test' from public.leads where id=test.value('inbound_literal_result')::jsonb->>'lead_id'),
  'inbound: literal mapping never traverses an unrelated nested object');
do $$ declare code text; result jsonb; expected_http text; before_count bigint; begin
  select count(*) into before_count from public.leads where workspace_id=test.value('inbound_ws_a')::uuid;
  foreach code in array array['INVALID_BODY','BODY_TOO_LARGE','UNSUPPORTED_MEDIA_TYPE','UNSUPPORTED_ENCODING','BODY_TOO_DEEP','UNSAFE_PROPERTY'] loop
    result:=test.inbound('inbound_hash_a',null,code);
    expected_http:=case code when 'BODY_TOO_LARGE' then '413' when 'UNSUPPORTED_MEDIA_TYPE' then '415' when 'UNSUPPORTED_ENCODING' then '415' else '400' end;
    perform test.ok(result->>'status'='rejected' and result->>'error_code'=code and result->>'http_status'=expected_http,'inbound: safe transport outcome '||code);
  end loop;
  result:=test.inbound('inbound_hash_a',null,'SECRET_UNAPPROVED_DIAGNOSTIC');
  perform test.ok(result->>'error_code'='INVALID_BODY' and result::text not like '%SECRET_UNAPPROVED_DIAGNOSTIC%','inbound: unknown transport diagnostic is replaced by a safe allowlisted code');
  perform test.ok((select count(*)=before_count from public.leads where workspace_id=test.value('inbound_ws_a')::uuid),'inbound: transport rejections cannot create partial leads');
end; $$;
select test.ok(test.inbound('inbound_hash_a','[]')->>'error_code'='INVALID_BODY','inbound: database independently rejects nonobject payload');
select test.ok(test.inbound('inbound_hash_a',jsonb_build_object('full_name','Body excessivo','extra',repeat('x',65536)))->>'error_code'='BODY_TOO_LARGE',
  'inbound: database independently enforces a 64 KB payload limit');
select test.ok(test.inbound('inbound_hash_a','{"full_name":"Profundo","extra":{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":1}}}}}}}}}')->>'error_code'='BODY_TOO_DEEP',
  'inbound: database independently rejects excessively deep payload structure');
select test.ok(test.inbound('inbound_hash_a','{"full_name":"Inseguro","extra":{"__proto__":{"polluted":true}}}')->>'error_code'='UNSAFE_PROPERTY',
  'inbound: nested prototype property is rejected before mapping');
reset role;

-- Runtime validation uses current stage/owner/subscription rather than creation-time data.
update public.pipeline_stages set active=false where id=test.value('inbound_stage_a')::uuid;
set role service_role;
select test.ok(test.inbound('inbound_hash_a','{"full_name":"Etapa desativada"}')->>'error_code'='STAGE_UNAVAILABLE','inbound: deactivated destination stage stops inbound creation');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000080',false);
select test.denied(format('select public.set_inbound_integration_active(%L,%L,true)',test.value('inbound_ws_a'),test.value('inbound_int_a')),'23514','inbound: activation revalidates unavailable stage');
reset role;
update public.pipeline_stages set active=true where id=test.value('inbound_stage_a')::uuid;
update public.memberships set is_active=false where workspace_id=test.value('inbound_ws_a')::uuid and user_id='00000000-0000-0000-0000-000000000081';
set role service_role;
select test.ok(test.inbound('inbound_hash_a','{"full_name":"Responsável desativado"}')->>'error_code'='OWNER_UNAVAILABLE','inbound: deactivated configured owner stops inbound creation');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000080',false);
select test.denied(format('select public.set_inbound_integration_active(%L,%L,true)',test.value('inbound_ws_a'),test.value('inbound_int_a')),'23514','inbound: activation revalidates unavailable owner');
reset role;
update public.memberships set is_active=true,role='viewer' where workspace_id=test.value('inbound_ws_a')::uuid and user_id='00000000-0000-0000-0000-000000000081';
set role service_role;
select test.ok(test.inbound('inbound_hash_a','{"full_name":"Responsável sem edição"}')->>'error_code'='OWNER_UNAVAILABLE','inbound: demoted owner cannot receive automatically assigned leads');
reset role;
update public.memberships set role='closer' where workspace_id=test.value('inbound_ws_a')::uuid and user_id='00000000-0000-0000-0000-000000000081';
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select public.admin_update_subscription(test.value('inbound_ws_a')::uuid,'team','suspended',10);
reset role;
set role service_role;
insert into test.context values('inbound_suspended_result',test.inbound('inbound_hash_a','{"full_name":"Workspace pausado"}')::text);
select test.ok(test.value('inbound_suspended_result')::jsonb->>'status'='rejected' and test.value('inbound_suspended_result')::jsonb->>'error_code'='WORKSPACE_UNAVAILABLE'
  and test.value('inbound_suspended_result')::jsonb->>'http_status'='403','inbound: suspended workspace refuses ingestion despite a valid active credential');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select public.admin_update_subscription(test.value('inbound_ws_a')::uuid,'team','active',10);
reset role;

-- Foreign-key cleanup preserves the workspace and makes removed destinations unavailable.
insert into public.pipeline_stages(workspace_id,pipeline_id,name,position,color,type,legacy_status)
select test.value('inbound_ws_a')::uuid,id,'Destino temporário',7,'#123456','NORMAL','Qualificado' from public.pipelines where workspace_id=test.value('inbound_ws_a')::uuid and is_default;
insert into test.context select 'inbound_temporary_stage',id::text from public.pipeline_stages where workspace_id=test.value('inbound_ws_a')::uuid and name='Destino temporário';
update public.memberships set is_active=true where workspace_id=test.value('inbound_ws_a')::uuid and user_id='00000000-0000-0000-0000-000000000085';
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000080',false);
insert into test.context values('inbound_removed_destination_created',public.create_inbound_integration(test.value('inbound_ws_a')::uuid,'Destino removível','Site',test.value('inbound_temporary_stage')::uuid,
  '00000000-0000-0000-0000-000000000085','{"name":"name"}')::text);
insert into test.context values('inbound_removed_destination_int',test.value('inbound_removed_destination_created')::jsonb->'integration'->>'id'),
  ('inbound_removed_destination_token',test.value('inbound_removed_destination_created')::jsonb->>'token');
reset role;
insert into test.context values('inbound_removed_destination_hash',encode(extensions.digest(test.value('inbound_removed_destination_token'),'sha256'),'hex'));
update public.pipeline_stages set type='WON' where id=test.value('inbound_temporary_stage')::uuid;
set role service_role;
select test.ok(test.inbound('inbound_removed_destination_hash','{"name":"Não entrar em WON"}')->>'error_code'='STAGE_UNAVAILABLE','inbound: runtime rejects destination whose type changed to WON');
reset role;
delete from public.pipeline_stages where id=test.value('inbound_temporary_stage')::uuid;
select test.ok((select stage_id is null and workspace_id=test.value('inbound_ws_a')::uuid from public.inbound_integrations where id=test.value('inbound_removed_destination_int')::uuid),
  'inbound: deleting an unused configured stage clears only stage ID');
delete from public.memberships where workspace_id=test.value('inbound_ws_a')::uuid and user_id='00000000-0000-0000-0000-000000000085';
select test.ok((select owner_id is null and workspace_id=test.value('inbound_ws_a')::uuid from public.inbound_integrations where id=test.value('inbound_removed_destination_int')::uuid),
  'inbound: deleting an unused configured membership clears only owner ID');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000080',false);
select test.ok(public.archive_inbound_integration(test.value('inbound_ws_a')::uuid,test.value('inbound_removed_destination_int')::uuid)->>'active'='false',
  'inbound: administrator can archive broken configuration without a valid destination');
reset role;
insert into public.memberships(workspace_id,user_id,role,is_active) values(test.value('inbound_ws_a')::uuid,'00000000-0000-0000-0000-000000000085','closer',false);

-- Every administrative mutation uses the same tenant-role boundary.
set role authenticated;
do $$ declare actor uuid; begin
  foreach actor in array array['00000000-0000-0000-0000-000000000081'::uuid,'00000000-0000-0000-0000-000000000082'::uuid,
    '00000000-0000-0000-0000-000000000083'::uuid,'00000000-0000-0000-0000-000000000085'::uuid,'00000000-0000-0000-0000-000000000001'::uuid] loop
    perform set_config('request.jwt.claim.sub',actor::text,false);
    perform test.denied(format('select public.create_inbound_integration(%L,''Sem permissão'',''Site'',%L,%L,''{"name":"name"}'')',
      test.value('inbound_ws_a'),test.value('inbound_stage_a'),'00000000-0000-0000-0000-000000000081'),'42501','inbound: nonadmin create denied for '||actor::text);
    perform test.denied(format('select public.update_inbound_integration(%L,%L,''Sem permissão'',''Site'',%L,%L,''{"name":"name"}'')',
      test.value('inbound_ws_a'),test.value('inbound_int_a'),test.value('inbound_stage_a'),'00000000-0000-0000-0000-000000000081'),'42501','inbound: nonadmin edit denied for '||actor::text);
    perform test.denied(format('select public.archive_inbound_integration(%L,%L)',test.value('inbound_ws_a'),test.value('inbound_int_a')),'42501','inbound: nonadmin archive denied for '||actor::text);
    perform test.denied(format('select public.list_inbound_integration_logs(%L,%L)',test.value('inbound_ws_a'),test.value('inbound_int_a')),'42501','inbound: nonadmin log read denied for '||actor::text);
  end loop;
end; $$;
reset role;
update public.memberships set is_active=false where workspace_id=test.value('inbound_ws_a')::uuid and user_id='00000000-0000-0000-0000-000000000080';
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000080',false);
select test.denied(format('select public.list_inbound_integrations(%L)',test.value('inbound_ws_a')),'42501','inbound: inactive real tenant administrator cannot list integrations');
select test.denied(format('select public.rotate_inbound_integration_token(%L,%L)',test.value('inbound_ws_a'),test.value('inbound_int_a')),'42501','inbound: inactive real tenant administrator cannot rotate credentials');
reset role;
update public.memberships set is_active=true where workspace_id=test.value('inbound_ws_a')::uuid and user_id='00000000-0000-0000-0000-000000000080';
select test.ok((select created_count=(select count(*) from public.inbound_integration_logs where integration_id=i.id and status='created')
  and duplicate_count=(select count(*) from public.inbound_integration_logs where integration_id=i.id and status='duplicate')
  and error_count=(select count(*) from public.inbound_integration_logs where integration_id=i.id and status in ('rejected','error'))
  and last_received_at is not null from public.inbound_integrations i where i.id=test.value('inbound_int_a')::uuid),
  'inbound: cumulative created duplicate and error counters agree with committed pre-rate outcomes');

-- Rotation invalidates the old secret even for a previously committed request.
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000080',false);
insert into test.context values('inbound_rotation',public.rotate_inbound_integration_token(test.value('inbound_ws_a')::uuid,test.value('inbound_int_a')::uuid)::text);
insert into test.context values('inbound_rotated_token',test.value('inbound_rotation')::jsonb->>'token');
select test.ok(length(test.value('inbound_rotated_token'))=64 and test.value('inbound_rotated_token')<>test.value('inbound_token_a'),
  'inbound: rotation returns a new strong credential');
select test.ok(not(test.value('inbound_rotation')::jsonb->'integration' ? 'token_hash'),'inbound: rotation DTO excludes credential hash');
reset role;
insert into test.context values('inbound_rotated_hash',encode(extensions.digest(test.value('inbound_rotated_token'),'sha256'),'hex')),
  ('inbound_after_rotation',(select to_jsonb(i)::text from public.inbound_integrations i where id=test.value('inbound_int_a')::uuid));
set role service_role;
select set_config('request.jwt.claim.sub','',false);
select test.ok(test.inbound('inbound_hash_a','{"full_name":"Segredo antigo"}')->>'error_code'='INVALID_CREDENTIALS','inbound: old rotated credential immediately stops working');
select test.ok(test.inbound('inbound_hash_a','{"full_name":"Replay antigo"}',null,test.value('inbound_main_request')::uuid)->>'http_status'='401',
  'inbound: replay cannot bypass credential rotation');
select test.ok((select to_jsonb(i)=test.value('inbound_after_rotation')::jsonb from public.inbound_integrations i where id=test.value('inbound_int_a')::uuid),
  'inbound: invalid old credential cannot inflate integration counters or logs');
select test.ok(test.inbound('inbound_rotated_hash','{"full_name":"Credencial nova","email_address":"new-token@example.test"}')->>'status'='created',
  'inbound: rotated credential continues the configured real ingestion flow');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000080',false);
select test.ok(public.set_inbound_integration_active(test.value('inbound_ws_a')::uuid,test.value('inbound_int_a')::uuid,false)->>'active'='false',
  'inbound: administrator disables integration');
reset role;
set role service_role;
select test.ok(test.inbound('inbound_rotated_hash','{"full_name":"Desativado"}')->>'error_code'='INVALID_CREDENTIALS','inbound: disabled integration is indistinguishable from invalid credentials');
select test.ok(test.inbound('inbound_rotated_hash','{"full_name":"Replay desativado"}',null,test.value('inbound_main_request')::uuid)->>'http_status'='401',
  'inbound: replay cannot bypass integration disable');
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000080',false);
select test.ok(public.set_inbound_integration_active(test.value('inbound_ws_a')::uuid,test.value('inbound_int_a')::uuid,true)->>'active'='true',
  'inbound: administrator reactivates valid configuration');
insert into test.context values('inbound_before_archive_logs',(select count(*)::text from public.inbound_integration_logs where integration_id=test.value('inbound_int_second')::uuid)),
  ('inbound_archive',public.archive_inbound_integration(test.value('inbound_ws_a')::uuid,test.value('inbound_int_second')::uuid)::text);
select test.ok(test.value('inbound_archive')::jsonb->>'active'='false' and test.value('inbound_archive')::jsonb->>'archived_at' is not null,
  'inbound: archive retains configuration but disables its credential');
select test.ok(public.archive_inbound_integration(test.value('inbound_ws_a')::uuid,test.value('inbound_int_second')::uuid)=test.value('inbound_archive')::jsonb,
  'inbound: repeated archive is idempotent');
select test.denied(format('select public.set_inbound_integration_active(%L,%L,true)',test.value('inbound_ws_a'),test.value('inbound_int_second')),'23514',
  'inbound: archived integration cannot be reactivated');
select test.denied(format('select public.rotate_inbound_integration_token(%L,%L)',test.value('inbound_ws_a'),test.value('inbound_int_second')),'23514',
  'inbound: archived integration cannot rotate credentials');
select test.denied(format('select public.update_inbound_integration(%L,%L,''Arquivado editado'',''Site'',%L,%L,''{"name":"name"}'')',
  test.value('inbound_ws_a'),test.value('inbound_int_second'),test.value('inbound_stage_a'),'00000000-0000-0000-0000-000000000080'),'23514',
  'inbound: archived integration cannot be edited');
select test.ok((select count(*)=test.value('inbound_before_archive_logs')::bigint from public.inbound_integration_logs where integration_id=test.value('inbound_int_second')::uuid),
  'inbound: archive preserves existing operational logs');
reset role;
set role service_role;
select test.ok(test.inbound('inbound_hash_second','{"name":"Arquivado"}')->>'http_status'='401','inbound: archived credential cannot ingest');
reset role;

-- Persistent fixed windows exercise the last available slot and saturation.
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000080',false);
insert into test.context values('inbound_quota_created',public.create_inbound_integration(test.value('inbound_ws_a')::uuid,'Limites persistentes','Quota',test.value('inbound_stage_a')::uuid,
  '00000000-0000-0000-0000-000000000081','{"name":"name","email":"email"}')::text);
insert into test.context values('inbound_quota_int',test.value('inbound_quota_created')::jsonb->'integration'->>'id'),('inbound_quota_token',test.value('inbound_quota_created')::jsonb->>'token');
reset role;
insert into test.context values('inbound_quota_hash',encode(extensions.digest(test.value('inbound_quota_token'),'sha256'),'hex'));
set role service_role;
select set_config('request.jwt.claim.sub','',false);
do $$ declare item uuid:=test.value('inbound_quota_int')::uuid; result jsonb; epoch_seconds numeric; first_id uuid:=gen_random_uuid(); begin
  -- Avoid a test fixture crossing the minute boundary between its two calls.
  epoch_seconds:=extract(second from clock_timestamp());
  if epoch_seconds>59.5 then perform pg_sleep((60-epoch_seconds+0.05)::double precision); end if;
  insert into private.inbound_rate_limits(bucket_key,integration_id,window_start,hits)
    values('integration:'||item::text||':minute',item,date_trunc('minute',clock_timestamp()),119)
    on conflict(bucket_key) do update set window_start=excluded.window_start,hits=excluded.hits;
  result:=test.inbound('inbound_quota_hash','{"name":"Última vaga minuto","email":"minute-last@example.test"}',null,first_id);
  perform test.ok(result->>'status'='created','inbound: 120th minute request gets the last available integration slot');
  insert into test.context values('inbound_quota_first_request',first_id::text),('inbound_quota_first_result',result::text);
  result:=test.inbound('inbound_quota_hash','{"name":"Minuto excedido","email":"minute-rejected@example.test"}');
  perform test.ok(result->>'status'='rejected' and result->>'http_status'='429' and result->>'error_code'='RATE_LIMITED'
    and (result->>'retry_after')::integer between 1 and 60,'inbound: 121st minute request receives bounded retry-after and 429');
  perform test.inbound('inbound_quota_hash','{"name":"Minuto ainda excedido"}');
  perform test.inbound('inbound_quota_hash','{"name":"Minuto outra tentativa"}');
  perform test.ok((select hits=121 from private.inbound_rate_limits where bucket_key='integration:'||item::text||':minute'),
    'inbound: exhausted minute bucket saturates rather than growing without bound');
  perform test.ok((select count(*)=1 from public.inbound_integration_logs where integration_id=item and error_code='RATE_LIMITED'),
    'inbound: repeated quota rejections create one representative log per minute');
  perform test.ok((select created_count=1 and error_count=3 from public.inbound_integrations where id=item),
    'inbound: quota rejects count each attempt without creating leads');
  perform test.ok(not exists(select 1 from public.leads where workspace_id=test.value('inbound_ws_a')::uuid and data->>'email'='minute-rejected@example.test'),
    'inbound: rejected minute request leaves no lead');
  insert into test.context values('inbound_quota_before_replay',(select to_jsonb(i)::text from public.inbound_integrations i where id=item)),
    ('inbound_quota_buckets_before_replay',(select jsonb_agg(to_jsonb(r) order by bucket_key)::text from private.inbound_rate_limits r where integration_id=item));
  perform test.ok(test.inbound('inbound_quota_hash','{"name":"Replay"}',null,first_id)=test.value('inbound_quota_first_result')::jsonb,
    'inbound: committed replay succeeds even when its integration minute quota is exhausted');
  perform test.ok((select to_jsonb(i)=test.value('inbound_quota_before_replay')::jsonb from public.inbound_integrations i where id=item),
    'inbound: replay after quota exhaustion does not inflate cumulative counters');
  perform test.ok((select jsonb_agg(to_jsonb(r) order by bucket_key)=test.value('inbound_quota_buckets_before_replay')::jsonb from private.inbound_rate_limits r where integration_id=item),
    'inbound: replay consumes integration quota only once');
  update private.inbound_rate_limits set window_start=date_trunc('minute',clock_timestamp()),hits=0 where bucket_key='integration:'||item::text||':minute';
  update private.inbound_rate_limits set window_start=date_trunc('day',clock_timestamp()),hits=9999 where bucket_key='integration:'||item::text||':day';
  result:=test.inbound('inbound_quota_hash','{"name":"Última vaga dia","email":"day-last@example.test"}');
  perform test.ok(result->>'status'='created','inbound: 10000th daily request remains allowed');
  result:=test.inbound('inbound_quota_hash','{"name":"Dia excedido","email":"day-rejected@example.test"}');
  perform test.ok(result->>'http_status'='429' and (result->>'retry_after')::integer between 1 and 86400,'inbound: daily quota rejects excess with a bounded retry-after');
  perform test.inbound('inbound_quota_hash','{"name":"Dia ainda excedido"}');
  perform test.ok((select hits=10001 from private.inbound_rate_limits where bucket_key='integration:'||item::text||':day'),
    'inbound: exhausted daily bucket saturates at limit plus one');
end; $$;
do $$ declare result jsonb; before_buckets bigint; epoch_seconds numeric; begin
  epoch_seconds:=extract(second from clock_timestamp());
  if epoch_seconds>59.5 then perform pg_sleep((60-epoch_seconds+0.05)::double precision); end if;
  select count(*) into before_buckets from private.inbound_rate_limits;
  update private.inbound_rate_limits set window_start=date_trunc('minute',clock_timestamp()),hits=4999 where bucket_key='global:minute';
  result:=test.inbound('inbound_unknown_hash','{}');
  perform test.ok(result->>'http_status'='401','inbound: invalid credential still consumes last available global slot');
  result:=test.inbound('inbound_unknown_hash','{}');
  perform test.ok(result->>'http_status'='429' and result->>'error_code'='RATE_LIMITED','inbound: global rate limit applies before unknown-token lookup');
  perform test.inbound('inbound_unknown_hash','{}');
  perform test.ok((select hits=5001 from private.inbound_rate_limits where bucket_key='global:minute'),'inbound: exhausted global bucket has bounded storage and saturated hits');
  perform test.ok((select count(*)=before_buckets from private.inbound_rate_limits),'inbound: unknown credentials never allocate attacker-controlled rate buckets');
  update private.inbound_rate_limits set window_start=date_trunc('minute',clock_timestamp()),hits=0 where bucket_key='global:minute';
end; $$;
reset role;

-- A forced server-side failure after the normal insert must roll back all lead
-- and timeline/audit writes while preserving one safe error log and quota use.
create function test.fail_inbound_receipt() returns trigger language plpgsql as $$ begin
  if new.event_type='lead.inbound_received' and new.workspace_id=test.value('inbound_ws_a')::uuid then
    raise exception 'SENSITIVE_FIXTURE_DIAGNOSTIC_SHOULD_NOT_LEAK';
  end if;
  return new;
end; $$;
create trigger test_inbound_failure before insert on public.lead_events for each row execute function test.fail_inbound_receipt();
insert into test.context values('inbound_before_failure_leads',(select count(*)::text from public.leads where workspace_id=test.value('inbound_ws_a')::uuid)),
  ('inbound_before_failure_events',(select count(*)::text from public.lead_events where workspace_id=test.value('inbound_ws_a')::uuid)),
  ('inbound_before_failure_audit',(select count(*)::text from public.audit_logs where workspace_id=test.value('inbound_ws_a')::uuid)),
  ('inbound_failure_request',gen_random_uuid()::text);
set role service_role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000080',false);
select set_config('request.jwt.claims','{"role":"service_role","sub":"00000000-0000-0000-0000-000000000080","fixture":"failure"}',false);
insert into test.context values('inbound_failure_result',test.inbound('inbound_rotated_hash','{"full_name":"Lead que deve reverter","email_address":"rolled-back@example.test"}',null,
  test.value('inbound_failure_request')::uuid)::text);
select test.ok(test.value('inbound_failure_result')::jsonb->>'status'='error' and test.value('inbound_failure_result')::jsonb->>'http_status'='503'
  and test.value('inbound_failure_result')::jsonb->>'error_code'='SERVICE_UNAVAILABLE','inbound: internal database failure becomes a safe operational 503 outcome');
select test.ok(test.value('inbound_failure_result') not like '%SENSITIVE_FIXTURE_DIAGNOSTIC_SHOULD_NOT_LEAK%','inbound: internal diagnostic never appears in webhook response');
select test.ok(current_setting('request.jwt.claim.sub')='00000000-0000-0000-0000-000000000080'
  and current_setting('request.jwt.claims')::jsonb='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000080","fixture":"failure"}'::jsonb,
  'inbound: failing ingress restores both original request claim settings');
select set_config('request.jwt.claim.sub','',false);
select set_config('request.jwt.claims','{"role":"service_role"}',false);
select test.ok((select count(*)=test.value('inbound_before_failure_leads')::bigint from public.leads where workspace_id=test.value('inbound_ws_a')::uuid),
  'inbound: internal receipt failure rolls back the inserted lead');
select test.ok((select count(*)=test.value('inbound_before_failure_events')::bigint from public.lead_events where workspace_id=test.value('inbound_ws_a')::uuid),
  'inbound: internal receipt failure rolls back normal and external timeline events');
select test.ok((select count(*)=test.value('inbound_before_failure_audit')::bigint from public.audit_logs where workspace_id=test.value('inbound_ws_a')::uuid),
  'inbound: internal receipt failure rolls back normal lead audit');
select test.ok((select count(*)=1 and bool_and(status='error' and error_code='SERVICE_UNAVAILABLE' and lead_id is null and duplicate_lead_id is null)
  from public.inbound_integration_logs where integration_id=test.value('inbound_int_a')::uuid and request_id=test.value('inbound_failure_request')::uuid),
  'inbound: internal failure persists one safe error log without phantom lead reference');
reset role;
drop trigger test_inbound_failure on public.lead_events;
drop function test.fail_inbound_receipt();

-- Retention deletes bounded old operational metadata without resetting lifetime
-- counters or discarding recent persistent quota rows.
with added as (
  insert into public.inbound_integration_logs(workspace_id,integration_id,request_id,status,error_code,http_status,created_at)
  select test.value('inbound_ws_a')::uuid,test.value('inbound_int_a')::uuid,gen_random_uuid(),'rejected','FIELD_INVALID',422,clock_timestamp()-interval '91 days'
    from generate_series(1,3) returning id
) insert into test.context select 'inbound_old_log_ids',jsonb_agg(id)::text from added;
update private.inbound_rate_limits set updated_at=clock_timestamp()-interval '3 days' where bucket_key='integration:'||test.value('inbound_quota_int')||':day';
insert into test.context values('inbound_before_retention_integration',(select to_jsonb(i)::text from public.inbound_integrations i where id=test.value('inbound_int_a')::uuid)),
  ('inbound_recent_quota',(select to_jsonb(r)::text from private.inbound_rate_limits r where bucket_key='integration:'||test.value('inbound_quota_int')||':minute'));
set role service_role;
select test.ok(public.purge_inbound_integration_logs(1)=1,'inbound: retention removes at most the requested old log count');
select test.ok((select count(*)=2 from public.inbound_integration_logs where id in (select value::bigint from jsonb_array_elements_text(test.value('inbound_old_log_ids')::jsonb))),
  'inbound: bounded retention leaves remaining expired logs for a later batch');
select test.ok(not exists(select 1 from private.inbound_rate_limits where bucket_key='integration:'||test.value('inbound_quota_int')||':day'),
  'inbound: retention removes an idle expired integration quota row');
select test.ok((select to_jsonb(r)=test.value('inbound_recent_quota')::jsonb from private.inbound_rate_limits r
  where bucket_key='integration:'||test.value('inbound_quota_int')||':minute'),'inbound: retention preserves a recent active quota row exactly');
select test.ok(exists(select 1 from private.inbound_rate_limits where bucket_key='global:minute'),'inbound: retention never deletes the fixed global bucket');
select test.ok(public.purge_inbound_integration_logs(5000)=2,'inbound: later retention batch removes the remaining expired logs');
select test.ok((select to_jsonb(i)=test.value('inbound_before_retention_integration')::jsonb from public.inbound_integrations i where id=test.value('inbound_int_a')::uuid),
  'inbound: log retention leaves all lifetime counters and integration metadata unchanged');
select test.ok(exists(select 1 from public.inbound_integration_logs where integration_id=test.value('inbound_int_a')::uuid and request_id=test.value('inbound_failure_request')::uuid),
  'inbound: retention preserves recent operational logs');
select test.denied('select public.purge_inbound_integration_logs(0)','22023','inbound: unbounded zero-sized retention batch is rejected');
select test.denied('select public.purge_inbound_integration_logs(20001)','22023','inbound: excessive retention batch is rejected');
select test.ok(not exists(select 1 from public.inbound_integration_logs where workspace_id in (test.value('inbound_ws_a')::uuid,test.value('inbound_ws_b')::uuid)
  and (to_jsonb(inbound_integration_logs)::text ~ 'joao@example.test|João Silva|UNMAPPED_SECRET_SHOULD_NOT_PERSIST|SENSITIVE_FIXTURE_DIAGNOSTIC_SHOULD_NOT_LEAK|SECRET_UNAPPROVED_DIAGNOSTIC'
    or position(test.value('inbound_token_a') in to_jsonb(inbound_integration_logs)::text)>0
    or position(test.value('inbound_rotated_token') in to_jsonb(inbound_integration_logs)::text)>0)),
  'inbound: operational logs never contain contact payload credentials or diagnostics');
select test.ok(not exists(select 1 from public.audit_logs where workspace_id in (test.value('inbound_ws_a')::uuid,test.value('inbound_ws_b')::uuid)
  and (position(test.value('inbound_token_a') in details::text)>0 or position(test.value('inbound_rotated_token') in details::text)>0)),
  'inbound: administration audit never stores webhook credentials');
reset role;

-- Existing lead privacy/deletion flows remain available. Operational identifiers
-- may survive as references, but deleted lead/contact content does not.
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000080',false);
delete from public.leads where workspace_id=test.value('inbound_ws_a')::uuid and id=test.value('inbound_lead_main');
select test.ok(not exists(select 1 from public.leads where id=test.value('inbound_lead_main')),'inbound: administrator can delete an automatically received lead normally');
select test.ok(not exists(select 1 from public.lead_events where lead_id=test.value('inbound_lead_main')),'inbound: individual lead deletion cascades receipt and normal timeline history');
select test.ok(exists(select 1 from public.inbound_integration_logs where integration_id=test.value('inbound_int_a')::uuid
  and (lead_id=test.value('inbound_lead_main') or duplicate_lead_id=test.value('inbound_lead_main'))),
  'inbound: nonlocking operational references do not prevent normal lead deletion');
reset role;
update public.leads set retention_until=clock_timestamp()-interval '1 day' where workspace_id=test.value('inbound_ws_a')::uuid
  and id=test.value('inbound_sql_text_result')::jsonb->>'lead_id';
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000080',false);
select test.ok(public.purge_expired_leads(test.value('inbound_ws_a')::uuid)>=1,'inbound: existing lead retention purges expired automatic entries');
select test.ok(not exists(select 1 from public.lead_events where lead_id=test.value('inbound_sql_text_result')::jsonb->>'lead_id'),
  'inbound: lead retention also removes automatic receipt history');
insert into test.context values('inbound_final_export',public.export_workspace(test.value('inbound_ws_a')::uuid)::text);
select test.ok(test.value('inbound_final_export')::jsonb ? 'inbound_integrations' and test.value('inbound_final_export')::jsonb ? 'inbound_integration_logs',
  'inbound: workspace portability includes integration configuration and safe operational history');
select test.ok(not exists(select 1 from jsonb_array_elements(test.value('inbound_final_export')::jsonb->'inbound_integrations') i where i ? 'token' or i ? 'token_hash'),
  'inbound: portability never exports integration credentials or hashes');
select public.delete_workspace(test.value('inbound_ws_a')::uuid,'Empresa inbound A');
reset role;
select test.ok(not exists(select 1 from public.inbound_integrations where workspace_id=test.value('inbound_ws_a')::uuid),'inbound: workspace deletion cascades integration configuration');
select test.ok(not exists(select 1 from public.inbound_integration_logs where workspace_id=test.value('inbound_ws_a')::uuid),'inbound: workspace deletion cascades integration operational logs');
select test.ok(not exists(select 1 from private.inbound_rate_limits where integration_id in (test.value('inbound_int_a')::uuid,test.value('inbound_int_second')::uuid,
  test.value('inbound_literal_int')::uuid,test.value('inbound_removed_destination_int')::uuid,test.value('inbound_quota_int')::uuid)),
  'inbound: workspace deletion cascades its integration quota buckets');
select test.ok(not exists(select 1 from public.leads where workspace_id=test.value('inbound_ws_a')::uuid),'inbound: workspace deletion keeps existing lead privacy cascade');
select test.ok(exists(select 1 from public.inbound_integrations where id=test.value('inbound_int_b')::uuid),'inbound: company A deletion preserves company B integration');

-- Keep the second company active for the harness's real two-session races.
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000084',false);
insert into test.context values('inbound_race_created',public.create_inbound_integration(test.value('inbound_ws_b')::uuid,'Concorrência inbound','Race',test.value('inbound_stage_b')::uuid,
  auth.uid(),'{"name":"name","email":"email","phone":"phone"}')::text),
  ('inbound_rate_race_created',public.create_inbound_integration(test.value('inbound_ws_b')::uuid,'Concorrência quota','Race quota',test.value('inbound_stage_b')::uuid,
  auth.uid(),'{"name":"name","email":"email"}')::text);
insert into test.context values('inbound_race_ws',test.value('inbound_ws_b')),('inbound_race_int',test.value('inbound_race_created')::jsonb->'integration'->>'id'),
  ('inbound_race_token',test.value('inbound_race_created')::jsonb->>'token'),('inbound_race_email','inbound-race@example.test'),
  ('inbound_rate_race_ws',test.value('inbound_ws_b')),('inbound_rate_race_int',test.value('inbound_rate_race_created')::jsonb->'integration'->>'id'),
  ('inbound_rate_race_token',test.value('inbound_rate_race_created')::jsonb->>'token');
reset role;
insert into test.context values('inbound_race_hash',encode(extensions.digest(test.value('inbound_race_token'),'sha256'),'hex')),
  ('inbound_rate_race_hash',encode(extensions.digest(test.value('inbound_rate_race_token'),'sha256'),'hex'));
insert into private.inbound_rate_limits(bucket_key,integration_id,window_start,hits)
values('integration:'||test.value('inbound_rate_race_int')||':minute',test.value('inbound_rate_race_int')::uuid,date_trunc('minute',clock_timestamp()),119);
drop function test.inbound(text,jsonb,text,uuid);
revoke usage on schema test from service_role;
revoke select,insert,update on test.context from service_role;
revoke insert on test.results from service_role;
select 'Inbound integration assertions passed: '||count(*) from test.results;
