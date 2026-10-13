\set ON_ERROR_STOP on
-- Real roles and RLS in the disposable database, never a production fixture.
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'external-import-'||n||'@example.test',now(),'{}'
from generate_series(140,146) n;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
insert into test.context values('external_ws_a',public.create_workspace('Importação empresa A')::text),('external_ws_b',public.create_workspace('Importação empresa B')::text);
select public.admin_update_subscription(test.value('external_ws_a')::uuid,'team','active',12);
select public.admin_update_subscription(test.value('external_ws_b')::uuid,'team','active',12);
reset role;
insert into public.memberships(workspace_id,user_id,role,is_active)
select test.value('external_ws_a')::uuid,('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,role,active
from (values(140,'admin',true),(141,'manager',true),(142,'closer',true),(143,'viewer',true),(144,'manager',false)) x(n,role,active);
insert into public.memberships(workspace_id,user_id,role,is_active)
values(test.value('external_ws_b')::uuid,'00000000-0000-0000-0000-000000000145','admin',true);
update public.workspaces set owner_id='00000000-0000-0000-0000-000000000140' where id=test.value('external_ws_a')::uuid;
update public.workspaces set owner_id='00000000-0000-0000-0000-000000000145' where id=test.value('external_ws_b')::uuid;
insert into test.context select 'external_stage_a',id::text from public.pipeline_stages where workspace_id=test.value('external_ws_a')::uuid and name='Lead novo';
insert into test.context select 'external_stage_b',id::text from public.pipeline_stages where workspace_id=test.value('external_ws_b')::uuid and name='Lead novo';
insert into test.context select 'external_won',id::text from public.pipeline_stages where workspace_id=test.value('external_ws_a')::uuid and type='WON';
insert into test.context select 'external_lost',id::text from public.pipeline_stages where workspace_id=test.value('external_ws_a')::uuid and type='LOST';
insert into public.pipeline_stages(workspace_id,pipeline_id,name,position,color,type,legacy_status)
select p.workspace_id,p.id,'Negociação personalizada',7,'#8899aa','NORMAL','Follow-up' from public.pipelines p where p.workspace_id=test.value('external_ws_a')::uuid;
insert into test.context select 'external_custom',id::text from public.pipeline_stages where workspace_id=test.value('external_ws_a')::uuid and name='Negociação personalizada';
insert into public.pipeline_stages(workspace_id,pipeline_id,name,position,color,type,active)
select p.workspace_id,p.id,'Etapa arquivada',8,'#8899aa','NORMAL',false from public.pipelines p where p.workspace_id=test.value('external_ws_a')::uuid;
insert into test.context select 'external_inactive_stage',id::text from public.pipeline_stages where workspace_id=test.value('external_ws_a')::uuid and not active;

create function test.external_hash(p_key text) returns text language sql immutable security definer set search_path=''
as $$ select encode(extensions.digest(p_key,'sha256'),'hex'); $$;

create function test.external_record(p_key text,p_number integer default 1,p_changes jsonb default '{}',p_stage text default 'external_stage_a',p_owner uuid default '00000000-0000-0000-0000-000000000142') returns jsonb
language sql stable security definer set search_path='' as $$ select jsonb_build_object('rowNumber',p_number,'rowKey',test.external_hash(p_key),
  'stageId',test.value(p_stage),'ownerId',p_owner,'lead',test.lead('import-'||test.external_hash(p_key))||'{"email":"","createdAt":"","lastContactAt":""}'::jsonb||p_changes); $$;
create function test.external_preview(p_records jsonb,p_namespace text default null) returns jsonb language sql volatile
as $$ select public.preview_import_leads(test.value('external_ws_a')::uuid,p_records,p_namespace); $$;
create function test.external_import(p_records jsonb,p_namespace text default null) returns jsonb language sql volatile
as $$ select public.import_external_leads(test.value('external_ws_a')::uuid,p_records,p_namespace); $$;

select test.ok((select relrowsecurity from pg_class where oid='private.external_import_keys'::regclass),'external: private provenance enables RLS');
select test.ok(not has_table_privilege('authenticated','private.external_import_keys','SELECT,INSERT,UPDATE,DELETE'),'external: client cannot read or forge idempotence records');
select test.ok(not has_table_privilege('anon','private.external_import_keys','SELECT,INSERT,UPDATE,DELETE'),'external: anonymous cannot read provenance');
select test.ok(has_function_privilege('authenticated','public.preview_import_leads(uuid,jsonb,text,jsonb)','EXECUTE'),'external: preview callable with authenticated membership');
select test.ok(has_function_privilege('authenticated','public.import_external_leads(uuid,jsonb,text)','EXECUTE'),'external: import callable with authenticated membership');
select test.ok(not has_function_privilege('anon','public.preview_import_leads(uuid,jsonb,text,jsonb)','EXECUTE'),'external: anonymous preview not granted');
select test.ok(not has_function_privilege('anon','public.import_external_leads(uuid,jsonb,text)','EXECUTE'),'external: anonymous import not granted');
select test.ok(not has_function_privilege('authenticated','private.assert_external_import(uuid,jsonb,text,boolean)','EXECUTE'),'external: internal authorization assertion inaccessible');
select test.ok(not has_function_privilege('authenticated','private.external_import_matches(uuid,jsonb,jsonb)','EXECUTE'),'external: internal commercial lookup inaccessible');
select test.ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  where n.nspname in ('public','private') and a.grantee=0 and a.privilege_type='EXECUTE'),'external: functions grant no implicit PUBLIC execute');
select test.ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prosecdef
  and not ('search_path=""'=any(p.proconfig))),'external: security definers lock empty search path');

set role anon;
select test.denied('select test.external_import(''[]'')','42501','external: anonymous import denied');
select test.denied('select test.external_preview(''[]'')','42501','external: anonymous preview denied');
reset role;
set role authenticated;
do $$ declare actor uuid; label text; begin
  for actor,label in select * from (values(null::uuid,'no identity'),('00000000-0000-0000-0000-000000000001'::uuid,'Master without membership'),
    ('00000000-0000-0000-0000-000000000142'::uuid,'closer'),('00000000-0000-0000-0000-000000000143'::uuid,'viewer'),
    ('00000000-0000-0000-0000-000000000144'::uuid,'inactive manager'),('00000000-0000-0000-0000-000000000145'::uuid,'foreign admin'),
    ('00000000-0000-0000-0000-000000000146'::uuid,'unaffiliated account')) x(actor,label) loop
    perform set_config('request.jwt.claim.sub',coalesce(actor::text,''),false);
    perform test.denied(format('select test.external_preview(%L::jsonb)',jsonb_build_array(test.external_record('forged'))),'42501','external: preview denied for '||label);
    perform test.denied(format('select test.external_import(%L::jsonb)',jsonb_build_array(test.external_record('forged'))),'42501','external: import denied for '||label);
  end loop;
end; $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000140',false);
select test.denied(format('select public.import_external_leads(%L,%L::jsonb)',test.value('external_ws_b'),jsonb_build_array(test.external_record('foreign'))),'42501','external: admin cannot write another tenant');
select test.denied(format('select public.preview_import_leads(%L,%L::jsonb)',test.value('external_ws_b'),jsonb_build_array(test.external_record('foreign'))),'42501','external: admin cannot preview another tenant');
select test.denied('select * from private.external_import_keys','42501','external: own admin cannot read raw provenance');
select test.denied('insert into private.external_import_keys values(gen_random_uuid(),''row'',repeat(''1'',64),''forged'')','42501','external: own admin cannot forge provenance');

-- Envelope guards, including meaningful full-batch rollback.
select test.denied('select test.external_import(null)','22023','external: null batch rejected');
select test.denied('select test.external_import(''{}'')','22023','external: object batch rejected');
select test.denied('select test.external_import(''[]'')','22023','external: empty batch rejected');
select test.denied('select test.external_import((select jsonb_agg(test.external_record(''limit-''||n,n)) from generate_series(1,501) n))','22023','external: 501 row batch rejected');
select test.denied('select test.external_import(jsonb_build_array(test.external_record(''bytes'',1,jsonb_build_object(''notes'',repeat(''x'',1048576)))))','22023','external: payload byte limit enforced');
select test.denied('select test.external_import(jsonb_build_array(test.external_record(''one''),test.external_record(''two'')))','22023','external: repeated row numbers rejected');
select test.denied('select test.external_import(jsonb_build_array(test.external_record(''namespace'')),'''')','22023','external: explicit empty namespace rejected');
select test.denied('select test.external_import(jsonb_build_array(test.external_record(''namespace'')),repeat(''x'',121))','22023','external: namespace length bounded');
select test.denied('select test.external_import(jsonb_build_array(test.external_record(''namespace'')),E''unsafe\nnamespace'')','22023','external: namespace controls rejected');

do $$ declare changes jsonb; label text; before_count integer; response jsonb; begin
  for changes,label in select * from (values
    ('{"name":""}'::jsonb,'missing name'),('{"name":1}'::jsonb,'numeric name'),('{"email":"wrong.email"}'::jsonb,'invalid email'),
    ('{"phone":"abc"}'::jsonb,'invalid phone'),('{"ticket":-1}'::jsonb,'negative ticket'),('{"ticket":"123"}'::jsonb,'unparsed ticket'),
    ('{"decisionMaker":"true"}'::jsonb,'unparsed boolean'),('{"callDate":"2026-02-30T10:00:00Z"}'::jsonb,'invalid calendar date'),
    ('{"createdAt":"infinity"}'::jsonb,'nonfinite date'),('{"createdAt":20261012}'::jsonb,'numeric creation date'),
    ('{"lastContactAt":null}'::jsonb,'null contact date'),('{"callDate":true}'::jsonb,'boolean call date'),
    ('{"closedAt":1}'::jsonb,'numeric closed date'),('{"callDate":"now"}'::jsonb,'relative call date'),
    ('{"createdAt":"2026-10-12"}'::jsonb,'unresolved creation timezone'),
    ('{"closedValue":100}'::jsonb,'closed amount outside won stage'),('{"closedAt":"2026-10-12T12:00:00Z"}'::jsonb,'closed date outside won stage'),
    ('{"urgency":"Urgente"}'::jsonb,'invalid urgency'),
    ('{"financialCapacity":"Unknown"}'::jsonb,'invalid financial capacity'),('{"attendance":"Sim"}'::jsonb,'unparsed attendance'),
    ('{"callScore":10}'::jsonb,'call assessment'),('{"closerError":"Inventado"}'::jsonb,'closer evaluation'),
    ('{"callSummary":"Inventado"}'::jsonb,'call summary'),('{"recordingUrl":"https://example.test/call"}'::jsonb,'recording'),
    ('{"leadershipReview":{}}'::jsonb,'leadership review'),('{"workspaceId":"forged"}'::jsonb,'tenant override'),
    ('{"importMetadata":{"lastContactAtSource":"provided"}}'::jsonb,'forged import metadata'),
    ('{"activities":[]}'::jsonb,'invented activities'),('{"events":[]}'::jsonb,'invented history')) x(changes,label) loop
    select count(*) into before_count from public.leads where workspace_id=test.value('external_ws_a')::uuid;
    response:=test.external_preview(jsonb_build_array(test.external_record('bad-'||label,1,changes)));
    perform test.ok(response->>'error'='1','external: preview reports '||label);
    perform test.denied(format('select test.external_import(%L::jsonb)',jsonb_build_array(test.external_record('atomic-'||label,1),test.external_record('bad-'||label,2,changes))),
      '22023','external: whole batch rejects '||label);
    perform test.ok((select count(*)=before_count from public.leads where workspace_id=test.value('external_ws_a')::uuid),'external: invalid batch leaves no partial rows for '||label);
  end loop;
end; $$;

do $$ declare raw jsonb; label text; begin
  for raw,label in select * from (values
    (test.external_record('stage',1,'{}','external_stage_b'),'foreign stage'),
    (test.external_record('stage',1,'{}','external_inactive_stage'),'inactive stage'),
    (test.external_record('owner',1,'{}','external_stage_a','00000000-0000-0000-0000-000000000143'),'viewer owner'),
    (test.external_record('owner',1,'{}','external_stage_a','00000000-0000-0000-0000-000000000144'),'inactive owner'),
    (test.external_record('owner',1,'{}','external_stage_a','00000000-0000-0000-0000-000000000145'),'foreign owner'),
    (test.external_record('source')||'{"sourceId":"CRM-123"}','source ID without namespace'),
    (test.external_record('won',1,'{}','external_won'),'won without facts'),
    (test.external_record('won',1,'{"closedValue":100,"attendance":"Compareceu"}','external_won'),'won missing close date'),
    (test.external_record('won',1,'{"closedValue":100,"closedAt":"2026-10-01T12:00:00Z"}','external_won'),'won missing attendance'),
    (test.external_record('lost',1,'{}','external_lost'),'lost without reason'),
    (test.external_record('lost',1,'{"lossReason":"Not supported"}','external_lost'),'lost invalid reason')) x(raw,label) loop
    perform test.ok(test.external_preview(jsonb_build_array(raw))->>'error'='1','external: preview rejects '||label);
    perform test.denied(format('select test.external_import(%L::jsonb)',jsonb_build_array(raw)),'22023','external: server rejects '||label);
  end loop;
end; $$;

insert into test.context values('external_good_rows',jsonb_build_array(
  test.external_record('first',1,'{"email":" PERSON@EXAMPLE.TEST ","phone":"+55 (71) 98888-0001","notes":"PRIVATE_NOTE_CANARY","ticket":15900.75,"callDate":"2026-09-01T15:30:00Z"}'),
  test.external_record('custom',2,'{"email":"custom@example.test","createdAt":"2023-06-04T13:45:00Z","lastContactAt":"2026-01-02T10:00:00Z"}','external_custom','00000000-0000-0000-0000-000000000141'),
  test.external_record('won',3,'{"closedValue":43000.55,"closedAt":"2025-07-09T14:20:00Z","attendance":"Compareceu"}','external_won'),
  test.external_record('lost',4,'{"lossReason":"Timing","lossComment":"Revisar depois"}','external_lost')
)::text);
insert into test.context values('external_before_good_count',(select count(*)::text from public.leads where workspace_id=test.value('external_ws_a')::uuid));
insert into test.context values('external_good_preview',test.external_preview(test.value('external_good_rows')::jsonb)::text);
select test.ok(test.value('external_good_preview')::jsonb->>'new'='4','external: authorized admin previews new rows');
select test.ok((select count(*)::text=test.value('external_before_good_count') from public.leads where workspace_id=test.value('external_ws_a')::uuid),'external: preview writes no leads');
select test.ok(not test.value('external_good_preview') like '%PRIVATE_NOTE_CANARY%' and not test.value('external_good_preview') like '%PERSON@%' and not test.value('external_good_preview') like '%98888%','external: preview includes no lead payload');
insert into test.context values('external_good_result',test.external_import(test.value('external_good_rows')::jsonb)::text);
select test.ok(test.value('external_good_result')::jsonb->>'imported'='4','external: admin imports four valid distinct rows');
select test.ok((select data->>'email'='person@example.test' and data->>'phone'='+5571988880001' and data->>'ticket'='15900.75' from public.leads
  where workspace_id=test.value('external_ws_a')::uuid and id='import-'||test.external_hash('first')),'external: contact and exact money normalized');
select test.ok((select data->>'attendance'='Pendente' and data->>'callDate'='2026-09-01T15:30:00Z' from public.leads where workspace_id=test.value('external_ws_a')::uuid
  and id='import-'||test.external_hash('first')),'external: past call date does not fabricate attendance');
select test.ok((select data->'importMetadata'->>'lastContactAtSource'='import' and data->>'lastContactAt'=data->'importMetadata'->>'importedAt' from public.leads where workspace_id=test.value('external_ws_a')::uuid
  and id='import-'||test.external_hash('first')),'external: missing contact date tagged as technical import default');
select test.ok((select data->>'createdAt'='2023-06-04T13:45:00Z' and data->>'lastContactAt'='2026-01-02T10:00:00Z'
  and data->'importMetadata'->>'createdAtSource'='provided' and data->'importMetadata'->>'lastContactAtSource'='provided' from public.leads where workspace_id=test.value('external_ws_a')::uuid
  and id='import-'||test.external_hash('custom')),'external: supplied historical dates preserved and identified');
select test.ok((select owner_id='00000000-0000-0000-0000-000000000141' and stage_id=test.value('external_custom')::uuid and data->>'status'='Follow-up'
  from public.leads where workspace_id=test.value('external_ws_a')::uuid and id='import-'||test.external_hash('custom')),'external: per-row real custom stage and manager owner preserved');
select test.ok((select data->>'closedAt'='2025-07-09T14:20:00Z' and data->>'closedValue'='43000.55' and data->>'attendance'='Compareceu'
  from public.leads where workspace_id=test.value('external_ws_a')::uuid and id='import-'||test.external_hash('won')),'external: real won facts preserved');
select test.ok((select count(*)=4 and bool_and(event_type='lead.created') from public.lead_events where workspace_id=test.value('external_ws_a')::uuid),'external: imported snapshots generate only genuine present creation events');
select test.ok(not exists(select 1 from public.activities where workspace_id=test.value('external_ws_a')::uuid),'external: no fake activities created');
select test.ok(not exists(select 1 from public.call_reviews where workspace_id=test.value('external_ws_a')::uuid),'external: no fake leadership reviews created');
select test.ok(not test.value('external_good_result') like '%PRIVATE_NOTE_CANARY%' and not test.value('external_good_result') like '%person@example%' and not test.value('external_good_result') like '%import-%','external: import report contains no commercial payload or IDs');
insert into test.context values('external_original_snapshot',(select jsonb_agg(to_jsonb(l) order by id)::text from public.leads l where workspace_id=test.value('external_ws_a')::uuid));
select test.ok(test.external_import(test.value('external_good_rows')::jsonb)->>'skipped'='4','external: same import retry skips all committed rows');
select test.ok((select jsonb_agg(to_jsonb(l) order by id)::text=test.value('external_original_snapshot') from public.leads l where workspace_id=test.value('external_ws_a')::uuid),'external: retry preserves existing payloads owner and timestamps');

-- Membership managers may import; closers still use the untouched backup RPC.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000141',false);
select test.ok(test.external_import(jsonb_build_array(test.external_record('manager-new')))->>'imported'='1','external: active company manager may import');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000142',false);
select test.ok(public.import_leads(test.value('external_ws_a')::uuid,jsonb_build_array(test.lead('external-json-backup')),auth.uid())->>'imported'='1','external: existing closer own JSON backup import preserved');
select test.ok(public.import_leads(test.value('external_ws_a')::uuid,jsonb_build_array(test.lead('external-json-backup')),auth.uid())->>'skipped'='1','external: legacy JSON remains ID-idempotent');
select test.denied(format('select public.import_leads(%L,%L::jsonb,%L)',test.value('external_ws_a'),jsonb_build_array(test.lead('external-json-forged')),'00000000-0000-0000-0000-000000000141'),
  '42501','external: legacy closer cannot assign colleague');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000140',false);

-- Tenant-local duplicate matching, and ambiguity never chooses an arbitrary lead.
insert into public.leads(workspace_id,id,owner_id,data) values
  (test.value('external_ws_a')::uuid,'external-existing-a',auth.uid(),test.lead('external-existing-a')||'{"email":"dupe@example.test","phone":"5571988881111","notes":"EXISTING_PRESERVE"}'),
  (test.value('external_ws_a')::uuid,'external-existing-b',auth.uid(),test.lead('external-existing-b')||'{"email":"another@example.test","phone":"5571988882222"}');
insert into test.context values('external_duplicates',jsonb_build_array(
  test.external_record('email-dupe',1,'{"email":"DUPE@example.test","notes":"SHOULD_NOT_OVERWRITE"}'),
  test.external_record('phone-dupe',2,'{"phone":"+55 (71) 98888-1111"}'),
  test.external_record('contact-conflict',3,'{"email":"dupe@example.test","phone":"5571988882222"}')
)::text);
select test.ok(test.external_preview(test.value('external_duplicates')::jsonb)->>'duplicate'='2','external: normalized existing email and phone match duplicates');
select test.ok(test.external_preview(test.value('external_duplicates')::jsonb)->>'conflict'='1','external: email to A and phone to B reports conflict');
insert into test.context values('external_dupe_result',test.external_import(test.value('external_duplicates')::jsonb)::text);
select test.ok(test.value('external_dupe_result')::jsonb->>'imported'='0' and test.value('external_dupe_result')::jsonb->>'skipped'='2' and test.value('external_dupe_result')::jsonb->>'conflicts'='1','external: backend skips duplicates and conflict without overwrite');
select test.ok((select data->>'notes'='EXISTING_PRESERVE' from public.leads where workspace_id=test.value('external_ws_a')::uuid and id='external-existing-a'),'external: existing lead notes untouched');
select test.ok(test.external_preview(jsonb_build_array(test.external_record('internal-one',1,'{"email":"file-dupe@example.test"}'),test.external_record('internal-two',2,'{"email":"FILE-DUPE@example.test"}')))->>'duplicate'='1','external: preview detects duplicate rows inside file batch');
select test.ok(test.external_import(jsonb_build_array(test.external_record('internal-one',1,'{"email":"file-dupe@example.test"}'),test.external_record('internal-two',2,'{"email":"FILE-DUPE@example.test"}')))->>'imported'='1','external: duplicate rows in one file create one lead');

-- Skipping an existing lead is not a contact merge. Preview must not pretend
-- a newly supplied phone was written into that lead, within or across batches.
insert into test.context values('external_unmerged_rows',jsonb_build_array(
  test.external_record('unmerged-first',1,'{"email":"dupe@example.test","phone":"5571999993333"}'),
  test.external_record('unmerged-second',2,'{"email":"really-new@example.test","phone":"5571999993333"}')
)::text);
insert into test.context values('external_unmerged_preview',test.external_preview(test.value('external_unmerged_rows')::jsonb)::text);
select test.ok(test.value('external_unmerged_preview')::jsonb->>'new'='1' and test.value('external_unmerged_preview')::jsonb->>'duplicate'='1','external: duplicate incoming contact is never merged into virtual existing lead');
insert into test.context values('external_unmerged_first_preview',test.external_preview(jsonb_build_array(test.value('external_unmerged_rows')::jsonb->0))::text);
select test.ok(public.preview_import_leads(test.value('external_ws_a')::uuid,jsonb_build_array(test.value('external_unmerged_rows')::jsonb->1),null,
  test.value('external_unmerged_first_preview')::jsonb->'context')->>'new'='1','external: unmerged duplicate phone stays new across preview batches');
select test.ok((test.value('external_unmerged_first_preview')::jsonb->'context'->'entries'->0)->'emailHash'='null'::jsonb
  and (test.value('external_unmerged_first_preview')::jsonb->'context'->'entries'->0)->'phoneHash'='null'::jsonb,'external: existing duplicate contributes retry aliases only');
select test.ok(test.external_import(test.value('external_unmerged_rows')::jsonb)->>'imported'='1','external: write agrees with preview without false duplicate data loss');
select test.ok((select data->>'phone'='5571988881111' from public.leads where workspace_id=test.value('external_ws_a')::uuid and id='external-existing-a'),'external: existing contact remains unmerged');

insert into test.context values('external_context_first',test.external_preview(jsonb_build_array(
  test.external_record('context-a',1,'{"email":"context-a@example.test","phone":"5571999994444"}'),
  test.external_record('context-b',2,'{"email":"context-b@example.test","phone":"5571999995555"}'))
)::text);
insert into test.context values('external_context_next',public.preview_import_leads(test.value('external_ws_a')::uuid,jsonb_build_array(
  test.external_record('context-dupe',501,'{"email":"CONTEXT-A@example.test"}'),
  test.external_record('context-conflict',502,'{"email":"context-a@example.test","phone":"5571999995555"}')),
  null,test.value('external_context_first')::jsonb->'context')::text);
select test.ok(test.value('external_context_next')::jsonb->>'duplicate'='1' and test.value('external_context_next')::jsonb->>'conflict'='1','external: continuation detects cross-batch duplicates and conflicting virtual identities');
select test.ok(jsonb_array_length(test.value('external_context_next')::jsonb->'context'->'entries')=3,'external: conflicts never register an arbitrary preview identity');
select test.ok((test.value('external_context_next')::jsonb->'context'->'entries'->2)->>'id'=(test.value('external_context_first')::jsonb->'context'->'entries'->0)->>'id','external: duplicate continuation alias reuses the matching opaque identity');
select test.ok(not exists(select 1 from public.leads where workspace_id=test.value('external_ws_a')::uuid and data->>'email' like 'context-%'),'external: continuation creates no persisted preview leads');
select test.ok(not (test.value('external_context_next')::jsonb->'context')::text like '%example.test%'
  and not (test.value('external_context_next')::jsonb->'context')::text like '%557199%'
  and not (test.value('external_context_next')::jsonb->'context')::text like '%import-%','external: continuation exposes neither raw contact data nor existing or virtual lead IDs');

do $$ declare invalid_context jsonb; label text; begin
  for invalid_context,label in select * from (values
    ('{}'::jsonb,'missing workspace binding'),('[]'::jsonb,'array context'),
    (jsonb_build_object('workspaceId',test.value('external_ws_b'),'entries','[]'::jsonb),'foreign workspace context'),
    (jsonb_build_object('workspaceId',test.value('external_ws_a'),'entries','{}'::jsonb),'non-array entries'),
    (jsonb_build_object('workspaceId',test.value('external_ws_a'),'entries',jsonb_build_array(jsonb_build_object('id','raw-lead','rowKey',repeat('a',64)))),'raw identity'),
    (jsonb_build_object('workspaceId',test.value('external_ws_a'),'entries',jsonb_build_array(jsonb_build_object('id',repeat('a',64),'rowKey',repeat('b',64),'sourceHash',null,'emailHash','PII@example.test','phoneHash',null))),'raw contact'),
    (jsonb_build_object('workspaceId',test.value('external_ws_a'),'entries','[]'::jsonb,'extra','unexpected'),'unexpected context fields'),
    (jsonb_build_object('workspaceId',test.value('external_ws_a'),'entries','[]'::jsonb,'extra',repeat('x',4194304)),'oversized context')) x(invalid_context,label) loop
    perform test.denied(format('select public.preview_import_leads(%L,%L::jsonb,null,%L::jsonb)',test.value('external_ws_a'),jsonb_build_array(test.external_record('context-envelope')),invalid_context),
      '22023','external: continuation rejects '||label);
  end loop;
end; $$;

-- The write endpoint has no continuation argument: forged preview state can
-- only change an estimate, never authorization or persisted duplication rules.
insert into test.context values('external_forged_context',jsonb_build_object('workspaceId',test.value('external_ws_a'),'entries',jsonb_build_array(
  jsonb_build_object('id',repeat('a',64),'rowKey',test.external_hash('forged-preview-row'),'sourceHash',null,'emailHash',null,'phoneHash',null)))::text);
select test.ok(public.preview_import_leads(test.value('external_ws_a')::uuid,jsonb_build_array(test.external_record('forged-preview-row')),null,
  test.value('external_forged_context')::jsonb)->>'duplicate'='1','external: untrusted continuation remains a read-only estimate');
select test.ok(test.external_import(jsonb_build_array(test.external_record('forged-preview-row')))->>'imported'='1','external: actual import ignores forged preview state completely');

do $$ declare maximum_context jsonb; result jsonb; begin
  select jsonb_build_object('workspaceId',test.value('external_ws_a'),'entries',jsonb_agg(jsonb_build_object(
    'id',test.external_hash('max-id-'||n),'rowKey',test.external_hash('max-row-'||n),'sourceHash',test.external_hash('max-source-'||n),
    'emailHash',test.external_hash('max-email-'||n),'phoneHash',test.external_hash('max-phone-'||n))))
    into maximum_context from generate_series(1,9999) n;
  perform test.ok(octet_length(maximum_context::text)<4194304,'external: worst-case full-hash 9999-row continuation fits the bounded envelope');
  result:=public.preview_import_leads(test.value('external_ws_a')::uuid,jsonb_build_array(test.external_record('context-limit-row',10000)),null,maximum_context);
  perform test.ok(jsonb_array_length(result->'context'->'entries')=10000 and octet_length((result->'context')::text)<4194304,'external: maximum ten-thousand-row preview round trip fits continuation budget');
  perform test.denied(format('select public.preview_import_leads(%L,%L::jsonb,null,%L::jsonb)',test.value('external_ws_a'),jsonb_build_array(test.external_record('context-over-limit',10001)),result->'context'),
    '22023','external: continuation never exceeds ten thousand rows');
end; $$;

select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select test.denied(format('select public.preview_import_leads(%L,%L::jsonb,null,%L::jsonb)',test.value('external_ws_a'),jsonb_build_array(test.external_record('master-context')),test.value('external_context_first')::jsonb->'context'),
  '42501','external: hashed preview continuation gives Master no company access');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000140',false);

-- Trustworthy source IDs are explicitly namespaced and hashed, not public fields.
select test.ok(test.external_import(jsonb_build_array(test.external_record('source-first')||'{"sourceId":"123"}'),'Kommo — Conta A')->>'imported'='1','external: explicit source ID imports new lead');
select test.ok(test.external_import(jsonb_build_array(test.external_record('source-second')||'{"sourceId":"123"}'),'kommo — conta a')->>'skipped'='1','external: same normalized namespace and source ID skip');
select test.ok(test.external_import(jsonb_build_array(test.external_record('source-other-account')||'{"sourceId":"123"}'),'Kommo — Conta B')->>'imported'='1','external: different namespaces do not confuse unrelated IDs');
select test.ok(test.external_preview(jsonb_build_array(test.external_record('source-email-conflict',1,'{"email":"dupe@example.test"}')||'{"sourceId":"123"}'),'Kommo — Conta A')->>'conflict'='1','external: source ID and email identifying different leads report conflict');
update public.leads set data=data||'{"email":"changed-after-import@example.test","phone":""}' where workspace_id=test.value('external_ws_a')::uuid and id='external-existing-a';
select test.ok(test.external_import(jsonb_build_array(test.external_record('email-dupe',1,'{"email":"DUPE@example.test"}')))->>'skipped'='1','external: registered row key remains idempotent after contact changes');

select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000145',false);
select test.ok(public.import_external_leads(test.value('external_ws_b')::uuid,jsonb_build_array(test.external_record('first',1,'{"email":"person@example.test","phone":"5571988880001"}','external_stage_b',auth.uid())))->>'imported'='1','external: same row key contact and ID imports independently in other company');
select test.ok((select count(*)=1 from public.leads where workspace_id=test.value('external_ws_b')::uuid),'external: tenant B sees only its own imported data');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000142',false);
select test.ok((select count(*)=0 from public.leads where workspace_id=test.value('external_ws_b')::uuid),'external: closer sees no other company rows');
select test.ok((select count(*)=0 from public.leads where workspace_id=test.value('external_ws_a')::uuid and owner_id<>'00000000-0000-0000-0000-000000000142'),'external: closer sees only assigned imported leads');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select test.ok(not exists(select 1 from public.leads where workspace_id in(test.value('external_ws_a')::uuid,test.value('external_ws_b')::uuid)),'external: Master sees no imported tenant leads');
select test.ok(not public.platform_list_administrative_audit(test.value('external_ws_a')::uuid)::text like '%leads.external_imported%','external: Master administrative audit excludes commercial import actions');
select public.admin_update_subscription(test.value('external_ws_a')::uuid,'team','suspended',12);
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000140',false);
select test.denied('select test.external_preview(jsonb_build_array(test.external_record(''suspended'')))','42501','external: suspended company cannot preview');
select test.denied('select test.external_import(jsonb_build_array(test.external_record(''suspended'')))','42501','external: suspended company cannot import');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select public.admin_update_subscription(test.value('external_ws_a')::uuid,'team','active',12);
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000140',false);

-- 2,001 actual lead rows across safe batches; interruption/retry never re-adds prior rows.
do $$ declare rows jsonb; response jsonb; batch integer; before_count integer; after_count integer; begin
  select count(*) into before_count from public.leads where workspace_id=test.value('external_ws_a')::uuid;
  for batch in 0..4 loop
    select jsonb_agg(test.external_record('volume-'||n,n)) into rows from generate_series(batch*500+1,least((batch+1)*500,2001)) n;
    response:=test.external_import(rows);
    perform test.ok((response->>'imported')::integer=jsonb_array_length(rows),'external: volume batch '||batch||' confirms actual inserted count');
    perform test.ok(test.external_import(rows)->>'imported'='0','external: volume batch '||batch||' retry inserts none');
    perform test.ok((test.external_import(rows)->>'skipped')::integer=jsonb_array_length(rows),'external: volume batch '||batch||' retry reports committed duplicates');
  end loop;
  select count(*) into after_count from public.leads where workspace_id=test.value('external_ws_a')::uuid;
  perform test.ok(after_count-before_count=2001,'external: 2001 leads safely imported across five atomic batches');
  perform test.denied(format('select test.external_import(%L::jsonb)',jsonb_build_array(test.external_record('later-invalid',1),test.external_record('later-bad',2,'{"name":""}'))),'22023','external: failed later batch rejects atomically');
  perform test.ok((select count(*)=after_count from public.leads where workspace_id=test.value('external_ws_a')::uuid),'external: later batch failure preserves all earlier committed batches');
end; $$;
reset role;
select test.ok(not exists(select 1 from public.audit_logs where workspace_id=test.value('external_ws_a')::uuid and action='leads.external_imported'
  and (details ? 'name' or details ? 'email' or details ? 'phone' or details ? 'notes' or details ? 'sourceId' or details::text like '%PRIVATE_NOTE_CANARY%')),'external: technical import audits store only counts');
select test.ok((select bool_and(key_hash ~ '^[a-f0-9]{64}$') from private.external_import_keys where workspace_id=test.value('external_ws_a')::uuid),'external: provenance stores fixed-size hashes only');
insert into test.context values('external_race_rows',jsonb_build_array(test.external_record('concurrent-external',1,'{"email":"external-race@example.test"}'))::text),
  ('external_manual_race_rows',jsonb_build_array(test.external_record('concurrent-manual',1,'{"email":"external-manual-race@example.test"}'))::text),
  ('external_inbound_race_rows',jsonb_build_array(test.external_record('concurrent-inbound',1,'{"email":"external-inbound-race@example.test"}'))::text),
  ('external_revoke_race_rows',jsonb_build_array(test.external_record('concurrent-revocation',1,'{"email":"external-revocation@example.test"}'))::text);
select 'External-import assertions passed: '||count(*) from test.results where label like 'external:%';
