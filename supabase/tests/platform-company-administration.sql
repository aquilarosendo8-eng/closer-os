\set ON_ERROR_STOP on
-- Disposable local PostgreSQL only. Real roles/RLS, no external mail or accounts.
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'platform-admin-'||n||'@example.test',now(),jsonb_build_object('display_name','Pessoa administrativa '||n)
from generate_series(120,127) n;
insert into public.platform_admins(user_id) values('00000000-0000-0000-0000-000000000120');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000120',false);
insert into test.context values('master_ws_a',public.create_workspace('Empresa Master A')::text),('master_ws_b',public.create_workspace('Empresa Master B')::text),
  ('master_delete_race',public.create_workspace('Empresa Master concorrente')::text),('master_company_delete',public.create_workspace('Exclusão da própria empresa')::text);
select public.admin_update_subscription(test.value('master_ws_a')::uuid,'team','active',12);
select public.admin_update_subscription(test.value('master_ws_b')::uuid,'team','active',12);
reset role;
insert into public.memberships(workspace_id,user_id,role,is_active)
select test.value('master_ws_a')::uuid,('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,role,active
from (values(122,'admin',true),(123,'closer',true),(125,'manager',true),(126,'viewer',true),(127,'closer',false)) x(n,role,active);
insert into public.memberships(workspace_id,user_id,role,is_active)
values(test.value('master_ws_b')::uuid,'00000000-0000-0000-0000-000000000124','admin',true),
  (test.value('master_ws_b')::uuid,'00000000-0000-0000-0000-000000000123','closer',true),
  (test.value('master_company_delete')::uuid,'00000000-0000-0000-0000-000000000122','admin',true);
update public.workspaces set owner_id='00000000-0000-0000-0000-000000000122' where id in (test.value('master_ws_a')::uuid,test.value('master_company_delete')::uuid);
update public.workspaces set owner_id='00000000-0000-0000-0000-000000000124' where id=test.value('master_ws_b')::uuid;
insert into test.context select 'master_stage_a',id::text from public.pipeline_stages where workspace_id=test.value('master_ws_a')::uuid and name='Lead novo';
insert into test.context select 'master_stage_b',id::text from public.pipeline_stages where workspace_id=test.value('master_ws_b')::uuid and name='Lead novo';
insert into test.context select 'master_won',id::text from public.pipeline_stages where workspace_id=test.value('master_ws_a')::uuid and type='WON';
insert into public.leads(workspace_id,id,owner_id,data) values
  (test.value('master_ws_a')::uuid,'master-secret-lead','00000000-0000-0000-0000-000000000123',test.lead('master-secret-lead')||'{"name":"LEAD_PRIVATE_CANARY","notes":"PRIVATE_FORM_ANSWER","callSummary":"PRIVATE_CALL_CONTENT"}'),
  (test.value('master_ws_b')::uuid,'master-preserved-lead','00000000-0000-0000-0000-000000000123',test.lead('master-preserved-lead'));
insert into public.call_reviews(workspace_id,lead_id,feedback,score,reviewed_by)
values(test.value('master_ws_a')::uuid,'master-secret-lead','PRIVATE_REVIEW_CONTENT',7,'00000000-0000-0000-0000-000000000122');
insert into public.activities(workspace_id,lead_id,assigned_to,type,title,due_at)
values(test.value('master_ws_a')::uuid,'master-secret-lead','00000000-0000-0000-0000-000000000123','call','PRIVATE_ACTIVITY_TITLE',now()+interval '1 day');
insert into public.audit_logs(workspace_id,actor_id,action,details) values
  (test.value('master_ws_a')::uuid,'00000000-0000-0000-0000-000000000122','lead.updated','{"lead_id":"master-secret-lead","name":"LEAD_PRIVATE_CANARY"}'),
  (test.value('master_ws_a')::uuid,'00000000-0000-0000-0000-000000000122','call.reviewed','{"lead_id":"master-secret-lead","feedback":"PRIVATE_REVIEW_CONTENT"}'),
  (test.value('master_ws_a')::uuid,'00000000-0000-0000-0000-000000000122','subscription.updated','{"plan":"team","status":"active","seat_limit":12,"payload":"PRIVATE_FORM_ANSWER","lead_id":"master-secret-lead"}');

select test.ok((select relrowsecurity from pg_class where oid='private.workspace_deletion_receipts'::regclass),'master: deletion receipts have RLS');
select test.ok(not has_table_privilege('authenticated','private.workspace_deletion_receipts','SELECT,INSERT,UPDATE,DELETE'),'master: browser has no raw receipt table privileges');
select test.ok(not has_column_privilege('authenticated','public.workspaces','business_contact_email','UPDATE'),'master: institutional contact updates require RPC');
select test.ok(not exists(select 1 from public.memberships where user_id='00000000-0000-0000-0000-000000000120'),'master: creating clients grants no platform membership');
select test.ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  where n.nspname in ('public','private') and a.grantee=0 and a.privilege_type='EXECUTE'),'master: no implicit PUBLIC function execution');
select test.ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prosecdef
  and not ('search_path=""'=any(p.proconfig))),'master: security definers retain locked empty search path');

set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000120',false);
select test.ok(jsonb_array_length(public.list_members(test.value('master_ws_a')::uuid))=5,'master: manages company team without membership');
select public.platform_update_workspace_information(test.value('master_ws_a')::uuid,'  Empresa Master atualizada  ','  COMERCIAL@EXAMPLE.TEST  ');
select test.ok(exists(select 1 from jsonb_array_elements(public.list_platform_workspaces()) w where w->>'id'=test.value('master_ws_a')
  and w->>'name'='Empresa Master atualizada' and w->>'business_contact_email'='comercial@example.test'),'master: updates institutional name and separate normalized contact');
select test.denied(format('select public.platform_update_workspace_information(%L,'' '', '''')',test.value('master_ws_a')),'22023','master: blank name is rejected');
select test.denied(format('select public.platform_update_workspace_information(%L,''Valid'',''bad-address'')',test.value('master_ws_a')),'22023','master: malformed contact is rejected');
select test.denied(format('select public.platform_update_workspace_information(%L,''Valid'',''a<@example.test'')',test.value('master_ws_a')),'22023','master: HTML-like email is rejected');
select test.denied(format('select public.platform_update_workspace_information(%L,''Valid'',%L)',test.value('master_ws_a'),E'a\\b@example.test'),'22023','master: email backslash is rejected');
select test.denied(format('select public.platform_update_workspace_information(%L,''Valid'',%L)',test.value('master_ws_a'),U&'a\00a0b@example.test'),'22023','master: Unicode whitespace in contact is rejected');
select test.denied(format('select public.platform_update_workspace_information(%L,%L,'''')',test.value('master_ws_a'),U&'\00a0\2000'),'22023','master: Unicode whitespace-only company name is rejected');
select test.denied(format('select public.platform_update_workspace_information(%L,''Valid'',null)',test.value('master_ws_a')),'22023','master: null institutional email is rejected');
select test.denied(format('select public.platform_update_workspace_information(%L,%L,'''')',test.value('master_ws_a'),E'Company\nUnsafe'),'22023','master: name controls are rejected');
select test.denied('select public.platform_update_workspace_information(gen_random_uuid(),''Unknown'','''')','P0002','master: absent company is rejected');
select test.ok((select count(*)=0 from public.leads where workspace_id=test.value('master_ws_a')::uuid),'master: direct lead read yields no customer rows');
select test.ok((select count(*)=0 from public.call_reviews where workspace_id=test.value('master_ws_a')::uuid),'master: direct call reviews read yields no customer rows');
select test.ok((select count(*)=0 from public.activities where workspace_id=test.value('master_ws_a')::uuid),'master: direct activities read yields no customer rows');
select test.ok((select count(*)=0 from public.lead_events where workspace_id=test.value('master_ws_a')::uuid),'master: direct timeline read yields no customer rows');
select test.ok((select count(*)=0 from public.pipeline_stages where workspace_id=test.value('master_ws_a')::uuid),'master: raw pipeline table yields no customer rows');
select test.ok((select count(*)=0 from public.workspace_settings where workspace_id=test.value('master_ws_a')::uuid),'master: customer financial goals and commission settings remain private');
select test.ok((select count(*)=0 from public.profiles where id in ('00000000-0000-0000-0000-000000000122','00000000-0000-0000-0000-000000000123')),'master: no broad personal profile directory access');
select test.ok((select count(*)=0 from public.audit_logs where workspace_id=test.value('master_ws_a')::uuid),'master: no direct unfiltered audit rows');
select test.denied(format('select public.export_workspace(%L)',test.value('master_ws_a')),'42501','master: customer commercial export remains denied');
select test.denied(format('select public.list_lead_call_history(%L,''master-secret-lead'')',test.value('master_ws_a')),'42501','master: cannot fetch call history by known lead ID');
select test.denied(format('select public.list_lead_events(%L,''master-secret-lead'')',test.value('master_ws_a')),'42501','master: cannot fetch timeline by known lead ID');
select test.denied(format('select public.list_pipeline_stages(%L)',test.value('master_ws_a')),'42501','master: operational pipeline RPC remains denied');
with changed as(update public.leads set data=data||'{"notes":"MASTER_FORGED"}' where workspace_id=test.value('master_ws_a')::uuid returning id)
  select test.ok((select count(*)=0 from changed),'master: cannot edit customer lead by forged direct update');
with changed as(delete from public.leads where workspace_id=test.value('master_ws_a')::uuid returning id)
  select test.ok((select count(*)=0 from changed),'master: cannot delete isolated customer lead');
insert into test.context values('master_options',public.platform_inbound_options(test.value('master_ws_a')::uuid)::text);
select test.ok(jsonb_array_length(test.value('master_options')::jsonb->'stages')=5,'master: options exposes only five active normal stage names and IDs');
select test.ok(jsonb_array_length(test.value('master_options')::jsonb->'owners')=3,'master: options excludes viewers and inactive owners');
select test.ok(not (test.value('master_options') like '%@%' or test.value('master_options') like '%PRIVATE_%' or test.value('master_options') like '%ticket%' or test.value('master_options') like '%commission%'),'master: options contains no email commercial payload or financial settings');
select test.ok(not exists(select 1 from jsonb_array_elements(test.value('master_options')::jsonb->'stages') x where (select count(*) from jsonb_object_keys(x))<>2),'master: stage options keys strictly id and name');
select test.ok(not exists(select 1 from jsonb_array_elements(test.value('master_options')::jsonb->'owners') x where (select count(*) from jsonb_object_keys(x))<>2),'master: owner options keys strictly user ID and display name');
insert into test.context values('master_integration_result',public.platform_create_inbound_integration(test.value('master_ws_a')::uuid,'Master formulário','Site',test.value('master_stage_a')::uuid,
  '00000000-0000-0000-0000-000000000123','{"name":"name","notes":"notes"}')::text);
insert into test.context values('master_int',test.value('master_integration_result')::jsonb->'integration'->>'id'),
  ('master_raw_token',test.value('master_integration_result')::jsonb->>'token');
select test.ok(test.value('master_raw_token') ~ '^[a-f0-9]{64}$','master: integration creation returns new token only once');
select test.ok(not (test.value('master_integration_result') like '%token_hash%'),'master: creation omits credential hash');
select test.ok(jsonb_array_length(public.platform_list_inbound_integrations(test.value('master_ws_a')::uuid))=1,'master: lists client integrations without membership');
select test.denied(format('select public.list_inbound_integrations(%L)',test.value('master_ws_a')),'42501','master: unchanged company integration RPC still requires company admin');
select test.denied('select token_hash from public.inbound_integrations','42501','master: cannot select stored token hashes');
select test.ok((select count(*)=0 from public.inbound_integrations where workspace_id=test.value('master_ws_a')::uuid),'master: direct config table RLS stays company-only');
select test.denied(format('select public.platform_create_inbound_integration(%L,''Foreign stage'',''Site'',%L,%L,''{"name":"name"}'')',test.value('master_ws_a'),test.value('master_stage_b'),'00000000-0000-0000-0000-000000000123'),'23514','master: integration foreign destination stage denied');
select test.denied(format('select public.platform_create_inbound_integration(%L,''Won stage'',''Site'',%L,%L,''{"name":"name"}'')',test.value('master_ws_a'),test.value('master_won'),'00000000-0000-0000-0000-000000000123'),'23514','master: integration won destination stage denied');
select test.denied(format('select public.platform_create_inbound_integration(%L,''Foreign owner'',''Site'',%L,%L,''{"name":"name"}'')',test.value('master_ws_a'),test.value('master_stage_a'),'00000000-0000-0000-0000-000000000124'),'23514','master: integration foreign owner denied');
select test.denied(format('select public.platform_create_inbound_integration(%L,''Viewer owner'',''Site'',%L,%L,''{"name":"name"}'')',test.value('master_ws_a'),test.value('master_stage_a'),'00000000-0000-0000-0000-000000000126'),'23514','master: integration viewer owner denied');
select test.denied(format('select public.platform_create_inbound_integration(%L,''Invalid mapping'',''Site'',%L,%L,''{"name":"name","workspaceId":"other"}'')',test.value('master_ws_a'),test.value('master_stage_a'),'00000000-0000-0000-0000-000000000123'),'22023','master: protected integration mapping fields denied');
select test.denied(format('select public.platform_update_inbound_integration(%L,%L,''Cross company'',''Site'',%L,%L,''{"name":"name"}'')',test.value('master_ws_b'),test.value('master_int'),test.value('master_stage_b'),'00000000-0000-0000-0000-000000000124'),'P0002','master: integration ID is bound to selected company');
select public.platform_update_inbound_integration(test.value('master_ws_a')::uuid,test.value('master_int')::uuid,'Master atualizado','Campanha',test.value('master_stage_a')::uuid,
  '00000000-0000-0000-0000-000000000123','{"name":"name","notes":"notes"}');
select test.ok((public.platform_set_inbound_integration_active(test.value('master_ws_a')::uuid,test.value('master_int')::uuid,false)->>'active')::boolean=false,'master: disables company integration');
select test.ok((public.platform_set_inbound_integration_active(test.value('master_ws_a')::uuid,test.value('master_int')::uuid,true)->>'active')::boolean=true,'master: reactivates validated company integration');
insert into test.context values('master_rotated',public.platform_rotate_inbound_integration_token(test.value('master_ws_a')::uuid,test.value('master_int')::uuid)::text);
select test.ok(test.value('master_rotated')::jsonb->>'token'<>test.value('master_raw_token'),'master: rotation replaces credential with a distinct new token');
select test.ok(not public.platform_list_inbound_integrations(test.value('master_ws_a')::uuid)::text like '%'||(test.value('master_rotated')::jsonb->>'token')||'%','master: list never reveals new or old tokens');
reset role;
insert into public.inbound_integration_logs(workspace_id,integration_id,request_id,status,lead_id,http_status)
values(test.value('master_ws_a')::uuid,test.value('master_int')::uuid,gen_random_uuid(),'created','master-secret-lead',201);
insert into public.inbound_integration_logs(workspace_id,integration_id,request_id,status,duplicate_lead_id,http_status)
values(test.value('master_ws_a')::uuid,test.value('master_int')::uuid,gen_random_uuid(),'duplicate','master-secret-lead',200);
insert into public.inbound_integration_logs(workspace_id,integration_id,request_id,status,error_code,http_status)
values(test.value('master_ws_a')::uuid,test.value('master_int')::uuid,gen_random_uuid(),'rejected','OWNER_UNAVAILABLE',409);
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000120',false);
insert into test.context values('master_safe_logs',public.platform_list_inbound_integration_logs(test.value('master_ws_a')::uuid,test.value('master_int')::uuid)::text);
select test.ok(jsonb_array_length(test.value('master_safe_logs')::jsonb->'items')=3,'master: diagnostics includes successful duplicate and rejected statuses');
select test.ok(not (test.value('master_safe_logs') like '%lead_id%' or test.value('master_safe_logs') like '%master-secret-lead%' or test.value('master_safe_logs') like '%PRIVATE_%' or test.value('master_safe_logs') like '%payload%' or test.value('master_safe_logs') like '%@%'),'master: technical logs strip all lead references and form content');
select test.ok((select count(*)=0 from public.inbound_integration_logs where workspace_id=test.value('master_ws_a')::uuid),'master: cannot bypass sanitized diagnostics through raw logs');
select test.denied(format('select public.list_inbound_integration_logs(%L,%L)',test.value('master_ws_a'),test.value('master_int')),'42501','master: legacy raw-log RPC remains company-admin only');
select test.denied(format('select public.platform_list_inbound_integration_logs(%L,%L,null,101)',test.value('master_ws_a'),test.value('master_int')),'22023','master: diagnostic pagination is bounded');
select test.denied(format('select public.platform_list_inbound_integration_logs(%L,%L)',test.value('master_ws_b'),test.value('master_int')),'P0002','master: logs integration ID is company bound');
insert into test.context values('master_safe_audit',public.platform_list_administrative_audit(test.value('master_ws_a')::uuid)::text);
select test.ok(not (test.value('master_safe_audit') like '%lead.%' or test.value('master_safe_audit') like '%call.%' or test.value('master_safe_audit') like '%master-secret-lead%' or test.value('master_safe_audit') like '%PRIVATE_%' or test.value('master_safe_audit') like '%payload%'),'master: administrative audit allowlist excludes commercial actions and hostile extra keys');
select test.ok(public.list_audit(test.value('master_ws_a')::uuid)=public.platform_list_administrative_audit(test.value('master_ws_a')::uuid),'master: legacy audit RPC cannot bypass sanitized projection');
select test.ok(exists(select 1 from jsonb_array_elements(test.value('master_safe_audit')::jsonb) x where x->>'action'='workspace.institutional_updated'),'master: institutional mutation is audited');
select test.ok((select count(*)=5 from jsonb_array_elements(test.value('master_safe_audit')::jsonb) x where x->>'action' in ('integration.created','integration.updated','integration.status_updated','integration.token_rotated')),'master: all integration mutations are audited');
insert into test.context values('master_invite',public.invite_member(test.value('master_ws_a')::uuid,'platform-admin-121@example.test','viewer','Nova pessoa')::text);
select test.ok(exists(select 1 from jsonb_array_elements(public.list_invitations(test.value('master_ws_a')::uuid)) x where x->>'id'=test.value('master_invite')::jsonb->>'id'),'master: existing server invitation management remains supported');
select public.revoke_invitation(test.value('master_ws_a')::uuid,(test.value('master_invite')::jsonb->>'id')::uuid);
select public.update_member(test.value('master_ws_a')::uuid,'00000000-0000-0000-0000-000000000126','viewer',false);
select test.ok(exists(select 1 from jsonb_array_elements(public.list_members(test.value('master_ws_a')::uuid)) x where x->>'user_id'='00000000-0000-0000-0000-000000000126' and x->>'is_active'='false'),'master: existing team deactivation works without membership');
select test.denied(format('select public.update_member(%L,%L,''closer'',false)',test.value('master_ws_a'),'00000000-0000-0000-0000-000000000122'),'23514','master: existing company owner protection remains');
select public.admin_update_subscription(test.value('master_ws_a')::uuid,'team','suspended',12);
select test.ok(jsonb_array_length(public.platform_list_inbound_integrations(test.value('master_ws_a')::uuid))=1,'master: integration support remains available while company suspended');
select public.admin_update_subscription(test.value('master_ws_a')::uuid,'team','active',12);

-- Forged browser calls by a closer, company admin, manager and viewer must all fail.
reset role;
create function test.master_denials(p_actor uuid,p_label text) returns void language plpgsql set search_path='' as $$ begin
  perform set_config('request.jwt.claim.sub',p_actor::text,false);
  perform test.denied(format('select public.platform_update_workspace_information(%L,''FORGED'','''')',test.value('master_ws_b')),'42501','master: '||p_label||' cannot forge institutional update');
  perform test.denied(format('select public.platform_inbound_options(%L)',test.value('master_ws_b')),'42501','master: '||p_label||' cannot forge metadata lookup');
  perform test.denied(format('select public.platform_list_inbound_integrations(%L)',test.value('master_ws_a')),'42501','master: '||p_label||' cannot invoke integration list');
  perform test.denied(format('select public.platform_create_inbound_integration(%L,''FORGED'',''Site'',%L,%L,''{"name":"name"}'')',test.value('master_ws_a'),test.value('master_stage_a'),'00000000-0000-0000-0000-000000000123'),'42501','master: '||p_label||' cannot invoke integration creation');
  perform test.denied(format('select public.platform_update_inbound_integration(%L,%L,''FORGED'',''Site'',%L,%L,''{"name":"name"}'')',test.value('master_ws_a'),test.value('master_int'),test.value('master_stage_a'),'00000000-0000-0000-0000-000000000123'),'42501','master: '||p_label||' cannot invoke integration update');
  perform test.denied(format('select public.platform_set_inbound_integration_active(%L,%L,false)',test.value('master_ws_a'),test.value('master_int')),'42501','master: '||p_label||' cannot invoke integration activation');
  perform test.denied(format('select public.platform_rotate_inbound_integration_token(%L,%L)',test.value('master_ws_a'),test.value('master_int')),'42501','master: '||p_label||' cannot invoke token rotation');
  perform test.denied(format('select public.platform_archive_inbound_integration(%L,%L)',test.value('master_ws_a'),test.value('master_int')),'42501','master: '||p_label||' cannot invoke integration archive');
  perform test.denied(format('select public.platform_list_inbound_integration_logs(%L,%L)',test.value('master_ws_a'),test.value('master_int')),'42501','master: '||p_label||' cannot invoke technical diagnostics');
  perform test.denied(format('select public.platform_list_administrative_audit(%L)',test.value('master_ws_b')),'42501','master: '||p_label||' cannot invoke Master audit');
  perform test.denied(format('select public.platform_delete_workspace(%L,''Empresa Master B'',true,true,''Pedido apropriado'')',test.value('master_ws_b')),'42501','master: '||p_label||' cannot forge workspace deletion');
  perform test.denied('select public.platform_list_workspace_deletions()','42501','master: '||p_label||' cannot enumerate deletion receipts');
end; $$;
set role authenticated;
select test.master_denials('00000000-0000-0000-0000-000000000123','closer');
select test.master_denials('00000000-0000-0000-0000-000000000122','company admin');
select test.master_denials('00000000-0000-0000-0000-000000000125','manager');
select test.master_denials('00000000-0000-0000-0000-000000000126','viewer');
select test.master_denials(null,'missing identity');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000122',false);
select test.denied(format('select public.rename_workspace(%L,''Cross tenant'')',test.value('master_ws_b')),'42501','master: company administrator cannot rename other company');
select test.denied(format('select public.update_member(%L,%L,''viewer'',false)',test.value('master_ws_b'),'00000000-0000-0000-0000-000000000123'),'42501','master: company administrator cannot edit other company team');
select test.ok((select count(*)=1 from public.leads where workspace_id=test.value('master_ws_a')::uuid),'master: original company admin lead access preserved');
select test.ok(public.list_audit(test.value('master_ws_a')::uuid)::text like '%master-secret-lead%','master: original company audit access remains scoped and complete');
select test.ok(jsonb_array_length(public.list_inbound_integrations(test.value('master_ws_a')::uuid))=1,'master: original company integration management remains supported');
select test.ok(public.list_inbound_integration_logs(test.value('master_ws_a')::uuid,test.value('master_int')::uuid)::text like '%master-secret-lead%','master: original company diagnostic reference remains available to its admin');

select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000120',false);
select test.ok(public.platform_archive_inbound_integration(test.value('master_ws_a')::uuid,test.value('master_int')::uuid)->>'archived_at' is not null,'master: archives integration with audit');
select test.denied(format('select public.platform_rotate_inbound_integration_token(%L,%L)',test.value('master_ws_a'),test.value('master_int')),'23514','master: archived integration cannot rotate token');
select test.denied(format('select public.platform_set_inbound_integration_active(%L,%L,true)',test.value('master_ws_a'),test.value('master_int')),'23514','master: archived integration cannot be reactivated');
select test.denied(format('select public.platform_delete_workspace(%L,''wrong name'',true,true,''Authorized cleanup'')',test.value('master_ws_a')),'22023','master: deletion rejects wrong typed company name');
select test.denied(format('select public.platform_delete_workspace(%L,''Empresa Master atualizada'',false,true,''Authorized cleanup'')',test.value('master_ws_a')),'22023','master: deletion requires explicit irreversible confirmation');
select test.denied(format('select public.platform_delete_workspace(%L,''Empresa Master atualizada'',true,false,''Authorized cleanup'')',test.value('master_ws_a')),'22023','master: deletion requires appropriate authorization confirmation');
select test.denied(format('select public.platform_delete_workspace(%L,''Empresa Master atualizada'',true,null,''Authorized cleanup'')',test.value('master_ws_a')),'22023','master: null authorization cannot bypass confirmation');
select test.denied(format('select public.platform_delete_workspace(%L,''Empresa Master atualizada'',true,true,'' '')',test.value('master_ws_a')),'22023','master: deletion requires valid administrative reason');
select test.denied(format('select public.platform_delete_workspace(%L,''Empresa Master atualizada'',true,true,''123456789'')',test.value('master_ws_a')),'22023','master: deletion rejects reason shorter than ten characters');
select test.denied(format('select public.platform_delete_workspace(%L,''Empresa Master atualizada'',true,true,%L)',test.value('master_ws_a'),repeat('x',501)),'22023','master: deletion rejects reason longer than five hundred characters');
select test.denied(format('select public.platform_delete_workspace(%L,''Empresa Master atualizada'',true,true,%L)',test.value('master_ws_a'),E'Cleanup\nUnsafe'),'22023','master: deletion reason controls are rejected');
select test.ok((select count(*)=1 from public.workspaces where id=test.value('master_ws_a')::uuid),'master: unsuccessful deletion leaves company intact');
select test.ok(not exists(select 1 from jsonb_array_elements(public.platform_list_workspace_deletions()) x where x->>'workspace_id'=test.value('master_ws_a')),'master: unsuccessful deletion leaves no receipt');
select test.denied(format('select public.delete_workspace(%L,''Empresa Master atualizada'')',test.value('master_ws_a')),'42501','master: original company deletion still requires active admin membership');
select public.platform_delete_workspace(test.value('master_ws_a')::uuid,'Empresa Master atualizada',true,true,'Autorização para limpeza do fixture local');
select test.ok(not exists(select 1 from public.workspaces where id=test.value('master_ws_a')::uuid),'master: confirmed Master deletion removes selected company');
select test.ok(exists(select 1 from jsonb_array_elements(public.platform_list_workspace_deletions()) x where x->>'workspace_id'=test.value('master_ws_a')
  and x->>'workspace_name'='Empresa Master atualizada' and x->>'actor_id'=auth.uid()::text and x->>'reason'='Autorização para limpeza do fixture local'),'master: minimal receipt retains actor company timestamp and reason independently');
select test.denied(format('select public.platform_delete_workspace(%L,''Empresa Master atualizada'',true,true,''Authorized cleanup'')',test.value('master_ws_a')),'P0002','master: repeated deletion fails without second receipt');
reset role;
select test.ok(not exists(select 1 from public.leads where workspace_id=test.value('master_ws_a')::uuid),'master: deletion removes tenant leads');
select test.ok(not exists(select 1 from public.activities where workspace_id=test.value('master_ws_a')::uuid),'master: deletion removes tenant activities');
select test.ok(not exists(select 1 from public.call_reviews where workspace_id=test.value('master_ws_a')::uuid),'master: deletion removes tenant call reviews');
select test.ok(not exists(select 1 from public.inbound_integrations where workspace_id=test.value('master_ws_a')::uuid),'master: deletion removes tenant integrations');
select test.ok(not exists(select 1 from public.inbound_integration_logs where workspace_id=test.value('master_ws_a')::uuid),'master: deletion removes tenant diagnostic logs');
select test.ok((select count(*)=1 from private.workspace_deletion_receipts where workspace_id=test.value('master_ws_a')::uuid),'master: exactly one deletion receipt persists outside cascade');
select test.ok(exists(select 1 from auth.users where id='00000000-0000-0000-0000-000000000123'),'master: shared closer Auth account survives company deletion');
select test.ok(exists(select 1 from auth.users where id='00000000-0000-0000-0000-000000000122'),'master: original owner Auth account survives company deletion');
select test.ok(exists(select 1 from public.memberships where workspace_id=test.value('master_ws_b')::uuid and user_id='00000000-0000-0000-0000-000000000123'),'master: shared closer other company membership survives deletion');
select test.ok(exists(select 1 from public.leads where workspace_id=test.value('master_ws_b')::uuid and id='master-preserved-lead'),'master: other company commercial records survive deletion');
select test.ok((select privacy_contact_email='' from public.workspaces where id=test.value('master_ws_b')::uuid),'master: commercial email never overwrites privacy contact');
select test.ok((select email='platform-admin-122@example.test' from auth.users where id='00000000-0000-0000-0000-000000000122'),'master: institutional edits never alter login email');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000122',false);
select public.delete_workspace(test.value('master_company_delete')::uuid,'Exclusão da própria empresa');
reset role;
select test.ok(not exists(select 1 from public.workspaces where id=test.value('master_company_delete')::uuid),'master: pre-existing company admin self-deletion still works');
select test.ok(exists(select 1 from auth.users where id='00000000-0000-0000-0000-000000000122'),'master: company-admin deletion also preserves own Auth account');
select 'Master administration assertions passed: '||count(*) from test.results where label like 'master:%';
