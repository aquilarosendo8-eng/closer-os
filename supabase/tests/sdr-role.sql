\set ON_ERROR_STOP on
-- Role/RLS integration tests use authenticated PostgreSQL sessions in a disposable
-- database. They never install helpers, send invitations or mutate customer data
-- in the configured production Supabase project.
grant usage on schema test to service_role;
grant select,insert on test.context to service_role;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
  'sdr-role-'||n||'@example.test',case when n=177 then null else now() end,
  jsonb_build_object('display_name','Pessoa SDR '||n,'role','admin')
from generate_series(170,178) n;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
insert into test.context values('sdr_ws_a',public.create_workspace('SDR empresa A')::text),('sdr_ws_b',public.create_workspace('SDR empresa B')::text);
select public.admin_update_subscription(test.value('sdr_ws_a')::uuid,'team','active',12);
select public.admin_update_subscription(test.value('sdr_ws_b')::uuid,'team','active',12);
reset role;
insert into public.memberships(workspace_id,user_id,role,is_active)
select test.value('sdr_ws_a')::uuid,('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,member_role,active
from (values(170,'admin',true),(171,'manager',true),(173,'closer',true),(174,'viewer',true),(176,'sdr',false)) s(n,member_role,active);
insert into public.memberships(workspace_id,user_id,role,is_active)
values(test.value('sdr_ws_b')::uuid,'00000000-0000-0000-0000-000000000175','admin',true);
update public.workspaces set owner_id='00000000-0000-0000-0000-000000000170' where id=test.value('sdr_ws_a')::uuid;
update public.workspaces set owner_id='00000000-0000-0000-0000-000000000175' where id=test.value('sdr_ws_b')::uuid;
insert into test.context select 'sdr_new_stage',id::text from public.pipeline_stages where workspace_id=test.value('sdr_ws_a')::uuid and name='Lead novo';
insert into test.context select 'sdr_call_stage',id::text from public.pipeline_stages where workspace_id=test.value('sdr_ws_a')::uuid and name='Call agendada';
insert into test.context select 'sdr_foreign_stage',id::text from public.pipeline_stages where workspace_id=test.value('sdr_ws_b')::uuid and name='Lead novo';

select test.ok((select pg_get_constraintdef(oid) like '%sdr%' from pg_constraint where conrelid='public.memberships'::regclass and conname='memberships_role_check'),'sdr: membership constraint recognizes SDR');
select test.ok((select pg_get_constraintdef(oid) like '%sdr%' from pg_constraint where conrelid='public.invitations'::regclass and conname='invitations_role_check'),'sdr: invitation constraint recognizes SDR');
select test.denied(format('insert into public.memberships(workspace_id,user_id,role) values(%L,%L,''superadmin'')',test.value('sdr_ws_a'),'00000000-0000-0000-0000-000000000178'),'23514','sdr: unknown membership role still rejected');
select test.ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  where n.nspname in ('public','private') and a.grantee=0 and a.privilege_type='EXECUTE'),'sdr: no implicit PUBLIC function execute');
select test.ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prosecdef
  and not ('search_path=""'=any(p.proconfig))),'sdr: all definers retain empty search path');
do $$ declare signature text; begin
  foreach signature in array array['public.invite_member(uuid,text,text,text)','public.update_member(uuid,uuid,text,boolean)',
    'public.save_activity(uuid,text,text,text,timestamptz,uuid,text,uuid)','public.platform_inbound_options(uuid)',
    'public.platform_list_administrative_audit(uuid)'] loop
    perform test.ok(not has_function_privilege('anon',signature,'EXECUTE'),'sdr: anonymous cannot execute '||signature);
    perform test.ok(has_function_privilege('authenticated',signature,'EXECUTE'),'sdr: authenticated RPC grant preserved '||signature);
    perform test.ok(has_function_privilege('service_role',signature,'EXECUTE'),'sdr: service RPC grant preserved '||signature);
  end loop;
end; $$;
select test.ok(not has_function_privilege('authenticated','private.assert_manage(uuid)','EXECUTE'),'sdr: private administrative assertion remains internal');
select test.ok(not has_function_privilege('authenticated','private.validate_inbound_config(uuid,text,text,uuid,uuid,jsonb)','EXECUTE'),'sdr: private inbound validation remains internal');

-- Admin invitation preserves SDR on preview, email verification, activation and
-- list-members DTO. The acceptance implementation itself remains unchanged.
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000170',false);
insert into test.context values('sdr_invitation',public.invite_member(test.value('sdr_ws_a')::uuid,'sdr-role-172@example.test','sdr','Pré-vendas convidado')::text);
insert into test.context values('sdr_token',test.value('sdr_invitation')::jsonb->>'token');
select test.ok(test.value('sdr_invitation')::jsonb->>'role'='sdr','sdr: admin creates SDR invitation');
select test.ok(public.list_invitation_preview(test.value('sdr_token'))->>'role'='sdr','sdr: invitation preview retains SDR role');
select test.ok(exists(select 1 from jsonb_array_elements(public.list_invitations(test.value('sdr_ws_a')::uuid)) i where i->>'role'='sdr' and i->>'status'='pending'),'sdr: admin sees pending SDR invitation');
select test.denied(format('select public.invite_member(%L,''invalid-role@example.test'',''superadmin'')',test.value('sdr_ws_a')),'22023','sdr: invalid invite role remains rejected');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000178',false);
select test.denied(format('select public.accept_invitation(%L)',test.value('sdr_token')),'42501','sdr: wrong confirmed email cannot accept');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000170',false);
insert into test.context values('sdr_unconfirmed_token',public.invite_member(test.value('sdr_ws_a')::uuid,'sdr-role-177@example.test','sdr')->>'token');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000177',false);
select test.denied(format('select public.accept_invitation(%L)',test.value('sdr_unconfirmed_token')),'42501','sdr: unconfirmed email cannot activate invitation');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000172',false);
select test.ok(public.accept_invitation(test.value('sdr_token'))=test.value('sdr_ws_a')::uuid,'sdr: confirmed invite enters correct workspace');
select test.ok(private.workspace_role(test.value('sdr_ws_a')::uuid)='sdr','sdr: authenticated identity resolves SDR from active membership');
select test.ok((select role='sdr' and is_active from public.memberships where workspace_id=test.value('sdr_ws_a')::uuid and user_id=auth.uid()),'sdr: acceptance activates SDR membership');
select test.ok((select display_name='Pessoa SDR 172' from public.profiles where id=auth.uid()),'sdr: invitation preserves user-chosen display name');
select test.denied(format('select public.accept_invitation(%L)',test.value('sdr_token')),'42501','sdr: token cannot be accepted twice');

-- Existing Closer operational path: only own rows are readable/writable. A
-- forged Auth metadata role grants no permission, and delete stays restricted.
insert into public.leads(workspace_id,id,owner_id,data)
values(test.value('sdr_ws_a')::uuid,'sdr-own',auth.uid(),test.lead('sdr-own'));
select test.ok((select count(*)=1 from public.leads where workspace_id=test.value('sdr_ws_a')::uuid),'sdr: create and read assigned opportunity');
update public.leads set data=data||'{"pain":"Equipe sem previsibilidade","urgency":"Alta","financialCapacity":"Alta","decisionMaker":true,"notes":"Qualificação SDR"}'
where workspace_id=test.value('sdr_ws_a')::uuid and id='sdr-own';
select test.ok((select data->>'pain'='Equipe sem previsibilidade' and data->>'notes'='Qualificação SDR' from public.leads where id='sdr-own'),'sdr: own lead qualification persists');
update public.leads set stage_id=test.value('sdr_call_stage')::uuid,
  data=data||jsonb_build_object('callDate',to_char(clock_timestamp()+interval '1 day','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attendance','Pendente')
where workspace_id=test.value('sdr_ws_a')::uuid and id='sdr-own';
select test.ok((select stage_id=test.value('sdr_call_stage')::uuid and data->>'attendance'='Pendente' and data->>'callDate'<>'' from public.leads where id='sdr-own'),'sdr: own appointment and stage saved together');
select test.ok(exists(select 1 from public.lead_events where workspace_id=test.value('sdr_ws_a')::uuid and lead_id='sdr-own' and event_type='call.scheduled'),'sdr: scheduling records existing timeline event');
insert into test.context values('sdr_activity',public.save_activity(test.value('sdr_ws_a')::uuid,'sdr-own','Preparar reunião','meeting',clock_timestamp()+interval '2 days')::text);
select test.ok(test.value('sdr_activity')::jsonb->>'assigned_to'=auth.uid()::text,'sdr: new own activity defaults to SDR');
select test.denied(format('select public.save_activity(%L,''sdr-own'',''Delegação indevida'',''call'',clock_timestamp()+interval ''1 day'',%L)',test.value('sdr_ws_a'),'00000000-0000-0000-0000-000000000173'),'42501','sdr: cannot assign activity to teammate');
select test.ok(public.set_activity_status(test.value('sdr_ws_a')::uuid,(test.value('sdr_activity')::jsonb->>'id')::uuid,'completed')->>'status'='completed','sdr: can complete activity of own lead');
select test.ok(public.list_lead_call_history(test.value('sdr_ws_a')::uuid,'sdr-own')->>'call_count'='1','sdr: own call history available');
select test.ok(jsonb_array_length(public.list_lead_events(test.value('sdr_ws_a')::uuid,'sdr-own')->'items')>0,'sdr: own lead timeline available');
select test.denied(format('update public.leads set owner_id=%L where id=''sdr-own''','00000000-0000-0000-0000-000000000173'),'42501','sdr: cannot redistribute own lead');
select test.denied(format('update public.leads set workspace_id=%L where id=''sdr-own''',test.value('sdr_ws_b')),'42501','sdr: cannot move own lead across tenants');
select test.denied(format('insert into public.leads(workspace_id,id,owner_id,data) values(%L,''sdr-forged-owner'',%L,test.lead(''sdr-forged-owner''))',test.value('sdr_ws_a'),'00000000-0000-0000-0000-000000000173'),'42501','sdr: cannot create lead assigned to teammate');
select test.denied(format('insert into public.leads(workspace_id,id,owner_id,data) values(%L,''sdr-forged-tenant'',%L,test.lead(''sdr-forged-tenant''))',test.value('sdr_ws_b'),auth.uid()),'42501','sdr: cannot create lead in another company');
with removed as(delete from public.leads where id='sdr-own' returning id)
select test.ok((select count(*)=0 from removed),'sdr: cannot delete even own opportunity');
select test.ok(public.import_leads(test.value('sdr_ws_a')::uuid,jsonb_build_array(test.lead('sdr-json')),auth.uid())->>'imported'='1','sdr: legacy JSON own-lead operation equals Closer');
select test.denied(format('select public.import_leads(%L,jsonb_build_array(test.lead(''sdr-json-foreign'')),%L)',test.value('sdr_ws_a'),'00000000-0000-0000-0000-000000000173'),'42501','sdr: JSON cannot assign to teammate');
select test.denied(format('select public.import_external_leads(%L,''[]'')',test.value('sdr_ws_a')),'42501','sdr: Admin-Manager external importer remains unavailable');
select test.denied(format('select public.preview_import_leads(%L,''[]'')',test.value('sdr_ws_a')),'42501','sdr: Admin-Manager external preview remains unavailable');

-- No administrative escalation, either via RPC or direct authenticated writes.
select test.denied(format('select public.invite_member(%L,''escalate@example.test'',''admin'')',test.value('sdr_ws_a')),'42501','sdr: cannot invite administrator');
select test.denied(format('select public.update_member(%L,%L,''admin'',true)',test.value('sdr_ws_a'),auth.uid()),'42501','sdr: cannot elevate own membership');
select test.denied('update public.memberships set role=''admin'' where user_id=auth.uid()','42501','sdr: direct membership role update denied');
select test.denied(format('select public.rename_workspace(%L,''Invasão'')',test.value('sdr_ws_a')),'42501','sdr: cannot rename company');
select test.denied(format('select public.review_call(%L,''sdr-own'',''Review indevido'',10)',test.value('sdr_ws_a')),'42501','sdr: cannot perform leadership call review');
select test.denied(format('select public.save_pipeline_stages(%L,''[]'')',test.value('sdr_ws_a')),'42501','sdr: cannot manage pipeline stages');
select test.denied(format('select public.export_workspace(%L)',test.value('sdr_ws_a')),'42501','sdr: cannot export whole company');
select test.denied(format('select public.list_audit(%L)',test.value('sdr_ws_a')),'42501','sdr: cannot access administrative audit');
select test.denied('select public.list_platform_workspaces()','42501','sdr: cannot list platform clients');
select test.denied(format('select public.platform_inbound_options(%L)',test.value('sdr_ws_a')),'42501','sdr: cannot use Master metadata options');
select test.denied(format('select public.list_inbound_integrations(%L)',test.value('sdr_ws_a')),'42501','sdr: cannot administer inbound integrations');

-- Real teammate and foreign-tenant data remain inaccessible.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000173',false);
insert into public.leads(workspace_id,id,owner_id,data) values(test.value('sdr_ws_a')::uuid,'sdr-colleague',auth.uid(),test.lead('sdr-colleague'));
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000175',false);
insert into public.leads(workspace_id,id,owner_id,data) values(test.value('sdr_ws_b')::uuid,'sdr-foreign',auth.uid(),test.lead('sdr-foreign'));
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000172',false);
select test.ok((select count(*)=0 from public.leads where id in ('sdr-colleague','sdr-foreign')),'sdr: cannot read teammate or foreign tenant rows');
with changed as(update public.leads set data=data||'{"notes":"forged"}' where id in ('sdr-colleague','sdr-foreign') returning id)
select test.ok((select count(*)=0 from changed),'sdr: cannot update teammate or foreign tenant rows');
with removed as(delete from public.leads where id in ('sdr-colleague','sdr-foreign') returning id)
select test.ok((select count(*)=0 from removed),'sdr: cannot delete teammate or foreign tenant rows');
select test.denied(format('select public.list_lead_events(%L,''sdr-colleague'')',test.value('sdr_ws_a')),'42501','sdr: cannot read teammate timeline');
select test.denied(format('select public.list_lead_call_history(%L,''sdr-foreign'')',test.value('sdr_ws_b')),'42501','sdr: cannot read foreign call history');
select test.denied(format('select public.save_activity(%L,''sdr-colleague'',''forged'',''call'',clock_timestamp()+interval ''1 day'')',test.value('sdr_ws_a')),'42501','sdr: cannot schedule teammate activity');

-- Admin/Manager may distribute opportunities to active SDRs. Invalid owners
-- still fail, and existing Closer↔SDR conversion keeps lead identity/history.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000170',false);
select test.ok(exists(select 1 from jsonb_array_elements(public.list_members(test.value('sdr_ws_a')::uuid)) m where m->>'user_id'='00000000-0000-0000-0000-000000000172' and m->>'role'='sdr'),'sdr: team DTO includes activated SDR');
select test.ok(exists(select 1 from jsonb_array_elements(public.list_invitations(test.value('sdr_ws_a')::uuid)) i where i->>'id'=test.value('sdr_invitation')::jsonb->>'id' and i->>'status'='activated'),'sdr: invitation status becomes activated');
insert into test.context values('sdr_before_role_change',(select jsonb_build_object('id',id,'owner_id',owner_id,'data',data,'stage_id',stage_id)::text from public.leads where id='sdr-own'));
select public.update_member(test.value('sdr_ws_a')::uuid,'00000000-0000-0000-0000-000000000172','closer',true);
select test.ok((select role='closer' from public.memberships where workspace_id=test.value('sdr_ws_a')::uuid and user_id='00000000-0000-0000-0000-000000000172'),'sdr: Admin changes SDR to Closer');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000172',false);
select test.ok((select jsonb_build_object('id',id,'owner_id',owner_id,'data',data,'stage_id',stage_id)::text=test.value('sdr_before_role_change') from public.leads where id='sdr-own'),'sdr: SDR to Closer preserves assigned opportunity');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000170',false);
select public.update_member(test.value('sdr_ws_a')::uuid,'00000000-0000-0000-0000-000000000172','sdr',true);
select test.ok((select role='sdr' from public.memberships where workspace_id=test.value('sdr_ws_a')::uuid and user_id='00000000-0000-0000-0000-000000000172'),'sdr: Admin changes Closer to SDR');
select test.denied(format('select public.update_member(%L,%L,''sdr'',true)',test.value('sdr_ws_a'),'00000000-0000-0000-0000-000000000170'),'23514','sdr: owner cannot be demoted to SDR');
select test.denied(format('update public.leads set owner_id=%L where id=''sdr-colleague''','00000000-0000-0000-0000-000000000176'),'42501','sdr: inactive SDR cannot own new assignments');
select test.denied(format('update public.leads set owner_id=%L where id=''sdr-colleague''','00000000-0000-0000-0000-000000000174'),'42501','sdr: Viewer still cannot receive editable assignment');
select test.denied(format('update public.leads set owner_id=%L where id=''sdr-colleague''','00000000-0000-0000-0000-000000000175'),'42501','sdr: foreign owner remains rejected');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000171',false);
update public.leads set owner_id='00000000-0000-0000-0000-000000000172' where workspace_id=test.value('sdr_ws_a')::uuid and id='sdr-colleague';
select test.ok((select owner_id='00000000-0000-0000-0000-000000000172' from public.leads where id='sdr-colleague'),'sdr: Manager distributes opportunity to SDR');
select test.denied(format('select public.update_member(%L,%L,''closer'',true)',test.value('sdr_ws_a'),'00000000-0000-0000-0000-000000000172'),'42501','sdr: Manager does not gain membership administration');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000173',false);
select test.ok(not exists(select 1 from public.leads where id='sdr-colleague'),'sdr: old owner loses access after redistribution');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000172',false);
select test.ok(exists(select 1 from public.leads where id='sdr-colleague'),'sdr: new SDR owner receives assigned lead');

-- Both maintained import paths and the existing inbound receiver accept an
-- active SDR assignee, without allowing SDR to manage integrations/imports.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000170',false);
select test.ok(public.import_leads(test.value('sdr_ws_a')::uuid,jsonb_build_array(test.lead('sdr-admin-json')),'00000000-0000-0000-0000-000000000172')->>'imported'='1','sdr: Admin legacy JSON assigns SDR');
insert into test.context values('sdr_external_record',jsonb_build_array(jsonb_build_object('rowNumber',1,'rowKey',repeat('a',64),
  'stageId',test.value('sdr_new_stage'),'ownerId','00000000-0000-0000-0000-000000000172',
  'lead',test.lead('import-'||repeat('a',64))||'{"email":"sdr-external@example.test","createdAt":"","lastContactAt":""}'))::text);
select test.ok(public.preview_import_leads(test.value('sdr_ws_a')::uuid,test.value('sdr_external_record')::jsonb)->>'new'='1','sdr: Admin external preview accepts SDR owner');
select test.ok(public.import_external_leads(test.value('sdr_ws_a')::uuid,test.value('sdr_external_record')::jsonb)->>'imported'='1','sdr: Admin external importer assigns SDR');
insert into test.context values('sdr_inbound',public.create_inbound_integration(test.value('sdr_ws_a')::uuid,'SDR formulario','Formulario SDR',test.value('sdr_new_stage')::uuid,'00000000-0000-0000-0000-000000000172','{"name":"nome","email":"email"}')::text);
select test.ok(test.value('sdr_inbound')::jsonb->'integration'->>'owner_id'='00000000-0000-0000-0000-000000000172','sdr: company Admin creates inbound assigned to SDR');
reset role;
insert into test.context values('sdr_inbound_hash',encode(extensions.digest(test.value('sdr_inbound')::jsonb->>'token','sha256'),'hex'));
select set_config('request.jwt.claim.sub','',false);
set role service_role;
insert into test.context values('sdr_inbound_result',public.receive_inbound_lead(test.value('sdr_inbound_hash'),gen_random_uuid(),'{"nome":"Lead inbound SDR","email":"sdr-inbound@example.test"}')::text);
reset role;
select test.ok(test.value('sdr_inbound_result')::jsonb->>'status'='created','sdr: inbound receiver creates lead with active SDR owner');
select test.ok((select owner_id='00000000-0000-0000-0000-000000000172' from public.leads where workspace_id=test.value('sdr_ws_a')::uuid and data->>'email'='sdr-inbound@example.test'),'sdr: inbound opportunity remains in correct company assigned to SDR');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000172',false);
select test.ok(exists(select 1 from public.leads where workspace_id=test.value('sdr_ws_a')::uuid and data->>'email'='sdr-inbound@example.test'),'sdr: SDR reads its inbound opportunity');
select test.ok(exists(select 1 from public.leads where workspace_id=test.value('sdr_ws_a')::uuid and data->>'email'='sdr-external@example.test'),'sdr: SDR reads externally imported own opportunity');

-- Master receives only existing sanitized administration metadata, never lead,
-- activity, history or extra personal-data privileges through the new role.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select test.ok(exists(select 1 from jsonb_array_elements(public.platform_inbound_options(test.value('sdr_ws_a')::uuid)->'owners') o where o->>'user_id'='00000000-0000-0000-0000-000000000172'),'sdr: Master narrow inbound owner options include active SDR');
select test.ok(not exists(select 1 from jsonb_array_elements(public.platform_inbound_options(test.value('sdr_ws_a')::uuid)->'owners') o where o->>'user_id' in ('00000000-0000-0000-0000-000000000176','00000000-0000-0000-0000-000000000174')),'sdr: Master options exclude inactive SDR and Viewer');
select test.ok(exists(select 1 from jsonb_array_elements(public.platform_list_administrative_audit(test.value('sdr_ws_a')::uuid)) a where a->>'action'='invitation.accepted' and a->'details'->>'role'='sdr'),'sdr: sanitized Master audit recognizes SDR');
select test.ok(not public.platform_list_administrative_audit(test.value('sdr_ws_a')::uuid)::text like '%sdr-inbound@example.test%' and not public.platform_list_administrative_audit(test.value('sdr_ws_a')::uuid)::text like '%Qualificação SDR%','sdr: Master audit contains no commercial payload');
select test.ok((select count(*)=0 from public.leads where workspace_id=test.value('sdr_ws_a')::uuid),'sdr: Master receives no commercial read access');
with changed as(update public.leads set data=data||'{"notes":"Master forged"}' where workspace_id=test.value('sdr_ws_a')::uuid returning id)
select test.ok((select count(*)=0 from changed),'sdr: Master receives no commercial edit access');
select test.denied(format('select public.export_workspace(%L)',test.value('sdr_ws_a')),'42501','sdr: Master export remains denied');
select test.denied(format('select public.list_lead_call_history(%L,''sdr-own'')',test.value('sdr_ws_a')),'42501','sdr: Master call history remains denied');
select test.ok((select count(*)=0 from public.profiles where id='00000000-0000-0000-0000-000000000172'),'sdr: Master receives no extra personal profile access');

-- Revocation and expiry affect SDR immediately through the same RLS helpers.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000170',false);
select public.update_member(test.value('sdr_ws_a')::uuid,'00000000-0000-0000-0000-000000000172','sdr',false);
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000172',false);
select test.ok((select count(*)=0 from public.leads where workspace_id=test.value('sdr_ws_a')::uuid),'sdr: deactivation removes own commercial read access');
with changed as(update public.leads set data=data||'{"notes":"revoked forged"}' where id='sdr-own' returning id)
select test.ok((select count(*)=0 from changed),'sdr: deactivation removes own commercial edit access');
reset role;
select set_config('request.jwt.claim.sub','',false);
set role service_role;
insert into test.context values('sdr_inbound_inactive',public.receive_inbound_lead(test.value('sdr_inbound_hash'),gen_random_uuid(),'{"nome":"Sem responsavel","email":"sdr-inactive-inbound@example.test"}')::text);
reset role;
select test.ok(test.value('sdr_inbound_inactive')::jsonb->>'error_code'='OWNER_UNAVAILABLE','sdr: inbound rejects inactive SDR rather than assigning unavailable owner');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000170',false);
select public.update_member(test.value('sdr_ws_a')::uuid,'00000000-0000-0000-0000-000000000172','sdr',true);
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000172',false);
select test.ok(exists(select 1 from public.leads where id='sdr-own'),'sdr: reactivation restores own opportunities');
reset role;
update public.subscriptions set status='suspended' where workspace_id=test.value('sdr_ws_a')::uuid;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000172',false);
select test.ok((select count(*)=0 from public.leads where workspace_id=test.value('sdr_ws_a')::uuid),'sdr: unavailable subscription removes own commercial access');
reset role;
update public.subscriptions set status='active' where workspace_id=test.value('sdr_ws_a')::uuid;
set role anon;
select test.denied(format('select public.accept_invitation(%L)',test.value('sdr_token')),'42501','sdr: anonymous invitation activation remains denied');
select test.denied('select * from public.leads','42501','sdr: anonymous commercial reads remain denied');
reset role;
revoke usage on schema test from service_role;
select 'SDR role assertions passed: '||count(*) from test.results where label like 'sdr:%';
